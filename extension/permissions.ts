import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Authorizer, AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import { extractCommandObservation } from "./command.ts";
import { SessionState } from "./state.ts";
import type {
  AnalysisTask, ClassificationResult, CommandAnalyzer, Config, ExternalViewerDependencies, PermissionRuntime,
  ServiceAccessor, SessionStateContract,
} from "./types.ts";
import { notifyError, notifyWarning } from "./utils-pi.ts";
import { isNonBlankString, isRecord } from "./utils.ts";
import { createWidgetController } from "./widget.ts";

export const AUTHORIZER_NAME = "bash-cmd-checker";

/** Attach synchronously after configuration and the accessor have loaded. No event callback imports modules. */
export function attachPermissions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: Config,
  getService: ServiceAccessor,
  analyzer: CommandAnalyzer,
  viewerDependencies: ExternalViewerDependencies,
  signal?: AbortSignal,
): PermissionRuntime {
  const state: SessionStateContract = new SessionState();
  const inert = (): PermissionRuntime => { state.close(); return { state, dispose() {} }; };
  if (signal?.aborted || ctx.mode !== "tui") return inert();
  const sessionId = ctx.sessionManager.getSessionId();
  if (!isNonBlankString(sessionId)) {
    notifyWarning(ctx.ui, "Session identity unavailable; checker disabled.");
    return inert();
  }
  const widget = createWidgetController(
    ctx.ui, sessionId, config.externalViewer, viewerDependencies, config.widget.commandViewerShortcut,
  );
  const tasks = new Map<string, { controller: AbortController; verdict: Promise<AuthorizerVerdict> }>();
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
      if (state.active) notifyError(ctx.ui, "Failed to update the command widget.");
    }
  };

  const authorize: Authorizer["authorize"] = async (details) => {
    if (!state.active) return { kind: "defer" };
    const observation = extractCommandObservation(details);
    if (!observation) return { kind: "defer" };
    const pending = tasks.get(observation.requestId);
    if (pending) return pending.verdict;
    const existing = state.get(observation.requestId);
    if (existing) return existing.verdict;
    const record = state.observe(observation, config.classifier.model === null);
    if (!record) return { kind: "defer" };
    // The command is displayed as soon as it enters the checker, before classification starts.
    state.show(observation.requestId);
    refresh();
    if (!state.active) return { kind: "defer" };
    const controller = new AbortController();
    const publish: Parameters<CommandAnalyzer>[2] = (update) => {
      if (controller.signal.aborted || !state.publish(record, update)) return;
      if (state.visible?.observation === record.observation) refresh();
    };
    let resolveVerdict!: (value: AuthorizerVerdict) => void;
    const verdict = new Promise<AuthorizerVerdict>((resolve) => { resolveVerdict = resolve; });
    let settled = false;
    const finish = (classification: ClassificationResult): void => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener("abort", cancel);
      if (controller.signal.aborted || !state.active) { resolveVerdict({ kind: "defer" }); return; }
      publish({ kind: "classification", value: classification });
      const result = state.get(observation.requestId)?.classification;
      const decision: AuthorizerVerdict = config.autoBlockUnsafe && result?.status === "complete"
        && result.risk === "unsafe"
        ? { kind: "deny", reason: "Bash command blocked by the configured unsafe-risk policy." }
        : { kind: "defer" };
      if (state.settleVerdict(record, decision)) {
        // Missing permission prompts still track the settled verdict; automatic denial never re-shows a covered widget.
        if (state.visible?.observation === record.observation) refresh();
        if (decision.kind === "deny") notifyWarning(ctx.ui, "Blocked a bash command assessed as dangerous.");
      }
      resolveVerdict(decision);
    };
    const cancel = (): void => { finish({ status: "unavailable" }); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const entry = { controller, verdict };
    // Reserve the request before starting adapters, including any synchronous/reentrant work.
    tasks.set(observation.requestId, entry);
    let task: AnalysisTask;
    try {
      task = analyzer(record.observation, controller.signal, publish);
    } catch {
      publish({ kind: "explanation", value: { status: "unavailable" } });
      finish({ status: "failed" });
      tasks.delete(observation.requestId);
      return verdict;
    }
    void task.classification.then(finish, () => { finish({ status: "failed" }); });
    const done = task.done.then(
      () => { publish({ kind: "explanation", value: { status: "unavailable" } }); },
      () => { publish({ kind: "explanation", value: { status: "unavailable" } }); },
    );
    // Only cleanup joins both tasks; authorization waits exclusively for the classification verdict.
    void Promise.all([verdict, done]).then(() => {
      if (tasks.get(observation.requestId) === entry) tasks.delete(observation.requestId);
    });
    return verdict;
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
        notifyError(ctx.ui, "Authorizer registration failed; check for duplicate loading or a conflicting name.");
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
    for (const { controller } of tasks.values()) controller.abort();
    tasks.clear();
    try { widget.dispose(); } catch {}
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
    if (signal?.aborted) dispose();
    else bind();
    return { state, dispose };
  } catch {
    dispose();
    notifyError(ctx.ui, "Permission event setup failed; checker disabled.");
    return { state, dispose };
  }
}
