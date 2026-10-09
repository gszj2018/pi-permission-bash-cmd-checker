import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { KeyId } from "@earendil-works/pi-tui";
import { extractCommandObservation } from "../extension/command.ts";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import { commandFilePath } from "../extension/external-viewer.ts";
import { SessionState } from "../extension/state.ts";
import type { ExternalViewerConfig } from "../extension/types.ts";
import { createWidgetController, WIDGET_KEY } from "../extension/widget.ts";
import { MockExternalViewer } from "./helpers/external-viewer.ts";
import { MockUi, commandDetails, flushPromises } from "./helpers/mocks.ts";

const shortcut = "\u001bc";

function record(id = "first", command = "printf 'first full command'") {
  const observation = extractCommandObservation(commandDetails(id, command));
  assert.ok(observation);
  const result = new SessionState().observe(observation);
  assert.ok(result);
  return result;
}

function setup(t: TestContext, config: Partial<ExternalViewerConfig> = {}, key?: KeyId) {
  const ui = new MockUi();
  const external = new MockExternalViewer();
  const viewerConfig = { ...DEFAULT_CONFIG.externalViewer, ...config };
  const controller = createWidgetController(ui.ui, "serving-session", viewerConfig, external.dependencies, key);
  const path = commandFilePath("serving-session", config.filePath ?? null, () => external.root);
  t.after(() => { controller.dispose(); external.close(); });
  return { ui, external, controller, viewerConfig, path };
}

test("the controller owns one input listener while only a visible widget consumes the actual shortcut", async (t) => {
  const app = setup(t);
  assert.equal(app.ui.inputHandlers.size, 1);
  assert.equal(app.ui.input(shortcut), false);
  assert.equal(app.external.files.size, 0);
  assert.equal(app.external.directories.size, 0);
  assert.equal(app.external.calls.length, 0);
  app.controller.show(record());
  for (const data of ["c", "q", "\r", "\u001b", "x", " ", "\t", "\u007f", "\u001b[D"]) {
    assert.equal(app.ui.input(data), false, JSON.stringify(data));
  }
  for (const data of ["\u001b[99;3:2u", "\u001b[99;3:3u"]) assert.equal(app.ui.input(data), true);
  assert.equal(app.external.calls.length, 0);
  assert.equal(app.ui.input(shortcut), true);
  await flushPromises();
  assert.equal(app.external.files.get(app.path), "printf 'first full command'");
  assert.equal(app.external.calls.length, 1);
  assert.equal(app.ui.customCalls, 0);
  assert.equal(app.ui.stopped, false);
  app.controller.hide();
  assert.equal(app.ui.inputHandlers.size, 1);
  assert.equal(app.ui.input(shortcut), false);
  app.controller.show(record("new", "new command"));
  assert.equal(app.ui.inputHandlers.size, 1);
  app.controller.dispose();
  assert.equal(app.ui.inputHandlers.size, 0);
  assert.equal(app.ui.notifications.length, 0);
});

test("four-line previews keep complete raw UTF-8 files and custom shortcuts also open short commands", async (t) => {
  const app = setup(t, {}, "alt+m");
  const source = `  printf '中😀e\u0301'\n\n${Array.from({ length: 40 }, (_, index) => `printf 'line-${index}'`).join("\n")}\n\u001b[2J  `;
  app.controller.show(record("long", source));
  const preview = app.ui.text(WIDGET_KEY);
  assert.ok(preview.includes("Command truncated. Press Alt+m to view the full command."));
  assert.equal(preview.includes("line-39"), false);
  assert.equal(app.ui.input(shortcut), false);
  assert.equal(app.ui.input("\u001bm"), true);
  await flushPromises();
  assert.equal(app.external.files.get(app.path), source);
  assert.equal(app.external.calls[0]!.args.at(-1), app.path);
  assert.equal(app.ui.customCalls, 0);
  assert.equal(app.ui.overlays.length, 0);
  app.controller.show(record("short", "short command"));
  app.ui.input("\u001bm");
  await flushPromises();
  assert.equal(app.external.files.get(app.path), "short command");
  assert.equal(app.external.calls.length, 2);
});

