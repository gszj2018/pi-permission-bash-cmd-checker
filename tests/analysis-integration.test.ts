import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import { attachPermissions } from "../extension/permissions.ts";
import type { Config } from "../extension/types.ts";
import { WIDGET_KEY } from "../extension/widget.ts";
import { MockPi, MockService, commandDetails, deferred, flushPromises, promptEvent } from "./helpers/mocks.ts";
import { createModelContext, explanationResponse, MockClock, modelAnalyzer, riskResponse } from "./helpers/models.ts";

function setup(config: Config = DEFAULT_CONFIG) {
  const pi = new MockPi();
  const service = new MockService();
  const { ctx, models, ui } = createModelContext();
  const clock = new MockClock();
  const runtime = attachPermissions(pi.api, ctx, config, () => service.service, modelAnalyzer(ctx, config, clock));
  return { pi, service, ctx, models, ui, clock, runtime };
}

const blockingConfig = { ...DEFAULT_CONFIG, autoBlockUnsafe: true };

test("the gate waits for classification, deduplicates pending requests and never waits for the LLM", async (t) => {
  const app = setup();
  t.after(app.runtime.dispose);
  const classifier = deferred<unknown>();
  const explanation = deferred<unknown>();
  app.models.classifierResult = () => classifier.promise;
  app.models.llmResult = () => explanation.promise;
  const details = commandDetails();
  const first = app.service.run(details);
  const duplicate = app.service.run(details);
  let settled = false;
  void first.then(() => { settled = true; });
  await flushPromises();
  assert.equal(settled, false);
  assert.equal(app.models.classifications.length, 1);
  assert.equal(app.models.streams.length, 1);
  assert.equal(app.ui.mounts.length, 0);
  classifier.resolve(riskResponse());
  assert.deepEqual(await first, { kind: "defer" });
  assert.deepEqual(await duplicate, { kind: "defer" });
  assert.equal(app.runtime.state.get(details.requestId)?.explanation.status, "pending");
  assert.equal(app.runtime.state.get(details.requestId)?.verdictSettled, true);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
  assert.ok(app.ui.text(WIDGET_KEY).includes("✅  Likely Safe (RO)"));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Analyzing command…"));
  app.pi.events.emit("permissions:decision", { requestId: details.requestId, result: "allow", resolution: "user_approved" });
  explanation.resolve(explanationResponse("Late explanation after approval."));
  await flushPromises();
  assert.ok(app.ui.text(WIDGET_KEY).includes("Late explanation after approval."));
  assert.deepEqual(await app.service.run(details), { kind: "defer" });
  assert.equal(app.models.classifications.length, 1);
  assert.equal(app.clock.pending, 0);
});

test("auto-blocking denies only a validated threshold-unsafe response when explicitly enabled, never allows", async (t) => {
  const cases: [unknown, boolean][] = [
    [riskResponse(), false],
    [{ stopReason: "stop", answers: { risk: {
      type: "choice", choice: "safe-rw", confidence: 0.9,
      probabilities: { "safe-ro": 0.05, "safe-rw": 0.9, unsafe: 0.05 },
    } } }, false],
    [riskResponse(1, 0.1), false],
    [riskResponse(0.3), true],
    [{ stopReason: "stop", answers: {} }, false],
    [{ stopReason: "error", errorMessage: "SENSITIVE_PROVIDER_ERROR" }, false],
  ];
  for (const autoBlockUnsafe of [false, true]) {
    for (const [response, dangerous] of cases) {
      const app = setup({ ...DEFAULT_CONFIG, autoBlockUnsafe });
      t.after(app.runtime.dispose);
      app.models.classifierResult = async () => response;
      const details = commandDetails();
      const verdict = await app.service.run(details);
      assert.equal(verdict.kind, autoBlockUnsafe && dangerous ? "deny" : "defer");
      assert.equal(app.ui.notifications.length, autoBlockUnsafe && dangerous ? 1 : 0);
      assert.deepEqual(app.runtime.state.get(details.requestId)?.verdict, verdict);
      assert.equal(app.ui.mounts.length, verdict.kind === "deny" ? 1 : 0);
      if (verdict.kind === "deny") {
        assert.ok(app.ui.text(WIDGET_KEY).includes("⛔  Dangerous"));
        assert.ok(app.ui.text(WIDGET_KEY).includes("Prints two values."));
        assert.equal(verdict.reason, "Bash command blocked by the configured unsafe-risk policy.");
        assert.equal(verdict.reason.includes(details.payload.evidence[0]!.text), false);
      }
    }
  }
});

