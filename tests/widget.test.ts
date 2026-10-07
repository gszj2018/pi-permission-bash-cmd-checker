import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { extractCommandObservation } from "../extension/command.ts";
import { SessionState } from "../extension/state.ts";
import type { ClassificationState, CommandRecord, ExplanationState, RiskLevel } from "../extension/types.ts";
import { CommandWidget, WIDGET_KEY, createWidgetController, sanitizeTerminalText, wrapTerminalText } from "../extension/widget.ts";
import { commandDetails, createContext, mockTheme } from "./helpers/mocks.ts";

function record(command = "printf 'a' && printf 'b'"): CommandRecord {
  const observation = extractCommandObservation(commandDetails("request-1", command));
  assert.ok(observation);
  const result = new SessionState().observe(observation);
  assert.ok(result);
  return result;
}

function classified(risk: RiskLevel): ClassificationState {
  return { status: "complete", risk, probabilities: { "safe-ro": 0.5, "safe-rw": 0.5, unsafe: 0 }, confidence: 0.9 };
}

const riskCases: [RiskLevel, string, string][] = [
  ["safe-ro", "✅  Likely Safe (RO)", "100;220;140"],
  ["safe-rw", "ℹ  Likely Safe (RW)", "80;160;255"],
  ["unsafe", "⛔  Dangerous", "255;100;100"],
  ["unknown", "⚠  Unknown", "255;215;0"],
];

test("risk labels use exactly two spaces and concrete semantic colors", () => {
  for (const [risk, text, color] of riskCases) {
    const widget = new CommandWidget({ ...record(), classification: classified(risk) }, () => mockTheme());
    const line = widget.render(200).find((item) => stripTerminalSequences(item) === text);
    assert.ok(line);
    assert.ok(line.includes(`\u001b[38;2;${color}m`));
    assert.equal(stripTerminalSequences(line), text);
  }
});

test("explanation colors depend only on classification, including wrapped text and placeholders", () => {
  const lightColors: Record<RiskLevel, string> = {
    "safe-ro": "0;125;50", "safe-rw": "0;85;205", unsafe: "190;0;0", unknown: "145;110;0",
  };
  const explanations: [ExplanationState, string][] = [
    [{ status: "complete", text: "Deletes data and exposes secrets." }, "Deletes data and exposes secrets."],
    [{ status: "complete", text: "Safely reads a file." }, "Safely reads a file."],
    [{ status: "pending" }, "Analyzing command…"],
    [{ status: "unavailable" }, "Command explanation unavailable."],
  ];
  for (const appearance of ["dark", "light"] as const) {
    for (const [risk, , darkColor] of riskCases) {
      const color = appearance === "dark" ? darkColor : lightColors[risk];
      for (const [explanation, text] of explanations) {
        const widget = new CommandWidget({ ...record(), classification: classified(risk), explanation },
          () => mockTheme(appearance));
        for (const width of [12, 200]) {
          const expected = wrapTerminalText(text, width);
          const lines = widget.render(width).slice(-expected.length);
          assert.deepEqual(lines.map(stripTerminalSequences), expected);
          for (const line of lines) assert.ok(line.includes(`\u001b[38;2;${color}m`));
        }
      }
    }
  }
});

test("all non-assessment notices are yellow, unadorned and distinct from unknown", () => {
  const cases = {
    pending: "Assessing command risk…",
    disabled: "Risk assessment disabled.", unavailable: "Risk assessment unavailable.",
    failed: "Risk assessment failed.", "timed-out": "Risk assessment timed out.",
    "invalid-response": "Risk assessment unavailable: invalid response.",
  } as const;
  for (const appearance of ["dark", "light"] as const) {
    for (const [status, text] of Object.entries(cases)) {
      const classification = { status } as ClassificationState;
      const explanation = "Safely reads a file.";
      const widget = new CommandWidget({
        ...record(), classification, explanation: { status: "complete", text: explanation },
      }, () => mockTheme(appearance));
      const lines = widget.render(200);
      const notice = lines.find((line) => stripTerminalSequences(line) === text);
      assert.ok(notice);
      const yellow = appearance === "dark" ? "255;215;0" : "145;110;0";
      assert.ok(notice.includes(`\u001b[38;2;${yellow}m`));
      const explanationLine = lines.find((line) => stripTerminalSequences(line) === explanation);
      assert.ok(explanationLine);
      assert.ok(explanationLine.includes(`\u001b[38;2;${yellow}m`));
      assert.equal(/[✅ℹ⛔⚠]|Unknown/.test(stripTerminalSequences(notice)), false);
      assert.ok(lines.some((line) => line === "printf 'a' && printf 'b'"));
    }
  }
});

