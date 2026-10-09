import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { link, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import {
  VIEWER_BASE_DIRECTORY, commandFileName, commandFilePath, launchExternalViewer,
  prepareCommandFile,
} from "../extension/external-viewer.ts";
import { nodeViewerFileDependencies } from "../extension/external-viewer-node.ts";
import type {
  DetachedViewerProcess, ExternalViewerConfig, ViewerFileDependencies, ViewerFileSystem, ViewerProcessDependencies,
} from "../extension/types.ts";

async function isolatedFiles(t: TestContext) {
  // Every real write stays below this unique root, including the injected production-style default directory.
  const root = await mkdtemp(join(tmpdir(), "bash-cmd-checker-viewer-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const dependencies: ViewerFileDependencies = {
    fileSystem: { ...nodeViewerFileDependencies.fileSystem },
    temporaryDirectory: () => root,
  };
  return { root, dependencies };
}

function fileInfo(kind: "file" | "directory" | "link") {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "link",
  };
}

function missing(): Error { return Object.assign(new Error("MOCK_MISSING"), { code: "ENOENT" }); }

function mockFiles() {
  const root = resolve("mock-viewer-root");
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const links = new Set<string>();
  const calls: string[] = [];
  const handles = new Map<number, string>();
  let nextFd = 0;
  const fileSystem: ViewerFileSystem = {
    lstatSync(path) {
      calls.push("lstat");
      if (links.has(path)) return fileInfo("link");
      if (directories.has(path)) return fileInfo("directory");
      if (files.has(path)) return fileInfo("file");
      throw missing();
    },
    mkdirSync(path, options) {
      calls.push("mkdir");
      assert.deepEqual(options, { recursive: true, mode: 0o700 });
      directories.add(path);
    },
    openSync(path, flags, mode) {
      calls.push("open");
      assert.equal(flags, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
      assert.equal(mode, 0o600);
      assert.ok(path.endsWith(".sh"));
      files.set(path, "");
      const fd = nextFd++;
      handles.set(fd, path);
      return fd;
    },
    writeFileSync(fd, text, encoding) {
      calls.push("write");
      assert.equal(encoding, "utf8");
      assert.ok(handles.has(fd));
      files.set(handles.get(fd)!, text);
    },
    closeSync(fd) { calls.push("close"); assert.ok(handles.has(fd)); handles.delete(fd); },
  };
  const dependencies: ViewerFileDependencies = { fileSystem, temporaryDirectory: () => root };
  return { root, files, directories, links, calls, handles, dependencies };
}

test("session filenames are stable, isolated and safe for arbitrary non-blank identities", () => {
  assert.equal(commandFileName("session-1"), "command-session-1.sh");
  assert.equal(commandFileName("a".repeat(128)), `command-${"a".repeat(128)}.sh`);
  assert.notEqual(commandFileName("first"), commandFileName("second"));
  for (const identity of ["../other/session", "a/b", "a\\b", "\u0000", "中😀", " a ", "a".repeat(129),
    "sha256.literal", "line\nidentity"]) {
    const digest = createHash("sha256").update(identity, "utf8").digest("hex");
    const filename = commandFileName(identity);
    assert.equal(filename, `command-sha256.${digest}.sh`);
    assert.equal(filename, commandFileName(identity));
    assert.equal(basename(filename), filename);
  }
  assert.notEqual(commandFileName("a/b"), commandFileName("a\\b"));
  for (const identity of ["", " \t\n"]) assert.throws(() => commandFileName(identity));
});

test("filePath selects only a directory and all generated command paths are native absolute paths", () => {
  const root = resolve("mock-temporary-root");
  assert.equal(commandFilePath("session", null, () => root),
    join(root, VIEWER_BASE_DIRECTORY, "command-session.sh"));
  const directory = join(root, "custom directory.sh");
  assert.equal(commandFilePath("session", directory, () => { assert.fail("Must not read the default directory."); }),
    join(directory, "command-session.sh"));
  const unsafe = commandFilePath("../escape", null, () => root);
  assert.equal(dirname(unsafe), join(root, VIEWER_BASE_DIRECTORY));
  assert.equal(isAbsolute(unsafe), true);
  for (const directory of ["relative", "~/viewer", "bad\u0000", join(root, "bad\u0000")]) {
    assert.throws(() => commandFilePath("session", directory, () => root));
  }
  const incompatible = isAbsolute("C:/viewer") ? "C:relative" : "C:/viewer";
  assert.throws(() => commandFilePath("session", incompatible, () => root));
});

test("command files preserve exact UTF-8 text, overwrite per session and retain separate sessions", async (t) => {
  const { root, dependencies } = await isolatedFiles(t);
  const command = "  printf '中😀e\u0301'\t\r\n\n$(literal); \u001b[2J\u0000  ";
  const path = prepareCommandFile("first", null, command, dependencies);
  assert.equal(path, join(root, VIEWER_BASE_DIRECTORY, "command-first.sh"));
  assert.equal(await readFile(path!, "utf8"), command);
  const second = prepareCommandFile("second", null, "second command\n", dependencies);
  assert.notEqual(path, second);
  assert.equal(prepareCommandFile("first", null, "replacement", dependencies), path);
  assert.equal(await readFile(path!, "utf8"), "replacement");
  assert.equal(await readFile(second!, "utf8"), "second command\n");
  assert.deepEqual((await readdir(dirname(path!))).sort(), ["command-first.sh", "command-second.sh"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(dirname(path!))).mode & 0o777, 0o700);
    assert.equal((await stat(path!)).mode & 0o777, 0o600);
  }
});

test("custom directories are created without consulting the production temporary location", async (t) => {
  const { root, dependencies } = await isolatedFiles(t);
  const directory = join(root, "nested", "viewer dir.sh");
  dependencies.temporaryDirectory = () => { assert.fail("A custom directory must not use the default."); };
  const path = prepareCommandFile("session", directory, "no added newline", dependencies);
  assert.equal(path, join(directory, "command-session.sh"));
  assert.equal(await readFile(path!, "utf8"), "no added newline");
  assert.deepEqual(await readdir(directory), ["command-session.sh"]);
});

test("direct truncation writes through the existing session file and its hard links", async (t) => {
  const { root, dependencies } = await isolatedFiles(t);
  const path = prepareCommandFile("session", null, "long original command", dependencies);
  const other = join(root, "other-file");
  await link(path!, other);
  assert.equal(prepareCommandFile("session", null, "short", dependencies), path);
  assert.equal(await readFile(path!, "utf8"), "short");
  assert.equal(await readFile(other, "utf8"), "short");
});

test("failed direct writes leave partial content, close the file and create no intermediate files", async (t) => {
  const { dependencies } = await isolatedFiles(t);
  const path = prepareCommandFile("session", null, "old complete text", dependencies);
  const originalWrite = dependencies.fileSystem.writeFileSync;
  const originalClose = dependencies.fileSystem.closeSync;
  let closed = false;
  dependencies.fileSystem.writeFileSync = (fd, text, encoding) => {
    originalWrite(fd, text.slice(0, 3), encoding);
    throw new Error("MOCK_WRITE_ERROR");
  };
  dependencies.fileSystem.closeSync = (fd) => { originalClose(fd); closed = true; };
  assert.throws(() => prepareCommandFile("session", null, "new complete text", dependencies));
  assert.equal(closed, true);
  assert.equal(await readFile(path!, "utf8"), "new");
  assert.deepEqual(await readdir(dirname(path!)), ["command-session.sh"]);
});

test("unsafe default directories and non-regular or linked target files are rejected without opening files", () => {
  for (const kind of ["directory-link", "directory-file", "target-link", "target-directory"] as const) {
    const app = mockFiles();
    const directory = join(app.root, VIEWER_BASE_DIRECTORY);
    const path = join(directory, "command-session.sh");
    if (kind === "directory-link") app.links.add(directory);
    if (kind === "directory-file") app.files.set(directory, "not a directory");
    if (kind === "target-link") app.links.add(path);
    if (kind === "target-directory") app.directories.add(path);
    assert.throws(() => prepareCommandFile("session", null, "command", app.dependencies));
    assert.equal(app.calls.includes("open"), false);
  }
});

test("direct file failures preserve only the content written so far and always attempt handle cleanup", () => {
  for (const failure of ["open", "write", "close", "stat", "mkdir"] as const) {
    const app = mockFiles();
    const path = join(app.root, VIEWER_BASE_DIRECTORY, "command-session.sh");
    app.files.set(path, "old text");
    const originalClose = app.dependencies.fileSystem.closeSync;
    let closeAttempts = 0;
    app.dependencies.fileSystem.closeSync = (fd) => {
      closeAttempts++;
      if (failure === "close") throw new Error("MOCK_CLOSE_ERROR");
      originalClose(fd);
    };
    if (failure === "open") app.dependencies.fileSystem.openSync = () => { throw new Error("MOCK_OPEN_ERROR"); };
    if (failure === "write") app.dependencies.fileSystem.writeFileSync = () => { throw new Error("MOCK_WRITE_ERROR"); };
    if (failure === "stat") app.dependencies.fileSystem.lstatSync = () => { throw new Error("MOCK_STAT_ERROR"); };
    if (failure === "mkdir") app.dependencies.fileSystem.mkdirSync = () => { throw new Error("MOCK_MKDIR_ERROR"); };
    assert.throws(() => prepareCommandFile("session", null, "new text", app.dependencies));
    const expected = failure === "write" ? "" : failure === "close" ? "new text" : "old text";
    assert.equal(app.files.get(path), expected);
    assert.equal(app.files.size, 1);
    assert.equal(closeAttempts, failure === "close" ? 2 : failure === "write" ? 1 : 0);
    if (failure !== "close") assert.equal(app.handles.size, 0);
  }
});

test("synchronous preparation completes and closes descriptor zero before returning", () => {
  const app = mockFiles();
  const path = prepareCommandFile("session", null, "command", app.dependencies);
  assert.equal(typeof path, "string");
  assert.deepEqual(app.calls, ["lstat", "mkdir", "lstat", "lstat", "open", "write", "close"]);
  assert.equal(app.files.get(path!), "command");
  assert.equal(app.handles.size, 0);
});

class MockProcess extends EventEmitter implements DetachedViewerProcess {
  unrefs = 0;
  unrefError = false;
  unref(): void { this.unrefs++; if (this.unrefError) throw new Error("MOCK_UNREF_ERROR"); }
}

function mockProcesses() {
  const child = new MockProcess();
  const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
  const steps: string[] = [];
  const dependencies: ViewerProcessDependencies = {
    spawn(command, args, options) { calls.push({ command, args: [...args], options }); return child; },
    spawnSync(command, args, options) {
      steps.push("spawnSync"); calls.push({ command, args: [...args], options });
      return { status: 0, signal: null };
    },
    writeTerminal(text) { assert.equal(text, "\u001b[2J\u001b[H"); steps.push("clear"); },
  };
  return { child, calls, steps, dependencies };
}

const noCustom: Pick<ExtensionUIContext, "custom"> = {
  custom: () => { assert.fail("Detach and unconfigured operations must not touch the terminal UI."); },
};
const commandPath = resolve("mock command directory", "command-session.sh");

function viewerConfig(overrides: Partial<ExternalViewerConfig> = {}): ExternalViewerConfig {
  return { ...DEFAULT_CONFIG.externalViewer, ...overrides };
}

test("detach passes a literal args array and the final absolute file path without shell execution or terminal access", async () => {
  const app = mockProcesses();
  const args = Object.freeze(["", "--reuse-window", "space and 'quotes'", "$(literal); &"]);
  const config = viewerConfig({ command: "C:\\Program Files\\Code.exe", args });
  const pending = launchExternalViewer(noCustom, config, commandPath, app.dependencies);
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  app.child.emit("spawn");
  assert.equal(await pending, "started");
  assert.deepEqual(app.calls, [{ command: config.command, args: [...args, commandPath],
    options: { shell: false, detached: true, stdio: "ignore" } }]);
  assert.equal(app.child.unrefs, 1);
  assert.deepEqual(app.steps, []);
  assert.equal(args.length, 4);
  app.child.emit("error", new Error("MOCK_LATE_ERROR"));
  app.child.emit("close");
  assert.equal(app.child.listenerCount("error"), 0);
  assert.equal(app.child.listenerCount("spawn"), 0);
});

test("detach contains synchronous spawn failures, asynchronous errors and unref failures", async () => {
  for (const failure of ["throw", "error", "unref", "early-close"] as const) {
    const app = mockProcesses();
    if (failure === "throw") app.dependencies.spawn = () => { throw new Error("MOCK_SPAWN_ERROR"); };
    if (failure === "unref") app.child.unrefError = true;
    const pending = launchExternalViewer(noCustom, viewerConfig(), commandPath, app.dependencies);
    if (failure === "error") app.child.emit("error", new Error("MOCK_ASYNC_ERROR"));
    if (failure === "unref") app.child.emit("spawn");
    if (failure === "early-close") app.child.emit("close");
    assert.equal(await pending, "failed");
    if (failure !== "throw" && failure !== "early-close") app.child.emit("close");
    assert.equal(app.child.listenerCount("error"), 0);
  }
});

type WaitFactory<T> = (
  tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void,
) => Component | Promise<Component>;

function waitUi(steps: string[], failure?: "stop" | "start" | "render" | "custom") {
  let mounts = 0;
  const tui = {
    stop() { steps.push("stop"); if (failure === "stop") throw new Error("MOCK_STOP_ERROR"); },
    start() { steps.push("start"); if (failure === "start") throw new Error("MOCK_START_ERROR"); },
    requestRender(force?: boolean) {
      assert.equal(force, true); steps.push("render");
      if (failure === "render") throw new Error("MOCK_RENDER_ERROR");
    },
  } as unknown as TUI;
  const ui: Pick<ExtensionUIContext, "custom"> = {
    async custom<T>(factory: WaitFactory<T>) {
      steps.push("custom");
      if (failure === "custom") throw new Error("MOCK_CUSTOM_ERROR");
      let completed = false;
      let result!: T;
      const component = factory(tui, {} as Theme, {} as KeybindingsManager, (value) => {
        steps.push("done"); completed = true; result = value;
      });
      assert.equal(component instanceof Promise, false, "The handoff factory must finish synchronously.");
      if (!completed) mounts++;
      assert.equal(completed, true);
      assert.deepEqual((component as Component).render(80), []);
      return result;
    },
  };
  return { ui, mounts: () => mounts };
}

test("wait synchronously hands off and restores the terminal without mounting a command preview", async () => {
  const app = mockProcesses();
  const ui = waitUi(app.steps);
  const config = viewerConfig({ command: "nvim", args: ["-R", "$(literal); &"], mode: "wait" });
  assert.equal(await launchExternalViewer(ui.ui, config, commandPath, app.dependencies), "completed");
  assert.deepEqual(app.steps, ["custom", "stop", "clear", "spawnSync", "start", "render", "done"]);
  assert.deepEqual(app.calls, [{ command: "nvim", args: ["-R", "$(literal); &", commandPath],
    options: { shell: false, stdio: "inherit" } }]);
  assert.equal(ui.mounts(), 0);
  assert.equal(app.child.unrefs, 0);
});

test("wait restores the terminal after nonzero, signal, error and thrown process failures", async () => {
  for (const failure of ["nonzero", "signal", "error", "throw"] as const) {
    const app = mockProcesses();
    const ui = waitUi(app.steps);
    app.dependencies.spawnSync = () => {
      app.steps.push("spawnSync");
      if (failure === "throw") throw new Error("MOCK_SYNC_ERROR");
      return { status: failure === "nonzero" ? 7 : failure === "signal" ? null : 0,
        signal: failure === "signal" ? "SIGINT" : null,
        ...(failure === "error" ? { error: new Error("MOCK_SYNC_ERROR") } : {}) };
    };
    assert.equal(await launchExternalViewer(ui.ui, viewerConfig({ mode: "wait" }), commandPath, app.dependencies), "failed");
    assert.deepEqual(app.steps.slice(-3), ["start", "render", "done"]);
    assert.equal(ui.mounts(), 0);
  }
});

test("terminal handoff failures still attempt restoration and complete the custom interaction", async () => {
  for (const failure of ["stop", "clear", "start", "render", "custom"] as const) {
    const app = mockProcesses();
    const ui = waitUi(app.steps, failure === "clear" ? undefined : failure);
    if (failure === "clear") app.dependencies.writeTerminal = () => { throw new Error("MOCK_WRITE_ERROR"); };
    assert.equal(await launchExternalViewer(ui.ui, viewerConfig({ mode: "wait" }), commandPath, app.dependencies),
      "terminal-failed");
    if (failure !== "custom") assert.deepEqual(app.steps.slice(-3), ["start", "render", "done"]);
    if (failure === "stop" || failure === "clear" || failure === "custom") assert.equal(app.calls.length, 0);
    assert.equal(ui.mounts(), 0);
  }
});

test("unconfigured and invalid-path launches never start a process", async () => {
  const app = mockProcesses();
  assert.equal(await launchExternalViewer(noCustom, viewerConfig({ command: null }), commandPath, app.dependencies),
    "unconfigured");
  for (const path of ["relative.sh", `${commandPath}\u0000`]) {
    assert.equal(await launchExternalViewer(noCustom, viewerConfig(), path, app.dependencies), "failed");
  }
  assert.equal(app.steps.length, 0);
  assert.equal(app.calls.length, 0);
});
