import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandAnalyzer, Config, ConfigLoadResult, ServiceAccessor } from "./types.ts";

export type TuiInitializer = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<() => void>;

export interface TuiDependencies {
  loadConfig(): Promise<ConfigLoadResult>;
  loadAccessor(): Promise<ServiceAccessor>;
  createAnalyzer(ctx: ExtensionContext, config: Config): CommandAnalyzer;
  attachPermissions: typeof import("./permissions.ts").attachPermissions;
}

function notify(ctx: ExtensionContext, message: string): void {
  try { ctx.ui.notify(`[bash-cmd-checker] ${message}`, "warning"); } catch {}
}

/** Factory-time registration is limited to mode detection; non-TUI sessions never load feature modules. */
export function registerLifecycle(pi: ExtensionAPI, initialize: TuiInitializer): void {
  let stop: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    stop?.();
    if (ctx.mode !== "tui") return;
    const controller = new AbortController();
    let cleanup: (() => void) | undefined;
    let closed = false;
    const stopGeneration = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      try { cleanup?.(); } catch {} finally {
        cleanup = undefined;
        unsubscribeShutdown();
        if (stop === stopGeneration) stop = undefined;
      }
    };
    const unsubscribeShutdown = pi.on("session_shutdown", stopGeneration);
    stop = stopGeneration;
    try {
      const dispose = await initialize(pi, ctx, controller.signal);
      if (controller.signal.aborted) dispose();
      else cleanup = dispose;
    } catch {
      if (!controller.signal.aborted) {
        notify(ctx, "Initialization failed; checker disabled.");
      }
      stopGeneration();
    }
  });
}

/** Initialization is session-scoped and cancellation is checked after every awaited boundary. */
export async function initializeTui(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal,
  dependencies: TuiDependencies,
): Promise<() => void> {
  const noop = (): void => {};
  if (signal.aborted || ctx.mode !== "tui") return noop;
  let loaded: ConfigLoadResult;
  try { loaded = await dependencies.loadConfig(); } catch {
    if (!signal.aborted) notify(ctx, "Configuration could not be loaded; checker disabled.");
    return noop;
  }
  if (signal.aborted) return noop;
  if (loaded.status === "invalid" || loaded.status === "unreadable") {
    notify(ctx, "Invalid or unreadable configuration; checker disabled.");
    return noop;
  }
  let getService: ServiceAccessor;
  try { getService = await dependencies.loadAccessor(); } catch {
    if (!signal.aborted) notify(ctx, "Permission package could not be imported; checker disabled.");
    return noop;
  }
  if (signal.aborted) return noop;
  const analyzer = dependencies.createAnalyzer(ctx, loaded.config);
  return dependencies.attachPermissions(pi, ctx, loaded.config, getService, analyzer, signal).dispose;
}