test("pending risk shows progress without a risk badge while explanation and permission status remain visible", () => {
  const widget = new CommandWidget(record(), () => mockTheme());
  let text = widget.render(200).map(stripTerminalSequences).join("\n");
  assert.ok(text.includes("Analyzing command…"));
  assert.ok(text.includes("Assessing command risk…"));
  assert.ok(text.includes("Awaiting approval"));
  assert.equal(/Risk assessment|Likely Safe|Dangerous|Unknown/.test(text), false);
  widget.setRecord({ ...record(), decision: { result: "allow", resolution: "user_approved" } });
  text = widget.render(200).map(stripTerminalSequences).join("\n");
  assert.ok(text.includes("Completed: allow (user_approved)"));
  assert.ok(text.includes("Analyzing command…"));
  widget.setRecord({ ...record(), explanation: { status: "unavailable" } });
  assert.ok(widget.render(200).map(stripTerminalSequences).includes("Command explanation unavailable."));
});

test("terminal controls and directional overrides become visible escapes, with only LF preserved", () => {
  const source = "a\u001b[31m\u001b]8;;https://example.invalid\u0007\r\u009b\u202e\u2066\ufeff\tb\nc";
  const sanitized = sanitizeTerminalText(source);
  assert.equal(sanitized, "a\\u001b[31m\\u001b]8;;https://example.invalid\\u0007\\u000d\\u009b\\u202e\\u2066\\ufeff    b\nc");
  const widget = new CommandWidget({
    ...record(source), explanation: { status: "complete", text: "**plain text**\u001b[2J" },
  }, () => mockTheme());
  const lines = widget.render(200);
  assert.ok(lines.some((line) => line.includes("**plain text**\\u001b[2J")));
  assert.equal(lines.map(stripTerminalSequences).join("\n").includes("\u001b"), false);
  assert.equal(record(source).observation.fullCommand, source);
});

test("request identity, forwarded requester and decision text receive the same terminal sanitization", () => {
  const initial = record();
  const widget = new CommandWidget({
    ...initial,
    observation: {
      ...initial.observation, requestId: "request\u001b[2J",
      requester: { forwarded: true, agentName: "Worker\u202e", sessionId: "child\u009b" },
    },
    decision: { result: "deny", resolution: "user_denied\u0007" },
  }, () => mockTheme());
  const text = widget.render(200).map(stripTerminalSequences).join("\n");
  assert.equal(text.includes("\u001b"), false);
  assert.ok(text.includes("request\\u001b[2J"));
  assert.ok(text.includes("Worker\\u202e"));
  assert.ok(text.includes("child\\u009b"));
  assert.ok(text.includes("user_denied\\u0007"));
});

test("hard wrapping preserves command spaces and graphemes, allowing viewport-wide graphemes to overflow", () => {
  const line = `  printf 'a  b' && printf 中文😀e\u0301 ${"x".repeat(3000)}  `;
  for (const width of [2, 3, 7, 40, 120]) {
    const wrapped = wrapTerminalText(line, width);
    assert.equal(wrapped.join(""), line);
    for (const part of wrapped) assert.ok(visibleWidth(part) <= width);
  }
  assert.deepEqual(wrapTerminalText("a\n\nb\n", 10), ["a", "", "b", ""]);
  const tiny = wrapTerminalText("中😀", 1);
  assert.deepEqual(tiny, ["中", "😀"]);
  assert.equal(tiny.join(""), "中😀");
  for (const part of tiny) assert.equal(visibleWidth(part), 2);
  assert.deepEqual(wrapTerminalText("a中b", 1), ["a", "中", "b"]);
  assert.deepEqual(wrapTerminalText("e\u0301😀", 1), ["e\u0301", "😀"]);
  assert.deepEqual(wrapTerminalText("text", 0), []);
});

test("resize and theme invalidation recompute rendering without stale ANSI colors", () => {
  let theme = mockTheme();
  const widget = new CommandWidget({ ...record(), classification: classified("safe-rw") }, () => theme);
  const wide = widget.render(200);
  assert.equal(widget.render(200), wide);
  const narrow = widget.render(7);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 7);
  theme = mockTheme("light");
  widget.invalidate();
  const light = widget.render(200);
  assert.ok(light.some((line) => line.includes("\u001b[38;2;0;85;205m")));
  assert.equal(light.join("\n").includes("\u001b[38;2;80;160;255m"), false);
  assert.deepEqual(widget.render(0), []);
});

test("widget controller mounts above the editor without focus APIs and updates the existing component", () => {
  const { ui } = createContext();
  const controller = createWidgetController(ui.ui);
  controller.show(record());
  const component = ui.components.get(WIDGET_KEY);
  assert.ok(component);
  assert.equal(component.handleInput, undefined);
  assert.equal(ui.mounts[0]?.placement, "aboveEditor");
  controller.show({ ...record(), explanation: { status: "complete", text: "Updated explanation" } });
  assert.equal(ui.components.get(WIDGET_KEY), component);
  assert.ok(ui.renders > 0);
  assert.ok(ui.text(WIDGET_KEY).includes("Updated explanation"));
  controller.hide();
  controller.hide();
  assert.equal(ui.components.size, 0);
  assert.equal(ui.mounts.length, 2);
  controller.show(record());
  assert.notEqual(ui.components.get(WIDGET_KEY), component);
});
