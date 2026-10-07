import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Authorizer, PermissionsService } from "@gotgenes/pi-permission-system";
import { extractCommandObservation } from "./command.ts";
import { SessionState } from "./state.ts";
import type { CommandAnalyzer, Config } from "./types.ts";
import { isNonBlankString, isRecord } from "./utils.ts";
import { createWidgetController } from "./widget.ts";

export const AUTHORIZER_NAME = "bash-cmd-checker";
export type ServiceAccessor = (sessionId: string) => Pick<PermissionsService, "registerAuthorizer"> | undefined;

export interface PermissionRuntime {
  readonly state: SessionState;
  dispose(): void;
}

/** Phase-two production fallback: no provider calls until the model adapters are implemented. */
export const unavailableAnalyzer: CommandAnalyzer = async (_command, _signal, publish) => {
  publish({ kind: "classification", value: { status: "unavailable" } });
  publish({ kind: "explanation", value: { status: "unavailable" } });
};

function notify(ctx: ExtensionContext, message: string): void {
  try { ctx.ui.notify(`[bash-cmd-checker] ${message}`, "warning"); } catch {}
}

/** Attach synchronously after configuration and the accessor have loaded. No event callback imports modules. */
export function attachPermissions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: Config,
  getService: ServiceAccessor,
  analyzer: CommandAnalyzer,
  signal?: AbortSignal,
): PermissionRuntime {
  const state = new SessionState();
  const inert = (): PermissionRuntime => { state.close(); return { state, dispose() {} }; };
  if (signal?.aborted || ctx.mode !== "tui") return inert();
  const sessionId = ctx.sessionManager.getSessionId();
  if (!isNonBlankString(sessionId)) {
    notify(ctx, "Session identity unavailable; checker disabled.");
    return inert();
  }
  const widget = createWidgetController(ctx.ui);
  const tasks = new Map<string, AbortController>();
  let boundService: ReturnType<ServiceAccessor>;
  let unregister: (() => void) | undefined;
  let warnedRegistration = false;
  const subscriptions: (() => void)[] = [];

  const refresh = (): void => {
    if (!state.active) return;
    try {
      const visible = state.visible;
      if (visible) widget.show(visible);
      else widget.hide();
    } catch {
      // Rendering cannot throw into the permission gate or expose the command via an error log.
    }
  };

  const authorize: Authorizer["authorize"] = async (details) => {
    if (!state.active) return { kind: "defer" };
    const observation = extractCommandObservation(details);
    if (!observation) return { kind: "defer" };
    const existing = state.get(observation.requestId);
    if (existing) return existing.verdict;
    const record = state.observe(observation, config.classifier.model === null);
    if (!record) return { kind: "defer" };
    const controller = new AbortController();
    tasks.set(observation.requestId, controller);
    const publish: Parameters<CommandAnalyzer>[2] = (update) => {
      if (controller.signal.aborted || !state.publish(record, update)) return;
      if (state.visible?.identity === record.identity) refresh();
    };
    // Detached work is owned by this session, not by the human dialog's lifetime.
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return analyzer(record.observation, controller.signal, publish);
    }).catch(() => {
      publish({ kind: "classification", value: { status: "failed" } });
      publish({ kind: "explanation", value: { status: "unavailable" } });
    }).finally(() => {
      // An adapter that completes without a result must not leave a permanent placeholder.
      publish({ kind: "classification", value: { status: "unavailable" } });
      publish({ kind: "explanation", value: { status: "unavailable" } });
      if (tasks.get(observation.requestId) === controller) tasks.delete(observation.requestId);
    });
    // Classification arbitration and auto-deny are deliberately deferred to phase three.
    return record.verdict;
  };

  const releaseAuthorizer = (): void => {
    try { unregister?.(); } catch {}
    unregister = undefined;
    boundService = undefined;
  };
  const bind = (): void => {
    if (!state.active) return;
    try {
      const service = getService(sessionId);
      if (service === boundService && unregister) return;
      releaseAuthorizer();
      if (!service) return;
      unregister = service.registerAuthorizer(AUTHORIZER_NAME, authorize);
      boundService = service;
    } catch {
      releaseAuthorizer();
      if (!warnedRegistration) {
        warnedRegistration = true;
        notify(ctx, "Authorizer registration failed; check for duplicate loading or a conflicting name.");
      }
    }
  };

  const dispose = (): void => {
    if (!state.active) return;
    state.close();
    signal?.removeEventListener("abort", dispose);
    for (const unsubscribe of subscriptions) { try { unsubscribe(); } catch {} }
    subscriptions.length = 0;
    releaseAuthorizer();
    for (const controller of tasks.values()) controller.abort();
    tasks.clear();
    try { widget.hide(); } catch {}
  };

  try {
    subscriptions.push(pi.events.on("permissions:ready", (raw) => {
      if (isRecord(raw) && raw.sessionId === sessionId) bind();
    }));
    subscriptions.push(pi.events.on("permissions:ui_prompt", (raw) => {
      if (!state.active || !isRecord(raw) || !isNonBlankString(raw.requestId)) return;
      state.show(raw.requestId);
      refresh();
    }));
    subscriptions.push(pi.events.on("permissions:decision", (raw) => {
      if (!state.active || !isRecord(raw) || !isNonBlankString(raw.requestId)
        || (raw.result !== "allow" && raw.result !== "deny") || !isNonBlankString(raw.resolution)) return;
      if (state.decide(raw.requestId, { result: raw.result, resolution: raw.resolution })
        && state.visible?.observation.requestId === raw.requestId) refresh();
    }));
    signal?.addEventListener("abort", dispose, { once: true });
    bind();
    return { state, dispose };
  } catch {
    dispose();
    notify(ctx, "Permission event setup failed; checker disabled.");
    return { state, dispose };
  }
}
