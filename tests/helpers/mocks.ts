import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type {
  Authorizer, AuthorizerLog, PermissionQuery, PermissionUiPromptEvent, PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { styleText, stripTerminalSequences, type Component, type TextStyle, type TUI } from "@earendil-works/pi-tui";
import type { ServiceAccessor } from "../../extension/permissions.ts";
import type { AnalysisUpdate, CommandAnalyzer, CommandObservation } from "../../extension/types.ts";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export type MockBackgroundWork = (
  command: CommandObservation, signal: AbortSignal, publish: (update: AnalysisUpdate) => void,
) => Promise<void>;

/** Event/lifecycle tests can keep explanation work pending while classification is unavailable. */
export function mockBackgroundAnalyzer(work: MockBackgroundWork): CommandAnalyzer {
  return (command, signal, publish) => ({
    classification: Promise.resolve({ status: "unavailable" }),
    done: Promise.resolve().then(() => {
      if (!signal.aborted) return work(command, signal, publish);
    }).catch(() => {
      if (!signal.aborted) publish({ kind: "explanation", value: { status: "unavailable" } });
    }),
  });
}

export const unavailableAnalyzer = mockBackgroundAnalyzer(async (_command, _signal, publish) => {
  publish({ kind: "explanation", value: { status: "unavailable" } });
});

/** Drain the deterministic promise chain used by the mock adapters; never sleep or start a timer. */
export async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

export class MockEvents {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  on(channel: string, handler: (data: unknown) => void): () => void {
    let entries = this.handlers.get(channel);
    if (!entries) { entries = new Set(); this.handlers.set(channel, entries); }
    entries.add(handler);
    const registered = entries;
    return () => { registered.delete(handler); };
  }
  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }
  get size(): number { return [...this.handlers.values()].reduce((sum, entries) => sum + entries.size, 0); }
}

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export class MockPi {
  readonly events = new MockEvents();
  readonly handlers = new Map<string, Set<LifecycleHandler>>();
  readonly api = {
    events: this.events,
    on: (event: string, handler: LifecycleHandler) => {
      let entries = this.handlers.get(event);
      if (!entries) { entries = new Set(); this.handlers.set(event, entries); }
      entries.add(handler);
      const registered = entries;
      return () => { registered.delete(handler); };
    },
  } as unknown as ExtensionAPI;

  async emitLifecycle(event: string, ctx: ExtensionContext, reason = "startup"): Promise<void> {
    for (const handler of [...(this.handlers.get(event) ?? [])]) await handler({ type: event, reason }, ctx);
  }
  count(event: string): number { return this.handlers.get(event)?.size ?? 0; }
}

export function mockTheme(appearance: "dark" | "light" = "dark"): Theme {
  return {
    appearance,
    style: (text: string, options: TextStyle) => styleText(text, options, "truecolor"),
  } as unknown as Theme;
}

type WidgetFactory = (tui: TUI, theme: Theme) => Component;

export class MockUi {
  currentTheme = mockTheme();
  readonly components = new Map<string, Component>();
  readonly notifications: { message: string; type?: string }[] = [];
  readonly mounts: { key: string; placement?: string; removed: boolean }[] = [];
  renders = 0;
  readonly ui: ExtensionUIContext;

  constructor() {
    const owner = this;
    this.ui = {
      get theme(): Theme { return owner.currentTheme; },
      notify: (message: string, type?: string) => { owner.notifications.push({ message, type }); },
      setWidget: (key: string, content: string[] | WidgetFactory | undefined, options?: { placement?: string }) => {
        owner.mounts.push({ key, placement: options?.placement, removed: content === undefined });
        if (content === undefined) owner.components.delete(key);
        else if (typeof content === "function") {
          const tui = { requestRender: () => { owner.renders++; } } as unknown as TUI;
          owner.components.set(key, content(tui, owner.currentTheme));
        } else throw new Error("Expected a non-interactive widget factory.");
      },
    } as unknown as ExtensionUIContext;
  }

  text(key: string, width = 200): string {
    return (this.components.get(key)?.render(width) ?? []).map(stripTerminalSequences).join("\n");
  }
}

export function createContext(sessionId = "session-1", mode: ExtensionContext["mode"] = "tui") {
  const ui = new MockUi();
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager: { getSessionId: () => sessionId },
    ui: ui.ui,
    get modelRegistry(): never { throw new Error("This mock context must not access real model APIs."); },
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

export class MockService {
  current: Authorizer["authorize"] | undefined;
  readonly names: string[] = [];
  releases = 0;
  readonly service: NonNullable<ReturnType<ServiceAccessor>> = {
    registerAuthorizer: (name, authorize) => {
      if (this.current) throw new Error("Duplicate authorizer registration.");
      this.names.push(name);
      this.current = authorize;
      return () => {
        if (this.current === authorize) { this.current = undefined; this.releases++; }
      };
    },
  };

  run(details: PromptPermissionDetails) {
    if (!this.current) throw new Error("No authorizer registered.");
    const query = new Proxy({} as PermissionQuery, { get() { throw new Error("Unexpected policy query."); } });
    const log = new Proxy({} as AuthorizerLog, { get() { throw new Error("Unexpected command logging."); } });
    return this.current(details, query, log);
  }
}

export function commandDetails(requestId = "request-1", fullCommand = "printf 'a' && printf 'b'"): PromptPermissionDetails {
  return {
    requestId,
    source: "tool_call",
    agentName: null,
    payload: {
      kind: "bash",
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "bash", toolName: "bash", invokedToolName: null, value: "printf 'b'",
        matchedPattern: "*", commandContext: null, executedUnit: null,
      },
      evidence: [{ label: "full command", text: fullCommand, detail: null }],
      annotations: [],
    },
  };
}

export function promptEvent(details: PromptPermissionDetails): PermissionUiPromptEvent {
  return {
    requestId: details.requestId, source: details.source, surface: "bash", value: details.payload.request.value,
    agentName: details.agentName, request: details.payload.request, forwarding: details.forwarding ?? null,
  };
}
