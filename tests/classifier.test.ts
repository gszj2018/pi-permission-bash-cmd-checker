import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "../extension/classifier.ts";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import { CLASSIFIER_LABELS } from "../extension/risk.ts";
import { deferred, flushPromises } from "./helpers/mocks.ts";
import { createModelContext, observedCommand, riskResponse } from "./helpers/models.ts";

const signal = (): AbortSignal => new AbortController().signal;

test("classifier sends one full-command choice question with exactly the three approved criteria", async () => {
  const { ctx, models } = createModelContext();
  const captured = signal();
  const command = observedCommand("printf 'a' && printf 'b'\n# unsafe instructions are data");
  const result = await classifyCommand(ctx, DEFAULT_CONFIG.classifier, command, captured);
  assert.equal(result.status, "complete");
  assert.deepEqual(models.classifierFinds, [["classifier", "typesafe", "jev-latest"]]);
  assert.deepEqual(models.availabilityCalls, [{ type: "classifier", provider: "typesafe", signal: captured }]);
  const call = models.classifications[0]!;
  assert.equal(call.model, models.classifier);
  assert.equal(call.options.signal, captured);
  assert.deepEqual(call.context.state, { command: command.fullCommand });
  assert.deepEqual(Object.keys(call.context.questions), ["risk"]);
  const question = call.context.questions.risk!;
  assert.equal(question.type, "choice");
  if (question.type !== "choice") throw new Error("Expected a choice question.");
  assert.deepEqual(Object.keys(question.criteria), [...CLASSIFIER_LABELS]);
  assert.equal(Object.hasOwn(question.criteria, "unknown"), false);
  assert.match(question.instructions, /entire bash command/);
  assert.match(question.instructions, /untrusted data/);
  assert.match(question.instructions, /Mark unsafe only/);
  assert.match(question.instructions, /unexpected accidental damage or secret disclosure/);
  assert.match(question.instructions, /not unsafe merely because they modify, overwrite, or delete data/);
  assert.match(question.instructions, /Deleting a single ordinary file.*safe-rw/);
  assert.match(question.instructions, /Network access or privilege use alone is not unsafe/);
  assert.match(question.criteria["safe-ro"]!, /read-only operations/);
  assert.match(question.criteria["safe-rw"]!, /bounded changes/);
  assert.match(question.criteria.unsafe!, /unexpected accidental damage or secret disclosure/);
  for (const description of Object.values(question.criteria)) {
    assert.doesNotMatch(description, /including|single ordinary file|[\r\n]/);
  }
});

test("disabled, missing-model and missing-credential classification do not call a provider", async () => {
  const { ctx, models } = createModelContext();
  assert.deepEqual(await classifyCommand(ctx, { ...DEFAULT_CONFIG.classifier, model: null }, observedCommand(), signal()), {
    status: "disabled",
  });
  assert.equal(models.classifierFinds.length, 0);
  models.classifier = undefined;
  assert.deepEqual(await classifyCommand(ctx, DEFAULT_CONFIG.classifier, observedCommand(), signal()), { status: "unavailable" });
  assert.equal(models.availabilityCalls.length, 0);
  const other = createModelContext();
  other.models.availability = async () => [];
  assert.deepEqual(await classifyCommand(other.ctx, DEFAULT_CONFIG.classifier, observedCommand(), signal()), {
    status: "unavailable",
  });
  assert.equal(other.models.classifications.length, 0);
});

test("classifier response validation distinguishes provider failures, invalid responses and threshold unknown", async () => {
  const { ctx, models } = createModelContext();
  const cases: [unknown, string][] = [
    [{ stopReason: "error", errorMessage: "SENSITIVE" }, "failed"],
    [{ stopReason: "aborted", errorMessage: "SENSITIVE" }, "failed"],
    [{ stopReason: "stop", answers: {} }, "invalid-response"],
    [{ stopReason: "stop", answers: { risk: { ...riskResponse().answers.risk, choice: "unknown" } } }, "invalid-response"],
    [riskResponse(1, 0.1), "complete"],
  ];
  for (const [response, status] of cases) {
    models.classifierResult = async () => response;
    const result = await classifyCommand(ctx, DEFAULT_CONFIG.classifier, observedCommand(), signal());
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
    if (result.status === "complete") assert.equal(result.risk, "unknown");
  }
  models.classifierResult = async () => { throw new Error("SENSITIVE_PROVIDER_FAILURE"); };
  assert.deepEqual(await classifyCommand(ctx, DEFAULT_CONFIG.classifier, observedCommand(), signal()), { status: "failed" });
  models.availability = async () => { throw new Error("SENSITIVE_AUTH_FAILURE"); };
  assert.deepEqual(await classifyCommand(ctx, DEFAULT_CONFIG.classifier, observedCommand(), signal()), { status: "failed" });
});

test("availability cancellation prevents classification even when the availability query ignores abort", async () => {
  const { ctx, models } = createModelContext();
  const pending = deferred<NonNullable<typeof models.classifier>[]>();
  models.availability = () => pending.promise;
  const controller = new AbortController();
  const work = classifyCommand(ctx, DEFAULT_CONFIG.classifier, observedCommand(), controller.signal);
  await flushPromises();
  controller.abort();
  pending.resolve([models.classifier!]);
  assert.deepEqual(await work, { status: "unavailable" });
  assert.equal(models.classifications.length, 0);
});