test("automatic denial shows its widget, keeps late explanations and notifies once per request", async (t) => {
  const app = setup(blockingConfig);
  t.after(app.runtime.dispose);
  const first = commandDetails("visible", "printf 'visible command'");
  await app.service.run(first);
  app.pi.events.emit("permissions:ui_prompt", promptEvent(first));
  const mounts = app.ui.mounts.length;
  const explanation = deferred<unknown>();
  app.models.llmResult = () => explanation.promise;
  app.models.classifierResult = async () => riskResponse(1);
  const denied = commandDetails("denied", "printf 'another harmless test command'");
  const one = app.service.run(denied);
  const two = app.service.run(denied);
  const verdict = await one;
  assert.equal(verdict.kind, "deny");
  assert.deepEqual(await two, verdict);
  assert.ok(app.ui.text(WIDGET_KEY).includes(denied.payload.evidence[0]!.text));
  assert.equal(app.ui.text(WIDGET_KEY).includes(first.payload.evidence[0]!.text), false);
  assert.ok(app.ui.text(WIDGET_KEY).includes("⛔  Dangerous"));
  assert.ok(app.ui.text(WIDGET_KEY).includes("Analyzing command…"));
  assert.equal(app.models.streams[1]?.options.signal?.aborted, false);
  assert.equal(app.ui.mounts.length, mounts);
  assert.equal(app.runtime.state.get(denied.requestId)?.prompted, false);
  assert.equal(app.runtime.state.get(denied.requestId)?.decision, undefined);
  assert.equal(app.runtime.state.size, 2);
  assert.equal(app.ui.notifications.length, 1);
  assert.equal(app.ui.notifications[0]?.message, "[bash-cmd-checker] Blocked a bash command assessed as dangerous.");
  assert.equal(app.ui.notifications[0]?.message.includes(denied.payload.evidence[0]!.text), false);
  app.pi.events.emit("permissions:decision", { requestId: "denied", result: "deny", resolution: "authorizer_denied" });
  assert.equal(app.runtime.state.get("denied")?.decision?.result, "deny");
  assert.ok(app.ui.text(WIDGET_KEY).includes("Completed: deny (authorizer_denied)"));
  explanation.resolve(explanationResponse("Late explanation after automatic denial."));
  await flushPromises();
  assert.ok(app.ui.text(WIDGET_KEY).includes("Late explanation after automatic denial."));
  assert.deepEqual(await app.service.run(denied), verdict);
  assert.equal(app.models.classifications.length, 2);
  assert.equal(app.models.streams.length, 2);
  assert.equal(app.ui.notifications.length, 1);
  assert.equal(app.clock.pending, 0);
});

test("late explanations, decisions and duplicate denials cannot reclaim a covered or hidden widget", async (t) => {
  for (const coverage of ["prompt", "automatic-denial", "unobserved"] as const) {
    const app = setup(blockingConfig);
    t.after(app.runtime.dispose);
    const explanation = deferred<unknown>();
    app.models.llmResult = () => explanation.promise;
    app.models.classifierResult = async () => riskResponse(1);
    const denied = commandDetails("denied");
    const verdict = await app.service.run(denied);
    assert.equal(verdict.kind, "deny", coverage);
    assert.ok(app.ui.text(WIDGET_KEY).includes("Request: denied"), coverage);
    app.models.llmResult = async () => explanationResponse("Other request explanation.");
    app.models.classifierResult = async () => riskResponse(coverage === "automatic-denial" ? 1 : 0.05);
    const other = commandDetails("other", "printf 'other request'");
    await app.service.run(other);
    if (coverage === "prompt") app.pi.events.emit("permissions:ui_prompt", promptEvent(other));
    if (coverage === "unobserved") app.pi.events.emit("permissions:ui_prompt", { requestId: "unknown" });
    await flushPromises();
    const coveredText = app.ui.text(WIDGET_KEY);
    if (coverage === "unobserved") assert.equal(app.ui.components.has(WIDGET_KEY), false);
    else assert.ok(coveredText.includes(other.payload.evidence[0]!.text), coverage);
    app.pi.events.emit("permissions:decision", {
      requestId: denied.requestId, result: "deny", resolution: "authorizer_denied",
    });
    explanation.resolve(explanationResponse("Old denied request explanation."));
    await flushPromises();
    assert.deepEqual(app.runtime.state.get(denied.requestId)?.explanation, {
      status: "complete", text: "Old denied request explanation.",
    }, coverage);
    assert.equal(app.ui.text(WIDGET_KEY), coveredText, coverage);
    assert.deepEqual(await app.service.run(denied), verdict, coverage);
    assert.equal(app.ui.text(WIDGET_KEY), coveredText, coverage);
    assert.equal(app.ui.notifications.length, coverage === "automatic-denial" ? 2 : 1, coverage);
    assert.equal(app.models.classifications.length, 2, coverage);
    assert.equal(app.models.streams.length, 2, coverage);
    assert.equal(app.clock.pending, 0, coverage);
  }
});

