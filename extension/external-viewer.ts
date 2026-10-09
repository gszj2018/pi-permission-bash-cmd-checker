import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExternalViewerConfig } from "./types.ts";
import { isNonBlankString, isRecord } from "./utils.ts";

export const VIEWER_BASE_DIRECTORY = "pi-permission-bash-cmd-checker";
// Direct create/truncate, with final symlink protection where the platform supports O_NOFOLLOW.
const COMMAND_FILE_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

interface FileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ViewerFileSystem {
  lstatSync(path: string): FileInfo;
  mkdirSync(path: string, options: { recursive: true; mode: number }): void;
  openSync(path: string, flags: number, mode: number): number;
  writeFileSync(fd: number, text: string, encoding: "utf8"): void;
  closeSync(fd: number): void;
}

export interface ViewerFileDependencies {
  readonly fileSystem: ViewerFileSystem;
  temporaryDirectory(): string;
}

export function commandFileName(sessionId: string): string {
  if (!isNonBlankString(sessionId)) throw new Error("Session identity unavailable.");
  const token = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId
    : `sha256.${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
  return `command-${token}.sh`;
}

export function commandFilePath(sessionId: string, directory: string | null, temporaryDirectory: () => string): string {
  const selectedDirectory = directory ?? join(temporaryDirectory(), VIEWER_BASE_DIRECTORY);
  // Portable config paths must also be native absolute paths before touching the filesystem.
  if (!isAbsolute(selectedDirectory) || selectedDirectory.includes("\u0000")) {
    throw new Error("An absolute command directory is required.");
  }
  return join(resolve(selectedDirectory), commandFileName(sessionId));
}

function existingInfo(fileSystem: ViewerFileSystem, path: string): FileInfo | undefined {
  try { return fileSystem.lstatSync(path); } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function checkDirectory(info: FileInfo | undefined): void {
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error("Unsafe command directory.");
}

function checkTarget(info: FileInfo | undefined): void {
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error("Unsafe command file.");
}

/** Synchronously truncate and write the exact command. Failed writes can leave an empty or partial file. */
export function prepareCommandFile(
  sessionId: string,
  directory: string | null,
  fullCommand: string,
  dependencies: ViewerFileDependencies,
): string {
  const { fileSystem } = dependencies;
  const path = commandFilePath(sessionId, directory, dependencies.temporaryDirectory);
  // Use the already resolved file path instead of asking a potentially changing temporary-directory port twice.
  const baseDirectory = dirname(path);
  if (directory === null) checkDirectory(existingInfo(fileSystem, baseDirectory));
  fileSystem.mkdirSync(baseDirectory, { recursive: true, mode: 0o700 });
  if (directory === null) checkDirectory(existingInfo(fileSystem, baseDirectory));
  checkTarget(existingInfo(fileSystem, path));
  let fd: number | undefined;
  try {
    fd = fileSystem.openSync(path, COMMAND_FILE_WRITE_FLAGS, 0o600);
    fileSystem.writeFileSync(fd, fullCommand, "utf8");
    fileSystem.closeSync(fd);
    fd = undefined;
    return path;
  } finally {
    if (fd !== undefined) { try { fileSystem.closeSync(fd); } catch {} }
  }
}

export interface DetachedViewerProcess {
  on(event: "error", handler: (error: Error) => void): unknown;
  once(event: "spawn" | "close", handler: () => void): unknown;
  removeListener(event: "error", handler: (error: Error) => void): unknown;
  removeListener(event: "spawn", handler: () => void): unknown;
  unref(): void;
}

export interface ViewerProcessDependencies {
  spawn(command: string, args: readonly string[], options: {
    shell: false; detached: true; stdio: "ignore";
  }): DetachedViewerProcess;
  spawnSync(command: string, args: readonly string[], options: {
    shell: false; stdio: "inherit";
  }): { status: number | null; signal: string | null; error?: Error };
  writeTerminal(text: string): void;
}

export type ViewerLaunchResult = "started" | "completed" | "failed" | "terminal-failed" | "unconfigured";

type ViewerUi = Pick<ExtensionUIContext, "custom">;

function launchDetached(
  command: string,
  args: readonly string[],
  dependencies: ViewerProcessDependencies,
): Promise<ViewerLaunchResult> {
  return new Promise((resolveResult) => {
    let child: DetachedViewerProcess;
    try { child = dependencies.spawn(command, args, { shell: false, detached: true, stdio: "ignore" }); } catch {
      resolveResult("failed");
      return;
    }
    const onError = (): void => { resolveResult("failed"); };
    const onSpawn = (): void => {
      try { child.unref(); resolveResult("started"); } catch { onError(); }
    };
    // Consume late errors until close; resolving an already settled Promise does not change its startup result.
    child.on("error", onError);
    child.once("spawn", onSpawn);
    child.once("close", () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
      onError();
    });
  });
}

async function launchWait(
  ui: ViewerUi,
  command: string,
  args: readonly string[],
  dependencies: ViewerProcessDependencies,
): Promise<ViewerLaunchResult> {
  try {
    return await ui.custom<ViewerLaunchResult>((tui, _theme, _keys, done) => {
      let result: ViewerLaunchResult = "failed";
      try {
        tui.stop();
        dependencies.writeTerminal("\u001b[2J\u001b[H");
        try {
          const exit = dependencies.spawnSync(command, args, { shell: false, stdio: "inherit" });
          result = !exit.error && exit.status === 0 && exit.signal === null ? "completed" : "failed";
        } catch { result = "failed"; }
      } catch { result = "terminal-failed"; } finally {
        // Attempt both restoration steps independently; a start failure must not skip the render or completion.
        try { tui.start(); } catch { result = "terminal-failed"; }
        try { tui.requestRender(true); } catch { result = "terminal-failed"; }
        done(result);
      }
      // Synchronous done prevents mounting this empty component or replacing any permission overlay.
      return { render: () => [], invalidate() {} };
    });
  } catch { return "terminal-failed"; }
}

/** Launch only the configured executable. File contents are never interpreted by this module as a command. */
export async function launchExternalViewer(
  ui: ViewerUi,
  config: ExternalViewerConfig,
  absoluteCommandFile: string,
  dependencies: ViewerProcessDependencies,
): Promise<ViewerLaunchResult> {
  if (config.command === null) return "unconfigured";
  if (!isAbsolute(absoluteCommandFile) || absoluteCommandFile.includes("\u0000")) return "failed";
  const args = [...config.args, absoluteCommandFile];
  return config.mode === "detach"
    ? launchDetached(config.command, args, dependencies)
    : launchWait(ui, config.command, args, dependencies);
}
