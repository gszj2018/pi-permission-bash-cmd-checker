import type {
  ExtensionAPI, ExtensionContext, ExtensionUIContext, KeybindingsManager, TerminalInputHandler, Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  Authorizer, AuthorizerLog, PermissionQuery, PermissionUiPromptEvent, PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
  isKeyRelease, styleText, stripTerminalSequences, type Component, type OverlayHandle,
  type TextStyle, type TUI,
} from "@earendil-works/pi-tui";
import type { AnalysisUpdate, CommandAnalyzer, CommandObservation, ServiceAccessor } from "../../extension/types.ts";

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
type DisposableComponent = Component & { dispose?(): void };
type CustomOptions = NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;
type CustomFactory<T> = (
  tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void,
) => DisposableComponent | Promise<DisposableComponent>;

export interface MockOverlay {
  readonly component: DisposableComponent;
  readonly handle: OverlayHandle;
  closed: boolean;
  hidden: boolean;
}

export class MockUi {
  currentTheme = mockTheme();
  readonly components = new Map<string, Component>();
  readonly notifications: { message: string; type?: string }[] = [];
  readonly mounts: { key: string; placement?: string; removed: boolean }[] = [];
  readonly inputHandlers = new Set<TerminalInputHandler>();
  readonly editorInputs: string[] = [];
  readonly overlays: MockOverlay[] = [];
  readonly terminalSteps: string[] = [];
  readonly tui: TUI;
  columns = 100;
  rows = 30;
  renders = 0;
  customCalls = 0;
  customMounts = 0;
  stopped = false;
  readonly ui: ExtensionUIContext;

  constructor() {
    const owner = this;
    const tui = {
      stop: () => { owner.stopped = true; owner.terminalSteps.push("stop"); },
      start: () => { owner.stopped = false; owner.terminalSteps.push("start"); },
      requestRender: (force?: boolean) => {
        owner.renders++;
        if (force) owner.terminalSteps.push("render");
      },
      showOverlay: (component: DisposableComponent) => owner.mountOverlay(component),
      terminal: {
        get columns() { return owner.columns; },
        get rows() { return owner.rows; },
      },
    } as unknown as TUI;
    this.tui = tui;
    this.ui = {
      get theme(): Theme { return owner.currentTheme; },
      notify: (message: string, type?: string) => { owner.notifications.push({ message, type }); },
      onTerminalInput: (handler: TerminalInputHandler) => {
        owner.inputHandlers.add(handler);
        return () => { owner.inputHandlers.delete(handler); };
      },
      setWidget: (key: string, content: string[] | WidgetFactory | undefined, options?: { placement?: string }) => {
        owner.mounts.push({ key, placement: options?.placement, removed: content === undefined });
        if (content === undefined) owner.components.delete(key);
        else if (typeof content === "function") owner.components.set(key, content(tui, owner.currentTheme));
        else throw new Error("Expected a non-interactive widget factory.");
      },
      custom: <T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> => {
        owner.customCalls++;
        return new Promise<T>((resolve, reject) => {
          let closed = false;
          let component: DisposableComponent | undefined;
          let handle: OverlayHandle | undefined;
          const done = (result: T): void => {
            if (closed) return;
            closed = true;
            // Synchronous done in a handoff factory has no mounted component and must not dismiss another dialog.
            handle?.hide();
            component?.dispose?.();
            resolve(result);
          };
          Promise.resolve(factory(tui, owner.currentTheme, {} as KeybindingsManager, done)).then((created) => {
            if (closed) return;
            component = created;
            owner.customMounts++;
            handle = owner.mountOverlay(component);
            options?.onHandle?.(handle);
          }).catch(reject);
        });
      },
    } as unknown as ExtensionUIContext;
  }

  private mountOverlay(component: DisposableComponent): OverlayHandle {
    const handle: OverlayHandle = {
      hide: () => {
        const index = this.overlays.indexOf(overlay);
        if (index < 0) return;
        this.overlays.splice(index, 1);
        overlay.closed = true;
      },
      setHidden: (hidden) => { overlay.hidden = hidden; },
      isHidden: () => overlay.hidden,
      focus() {},
      unfocus() {},
      isFocused: () => this.overlays.at(-1) === overlay,
      getBounds: () => undefined,
    };
    const overlay: MockOverlay = { component, handle, closed: false, hidden: false };
    this.overlays.push(overlay);
    return handle;
  }

  input(data: string): boolean {
    for (const handler of [...this.inputHandlers]) {
      const result = handler(data);
      if (result?.consume) return true;
      if (result?.data !== undefined) data = result.data;
    }
    if (isKeyRelease(data)) return true;
    const dialog = this.overlays.at(-1);
    if (dialog && !dialog.hidden) { dialog.component.handleInput?.(data); return true; }
    this.editorInputs.push(data);
    return false;
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
