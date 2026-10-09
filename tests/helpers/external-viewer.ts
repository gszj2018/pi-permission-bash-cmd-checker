import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import type {
  DetachedViewerProcess, ViewerFileDependencies, ViewerProcessDependencies,
} from "../../extension/external-viewer.ts";
import type { ExternalViewerDependencies } from "../../extension/widget.ts";

export class MockViewerProcess extends EventEmitter implements DetachedViewerProcess {
  unrefs = 0;
  unref(): void { this.unrefs++; }
}

/** Every path is virtual and every child is an EventEmitter; no production file or executable is touched. */
export class MockExternalViewer {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly handles = new Map<number, string>();
  readonly children: MockViewerProcess[] = [];
  readonly calls: {
    command: string; args: readonly string[]; mode: "detach" | "wait";
    options: Parameters<ViewerProcessDependencies["spawn"]>[2] | Parameters<ViewerProcessDependencies["spawnSync"]>[2];
  }[] = [];
  readonly steps: string[] = [];
  readonly root = resolve("mock-external-viewer-files");
  automaticSpawn = true;
  private nextFd = 0;

  readonly fileDependencies: ViewerFileDependencies = {
    temporaryDirectory: () => this.root,
    fileSystem: {
      lstatSync: (path) => {
        const directory = this.directories.has(path);
        if (!directory && !this.files.has(path)) throw Object.assign(new Error("MOCK_MISSING"), { code: "ENOENT" });
        return { isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false };
      },
      mkdirSync: (path) => { this.directories.add(path); },
      openSync: (path) => {
        if (!this.directories.has(dirname(path))) throw new Error("MOCK_DIRECTORY_MISSING");
        const fd = this.nextFd++;
        this.handles.set(fd, path);
        this.files.set(path, "");
        return fd;
      },
      writeFileSync: (fd, text) => {
        const path = this.handles.get(fd);
        if (!path) throw new Error("MOCK_DESCRIPTOR_MISSING");
        this.files.set(path, text);
      },
      closeSync: (fd) => { this.handles.delete(fd); },
    },
  };

  readonly processDependencies: ViewerProcessDependencies = {
    spawn: (command, args, options) => {
      this.calls.push({ command, args: [...args], mode: "detach", options });
      const child = new MockViewerProcess();
      this.children.push(child);
      if (this.automaticSpawn) queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    spawnSync: (command, args, options) => {
      this.steps.push("spawnSync");
      this.calls.push({ command, args: [...args], mode: "wait", options });
      return { status: 0, signal: null };
    },
    writeTerminal: () => { this.steps.push("clear"); },
  };

  readonly dependencies: ExternalViewerDependencies = {
    files: this.fileDependencies, processes: this.processDependencies,
  };

  close(): void { for (const child of this.children) child.emit("close"); }
}
