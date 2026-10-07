import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import { initializeTui, registerLifecycle } from "../extension/lifecycle.ts";
import { SessionState } from "../extension/state.ts";
import { MockPi, createContext, deferred, flushPromises, unavailableAnalyzer } from "./helpers/mocks.ts";

test("lifecycle does not initialize features in non-TUI modes, even when RPC reports hasUI", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const pi = new MockPi();
    const { ctx, ui } = createContext("headless", mode);
    let initialized = 0;
    registerLifecycle(pi.api, async () => { initialized++; return () => {}; });
    await pi.emitLifecycle("session_start", ctx);
    assert.equal(initialized, 0, mode);
    assert.equal(pi.count("session_shutdown"), 0, mode);
    assert.equal(pi.events.size, 0, mode);
    assert.equal(ui.mounts.length, 0, mode);
    assert.equal(ui.notifications.length, 0, mode);
  }
});

test("TUI initialization forwards explicit dependencies to the injected permission attacher", async () => {
  const pi = new MockPi();
  const { ctx, ui } = createContext();
  const controller = new AbortController();
  const state = new SessionState();
  const accessor = () => undefined;
  const analyzer = unavailableAnalyzer;
  let attached = 0;
  let disposed = 0;
  const cleanup = await initializeTui(pi.api, ctx, controller.signal, {
    loadConfig: async () => ({ status: "loaded", config: DEFAULT_CONFIG }),
    loadAccessor: async () => accessor,
    createAnalyzer(context, config) {
      assert.equal(context, ctx);
      assert.equal(config, DEFAULT_CONFIG);
      return analyzer;
    },
    attachPermissions(api, context, config, getService, analyze, signal) {
      attached++;
      assert.equal(api, pi.api);
      assert.equal(context, ctx);
      assert.equal(config, DEFAULT_CONFIG);
      assert.equal(getService, accessor);
      assert.equal(analyze, analyzer);
      assert.equal(signal, controller.signal);
      return { state, dispose: () => { disposed++; state.close(); } };
    },
  });
  assert.equal(attached, 1);
  assert.equal(pi.events.size, 0);
  assert.equal(ui.mounts.length, 0);
  cleanup();
  assert.equal(disposed, 1);
  assert.equal(state.active, false);
});

test("new, resume, fork and reload replace the generation and unsubscribe old shutdown handlers", async () => {
  const pi = new MockPi();
  const signals: AbortSignal[] = [];
  let disposed = 0;
  registerLifecycle(pi.api, async (_pi, _ctx, signal) => {
    signals.push(signal);
    return () => { disposed++; };
  });
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    const { ctx } = createContext(`session-${signals.length}`);
    await pi.emitLifecycle("session_start", ctx, reason);
    assert.equal(pi.count("session_shutdown"), 1);
    assert.equal(disposed, signals.length - 1);
  }
  for (const signal of signals.slice(0, -1)) assert.equal(signal.aborted, true);
  const { ctx } = createContext();
  await pi.emitLifecycle("session_shutdown", ctx, "quit");
  await pi.emitLifecycle("session_shutdown", ctx, "quit");
  assert.equal(disposed, signals.length);
  assert.equal(pi.count("session_shutdown"), 0);
});

test("shutdown during async initialization discards late capabilities without notifying a stale UI", async () => {
  const pi = new MockPi();
  const { ctx, ui } = createContext();
  const pending = deferred<() => void>();
  let signal: AbortSignal | undefined;
  let disposed = 0;
  registerLifecycle(pi.api, async (_pi, _ctx, captured) => { signal = captured; return pending.promise; });
  const startup = pi.emitLifecycle("session_start", ctx);
  await flushPromises();
  await pi.emitLifecycle("session_shutdown", ctx, "reload");
  assert.equal(signal?.aborted, true);
  pending.resolve(() => { disposed++; });
  await startup;
  assert.equal(disposed, 1);
  assert.equal(pi.count("session_shutdown"), 0);
  assert.equal(ui.notifications.length, 0);
});

test("reentrant starts do not let old initializers become the new generation's cleanup", async () => {
  const pi = new MockPi();
  const first = deferred<() => void>();
  const second = deferred<() => void>();
  let calls = 0;
  const released: string[] = [];
  registerLifecycle(pi.api, async () => (++calls === 1 ? first.promise : second.promise));
  const start1 = pi.emitLifecycle("session_start", createContext("session-1").ctx);
  const start2 = pi.emitLifecycle("session_start", createContext("session-2").ctx, "new");
  second.resolve(() => { released.push("second"); });
  await start2;
  first.resolve(() => { released.push("first"); });
  await start1;
  assert.deepEqual(released, ["first"]);
  assert.equal(pi.count("session_shutdown"), 1);
  await pi.emitLifecycle("session_shutdown", createContext("session-2").ctx, "quit");
  assert.deepEqual(released, ["first", "second"]);
});

test("initialization failure is reported once without raw details and cleanup remains idempotent", async () => {
  const pi = new MockPi();
  const { ctx, ui } = createContext();
  registerLifecycle(pi.api, async () => { throw new Error("SENSITIVE_FAILURE"); });
  await pi.emitLifecycle("session_start", ctx);
  assert.equal(pi.count("session_shutdown"), 0);
  assert.equal(ui.notifications.length, 1);
  assert.equal(ui.notifications[0]?.message.includes("SENSITIVE_FAILURE"), false);
  assert.equal(ui.notifications[0]?.type, "error");
});

test("a thrown config loader reports an error without continuing initialization", async () => {
  const pi = new MockPi();
  const { ctx, ui } = createContext();
  const cleanup = await initializeTui(pi.api, ctx, new AbortController().signal, {
    loadConfig: async () => { throw new Error("SENSITIVE_CONFIG_ERROR"); },
    loadAccessor: async () => { assert.fail("Must not load the accessor after config failure."); },
    createAnalyzer: () => { assert.fail("Must not create an analyzer after config failure."); },
    attachPermissions: () => { assert.fail("Must not attach after config failure."); },
  });
  cleanup();
  assert.deepEqual(ui.notifications, [{
    message: "[bash-cmd-checker] Configuration could not be loaded; checker disabled.", type: "error",
  }]);
});
