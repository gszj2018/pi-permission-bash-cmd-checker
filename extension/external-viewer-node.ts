import { spawn, spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ViewerFileDependencies, ViewerProcessDependencies } from "./types.ts";

/** Only function references are assembled here; importing the module performs no filesystem operations. */
export const nodeViewerFileDependencies: ViewerFileDependencies = {
  fileSystem: {
    lstatSync,
    mkdirSync: (path, options) => { mkdirSync(path, options); },
    openSync,
    writeFileSync,
    closeSync,
  },
  temporaryDirectory: tmpdir,
};

/** These adapters are inert until explicitly called by a user-triggered operation. */
export const nodeViewerProcessDependencies: ViewerProcessDependencies = {
  spawn: (command, args, options) => spawn(command, [...args], options),
  spawnSync: (command, args, options) => spawnSync(command, [...args], options),
  writeTerminal: (text) => { process.stdout.write(text); },
};
