import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import { initializeTui, registerLifecycle, type TuiDependencies } from "../extension/lifecycle.ts";
import { attachPermissions } from "../extension/permissions.ts";
import type { AnalysisUpdate, ClassificationResult, CommandAnalyzer } from "../extension/types.ts";
import { WIDGET_KEY } from "../extension/widget.ts";
import {
  MockPi, MockService, commandDetails, createContext, deferred, flushPromises,
  mockBackgroundAnalyzer, promptEvent, unavailableAnalyzer,
} from "./helpers/mocks.ts";

function setup(analyzer: CommandAnalyzer) {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  const lifetime = new AbortController();
  const runtime = attachPermissions(pi.api, ctx, DEFAULT_CONFIG, () => service.service, analyzer, lifetime.signal);
  return { pi, service, ctx, ui, lifetime, runtime };
}

function decision(requestId: string, result: "allow" | "deny" = "allow") {
  return { requestId, result, resolution: result === "allow" ? "user_approved" : "user_denied" };
}

test("deferred requests wait only for classification and display their command before the prompt", async (t) => {
  const pending = deferred<void>();
  let publish!: (update: AnalysisUpdate) => void;
  let signal!: AbortSignal;
  let starts = 0;
  const app = setup((_command, captured, update) => {
    starts++; publish = update; signal = captured;
    return { classification: Promise.resolve<ClassificationResult>({
      status: "complete", risk: "safe-ro", confidence: 0.9,
      probabilities: { "safe-ro": 0.9, "safe-rw": 0.05, unsafe: 0.05 },
    }), done: pending.promise };
  });
  t.after(app.runtime.dispose);
  const details = commandDetails();
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  await flushPromises();
  assert.equal(starts, 1);
  assert.equal(app.ui.components.size, 1);
  assert.ok(app.ui.text(WIDGET_KEY).includes("✅  Likely Safe (RO)"));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Awaiting approval"));
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  assert.equal(starts, 1);
  assert.equal(app.ui.mounts.length, 1);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  assert.ok(app.ui.text(WIDGET_KEY).includes(details.payload.evidence[0]!.text));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Analyzing command…"));
  assert.ok(app.ui.text(WIDGET_KEY).includes("✅  Likely Safe (RO)"));
  app.pi.events.emit("permissions:decision", decision(details.requestId));
  assert.equal(signal.aborted, false);
  assert.ok(app.ui.text(WIDGET_KEY).includes("Completed: allow"));
  publish({ kind: "explanation", value: { status: "complete", text: "Prints two values without writing files." } });
  pending.resolve();
  await flushPromises();
  assert.ok(app.ui.text(WIDGET_KEY).includes("Prints two values"));
  assert.ok(app.ui.text(WIDGET_KEY).includes("✅  Likely Safe (RO)"));
  assert.equal(app.runtime.state.size, 1);
});

test("old request completion cannot overwrite a newer prompt, and unsupported prompts hide stale advice", async (t) => {
  const jobs = new Map<string, { publish: (update: AnalysisUpdate) => void; done: ReturnType<typeof deferred<void>> }>();
  const app = setup(mockBackgroundAnalyzer(async (command, _signal, publish) => {
    const done = deferred<void>();
    jobs.set(command.requestId, { publish, done });
    return done.promise;
  }));
  t.after(app.runtime.dispose);
  const first = commandDetails("first");
  const second = commandDetails("second", "printf 'second complete command'");
  await app.service.run(first);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(first));
  app.pi.events.emit("permissions:decision", decision("first"));
  await app.service.run(second);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(second));
  jobs.get("first")!.publish({ kind: "explanation", value: { status: "complete", text: "Old explanation" } });
  jobs.get("first")!.done.resolve();
  await flushPromises();
  assert.ok(app.ui.text(WIDGET_KEY).includes("second complete command"));
  assert.equal(app.ui.text(WIDGET_KEY).includes("Old explanation"), false);
  app.pi.events.emit("permissions:decision", decision("unobserved", "deny"));
  assert.ok(app.ui.components.has(WIDGET_KEY));
  app.pi.events.emit("permissions:ui_prompt", { ...promptEvent(first), requestId: "unobserved" });
  assert.equal(app.ui.components.has(WIDGET_KEY), false);
  assert.equal(app.runtime.state.size, 2);
  jobs.get("second")!.done.resolve();
  await flushPromises();
  assert.equal(app.ui.components.has(WIDGET_KEY), false);
});

