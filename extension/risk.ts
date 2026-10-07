import type { ClassifierLabel, RiskLevel, RiskThresholds } from "./types.ts";
import { isProbability, isRecord } from "./utils.ts";

export const RISK_QUESTION_ID = "risk";
export const CLASSIFIER_LABELS = Object.freeze(["safe-ro", "safe-rw", "unsafe"] as const);

export type RiskAssessment =
  | {
    readonly status: "complete";
    readonly risk: RiskLevel;
    readonly probabilities: Readonly<Record<ClassifierLabel, number>>;
    readonly confidence: number;
  }
  | { readonly status: "failed"; readonly reason: "call-failed" | "invalid-response" };

function isLabel(value: unknown): value is ClassifierLabel {
  return value === "safe-ro" || value === "safe-rw" || value === "unsafe";
}

/** Validate provider data before applying local thresholds. Never infer safety from a malformed answer. */
export function assessRisk(result: unknown, thresholds: RiskThresholds): RiskAssessment {
  if (!isRecord(thresholds) || !["safe", "unsafe", "confidence"].every(
    (key) => Object.hasOwn(thresholds, key) && isProbability(thresholds[key]),
  )) {
    throw new RangeError("Risk thresholds must be finite numbers between 0 and 1.");
  }
  if (!isRecord(result)) return { status: "failed", reason: "invalid-response" };
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    return { status: "failed", reason: "call-failed" };
  }
  if (result.stopReason !== "stop" || !isRecord(result.answers)
    || !Object.hasOwn(result.answers, RISK_QUESTION_ID)) {
    return { status: "failed", reason: "invalid-response" };
  }
  const answer = result.answers[RISK_QUESTION_ID];
  if (!isRecord(answer) || answer.type !== "choice" || !isLabel(answer.choice)
    || !isProbability(answer.confidence) || !isRecord(answer.probabilities)) {
    return { status: "failed", reason: "invalid-response" };
  }
  const values = answer.probabilities;
  if (!CLASSIFIER_LABELS.every((label) => Object.hasOwn(values, label) && isProbability(values[label]))) {
    return { status: "failed", reason: "invalid-response" };
  }
  const probabilities: Readonly<Record<ClassifierLabel, number>> = Object.freeze({
    "safe-ro": values["safe-ro"] as number,
    "safe-rw": values["safe-rw"] as number,
    unsafe: values.unsafe as number,
  });

  let risk: RiskLevel = "unknown";
  if (answer.confidence >= thresholds.confidence) {
    if (probabilities.unsafe >= thresholds.unsafe) {
      risk = "unsafe";
    } else {
      const ro = probabilities["safe-ro"] >= thresholds.safe;
      const rw = probabilities["safe-rw"] >= thresholds.safe;
      if (rw && (!ro || probabilities["safe-rw"] >= probabilities["safe-ro"])) risk = "safe-rw";
      else if (ro) risk = "safe-ro";
    }
  }
  // Probabilities are intentionally neither normalized nor chosen via answer.choice.
  return { status: "complete", risk, probabilities, confidence: answer.confidence };
}