test("unconfigured commands warn only on effective presses and never prepare a file", async (t) => {
  const app = setup(t, { command: null });
  app.ui.input(shortcut);
  assert.equal(app.ui.notifications.length, 0);
  app.controller.show(record());
  app.ui.input("\u001b[99;3:2u");
  app.ui.input(shortcut);
  await flushPromises();
  assert.deepEqual(app.ui.notifications, [{
    message: "[bash-cmd-checker] No external viewer command is configured.", type: "warning",
  }]);
  assert.equal(app.external.files.size, 0);
  assert.equal(app.external.directories.size, 0);
  assert.equal(app.external.calls.length, 0);
});

test("busy suppresses reentrant writes and presses without queuing; each later press captures the current record", async (t) => {
  const app = setup(t);
  app.external.automaticSpawn = false;
  app.controller.show(record());
  const write = app.external.fileDependencies.fileSystem.writeFileSync;
  app.external.fileDependencies.fileSystem.writeFileSync = (...args) => {
    write(...args);
    app.controller.show(record("second", "printf 'second'"));
    assert.equal(app.ui.input(shortcut), true);
    assert.equal(app.ui.input("ordinary"), false);
  };
  app.ui.input(shortcut);
  assert.equal(app.external.files.get(app.path), "printf 'first full command'");
  app.ui.input(shortcut);
  await flushPromises();
  assert.equal(app.external.calls.length, 1);
  app.external.children[0]!.emit("spawn");
  await flushPromises();
  assert.equal(app.external.calls.length, 1);
  app.external.fileDependencies.fileSystem.writeFileSync = write;
  app.ui.input(shortcut);
  assert.equal(app.external.files.get(app.path), "printf 'second'");
  assert.equal(app.external.calls.length, 2);
  app.external.children[1]!.emit("spawn");
  await flushPromises();
});

test("widget updates and hide/remount never rewrite a pending snapshot, release busy or restore a hidden command", async (t) => {
  const app = setup(t);
  app.external.automaticSpawn = false;
  const first = record();
  app.controller.show(first);
  app.ui.input(shortcut);
  app.controller.show({ ...first, explanation: { status: "complete", text: "Later explanation." },
    decision: { result: "allow", resolution: "user_approved" } });
  app.controller.hide();
  assert.equal(app.ui.components.size, 0);
  assert.equal(app.ui.inputHandlers.size, 1);
  assert.equal(app.ui.input(shortcut), false);
  app.controller.show(record("second", "second command"));
  app.ui.input(shortcut);
  assert.equal(app.external.calls.length, 1);
  app.external.children[0]!.emit("spawn");
  await flushPromises();
  assert.equal(app.external.files.get(app.path), first.observation.fullCommand);
  app.ui.input(shortcut);
  app.external.children[1]!.emit("spawn");
  await flushPromises();
  assert.equal(app.external.files.get(app.path), "second command");
  app.controller.hide();
  assert.equal(app.ui.input(shortcut), false);
});

test("widget runtime disposal during file writing cannot cancel an already triggered external flow", async (t) => {
  const app = setup(t);
  app.controller.show(record());
  const write = app.external.fileDependencies.fileSystem.writeFileSync;
  app.external.fileDependencies.fileSystem.writeFileSync = (...args) => { write(...args); app.controller.dispose(); };
  app.ui.input(shortcut);
  await flushPromises();
  assert.equal(app.ui.components.size, 0);
  assert.equal(app.ui.inputHandlers.size, 0);
  assert.equal(app.external.calls.length, 1);
  assert.equal(app.external.children[0]!.unrefs, 1);
  assert.equal(app.ui.input(shortcut), false);
  assert.equal(app.external.files.get(app.path), "printf 'first full command'");
});