test("UI prompts associate by requestId only, without comparing event projections", async (t) => {
  const app = setup(unavailableAnalyzer);
  t.after(app.runtime.dispose);
  const details = commandDetails();
  await app.service.run(details);
  for (const raw of [
    { requestId: details.requestId },
    { requestId: details.requestId, request: null },
    { requestId: details.requestId, surface: "read", value: "different display value", request: {
      toolName: "read", invokedToolName: "alias", value: "different decision value",
    } },
  ]) {
    app.pi.events.emit("permissions:ui_prompt", raw);
    assert.ok(app.ui.text(WIDGET_KEY).includes(details.payload.evidence[0]!.text));
    assert.equal(app.runtime.state.visible?.observation.requestId, details.requestId);
  }
  app.pi.events.emit("permissions:ui_prompt", { requestId: "unobserved" });
  assert.equal(app.ui.components.has(WIDGET_KEY), false);
  assert.equal(app.runtime.state.size, 1);
});

test("forwarded evidence and child identity are shown by the serving TUI session", async (t) => {
  const app = setup(unavailableAnalyzer);
  t.after(app.runtime.dispose);
  const details = commandDetails();
  details.payload = {
    ...details.payload,
    request: { ...details.payload.request, requester: { forwarded: true, agentName: "Worker", sessionId: "child" } },
  };
  details.forwarding = { requesterAgentName: "Worker", requesterSessionId: "child" };
  await app.service.run(details);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Requester: Worker · Session: child"));
  assert.ok(app.ui.text(WIDGET_KEY).includes(details.payload.evidence[0]!.text));
});

test("ready is session-scoped, handles both load orders, and replaces services without duplicate registration", (t) => {
  const pi = new MockPi();
  const { ctx } = createContext();
  const first = new MockService();
  const second = new MockService();
  let available: MockService | undefined;
  const lookedUp: string[] = [];
  const runtime = attachPermissions(
    pi.api, ctx, DEFAULT_CONFIG, (id) => { lookedUp.push(id); return available?.service; }, unavailableAnalyzer,
  );
  t.after(runtime.dispose);
  pi.events.emit("permissions:ready", { sessionId: "other-session" });
  pi.events.emit("permissions:ready", null);
  assert.deepEqual(lookedUp, ["session-1"]);
  available = first;
  pi.events.emit("permissions:ready", { sessionId: "session-1" });
  pi.events.emit("permissions:ready", { sessionId: "session-1" });
  assert.deepEqual(first.names, ["bash-cmd-checker"]);
  available = second;
  pi.events.emit("permissions:ready", { sessionId: "session-1" });
  assert.equal(first.releases, 1);
  assert.deepEqual(second.names, ["bash-cmd-checker"]);
  runtime.dispose();
  assert.equal(second.releases, 1);
  assert.equal(pi.events.size, 0);
  const early = attachPermissions(pi.api, ctx, DEFAULT_CONFIG, () => first.service, unavailableAnalyzer);
  assert.equal(first.names.length, 2);
  early.dispose();
});

test("registration errors are contained and warnings do not expose raw exception details", () => {
  const pi = new MockPi();
  const { ctx, ui } = createContext();
  const runtime = attachPermissions(pi.api, ctx, DEFAULT_CONFIG, () => ({
    registerAuthorizer() { throw new Error("SENSITIVE_REGISTRATION_ERROR"); },
  }), unavailableAnalyzer);
  pi.events.emit("permissions:ready", { sessionId: "session-1" });
  assert.equal(ui.notifications.length, 1);
  assert.equal(ui.notifications[0]?.message.includes("SENSITIVE_REGISTRATION_ERROR"), false);
  runtime.dispose();
});