test("a widget mount failure cannot change automatic denial, and late explanation can retry display", async (t) => {
  const app = setup(blockingConfig);
  t.after(app.runtime.dispose);
  const explanation = deferred<unknown>();
  app.models.llmResult = () => explanation.promise;
  app.models.classifierResult = async () => riskResponse(1);
  const setWidget = app.ctx.ui.setWidget;
  app.ctx.ui.setWidget = () => { throw new Error("SENSITIVE_UI_ERROR"); };
  const details = commandDetails();
  const verdict = await app.service.run(details);
  assert.equal(verdict.kind, "deny");
  assert.deepEqual(app.runtime.state.get(details.requestId)?.verdict, verdict);
  assert.equal(app.ui.notifications.length, 1);
  assert.equal(app.ui.notifications[0]?.message.includes("SENSITIVE"), false);
  app.ctx.ui.setWidget = setWidget;
  explanation.resolve(explanationResponse("Explanation after UI recovery."));
  await flushPromises();
  assert.ok(app.ui.text(WIDGET_KEY).includes("Explanation after UI recovery."));
  assert.ok(app.ui.text(WIDGET_KEY).includes("⛔  Dangerous"));
  assert.deepEqual(await app.service.run(details), verdict);
  assert.equal(app.ui.notifications.length, 1);
});

test("disabled, unavailable and failed classification defer to the rest of the chain while explanations still complete", async (t) => {
  for (const mode of ["disabled", "model", "credentials", "call"] as const) {
    const config = mode === "disabled"
      ? { ...blockingConfig, classifier: { ...blockingConfig.classifier, model: null } } : blockingConfig;
    const app = setup(config);
    t.after(app.runtime.dispose);
    if (mode === "model") app.models.classifier = undefined;
    if (mode === "credentials") app.models.availability = async () => [];
    if (mode === "call") app.models.classifierResult = async () => { throw new Error("SENSITIVE_PROVIDER_ERROR"); };
    const details = commandDetails();
    assert.deepEqual(await app.service.run(details), { kind: "defer" }, mode);
    await flushPromises();
    app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
    const status = mode === "disabled" ? "disabled" : mode === "call" ? "failed" : "unavailable";
    assert.equal(app.runtime.state.get(details.requestId)?.classification.status, status, mode);
    assert.ok(app.ui.text(WIDGET_KEY).includes("Prints two values."), mode);
    assert.equal(app.ui.text(WIDGET_KEY).includes("Unknown"), false, mode);
    assert.equal(app.ui.text(WIDGET_KEY).includes("SENSITIVE"), false, mode);
    assert.equal(app.ui.notifications.length, 0, mode);
  }
});