test("failed widget mounts and redraws disable viewing until a successful later show restores the new command", async (t) => {
  for (const failure of ["mount", "render"] as const) {
    const app = setup(t);
    const mount = app.ui.ui.setWidget;
    const render = app.ui.tui.requestRender.bind(app.ui.tui);
    if (failure === "mount") {
      app.ui.ui.setWidget = (key, content, options) => {
        if (typeof content === "function") mount(key, content, options);
        else mount(key, content, options);
        throw new Error("MOCK_WIDGET_ERROR");
      };
    } else {
      app.controller.show(record());
      app.ui.tui.requestRender = () => { throw new Error("MOCK_RENDER_ERROR"); };
    }
    assert.throws(() => app.controller.show(record("failed", "failed command")));
    assert.equal(app.ui.input(shortcut), false);
    assert.equal(app.external.calls.length, 0);
    app.ui.ui.setWidget = mount;
    app.ui.tui.requestRender = render;
    app.controller.show(record("recovered", "recovered command"));
    app.ui.input(shortcut);
    await flushPromises();
    assert.equal(app.external.files.get(app.path), "recovered command");
    assert.equal(app.ui.inputHandlers.size, 1);
  }
});

test("file preparation failures suppress sensitive details, skip spawn and release busy for a retry", async (t) => {
  for (const operation of ["mkdirSync", "writeFileSync"] as const) {
    const app = setup(t);
    app.controller.show(record());
    const original = { ...app.external.fileDependencies.fileSystem };
    app.external.fileDependencies.fileSystem[operation] = () => { throw new Error("SENSITIVE_FILE_ERROR"); };
    assert.doesNotThrow(() => app.ui.input(shortcut));
    await flushPromises();
    assert.equal(app.external.calls.length, 0);
    assert.equal(app.external.handles.size, 0);
    assert.deepEqual(app.ui.notifications, [{
      message: "[bash-cmd-checker] Failed to prepare the command file for the external viewer.", type: "error",
    }]);
    Object.assign(app.external.fileDependencies.fileSystem, original);
    app.ui.input(shortcut);
    await flushPromises();
    assert.equal(app.external.calls.length, 1);
  }
});

test("detached startup errors notify safely and release busy for retry", async (t) => {
  for (const failure of ["throw", "error"] as const) {
    const app = setup(t);
    app.controller.show(record());
    const spawn = app.external.processDependencies.spawn;
    if (failure === "throw") app.external.processDependencies.spawn = () => { throw new Error("SENSITIVE_SPAWN_ERROR"); };
    else app.external.automaticSpawn = false;
    app.ui.input(shortcut);
    if (failure === "error") app.external.children[0]!.emit("error", new Error("SENSITIVE_SPAWN_ERROR"));
    await flushPromises();
    assert.deepEqual(app.ui.notifications, [{
      message: "[bash-cmd-checker] Failed to run the external viewer.", type: "error",
    }]);
    app.external.processDependencies.spawn = spawn;
    app.external.automaticSpawn = true;
    const count = app.external.calls.length;
    app.ui.input(shortcut);
    await flushPromises();
    assert.equal(app.external.calls.length, count + 1);
  }
});

test("wait gets the current custom TUI rather than the widget owner captured before a terminal mode change", async (t) => {
  const app = setup(t, { mode: "wait" });
  app.controller.show(record());
  const current = new MockUi();
  app.ui.ui.custom = current.ui.custom;
  app.ui.input(shortcut);
  await flushPromises();
  assert.deepEqual(app.ui.terminalSteps, []);
  assert.deepEqual(current.terminalSteps, ["stop", "start", "render"]);
  assert.equal(current.customMounts, 0);
  assert.equal(app.external.calls[0]!.mode, "wait");
});