test("shutdown aborts in-flight work, clears the cache and suppresses late updates even with reused request IDs", async () => {
  const pending = deferred<void>();
  let publish!: (update: AnalysisUpdate) => void;
  let signal!: AbortSignal;
  const app = setup(mockBackgroundAnalyzer(async (_command, captured, update) => {
    publish = update; signal = captured; return pending.promise;
  }));
  const details = commandDetails();
  await app.service.run(details);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  app.lifetime.abort();
  assert.equal(signal.aborted, true);
  assert.equal(app.runtime.state.size, 0);
  assert.equal(app.ui.components.size, 0);
  assert.equal(app.pi.events.size, 0);
  const fresh = attachPermissions(app.pi.api, app.ctx, DEFAULT_CONFIG, () => app.service.service, unavailableAnalyzer);
  await app.service.run(details);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  publish({ kind: "explanation", value: { status: "complete", text: "Stale result" } });
  pending.resolve();
  await flushPromises();
  assert.equal(app.ui.text(WIDGET_KEY).includes("Stale result"), false);
  assert.equal(fresh.state.size, 1);
  fresh.dispose();
});

test("background errors and missing adapters fall back without blocking authorization or leaking errors", async (t) => {
  const app = setup(mockBackgroundAnalyzer(async () => { throw new Error("SENSITIVE_PROVIDER_ERROR"); }));
  t.after(app.runtime.dispose);
  const details = commandDetails();
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  await flushPromises();
  assert.ok(app.ui.text(WIDGET_KEY).includes("Risk assessment unavailable."));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Command explanation unavailable."));
  assert.equal(app.ui.text(WIDGET_KEY).includes("SENSITIVE_PROVIDER_ERROR"), false);
});

test("a synchronous analyzer failure settles once, defers and exposes no raw details", async (t) => {
  let calls = 0;
  const app = setup(() => { calls++; throw new Error("SENSITIVE_ANALYZER_ERROR"); });
  t.after(app.runtime.dispose);
  const details = commandDetails();
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  assert.equal(calls, 1);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Risk assessment failed."));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Command explanation unavailable."));
  assert.equal(app.ui.text(WIDGET_KEY).includes("SENSITIVE_ANALYZER_ERROR"), false);
  assert.equal(app.runtime.state.get(details.requestId)?.verdictSettled, true);
});

test("explicitly disabled classification remains yellow and defers even with auto-blocking enabled", async () => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  const config = { ...DEFAULT_CONFIG, classifier: { ...DEFAULT_CONFIG.classifier, model: null }, autoBlockUnsafe: true };
  const runtime = attachPermissions(pi.api, ctx, config, () => service.service, unavailableAnalyzer);
  const details = commandDetails();
  assert.deepEqual(await service.run(details), { kind: "defer" });
  await flushPromises();
  pi.events.emit("permissions:ui_prompt", promptEvent(details));
  assert.ok(ui.text(WIDGET_KEY).includes("Risk assessment disabled."));
  assert.equal(ui.text(WIDGET_KEY).includes("Risk assessment unavailable."), false);
  runtime.dispose();
});