test("deadline covers availability and provider calls; late unsafe answers cannot change a deferred verdict", async (t) => {
  for (const boundary of ["availability", "provider"] as const) {
    const app = setup(blockingConfig);
    t.after(app.runtime.dispose);
    const pending = deferred<unknown>();
    const available = deferred<NonNullable<typeof app.models.classifier>[]>();
    if (boundary === "availability") app.models.availability = () => available.promise;
    else app.models.classifierResult = () => pending.promise;
    const details = commandDetails();
    const work = app.service.run(details);
    let settled = false;
    void work.then(() => { settled = true; });
    await flushPromises();
    app.clock.advance(DEFAULT_CONFIG.classifier.timeoutMs - 1);
    await flushPromises();
    assert.equal(settled, false, boundary);
    app.clock.advance(1);
    assert.deepEqual(await work, { kind: "defer" }, boundary);
    if (boundary === "availability") {
      app.models.classifierResult = async () => riskResponse(1);
      available.resolve([app.models.classifier!]);
    } else pending.resolve(riskResponse(1));
    await flushPromises();
    assert.equal(app.runtime.state.get(details.requestId)?.classification.status, "timed-out", boundary);
    assert.deepEqual(await app.service.run(details), { kind: "defer" }, boundary);
    assert.equal(app.ui.notifications.length, 0, boundary);
    app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
    assert.ok(app.ui.text(WIDGET_KEY).includes("Risk assessment timed out."), boundary);
    if (boundary === "availability") assert.equal(app.models.classifications.length, 0);
    assert.equal(app.clock.pending, 0);
  }
});

test("session replacement cancels pending arbitration and suppresses stale results with reused request IDs", async () => {
  const app = setup(blockingConfig);
  const oldResult = deferred<unknown>();
  const oldExplanation = deferred<unknown>();
  app.models.classifierResult = () => oldResult.promise;
  app.models.llmResult = () => oldExplanation.promise;
  const details = commandDetails();
  const waiting = app.service.run(details);
  await flushPromises();
  app.runtime.dispose();
  assert.deepEqual(await waiting, { kind: "defer" });
  assert.equal(app.clock.pending, 0);
  assert.equal(app.runtime.state.size, 0);
  assert.ok(app.models.classifications[0]?.options.signal?.aborted);
  assert.ok(app.models.streams[0]?.options.signal?.aborted);
  const next = createModelContext();
  const nextClock = new MockClock();
  const fresh = attachPermissions(app.pi.api, next.ctx, blockingConfig, () => app.service.service,
    modelAnalyzer(next.ctx, blockingConfig, nextClock));
  try {
    assert.deepEqual(await app.service.run(details), { kind: "defer" });
    app.pi.events.emit("permissions:ui_prompt", promptEvent(details));
    oldResult.resolve(riskResponse(1));
    oldExplanation.resolve(explanationResponse("Stale explanation"));
    await flushPromises();
    assert.equal(next.ui.text(WIDGET_KEY).includes("Stale explanation"), false);
    assert.equal(next.ui.text(WIDGET_KEY).includes("Dangerous"), false);
    assert.equal(app.ui.notifications.length, 0);
    assert.equal(next.ui.notifications.length, 0);
    assert.equal(fresh.state.size, 1);
    assert.equal(nextClock.pending, 0);
  } finally { fresh.dispose(); }
});

test("LLM failure and timeout do not alter an unsafe classification verdict", async (t) => {
  for (const mode of ["error", "pending"] as const) {
    const app = setup(blockingConfig);
    t.after(app.runtime.dispose);
    app.models.classifierResult = async () => riskResponse(1);
    const explanation = deferred<unknown>();
    app.models.llmResult = mode === "error"
      ? async () => { throw new Error("SENSITIVE_CREDENTIAL_ERROR"); } : () => explanation.promise;
    const details = commandDetails();
    const verdict = await app.service.run(details);
    assert.equal(verdict.kind, "deny", mode);
    app.clock.advance(DEFAULT_CONFIG.llm.timeoutMs);
    await flushPromises();
    assert.equal(app.runtime.state.get(details.requestId)?.explanation.status, "unavailable", mode);
    assert.ok(app.ui.text(WIDGET_KEY).includes("⛔  Dangerous"), mode);
    assert.ok(app.ui.text(WIDGET_KEY).includes("Command explanation unavailable."), mode);
    assert.equal(app.ui.text(WIDGET_KEY).includes("SENSITIVE"), false, mode);
    assert.deepEqual(await app.service.run(details), verdict, mode);
    assert.equal(app.ui.notifications.length, 1, mode);
    assert.equal(app.clock.pending, 0, mode);
    if (mode === "pending") explanation.reject(new Error("Late rejection from a provider that ignored abort"));
    await flushPromises();
  }
});
