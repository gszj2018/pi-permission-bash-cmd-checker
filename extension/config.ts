import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, ConfigLoadResult, ModelReference } from "./types.ts";
import { DEFAULT_COMMAND_VIEWER_SHORTCUT, isCommandViewerShortcut } from "./shortcut.ts";
import { isNonBlankString, isProbability, isRecord } from "./utils.ts";

export const CONFIG_FILE_NAME = "permission-bash-cmd-checker.json";
/** Node timers cannot represent larger delays without overflowing. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_CONFIG: Config = Object.freeze({
  llm: Object.freeze({ model: null, language: "en", timeoutMs: 30_000 }),
  classifier: Object.freeze({
    model: Object.freeze({ provider: "typesafe", id: "jev-latest" }),
    timeoutMs: 10_000,
    thresholds: Object.freeze({ safe: 0.5, unsafe: 0.3, confidence: 0.8 }),
  }),
  autoBlockUnsafe: false,
  widget: Object.freeze({ commandViewerShortcut: DEFAULT_COMMAND_VIEWER_SHORTCUT }),
});

export type ConfigValidationResult =
  | { readonly status: "valid"; readonly config: Config }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

type RecordValue = Record<string, unknown>;

function checkKeys(value: RecordValue, allowed: readonly string[], path: string, issues: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    // Unknown keys can contain secrets; report only the known container path.
    issues.push(`${path}: unknown fields are not allowed.`);
  }
}

function section(value: unknown, path: string, issues: string[]): RecordValue {
  if (isRecord(value)) return value;
  issues.push(`${path}: expected an object.`);
  return {};
}

function model(value: unknown, path: string, issues: string[]): ModelReference | null {
  if (value === null) return null;
  const fields = section(value, path, issues);
  checkKeys(fields, ["provider", "id"], path, issues);
  for (const key of ["provider", "id"] as const) {
    if (!isNonBlankString(fields[key])) {
      issues.push(`${path}.${key}: expected a non-blank string.`);
    }
  }
  if (typeof fields.provider !== "string" || typeof fields.id !== "string") return null;
  // Preserve exact catalog identifiers instead of silently normalizing user input.
  return Object.freeze({ provider: fields.provider, id: fields.id });
}

function timeout(value: unknown, fallback: number, path: string, issues: string[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS) return value;
  issues.push(`${path}: expected an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  return fallback;
}

function probability(value: unknown, fallback: number, path: string, issues: string[]): number {
  if (isProbability(value)) return value;
  issues.push(`${path}: expected a finite number between 0 and 1.`);
  return fallback;
}

/** Validate without coercion. Any issue disables the config rather than partially enabling it. */
export function validateConfig(value: unknown): ConfigValidationResult {
  const issues: string[] = [];
  const root = section(value, "config", issues);
  checkKeys(root, ["$schema", "llm", "classifier", "autoBlockUnsafe", "widget"], "config", issues);
  if (Object.hasOwn(root, "$schema") && typeof root.$schema !== "string") {
    issues.push("$schema: expected a string.");
  }

  const llm = Object.hasOwn(root, "llm") ? section(root.llm, "llm", issues) : {};
  const classifier = Object.hasOwn(root, "classifier") ? section(root.classifier, "classifier", issues) : {};
  checkKeys(llm, ["model", "language", "timeoutMs"], "llm", issues);
  checkKeys(classifier, ["model", "timeoutMs", "thresholds"], "classifier", issues);
  const widget = Object.hasOwn(root, "widget") ? section(root.widget, "widget", issues) : {};
  checkKeys(widget, ["commandViewerShortcut"], "widget", issues);
  let commandViewerShortcut = DEFAULT_CONFIG.widget.commandViewerShortcut;
  if (Object.hasOwn(widget, "commandViewerShortcut")) {
    if (isCommandViewerShortcut(widget.commandViewerShortcut)) commandViewerShortcut = widget.commandViewerShortcut;
    else issues.push("widget.commandViewerShortcut: expected a valid non-reserved shortcut.");
  }
  const thresholds = Object.hasOwn(classifier, "thresholds")
    ? section(classifier.thresholds, "classifier.thresholds", issues)
    : {};
  checkKeys(thresholds, ["safe", "unsafe", "confidence"], "classifier.thresholds", issues);

  const llmModel = Object.hasOwn(llm, "model") ? model(llm.model, "llm.model", issues) : DEFAULT_CONFIG.llm.model;
  let llmLanguage = DEFAULT_CONFIG.llm.language;
  if (Object.hasOwn(llm, "language")) {
    if (llm.language === "en" || llm.language === "zh") llmLanguage = llm.language;
    else issues.push("llm.language: expected en or zh.");
  }
  const classifierModel = Object.hasOwn(classifier, "model")
    ? model(classifier.model, "classifier.model", issues)
    : DEFAULT_CONFIG.classifier.model;
  const llmTimeout = Object.hasOwn(llm, "timeoutMs")
    ? timeout(llm.timeoutMs, DEFAULT_CONFIG.llm.timeoutMs, "llm.timeoutMs", issues)
    : DEFAULT_CONFIG.llm.timeoutMs;
  const classifierTimeout = Object.hasOwn(classifier, "timeoutMs")
    ? timeout(classifier.timeoutMs, DEFAULT_CONFIG.classifier.timeoutMs, "classifier.timeoutMs", issues)
    : DEFAULT_CONFIG.classifier.timeoutMs;
  const resolvedThresholds = { ...DEFAULT_CONFIG.classifier.thresholds };
  for (const key of ["safe", "unsafe", "confidence"] as const) {
    if (Object.hasOwn(thresholds, key)) {
      resolvedThresholds[key] = probability(
        thresholds[key], DEFAULT_CONFIG.classifier.thresholds[key], `classifier.thresholds.${key}`, issues,
      );
    }
  }
  let autoBlockUnsafe = DEFAULT_CONFIG.autoBlockUnsafe;
  if (Object.hasOwn(root, "autoBlockUnsafe")) {
    if (typeof root.autoBlockUnsafe === "boolean") autoBlockUnsafe = root.autoBlockUnsafe;
    else issues.push("autoBlockUnsafe: expected a boolean.");
  }

  if (issues.length > 0) return { status: "invalid", issues };
  return {
    status: "valid",
    config: Object.freeze({
      llm: Object.freeze({ model: llmModel, language: llmLanguage, timeoutMs: llmTimeout }),
      classifier: Object.freeze({
        model: classifierModel,
        timeoutMs: classifierTimeout,
        thresholds: Object.freeze(resolvedThresholds),
      }),
      autoBlockUnsafe,
      widget: Object.freeze({ commandViewerShortcut }),
    }),
  };
}

/** Read only the supplied agent directory. Never creates a config or exposes raw file errors. */
export async function loadConfigFrom(agentDir: string): Promise<ConfigLoadResult> {
  let source: string;
  try {
    source = await readFile(join(agentDir, CONFIG_FILE_NAME), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { status: "missing", config: DEFAULT_CONFIG };
    return { status: "unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { status: "invalid", issues: ["config: invalid JSON."] };
  }
  const result = validateConfig(value);
  return result.status === "valid" ? { status: "loaded", config: result.config } : result;
}