test("permission events cannot change a viewer snapshot or close it when hiding the live widget", async (t) => {
  const jobs = new Map<string, { publish: (update: AnalysisUpdate) => void; done: ReturnType<typeof deferred<void>> }>();
  const app = setup(mockBackgroundAnalyzer(async (command, _signal, publish) => {
    const done = deferred<void>();
    jobs.set(command.requestId, { publish, done });
    return done.promise;
  }));
  t.after(() => { app.runtime.dispose(); for (const job of jobs.values()) job.done.resolve(); });
  const source = Array.from({ length: 40 }, (_, index) => `printf 'first-${index}'`).join("\n");
  const first = commandDetails("locked-first", source);
  assert.deepEqual(await app.service.run(first), { kind: "defer" });
  app.pi.events.emit("permissions:ui_prompt", promptEvent(first));
  assert.equal(app.runtime.state.get(first.requestId)?.observation.fullCommand, source);
  assert.equal(app.ui.text(WIDGET_KEY).includes("first-39"), false);
  app.ui.input("\u001bc");
  await flushPromises();
  app.ui.input("\u001b[F");
  const locked = app.ui.overlayText();
  assert.ok(locked.includes("first-39"));
  app.pi.events.emit("permissions:decision", decision(first.requestId));
  jobs.get(first.requestId)!.publish({ kind: "explanation", value: { status: "complete", text: "Later explanation." } });
  assert.equal(app.ui.overlayText(), locked);
  const second = commandDetails("live-second", "printf 'second command'");
  await app.service.run(second);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(second));
  assert.ok(app.ui.text(WIDGET_KEY).includes("second command"));
  assert.equal(app.ui.overlayText(), locked);
  app.pi.events.emit("permissions:ui_prompt", { requestId: "unobserved" });
  assert.equal(app.ui.components.size, 0);
  assert.equal(app.ui.overlays.length, 1);
  assert.equal(app.ui.overlayText(), locked);
  app.ui.input("\r");
  await flushPromises();
  assert.equal(app.ui.overlays.length, 0);
  assert.equal(app.ui.editorInputs.length, 0);
  assert.equal(app.runtime.state.get(first.requestId)?.decision?.result, "allow");
  app.pi.events.emit("permissions:ui_prompt", promptEvent(second));
  app.ui.input("\u001bc");
  await flushPromises();
  assert.ok(app.ui.overlayText().includes("second command"));
  app.lifetime.abort();
  await flushPromises();
  assert.equal(app.ui.overlays.length, 0);
  assert.equal(app.ui.inputHandlers.size, 0);
  assert.equal(app.runtime.state.active, false);
});

test("permission attachment injects the configured viewer shortcut and isolates UI failures", async (t) => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  const config = { ...DEFAULT_CONFIG, widget: { commandViewerShortcut: "alt+m" as const } };
  const runtime = attachPermissions(pi.api, ctx, config, () => service.service, unavailableAnalyzer);
  t.after(runtime.dispose);
  const details = commandDetails();
  assert.deepEqual(await service.run(details), { kind: "defer" });
  pi.events.emit("permissions:ui_prompt", promptEvent(details));
  ui.overlayError = new Error("SENSITIVE_VIEWER_ERROR");
  ui.input("\u001bm");
  await flushPromises();
  assert.equal(ui.overlays.length, 0);
  assert.deepEqual(await service.run(details), { kind: "defer" });
  assert.equal(JSON.stringify(ui.notifications).includes("SENSITIVE_VIEWER_ERROR"), false);
  ui.overlayError = undefined;
  ui.input("\u001bm");
  await flushPromises();
  assert.equal(ui.overlays.length, 1);
  assert.ok(ui.overlayText().includes("Alt+m Close"));
  runtime.dispose();
  await flushPromises();
  assert.equal(ui.inputHandlers.size, 0);
  assert.equal(ui.overlays.length, 0);
});

test("an input listener failure cannot disable an unsafe authorization verdict or its widget", async (t) => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  ui.ui.onTerminalInput = () => { throw new Error("SENSITIVE_INPUT_ERROR"); };
  const runtime = attachPermissions(pi.api, ctx, { ...DEFAULT_CONFIG, autoBlockUnsafe: true }, () => service.service,
    () => ({ classification: Promise.resolve<ClassificationResult>({
      status: "complete", risk: "unsafe", confidence: 1, probabilities: { "safe-ro": 0, "safe-rw": 0, unsafe: 1 },
    }), done: Promise.resolve() }));
  t.after(runtime.dispose);
  const result = await service.run(commandDetails());
  assert.equal(result.kind, "deny");
  assert.ok(ui.components.has(WIDGET_KEY));
  assert.equal(ui.inputHandlers.size, 0);
  assert.equal(JSON.stringify(ui.notifications).includes("SENSITIVE_INPUT_ERROR"), false);
});

test("widget failures cannot block the gate or escape a background update", async () => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  ui.ui.setWidget = () => { throw new Error("SENSITIVE_UI_ERROR"); };
  const runtime = attachPermissions(pi.api, ctx, DEFAULT_CONFIG, () => service.service, unavailableAnalyzer);
  const details = commandDetails();
  assert.deepEqual(await service.run(details), { kind: "defer" });
  assert.doesNotThrow(() => pi.events.emit("permissions:ui_prompt", promptEvent(details)));
  await flushPromises();
  assert.doesNotThrow(runtime.dispose);
  assert.equal(ui.notifications.length, 0);
});

