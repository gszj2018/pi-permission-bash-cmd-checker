import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_FILE_NAME, DEFAULT_CONFIG, MAX_TIMEOUT_MS, loadConfigFrom, validateConfig,
} from "../extension/config.ts";

const expectedDefaults = {
  llm: { model: null, language: "en", timeoutMs: 30_000 },
  classifier: {
    model: { provider: "typesafe", id: "jev-latest" },
    timeoutMs: 10_000,
    thresholds: { safe: 0.5, unsafe: 0.3, confidence: 0.8 },
  },
  autoBlockUnsafe: false,
};

test("empty config uses the approved defaults and immutable nested values", () => {
  const result = validateConfig({});
  assert.equal(result.status, "valid");
  if (result.status !== "valid") return;
  assert.deepEqual(result.config, expectedDefaults);
  assert.deepEqual(DEFAULT_CONFIG, expectedDefaults);
  for (const config of [result.config, DEFAULT_CONFIG]) {
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.llm));
    assert.ok(Object.isFrozen(config.classifier));
    assert.ok(Object.isFrozen(config.classifier.model));
    assert.ok(Object.isFrozen(config.classifier.thresholds));
  }
});

test("partial sections default each omitted field without mutating the input", () => {
  const input = Object.freeze({
    $schema: "./permission-bash-cmd-checker.schema.json",
    llm: Object.freeze({ timeoutMs: 1234 }),
    classifier: Object.freeze({ thresholds: Object.freeze({ unsafe: 0.2 }) }),
  });
  const result = validateConfig(input);
  assert.deepEqual(result, {
    status: "valid",
    config: {
      ...expectedDefaults,
      llm: { ...expectedDefaults.llm, timeoutMs: 1234 },
      classifier: {
        ...expectedDefaults.classifier,
        thresholds: { safe: 0.5, unsafe: 0.2, confidence: 0.8 },
      },
    },
  });
  assert.equal(input.classifier.thresholds.unsafe, 0.2);
  assert.deepEqual(validateConfig({ llm: {}, classifier: { thresholds: {} } }), validateConfig({}));
});

test("explicit model references preserve slash-containing IDs and null disables classification", () => {
  const reference = { provider: "openrouter", id: "vendor/model" };
  const result = validateConfig({ llm: { model: reference }, classifier: { model: null }, autoBlockUnsafe: true });
  assert.equal(result.status, "valid");
  if (result.status !== "valid") return;
  assert.deepEqual(result.config.llm.model, reference);
  assert.notEqual(result.config.llm.model, reference);
  assert.equal(result.config.classifier.model, null);
  assert.equal(result.config.autoBlockUnsafe, true);
  reference.id = "changed";
  assert.equal(result.config.llm.model?.id, "vendor/model");
});

test("LLM explanation language accepts only English or Simplified Chinese without changing classification", () => {
  for (const language of ["en", "zh"] as const) {
    const input = Object.freeze({ llm: Object.freeze({ language }) });
    const result = validateConfig(input);
    assert.equal(result.status, "valid");
    if (result.status !== "valid") continue;
    assert.deepEqual(result.config.llm, { ...expectedDefaults.llm, language });
    assert.deepEqual(result.config.classifier, DEFAULT_CONFIG.classifier);
    assert.equal(input.llm.language, language);
  }
  for (const language of ["", "EN", "ZH", "zh-CN", "english", "中文", "fr", " en ", 1, true, null, undefined, {}, []]) {
    assert.deepEqual(validateConfig({ llm: { language } }), {
      status: "invalid", issues: ["llm.language: expected en or zh."],
    });
  }
});

test("threshold and timer boundaries are inclusive", () => {
  const result = validateConfig({
    llm: { timeoutMs: 1 },
    classifier: { timeoutMs: MAX_TIMEOUT_MS, thresholds: { safe: 0, unsafe: 1, confidence: 0 } },
  });
  assert.equal(result.status, "valid");
});

const invalidConfigs: unknown[] = [
  null, undefined, [], "config", 123,
  { $schema: null },
  { llm: null }, { classifier: [] }, { classifier: { thresholds: null } },
  { llm: { model: "provider/id" } }, { llm: { model: {} } },
  { llm: { model: { provider: "typesafe" } } },
  { llm: { model: { provider: " ", id: "model" } } },
  { llm: { model: { provider: "provider", id: "\t\n" } } },
  { classifier: { model: { provider: 12, id: "model" } } },
  { llm: { model: undefined } }, { autoBlockUnsafe: "true" }, { autoBlockUnsafe: null },
  { unexpected: true }, { llm: { unexpected: true } }, { classifier: { unexpected: true } },
  { classifier: { thresholds: { unexpected: 0.1 } } },
  { classifier: { model: { provider: "typesafe", id: "jev-latest", unexpected: true } } },
];
for (const value of [0, -1, 1.5, NaN, Infinity, MAX_TIMEOUT_MS + 1, "1000", null, undefined]) {
  invalidConfigs.push({ llm: { timeoutMs: value } }, { classifier: { timeoutMs: value } });
}
for (const value of [-0.1, 1.1, NaN, Infinity, "0.5", null, undefined]) {
  for (const key of ["safe", "unsafe", "confidence"]) {
    invalidConfigs.push({ classifier: { thresholds: { [key]: value } } });
  }
}

