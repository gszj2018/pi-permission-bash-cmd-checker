import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { extractCommandObservation } from "../extension/command.ts";
import type { CommandViewerSource } from "../extension/command-viewer-controller.ts";
import { SessionState } from "../extension/state.ts";
import type { ClassificationState, CommandRecord, ExplanationState, RiskLevel } from "../extension/types.ts";
import {
  CommandWidget, MAX_COMMAND_PREVIEW_LINES, WIDGET_KEY, createWidgetController, sanitizeTerminalText, wrapTerminalText,
} from "../extension/widget.ts";
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

test("commands have a theme-aware background independent of risk while the heading remains unstyled", () => {
  for (const appearance of ["dark", "light"] as const) {
    for (const [risk] of riskCases) {
      const current = record();
      const widget = new CommandWidget({ ...current, classification: classified(risk) }, () => mockTheme(appearance));
      const lines = widget.render(200);
      const heading = lines.find((line) => stripTerminalSequences(line) === "Command:");
      assert.equal(heading, "Command:");
      const command = lines.find((line) => stripTerminalSequences(line) === current.observation.fullCommand);
      assert.ok(command);
      const background = appearance === "dark" ? "35;55;80" : "220;235;255";
      assert.ok(command.includes(`\u001b[48;2;${background}m`));
      assert.equal(command.includes("\u001b[38;"), false);
      assert.ok(command.endsWith("\u001b[49m"));
    }
  }
});

test("command backgrounds preserve complete sanitized text, spaces and graphemes across wrapping", () => {
  const source = "  printf 'a  b' && printf '中😀e\u0301'\n\nprintf '\u001b[2J'  ";
  const current = record(source);
  for (const appearance of ["dark", "light"] as const) {
    const widget = new CommandWidget(current, () => mockTheme(appearance));
    const background = appearance === "dark" ? "35;55;80" : "220;235;255";
    for (const width of [1, 7, 40]) {
      const lines = widget.render(width).filter((line) => line.includes(`\u001b[48;2;${background}m`));
      assert.deepEqual(lines.map(stripTerminalSequences),
        wrapTerminalText(sanitizeTerminalText(source), width).slice(0, MAX_COMMAND_PREVIEW_LINES));
      for (const line of lines) assert.ok(line.endsWith("\u001b[49m"));
    }
  }
  assert.equal(current.observation.fullCommand, source);
});

test("command previews cap wrapped content at eight lines without altering the snapshot or other analysis", () => {
  for (const appearance of ["dark", "light"] as const) {
    for (const count of [7, 8, 9, 20]) {
      const source = Array.from({ length: count }, (_, index) => `printf '${index}'`).join("\n");
      const current = record(source);
      const widget = new CommandWidget({ ...current, classification: classified("unsafe"),
        explanation: { status: "complete", text: "Explains the entire command." } }, () => mockTheme(appearance), "alt+m");
      const lines = widget.render(200);
      const background = appearance === "dark" ? "35;55;80" : "220;235;255";
      const command = lines.filter((line) => line.includes(`\u001b[48;2;${background}m`));
      assert.deepEqual(command.map(stripTerminalSequences), source.split("\n").slice(0, 8));
      const hint = lines.find((line) => stripTerminalSequences(line).startsWith("Command truncated."));
      assert.equal(hint !== undefined, count > 8);
      if (hint) {
        assert.ok(stripTerminalSequences(hint).includes("Alt+m"));
        assert.equal(stripTerminalSequences(hint).includes("Alt+c"), false);
        const yellow = appearance === "dark" ? "255;215;0" : "145;110;0";
        assert.ok(hint.includes(`\u001b[38;2;${yellow}m`));
      }
      assert.ok(lines.map(stripTerminalSequences).includes("⛔  Dangerous"));
      assert.ok(lines.map(stripTerminalSequences).includes("Explains the entire command."));
      assert.equal(current.observation.fullCommand, source);
      assert.equal(widget.snapshot().fullCommand, source);
      assert.ok(Object.isFrozen(widget.snapshot()));
    }
  }
  const widget = new CommandWidget(record("x".repeat(90)), () => mockTheme());
  const narrow = widget.render(10);
  assert.equal(narrow.filter((line) => line.includes("\u001b[48;2;35;55;80m")).length, 8);
  assert.ok(narrow.map(stripTerminalSequences).join("").includes("Command truncated."));
  assert.equal(widget.render(200).map(stripTerminalSequences).join("\n").includes("Command truncated."), false);
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
      assert.ok(lines.some((line) => stripTerminalSequences(line) === "printf 'a' && printf 'b'"));
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
  assert.ok(light.some((line) => line.includes("\u001b[48;2;220;235;255m")));
  assert.equal(light.join("\n").includes("\u001b[38;2;80;160;255m"), false);
  assert.equal(light.join("\n").includes("\u001b[48;2;35;55;80m"), false);
  assert.deepEqual(widget.render(0), []);
});

test("widget controller mounts above the editor without focus APIs and updates the existing component", (t) => {
  const { ui } = createContext();
  const snapshots: string[] = [];
  let cleared = 0;
  let disposed = 0;
  const source: CommandViewerSource = {
    update(snapshot, owner) { snapshots.push(snapshot.fullCommand); assert.equal(owner, ui.tui); },
    clear() { cleared++; },
    dispose() { disposed++; },
  };
  const viewer = {
    createSource: () => source,
    dispose() { assert.fail("Widget disposal must not dispose the viewer controller."); },
  };
  const controller = createWidgetController(ui.ui, viewer);
  t.after(() => controller.dispose());
  assert.equal(ui.inputHandlers.size, 0);
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
  assert.equal(snapshots.length, 3);
  assert.equal(cleared, 2);
  controller.dispose();
  controller.dispose();
  assert.equal(disposed, 1);
  assert.equal(ui.inputHandlers.size, 0);
});