test("malformed events and unsupported authorizer payloads cannot create command records", async (t) => {
  const app = setup(unavailableAnalyzer);
  t.after(app.runtime.dispose);
  const details = commandDetails();
  details.payload = { ...details.payload, kind: "path" };
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  for (const raw of [null, [], {}, { requestId: 1 }, { requestId: "unknown", request: null }]) {
    app.pi.events.emit("permissions:ui_prompt", raw);
    app.pi.events.emit("permissions:decision", raw);
  }
  assert.equal(app.runtime.state.size, 0);
  assert.equal(app.ui.components.size, 0);
});

test("session end-to-end cleanup is driven by lifecycle shutdown, not agent_end or tree navigation", async () => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  registerLifecycle(pi.api, (api, context, signal) => initializeTui(api, context, signal, {
    loadConfig: async () => ({ status: "loaded", config: DEFAULT_CONFIG }),
    loadAccessor: async () => () => service.service,
    createAnalyzer: () => unavailableAnalyzer,
    attachPermissions,
  }));
  await pi.emitLifecycle("session_start", ctx);
  const details = commandDetails();
  await service.run(details);
  pi.events.emit("permissions:ui_prompt", promptEvent(details));
  await pi.emitLifecycle("agent_end", ctx);
  await pi.emitLifecycle("session_tree", ctx);
  assert.ok(ui.components.has(WIDGET_KEY));
  ui.input("\u001bc");
  await flushPromises();
  assert.equal(ui.overlays.length, 1);
  await pi.emitLifecycle("session_shutdown", ctx, "new");
  await flushPromises();
  assert.equal(ui.components.size, 0);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.inputHandlers.size, 0);
  assert.equal(pi.events.size, 0);
  assert.equal(service.current, undefined);
});

test("session replacement and reload independently dispose the viewer and allow one new viewer", async (t) => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  registerLifecycle(pi.api, (api, context, signal) => initializeTui(api, context, signal, {
    loadConfig: async () => ({ status: "loaded", config: DEFAULT_CONFIG }),
    loadAccessor: async () => () => service.service,
    createAnalyzer: () => unavailableAnalyzer,
    attachPermissions,
  }));
  t.after(() => pi.emitLifecycle("session_shutdown", ctx, "quit"));
  let generation = 0;
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    await pi.emitLifecycle("session_start", ctx, reason);
    assert.equal(ui.overlays.length, 0, reason);
    assert.equal(ui.components.size, 0, reason);
    assert.equal(ui.inputHandlers.size, 1, reason);
    const details = commandDetails(`generation-${generation}`, `printf 'generation-${generation}'`);
    await service.run(details);
    pi.events.emit("permissions:ui_prompt", promptEvent(details));
    ui.input("\u001bc");
    assert.equal(ui.overlays.length, 1, reason);
    assert.ok(ui.overlayText().includes(`generation-${generation}`), reason);
    assert.equal(ui.overlayHistory.length, generation + 1, reason);
    assert.equal(ui.closeCalls, generation, reason);
    generation++;
  }
  await pi.emitLifecycle("session_shutdown", ctx, "quit");
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.components.size, 0);
  assert.equal(ui.inputHandlers.size, 0);
  assert.equal(ui.closeCalls, generation);
});

test("cancellation during viewer input registration releases the independent controller before binding", () => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  const lifetime = new AbortController();
  const subscribe = ui.ui.onTerminalInput;
  ui.ui.onTerminalInput = (handler) => {
    const unsubscribe = subscribe(handler);
    lifetime.abort();
    return unsubscribe;
  };
  const runtime = attachPermissions(pi.api, ctx, DEFAULT_CONFIG, () => service.service,
    unavailableAnalyzer, lifetime.signal);
  assert.equal(runtime.state.active, false);
  assert.equal(ui.inputHandlers.size, 0);
  assert.equal(pi.events.size, 0);
  assert.equal(service.names.length, 0);
  assert.equal(ui.overlays.length, 0);
  runtime.dispose();
});

