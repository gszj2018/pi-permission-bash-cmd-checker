import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnalyzer } from "../extension/analysis.ts";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import type { AnalysisUpdate, ClassificationResult, ExplanationResult } from "../extension/types.ts";
import { deferred, flushPromises } from "./helpers/mocks.ts";
import { createModelContext, MockClock, modelAnalyzer, observedCommand, riskResponse } from "./helpers/models.ts";

const unsafe: ClassificationResult = {
  status: "complete", risk: "unsafe", confidence: 0.9,
  probabilities: { "safe-ro": 0, "safe-rw": 0, unsafe: 1 },
};

test("analysis starts both operations independently and classification settles without waiting for an explanation", async () => {
  const clock = new MockClock();
  const explanation = deferred<ExplanationResult>();
  const classification = deferred<ClassificationResult>();
  const started: string[] = [];
  const signals: AbortSignal[] = [];
  const updates: AnalysisUpdate[] = [];
  const analyzer = createAnalyzer(DEFAULT_CONFIG, {
    explain: (_command, signal) => { started.push("explain"); signals.push(signal); return explanation.promise; },
    classify: (_command, signal) => { started.push("classify"); signals.push(signal); return classification.promise; },
    schedule: clock.schedule,
  });
  const task = analyzer(observedCommand(), new AbortController().signal, (update) => { updates.push(update); });
  assert.deepEqual(started, ["explain", "classify"]);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(clock.pending, 2);
  let classified = false;
  void task.classification.then(() => { classified = true; });
  await flushPromises();
  assert.equal(classified, false);
  classification.resolve(unsafe);
  assert.equal(await task.classification, unsafe);
  assert.equal(clock.pending, 1);
  assert.equal(updates.some((update) => update.kind === "explanation"), false);
  clock.advance(DEFAULT_CONFIG.llm.timeoutMs);
  await task.done;
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  assert.equal(clock.pending, 0);
  assert.deepEqual(updates.at(-1), { kind: "explanation", value: { status: "unavailable" } });
});

test("classification deadline ignores late unsafe results and leaves the explanation operation independent", async () => {
  const clock = new MockClock();
  const classification = deferred<ClassificationResult>();
  const explanation = deferred<ExplanationResult>();
  const updates: AnalysisUpdate[] = [];
  let classSignal!: AbortSignal;
  let explanationSignal!: AbortSignal;
  const analyzer = createAnalyzer(DEFAULT_CONFIG, {
    classify: (_command, signal) => { classSignal = signal; return classification.promise; },
    explain: (_command, signal) => { explanationSignal = signal; return explanation.promise; },
    schedule: clock.schedule,
  });
  const task = analyzer(observedCommand(), new AbortController().signal, (update) => { updates.push(update); });
  clock.advance(DEFAULT_CONFIG.classifier.timeoutMs - 1);
  await flushPromises();
  assert.equal(updates.length, 0);
  clock.advance(1);
  assert.deepEqual(await task.classification, { status: "timed-out" });
  assert.equal(classSignal.aborted, true);
  assert.equal(explanationSignal.aborted, false);
  classification.resolve(unsafe);
  explanation.resolve({ status: "complete", text: "Explanation still finishes." });
  await task.done;
  await flushPromises();
  assert.equal(updates.filter((update) => update.kind === "classification").length, 1);
  assert.deepEqual(updates.at(-1), { kind: "explanation", value: { status: "complete", text: "Explanation still finishes." } });
  assert.equal(clock.pending, 0);
});

test("classification timeout includes pending availability and prevents late provider dispatch", async () => {
  const { ctx, models } = createModelContext();
  const clock = new MockClock();
  const available = deferred<NonNullable<typeof models.classifier>[]>();
  models.availability = () => available.promise;
  models.classifierResult = async () => riskResponse(1);
  const updates: AnalysisUpdate[] = [];
  const task = modelAnalyzer(ctx, DEFAULT_CONFIG, clock)(observedCommand(), new AbortController().signal, (update) => {
    updates.push(update);
  });
  clock.advance(DEFAULT_CONFIG.classifier.timeoutMs);
  assert.deepEqual(await task.classification, { status: "timed-out" });
  available.resolve([models.classifier!]);
  await task.done;
  await flushPromises();
  assert.equal(models.classifications.length, 0);
  assert.equal(clock.pending, 0);
});

test("parent cancellation releases both bounded tasks without publishing, even if providers ignore abort", async () => {
  const clock = new MockClock();
  const classification = deferred<ClassificationResult>();
  const explanation = deferred<ExplanationResult>();
  const signals: AbortSignal[] = [];
  const updates: AnalysisUpdate[] = [];
  const controller = new AbortController();
  const analyzer = createAnalyzer(DEFAULT_CONFIG, {
    classify: (_command, signal) => { signals.push(signal); return classification.promise; },
    explain: (_command, signal) => { signals.push(signal); return explanation.promise; },
    schedule: clock.schedule,
  });
  const task = analyzer(observedCommand(), controller.signal, (update) => { updates.push(update); });
  controller.abort();
  await task.classification;
  await task.done;
  assert.equal(clock.pending, 0);
  assert.ok(signals.every((signal) => signal.aborted));
  classification.reject(new Error("Late classification rejection"));
  explanation.reject(new Error("Late explanation rejection"));
  await flushPromises();
  assert.equal(updates.length, 0);
  const inert = analyzer(observedCommand(), controller.signal, (update) => { updates.push(update); });
  await inert.done;
  assert.equal(updates.length, 0);
  assert.equal(signals.length, 2);
  assert.equal(clock.pending, 0);
});

test("disabled classification skips its operation and deadline, while explanation failure stays independent", async () => {
  const clock = new MockClock();
  const config = { ...DEFAULT_CONFIG, classifier: { ...DEFAULT_CONFIG.classifier, model: null } };
  const updates: AnalysisUpdate[] = [];
  const analyzer = createAnalyzer(config, {
    classify: async () => { throw new Error("Must not classify."); },
    explain: async () => { throw new Error("SENSITIVE_EXPLANATION_ERROR"); },
    schedule: clock.schedule,
  });
  const task = analyzer(observedCommand(), new AbortController().signal, (update) => { updates.push(update); });
  assert.deepEqual(await task.classification, { status: "disabled" });
  await task.done;
  assert.equal(clock.pending, 0);
  assert.ok(updates.some((update) => update.kind === "explanation" && update.value.status === "unavailable"));
});

test("synchronous adapter and publisher failures do not reject bounded tasks or leak deadlines", async () => {
  const clock = new MockClock();
  const analyzer = createAnalyzer(DEFAULT_CONFIG, {
    explain: () => { throw new Error("SENSITIVE_SYNC_ERROR"); },
    classify: () => { throw new Error("SENSITIVE_SYNC_ERROR"); },
    schedule: clock.schedule,
  });
  const task = analyzer(observedCommand(), new AbortController().signal, () => { throw new Error("SENSITIVE_UI_ERROR"); });
  assert.deepEqual(await task.classification, { status: "failed" });
  await task.done;
  assert.equal(clock.pending, 0);
});