test("wait keeps busy during handoff, restores before notifying and permits a later retry", async (t) => {
  const app = setup(t, { command: "nvim", args: ["-R"], mode: "wait" });
  app.controller.show(record());
  const spawn = app.external.processDependencies.spawnSync;
  app.external.processDependencies.spawnSync = (...args) => {
    assert.equal(app.ui.stopped, true);
    app.ui.input(shortcut);
    spawn(...args);
    return { status: 7, signal: null };
  };
  const notify = app.ui.ui.notify;
  app.ui.ui.notify = (...args) => { assert.equal(app.ui.stopped, false); notify(...args); };
  app.ui.input(shortcut);
  await flushPromises();
  assert.equal(app.external.calls.length, 1);
  assert.deepEqual(app.ui.terminalSteps, ["stop", "start", "render"]);
  assert.equal(app.ui.customMounts, 0);
  assert.deepEqual(app.ui.notifications, [{ message: "[bash-cmd-checker] Failed to run the external viewer.", type: "error" }]);
  app.external.processDependencies.spawnSync = spawn;
  app.ui.input(shortcut);
  await flushPromises();
  assert.equal(app.external.calls.length, 2);
});

test("wait completes synchronously without mounting a viewer or dismissing a permission overlay", async (t) => {
  const app = setup(t, { command: "nvim", args: ["-R"], mode: "wait" });
  let closePermission!: () => void;
  const permission = app.ui.ui.custom<void>((_tui, _theme, _keys, done) => {
    closePermission = () => { done(undefined); };
    return { render: () => ["Permission dialog"], invalidate() {} };
  }, { overlay: true });
  t.after(async () => { closePermission(); await permission; });
  await flushPromises();
  const dialog = app.ui.overlays[0]!;
  app.controller.show(record());
  app.ui.input(shortcut);
  await flushPromises();
  assert.equal(app.external.calls.length, 1);
  assert.deepEqual(app.ui.overlays, [dialog]);
  assert.equal(dialog.closed, false);
  assert.equal(app.ui.customMounts, 1);
  assert.deepEqual(app.ui.terminalSteps, ["stop", "start", "render"]);
  app.controller.dispose();
  assert.equal(dialog.closed, false);
});

test("terminal recovery errors have a fixed notification and notification failures cannot escape", async (t) => {
  const app = setup(t, { mode: "wait" });
  app.controller.show(record());
  const start = app.ui.tui.start.bind(app.ui.tui);
  app.ui.tui.start = () => { start(); throw new Error("SENSITIVE_TERMINAL_ERROR"); };
  app.ui.input(shortcut);
  await flushPromises();
  assert.deepEqual(app.ui.notifications, [{
    message: "[bash-cmd-checker] Failed to restore the terminal after running the external viewer.", type: "error",
  }]);
  app.ui.ui.notify = () => { throw new Error("SENSITIVE_NOTIFY_ERROR"); };
  assert.doesNotThrow(() => app.ui.input(shortcut));
  await flushPromises();
  assert.equal(app.external.calls.length, 2);
});

test("controller disposal releases input once and suppresses late notifications without cancelling startup", async (t) => {
  for (const event of ["spawn", "error"] as const) {
    const app = setup(t);
    app.external.automaticSpawn = false;
    app.controller.show(record());
    app.ui.input(shortcut);
    const handler = [...app.ui.inputHandlers][0]!;
    app.controller.dispose();
    app.controller.dispose();
    app.controller.show(record("stale", "stale command"));
    assert.equal(handler(shortcut), undefined);
    assert.equal(app.ui.input(shortcut), false);
    app.external.children[0]!.emit(event, new Error("SENSITIVE_LATE_ERROR"));
    await flushPromises();
    assert.equal(app.external.calls.length, 1);
    assert.equal(app.external.children[0]!.unrefs, event === "spawn" ? 1 : 0);
    assert.equal(app.external.files.get(app.path), "printf 'first full command'");
    assert.equal(app.ui.notifications.length, 0);
  }
});