test("TUI initialization and permission attachment remain inert in non-TUI modes", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const pi = new MockPi();
    const { ctx, ui } = createContext("headless", mode);
    const dependencies: TuiDependencies = {
      loadConfig: async () => { throw new Error("Must not read config."); },
      loadAccessor: async () => { throw new Error("Must not import the permission package."); },
      createAnalyzer: () => { throw new Error("Must not create an analyzer in a non-TUI session."); },
      attachPermissions: () => { throw new Error("Must not attach in a non-TUI session."); },
    };
    await initializeTui(pi.api, ctx, new AbortController().signal, dependencies);
    const runtime = attachPermissions(
      pi.api, ctx, DEFAULT_CONFIG, () => { throw new Error("Must not bind."); },
      () => { throw new Error("Must not analyze in a non-TUI session."); },
    );
    assert.equal(runtime.state.active, false, mode);
    assert.equal(pi.events.size, 0, mode);
    assert.equal(ui.notifications.length, 0, mode);
    assert.equal(ui.mounts.length, 0, mode);
    assert.equal(ui.inputHandlers.size, 0, mode);
    assert.equal(ui.overlayHistory.length, 0, mode);
  }
});

test("TUI initialization uses the explicitly supplied analysis dependency", async () => {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, ui } = createContext();
  let calls = 0;
  const dispose = await initializeTui(pi.api, ctx, new AbortController().signal, {
    loadConfig: async () => ({ status: "loaded", config: DEFAULT_CONFIG }),
    loadAccessor: async () => () => service.service,
    createAnalyzer: () => mockBackgroundAnalyzer(async (_command, _signal, publish) => {
      calls++;
      publish({ kind: "explanation", value: { status: "complete", text: "Injected explanation" } });
    }),
    attachPermissions,
  });
  const details = commandDetails();
  await service.run(details);
  pi.events.emit("permissions:ui_prompt", promptEvent(details));
  await flushPromises();
  assert.equal(calls, 1);
  assert.ok(ui.text(WIDGET_KEY).includes("Injected explanation"));
  dispose();
});

test("invalid config and missing dependency each produce only a fixed startup warning", async () => {
  for (const failure of ["config", "accessor"] as const) {
    const pi = new MockPi();
    const { ctx, ui } = createContext();
    await initializeTui(pi.api, ctx, new AbortController().signal, {
      loadConfig: async () => failure === "config"
        ? { status: "invalid", issues: ["SENSITIVE_CONFIG_ERROR"] } : { status: "loaded", config: DEFAULT_CONFIG },
      loadAccessor: async () => { throw new Error("SENSITIVE_IMPORT_ERROR"); },
      createAnalyzer: () => { throw new Error("Must not create an analyzer after initialization failure."); },
      attachPermissions: () => { throw new Error("Must not attach after initialization failure."); },
    });
    assert.equal(ui.notifications.length, 1);
    assert.equal(/SENSITIVE/.test(ui.notifications[0]!.message), false);
    assert.equal(pi.events.size, 0);
  }
});

test("shutdown across initialization awaits never binds a stale session or calls its UI", async () => {
  for (const boundary of ["config", "accessor"] as const) {
    const pi = new MockPi();
    const { ctx, ui } = createContext();
    const controller = new AbortController();
    const pending = deferred<void>();
    const initializing = initializeTui(pi.api, ctx, controller.signal, {
      loadConfig: async () => {
        if (boundary === "config") await pending.promise;
        return { status: "loaded", config: DEFAULT_CONFIG };
      },
      loadAccessor: async () => {
        if (boundary === "accessor") await pending.promise;
        return () => { throw new Error("Must not bind after shutdown."); };
      },
      createAnalyzer: () => { throw new Error("Must not create an analyzer after shutdown."); },
      attachPermissions: () => { throw new Error("Must not attach after shutdown."); },
    });
    await flushPromises();
    controller.abort();
    pending.resolve();
    const cleanup = await initializing;
    cleanup();
    assert.equal(pi.events.size, 0);
    assert.equal(ui.notifications.length, 0);
  }
});