test("invalid values and unknown fields reject the entire config without coercion", () => {
  for (const input of invalidConfigs) {
    const result = validateConfig(input);
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") continue;
    assert.ok(result.issues.length > 0);
    assert.equal(Object.hasOwn(result, "config"), false);
  }
});

test("config diagnostics contain neither supplied values nor unknown field names", () => {
  const secret = "SENSITIVE_CONFIG_MARKER";
  const result = validateConfig({ [secret]: secret, llm: { timeoutMs: secret, language: secret } });
  assert.equal(result.status, "invalid");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("schema defaults, accepted fields and numeric constraints match the runtime contract", async () => {
  // Read a project artifact only; no user configuration, environment changes or schema network requests.
  const schema = JSON.parse(await readFile(
    new URL("../schemas/permission-bash-cmd-checker.schema.json", import.meta.url), "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["$schema", "autoBlockUnsafe", "classifier", "llm"]);
  assert.deepEqual(schema.properties.llm.default, DEFAULT_CONFIG.llm);
  assert.deepEqual(schema.properties.classifier.default, DEFAULT_CONFIG.classifier);
  assert.equal(schema.properties.autoBlockUnsafe.default, DEFAULT_CONFIG.autoBlockUnsafe);
  for (const name of ["llm", "classifier"]) {
    const section = schema.properties[name];
    assert.equal(section.additionalProperties, false);
    assert.deepEqual(section.properties.model.default, DEFAULT_CONFIG[name as "llm" | "classifier"].model);
    assert.equal(section.properties.timeoutMs.default, DEFAULT_CONFIG[name as "llm" | "classifier"].timeoutMs);
    assert.equal(section.properties.timeoutMs.$ref, "#/$defs/timeout");
  }
  assert.deepEqual(Object.keys(schema.properties.llm.properties).sort(), ["language", "model", "timeoutMs"]);
  assert.equal(schema.properties.llm.properties.language.type, "string");
  assert.deepEqual(schema.properties.llm.properties.language.enum, ["en", "zh"]);
  assert.equal(schema.properties.llm.properties.language.default, DEFAULT_CONFIG.llm.language);
  const thresholds = schema.properties.classifier.properties.thresholds;
  assert.equal(thresholds.additionalProperties, false);
  assert.deepEqual(thresholds.default, DEFAULT_CONFIG.classifier.thresholds);
  for (const key of ["safe", "unsafe", "confidence"] as const) {
    assert.equal(thresholds.properties[key].default, DEFAULT_CONFIG.classifier.thresholds[key]);
    assert.equal(thresholds.properties[key].$ref, "#/$defs/probability");
  }
  assert.deepEqual(schema.$defs.timeout, { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS });
  assert.deepEqual(schema.$defs.probability, { type: "number", minimum: 0, maximum: 1 });
  assert.equal(schema.$defs.model.additionalProperties, false);
  assert.deepEqual(schema.$defs.model.required, ["provider", "id"]);
  for (const key of ["provider", "id"]) {
    assert.equal(schema.$defs.model.properties[key].type, "string");
    const pattern = new RegExp(schema.$defs.model.properties[key].pattern);
    assert.equal(pattern.test(" \t\n"), false);
    assert.equal(pattern.test("vendor/model"), true);
  }
});

test("config file loading is read-only and failures never return raw contents", async (t) => {
  // All writes and deletion are confined to this test's unique temporary directory.
  const agentDir = await mkdtemp(join(tmpdir(), "bash-cmd-checker-config-"));
  t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
  const path = join(agentDir, CONFIG_FILE_NAME);
  assert.deepEqual(await loadConfigFrom(agentDir), { status: "missing", config: DEFAULT_CONFIG });
  assert.deepEqual(await readdir(agentDir), []);

  const validText = JSON.stringify({ classifier: { model: null } });
  await writeFile(path, validText, "utf8");
  const loaded = await loadConfigFrom(agentDir);
  assert.equal(loaded.status, "loaded");
  if (loaded.status === "loaded") assert.equal(loaded.config.classifier.model, null);
  assert.equal(await readFile(path, "utf8"), validText);

  await writeFile(path, '{"llm": "SENSITIVE_JSON_MARKER"', "utf8");
  assert.deepEqual(await loadConfigFrom(agentDir), { status: "invalid", issues: ["config: invalid JSON."] });
  await writeFile(path, '{"autoBlockUnsafe": "SENSITIVE_CONFIG_MARKER"}', "utf8");
  const invalid = await loadConfigFrom(agentDir);
  assert.equal(invalid.status, "invalid");
  assert.equal(JSON.stringify(invalid).includes("SENSITIVE_CONFIG_MARKER"), false);

  await rm(path);
  await mkdir(path);
  assert.deepEqual(await loadConfigFrom(agentDir), { status: "unreadable" });
});