test("hide propagates host removal errors after clearing the mounted state and allows a fresh mount", async (t) => {
  const app = setup(t);
  app.controller.show(record());
  const previous = app.ui.components.get(WIDGET_KEY);
  const setWidget = app.ui.ui.setWidget;
  const removalError = new Error("MOCK_WIDGET_REMOVAL_ERROR");
  let removalCalls = 0;
  app.ui.ui.setWidget = () => { removalCalls++; throw removalError; };
  assert.throws(() => app.controller.hide(), (error: unknown) => error === removalError);
  assert.equal(app.ui.input(shortcut), false);
  assert.equal(app.ui.inputHandlers.size, 1);
  assert.equal(app.external.calls.length, 0);
  assert.doesNotThrow(() => app.controller.hide());
  assert.equal(removalCalls, 1);
  app.ui.ui.setWidget = setWidget;
  app.controller.show(record("recovered", "recovered command"));
  assert.notEqual(app.ui.components.get(WIDGET_KEY), previous);
  assert.equal(app.ui.input(shortcut), true);
  await flushPromises();
  assert.equal(app.external.files.get(app.path), "recovered command");
});

test("disposal contains host removal errors, releases input once and suppresses late startup notifications", async (t) => {
  const app = setup(t);
  app.external.automaticSpawn = false;
  app.controller.show(record());
  const previous = app.ui.components.get(WIDGET_KEY);
  const handler = [...app.ui.inputHandlers][0]!;
  app.ui.input(shortcut);
  const removalStates: unknown[] = [];
  app.ui.ui.setWidget = () => {
    removalStates.push({ listeners: app.ui.inputHandlers.size, input: handler(shortcut) });
    throw new Error("SENSITIVE_WIDGET_REMOVAL_ERROR");
  };
  assert.doesNotThrow(() => app.controller.dispose());
  assert.doesNotThrow(() => app.controller.dispose());
  app.controller.show(record("stale", "stale command"));
  assert.deepEqual(removalStates, [{ listeners: 0, input: undefined }]);
  assert.equal(app.ui.inputHandlers.size, 0);
  assert.equal(app.ui.input(shortcut), false);
  assert.equal(handler(shortcut), undefined);
  // A failed host removal can leave a stale rendered widget, but never an active controller.
  assert.equal(app.ui.components.get(WIDGET_KEY), previous);
  app.external.children[0]!.emit("error", new Error("SENSITIVE_LATE_ERROR"));
  await flushPromises();
  assert.equal(app.external.calls.length, 1);
  assert.equal(app.external.files.get(app.path), "printf 'first full command'");
  assert.deepEqual(app.ui.notifications, []);
});

test("input registration errors do not escape and reentrant or throwing cleanup remains idempotent", (t) => {
  const ui = new MockUi();
  const external = new MockExternalViewer();
  const subscribe = ui.ui.onTerminalInput;
  let cleanupCalls = 0;
  ui.ui.onTerminalInput = (handler) => {
    const unsubscribe = subscribe(handler);
    return () => {
      cleanupCalls++;
      assert.equal(handler(shortcut), undefined);
      unsubscribe();
      throw new Error("SENSITIVE_UNSUBSCRIBE_ERROR");
    };
  };
  const controller = createWidgetController(ui.ui, "session", DEFAULT_CONFIG.externalViewer, external.dependencies);
  t.after(() => { controller.dispose(); external.close(); });
  controller.dispose();
  controller.dispose();
  assert.equal(cleanupCalls, 1);
  ui.ui.onTerminalInput = () => { throw new Error("SENSITIVE_INPUT_ERROR"); };
  const failed = createWidgetController(ui.ui, "failed", DEFAULT_CONFIG.externalViewer, external.dependencies);
  t.after(failed.dispose);
  assert.deepEqual(ui.notifications, [{
    message: "[bash-cmd-checker] Failed to register external viewer input handling.", type: "error",
  }]);
  failed.show(record());
  assert.equal(ui.input(shortcut), false);
  assert.equal(external.calls.length, 0);
});
