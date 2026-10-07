import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extension/config.ts";
import { CLASSIFIER_LABELS, RISK_QUESTION_ID, assessRisk } from "../extension/risk.ts";
import type { ClassifierLabel, RiskLevel, RiskThresholds } from "../extension/types.ts";

const defaults = DEFAULT_CONFIG.classifier.thresholds;

function result(
  probabilities: Record<ClassifierLabel, number> = { "safe-ro": 0.7, "safe-rw": 0.2, unsafe: 0.1 },
  confidence = 0.9,
  choice: string = "safe-ro",
) {
  return {
    stopReason: "stop",
    answers: { [RISK_QUESTION_ID]: { type: "choice", choice, probabilities, confidence } },
  };
}

function expectRisk(input: unknown, expected: RiskLevel, thresholds: RiskThresholds = defaults): void {
  const assessment = assessRisk(input, thresholds);
  assert.equal(assessment.status, "complete");
  if (assessment.status === "complete") assert.equal(assessment.risk, expected);
}

test("only the three provider labels are defined; unknown is a local result", () => {
  assert.deepEqual(CLASSIFIER_LABELS, ["safe-ro", "safe-rw", "unsafe"]);
  assert.ok(Object.isFrozen(CLASSIFIER_LABELS));
  assert.deepEqual(assessRisk(result(undefined, 0.9, "unknown"), defaults), {
    status: "failed", reason: "invalid-response",
  });
  expectRisk(result(undefined, 0.79), "unknown");
});

test("approved defaults accept RO, RW and unsafe and preserve returned probabilities", () => {
  expectRisk(result(), "safe-ro");
  expectRisk(result({ "safe-ro": 0.1, "safe-rw": 0.8, unsafe: 0.1 }), "safe-rw");
  expectRisk(result({ "safe-ro": 0.1, "safe-rw": 0.1, unsafe: 0.8 }), "unsafe");
  const assessment = assessRisk(result(), defaults);
  assert.deepEqual(assessment, {
    status: "complete", risk: "safe-ro",
    probabilities: { "safe-ro": 0.7, "safe-rw": 0.2, unsafe: 0.1 }, confidence: 0.9,
  });
});

test("every accepted risk requires confidence, even when unsafe probability is one", () => {
  for (const confidence of [0, 0.799999]) {
    expectRisk(result({ "safe-ro": 0, "safe-rw": 0, unsafe: 1 }, confidence, "unsafe"), "unknown");
    expectRisk(result({ "safe-ro": 1, "safe-rw": 0, unsafe: 0 }, confidence), "unknown");
    expectRisk(result({ "safe-ro": 0, "safe-rw": 1, unsafe: 0 }, confidence, "safe-rw"), "unknown");
  }
});

test("probability and confidence thresholds accept equality and reject values just below", () => {
  expectRisk(result({ "safe-ro": 0.5, "safe-rw": 0.21, unsafe: 0.29 }, 0.8), "safe-ro");
  expectRisk(result({ "safe-ro": 0.21, "safe-rw": 0.5, unsafe: 0.29 }, 0.8), "safe-rw");
  expectRisk(result({ "safe-ro": 0.6, "safe-rw": 0.1, unsafe: 0.3 }, 0.8), "unsafe");
  expectRisk(result({ "safe-ro": 0.5, "safe-rw": 0.21, unsafe: 0.29 }, 0.799999), "unknown");
  expectRisk(result({ "safe-ro": 0.499999, "safe-rw": 0.25, unsafe: 0.250001 }, 0.8), "unknown");
  expectRisk(result({ "safe-ro": 0.25, "safe-rw": 0.499999, unsafe: 0.250001 }, 0.8), "unknown");
});

test("unsafe takes priority over any safe candidate and need not be the highest probability or choice", () => {
  expectRisk(result({ "safe-ro": 0.6, "safe-rw": 0.1, unsafe: 0.3 }, 0.9, "safe-ro"), "unsafe");
  expectRisk(result({ "safe-ro": 0.1, "safe-rw": 0.6, unsafe: 0.3 }, 0.9, "safe-rw"), "unsafe");
  expectRisk(result({ "safe-ro": 0.6, "safe-rw": 0.6, unsafe: 0.3 }), "unsafe");
});

test("safe candidates use the highest qualifying probability; exact ties select RW", () => {
  const thresholds = { safe: 0.3, unsafe: 0.5, confidence: 0.8 };
  expectRisk(result({ "safe-ro": 0.45, "safe-rw": 0.4, unsafe: 0.15 }, 0.9, "safe-rw"), "safe-ro", thresholds);
  expectRisk(result({ "safe-ro": 0.4, "safe-rw": 0.45, unsafe: 0.15 }), "safe-rw", thresholds);
  expectRisk(result({ "safe-ro": 0.5, "safe-rw": 0.5, unsafe: 0 }), "safe-rw");
});

