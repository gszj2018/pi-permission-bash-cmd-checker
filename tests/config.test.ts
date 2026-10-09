import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_FILE_NAME, DEFAULT_CONFIG, MAX_TIMEOUT_MS, VIEWER_DIRECTORY_PATTERN, loadConfigFrom, validateConfig,
} from "../extension/config.ts";
import { COMMAND_VIEWER_SHORTCUT_PATTERN } from "../extension/shortcut.ts";

const expectedDefaults = {
  llm: { model: null, language: "en", timeoutMs: 30_000 },
  classifier: {
    model: { provider: "typesafe", id: "jev-latest" },
    timeoutMs: 10_000,
    thresholds: { safe: 0.5, unsafe: 0.3, confidence: 0.8 },
  },
  autoBlockUnsafe: false,
  widget: { commandViewerShortcut: "alt+c" },
  externalViewer: { command: "code", args: [], mode: "detach", filePath: null },
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
    assert.ok(Object.isFrozen(config.widget));
    assert.ok(Object.isFrozen(config.externalViewer));
    assert.ok(Object.isFrozen(config.externalViewer.args));
  }
});

test("partial sections default each omitted field without mutating the input", () => {
  const input = Object.freeze({
    $schema: "./bash-cmd-checker.schema.json",
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

test("command viewer shortcuts default per field and strictly validate without changing analysis", () => {
  assert.deepEqual(validateConfig({ widget: {} }), validateConfig({}));
  for (const commandViewerShortcut of ["alt+c", "ctrl+;", "alt+m", "ctrl+alt+v", "ctrl+shift+=", "super+k",
    "ctrl+space", "alt+tab", "ctrl+backspace", "alt+left", "ctrl+right", "shift+delete", "ctrl+insert"]) {
    const widget = Object.freeze({ commandViewerShortcut });
    const input = Object.freeze({ widget });
    const result = validateConfig(input);
    assert.equal(result.status, "valid");
    if (result.status !== "valid") continue;
    assert.deepEqual(result.config, { ...expectedDefaults, widget: { commandViewerShortcut } });
    assert.notEqual(result.config.widget, widget);
    assert.ok(Object.isFrozen(result.config.widget));
    assert.equal(input.widget.commandViewerShortcut, commandViewerShortcut);
  }
  for (const commandViewerShortcut of [
    "", "Ctrl+;", "ctrl+; ", "ctrl+;\n", "control+x", "ctrl+ctrl+x", "ctrl+f13", "unknown", "ctrl+", "ctrl++", "+",
    "esc", "escape", "q", "enter", "return", "up", "down", "pageUp", "pageDown", "home", "end",
    "space", "tab", "backspace", "left", "right", "delete", "insert", "clear", "c", "0", ";", "f1", "f6", "f12",
    "ctrl+escape", "ctrl+esc", "alt+escape", "alt+esc", "shift+escape", "shift+esc", "super+escape", "super+esc",
    "ctrl+alt+escape", "ctrl+alt+esc", "shift+ctrl+alt+super+escape", "shift+ctrl+alt+super+esc",
    "ctrl+f1", "ctrl+f6", "alt+f12", "ctrl+clear", "alt+clear", "shift+clear", "super+clear",
    null, undefined, 1, false, {}, [],
  ]) {
    assert.deepEqual(validateConfig({ widget: { commandViewerShortcut } }), {
      status: "invalid", issues: ["widget.commandViewerShortcut: expected a valid non-reserved shortcut."],
    });
  }
});

test("external viewer fields default independently and preserve literal executable paths and arguments", () => {
  assert.deepEqual(validateConfig({ externalViewer: {} }), validateConfig({}));
  const args = ["", "--reuse-window", "a b", "'quoted'", "$(literal); &", "中文"];
  const directory = join(tmpdir(), "viewer directory.sh");
  const input = { externalViewer: { command: " C:\\Program Files\\Code.exe ", args, mode: "wait", filePath: directory } };
  const result = validateConfig(input);
  assert.equal(result.status, "valid");
  if (result.status !== "valid") return;
  assert.deepEqual(result.config.externalViewer, input.externalViewer);
  assert.deepEqual(result.config.llm, DEFAULT_CONFIG.llm);
  assert.deepEqual(result.config.classifier, DEFAULT_CONFIG.classifier);
  assert.notEqual(result.config.externalViewer, input.externalViewer);
  assert.notEqual(result.config.externalViewer.args, args);
  assert.ok(Object.isFrozen(result.config.externalViewer));
  assert.ok(Object.isFrozen(result.config.externalViewer.args));
  args.push("changed");
  assert.equal(result.config.externalViewer.args.includes("changed"), false);
  for (const mode of ["detach", "wait"]) {
    const partial = validateConfig({ externalViewer: { mode } });
    assert.equal(partial.status, "valid");
    if (partial.status === "valid") {
      assert.deepEqual(partial.config.externalViewer, { ...expectedDefaults.externalViewer, mode });
    }
  }
  const unconfigured = validateConfig({ externalViewer: { command: null, filePath: null } });
  assert.equal(unconfigured.status, "valid");
  if (unconfigured.status === "valid") {
    assert.deepEqual(unconfigured.config.externalViewer, { ...expectedDefaults.externalViewer, command: null });
  }
});

const viewerDirectories = ["/tmp/viewer dir", "/", "/tmp/name.sh", "C:\\viewer dir", "D:/viewer",
  "\\\\server\\share", "\\\\server\\share\\viewer", "/tmp/literal-$VAR"];
const invalidViewerDirectories: unknown[] = ["", " ", "relative/viewer", ".", "..", "~/viewer", "$TMP/viewer",
  "C:viewer", "\\viewer", "\\\\server", "/tmp/bad\u0000path", 1, true, undefined, {}, []];

const invalidViewerFields: Record<string, unknown>[] = [
  { unknown: "secret" },
  ...["", " \t\n", "code\u0000secret", 1, true, undefined, {}, []].map((command) => ({ command })),
  ...["--reuse-window", null, undefined, 1, {}, [1], [null], [undefined], ["ok", "bad\u0000"],
    Array(1)].map((args) => ({ args })),
  ...["DETACH", "wait ", "", null, undefined, 1, true, {}, []].map((mode) => ({ mode })),
  ...invalidViewerDirectories.map((filePath) => ({ filePath })),
];

test("external viewer rejects invalid types, NUL, relative directories and unknown fields without coercion", () => {
  for (const externalViewer of [null, undefined, [], true, "code", ...invalidViewerFields]) {
    const result = validateConfig({ externalViewer });
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.equal(Object.hasOwn(result, "config"), false);
  }
  for (const filePath of viewerDirectories) {
    const result = validateConfig({ externalViewer: { filePath } });
    assert.equal(result.status, "valid", filePath);
    if (result.status === "valid") assert.equal(result.config.externalViewer.filePath, filePath);
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
  { widget: null }, { widget: [] }, { widget: undefined }, { widget: "ctrl+;" }, { widget: { unexpected: true } },
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
  const result = validateConfig({
    [secret]: secret, llm: { timeoutMs: secret, language: secret }, widget: { [secret]: secret, commandViewerShortcut: secret },
    externalViewer: { [secret]: secret, command: `${secret}\u0000`, args: [`${secret}\u0000`], mode: secret, filePath: secret },
  });
  assert.equal(result.status, "invalid");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("schema defaults, accepted fields and numeric constraints match the runtime contract", async () => {
  // Read a project artifact only; no user configuration, environment changes or schema network requests.
  const schema = JSON.parse(await readFile(
    new URL("../schemas/bash-cmd-checker.schema.json", import.meta.url), "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(),
    ["$schema", "autoBlockUnsafe", "classifier", "externalViewer", "llm", "widget"]);
  assert.deepEqual(schema.properties.llm.default, DEFAULT_CONFIG.llm);
  assert.deepEqual(schema.properties.classifier.default, DEFAULT_CONFIG.classifier);
  assert.equal(schema.properties.autoBlockUnsafe.default, DEFAULT_CONFIG.autoBlockUnsafe);
  const viewer = schema.properties.externalViewer;
  assert.equal(viewer.type, "object");
  assert.equal(viewer.additionalProperties, false);
  assert.deepEqual(viewer.default, DEFAULT_CONFIG.externalViewer);
  assert.deepEqual(Object.keys(viewer.properties).sort(), ["args", "command", "filePath", "mode"]);
  for (const key of ["command", "args", "mode", "filePath"] as const) {
    assert.deepEqual(viewer.properties[key].default, DEFAULT_CONFIG.externalViewer[key]);
  }
  assert.deepEqual(viewer.properties.mode.enum, ["detach", "wait"]);
  assert.equal(viewer.properties.mode.type, "string");
  assert.equal(viewer.properties.args.type, "array");
  assert.equal(viewer.properties.args.items.type, "string");
  const argsPattern = new RegExp(viewer.properties.args.items.pattern);
  for (const arg of ["", " ", "a b", "$(literal); &", "中文", "\n"]) assert.equal(argsPattern.test(arg), true);
  assert.equal(argsPattern.test("bad\u0000argument"), false);
  const commandSchema = viewer.properties.command.anyOf;
  assert.equal(commandSchema[0].type, "string");
  assert.deepEqual(commandSchema[1], { type: "null" });
  const commandPattern = new RegExp(commandSchema[0].pattern);
  for (const command of ["code", "C:\\Program Files\\Code.exe", " code ", "program\nname"]) {
    assert.equal(commandPattern.test(command), true);
    assert.equal(validateConfig({ externalViewer: { command } }).status, "valid");
  }
  for (const command of ["", " \t\n", "code\u0000"]) {
    assert.equal(commandPattern.test(command), false);
    assert.equal(validateConfig({ externalViewer: { command } }).status, "invalid");
  }
  const directorySchema = viewer.properties.filePath.anyOf;
  assert.equal(directorySchema[0].type, "string");
  assert.deepEqual(directorySchema[1], { type: "null" });
  assert.equal(directorySchema[0].pattern, VIEWER_DIRECTORY_PATTERN);
  const directoryPattern = new RegExp(directorySchema[0].pattern);
  for (const directory of viewerDirectories) assert.equal(directoryPattern.test(directory), true, directory);
  for (const directory of invalidViewerDirectories) {
    if (typeof directory === "string") assert.equal(directoryPattern.test(directory), false, directory);
  }
  const widget = schema.properties.widget;
  assert.equal(widget.additionalProperties, false);
  assert.deepEqual(widget.default, DEFAULT_CONFIG.widget);
  assert.deepEqual(Object.keys(widget.properties), ["commandViewerShortcut"]);
  const shortcut = widget.properties.commandViewerShortcut;
  assert.equal(shortcut.type, "string");
  assert.equal(shortcut.default, DEFAULT_CONFIG.widget.commandViewerShortcut);
  assert.equal(shortcut.pattern, COMMAND_VIEWER_SHORTCUT_PATTERN);
  const shortcutPattern = new RegExp(shortcut.pattern);
  for (const key of ["c", ";", "space", "tab", "backspace", "left", "right", "delete", "insert"]) {
    assert.equal(shortcutPattern.test(key), false, key);
    assert.equal(validateConfig({ widget: { commandViewerShortcut: key } }).status, "invalid", key);
    assert.equal(shortcutPattern.test(`ctrl+${key}`), true, key);
    assert.equal(validateConfig({ widget: { commandViewerShortcut: `ctrl+${key}` } }).status, "valid", key);
  }
  const excludedKeys = ["escape", "esc", "clear", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)];
  for (const prefix of ["", "ctrl+", "alt+", "shift+", "super+", "ctrl+alt+", "shift+ctrl+alt+super+"]) {
    for (const baseKey of excludedKeys) {
      const key = `${prefix}${baseKey}`;
      assert.equal(shortcutPattern.test(key), false, key);
      assert.equal(validateConfig({ widget: { commandViewerShortcut: key } }).status, "invalid", key);
    }
  }
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
  assert.equal(CONFIG_FILE_NAME, "bash-cmd-checker.json");
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