test("valid results with no qualifying probability become unknown, without normalizing scores", () => {
  expectRisk(result({ "safe-ro": 0.4, "safe-rw": 0.4, unsafe: 0.2 }), "unknown");
  expectRisk(result({ "safe-ro": 0, "safe-rw": 0, unsafe: 0 }), "unknown");
  expectRisk(result({ "safe-ro": 0.2, "safe-rw": 0.1, unsafe: 0.1 }), "unknown");
  expectRisk(result({ "safe-ro": 0.7, "safe-rw": 0.7, unsafe: 0 }), "safe-rw");
});

test("zero and one thresholds retain inclusive comparison semantics", () => {
  expectRisk(result({ "safe-ro": 0, "safe-rw": 0, unsafe: 0 }, 0), "unsafe", {
    safe: 0, unsafe: 0, confidence: 0,
  });
  expectRisk(result({ "safe-ro": 1, "safe-rw": 0, unsafe: 0 }, 1), "safe-ro", {
    safe: 1, unsafe: 1, confidence: 1,
  });
  expectRisk(result({ "safe-ro": 0, "safe-rw": 0, unsafe: 1 }, 1), "unsafe", {
    safe: 1, unsafe: 1, confidence: 1,
  });
});

test("invalid answers do not generate unknown or leak raw provider errors", () => {
  const valid = result();
  const answer = valid.answers[RISK_QUESTION_ID];
  const malformed: unknown[] = [
    null, [], undefined, {}, { stopReason: "unexpected", answers: valid.answers },
    { stopReason: "stop", answers: null }, { stopReason: "stop", answers: [] },
    { stopReason: "stop", answers: {} }, { stopReason: "stop", answers: { risk: null } },
    { stopReason: "stop", answers: { risk: { ...answer, type: "bool" } } },
    { stopReason: "stop", answers: { risk: { ...answer, choice: "safw-rw" } } },
    { stopReason: "stop", answers: { risk: { ...answer, probabilities: [] } } },
    { stopReason: "stop", answers: Object.create({ risk: answer }) },
    { stopReason: "stop", answers: { risk: { ...answer, probabilities: Object.create(answer.probabilities) } } },
  ];
  for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.9", undefined, null]) {
    malformed.push({ stopReason: "stop", answers: { risk: { ...answer, confidence: value } } });
    for (const label of CLASSIFIER_LABELS) {
      malformed.push({
        stopReason: "stop",
        answers: { risk: { ...answer, probabilities: { ...answer.probabilities, [label]: value } } },
      });
    }
  }
  for (const label of CLASSIFIER_LABELS) {
    const probabilities: Partial<Record<ClassifierLabel, number>> = { ...answer.probabilities };
    delete probabilities[label];
    malformed.push({ stopReason: "stop", answers: { risk: { ...answer, probabilities } } });
  }
  for (const input of malformed) {
    assert.deepEqual(assessRisk(input, defaults), { status: "failed", reason: "invalid-response" });
  }
  for (const stopReason of ["error", "aborted"]) {
    assert.deepEqual(assessRisk({ ...valid, stopReason, errorMessage: "SENSITIVE_PROVIDER_ERROR" }, defaults), {
      status: "failed", reason: "call-failed",
    });
  }
});

test("invalid thresholds are programming errors, never an accidental unsafe verdict", () => {
  for (const value of [-1, 2, NaN, Infinity]) {
    for (const key of ["safe", "unsafe", "confidence"] as const) {
      assert.throws(() => assessRisk(result(), { ...defaults, [key]: value }), RangeError);
    }
  }
});

test("assessment copies provider data and leaves frozen inputs untouched", () => {
  const input = result();
  Object.freeze(input.answers.risk.probabilities);
  Object.freeze(input.answers.risk);
  Object.freeze(input.answers);
  Object.freeze(input);
  const assessment = assessRisk(input, defaults);
  assert.equal(assessment.status, "complete");
  if (assessment.status !== "complete") return;
  assert.notEqual(assessment.probabilities, input.answers.risk.probabilities);
  assert.ok(Object.isFrozen(assessment.probabilities));
  assert.deepEqual(input.answers.risk.probabilities, { "safe-ro": 0.7, "safe-rw": 0.2, unsafe: 0.1 });
});
