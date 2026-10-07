import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth, type Color, type Component } from "@earendil-works/pi-tui";
import type { ClassificationState, CommandRecord, RiskLevel } from "./types.ts";

export const WIDGET_KEY = "bash-cmd-checker";

const RISK_TEXT: Record<RiskLevel, string> = {
  "safe-ro": "✅  Likely Safe (RO)",
  "safe-rw": "ℹ  Likely Safe (RW)",
  unsafe: "⛔  Dangerous",
  unknown: "⚠  Unknown",
};
const CLASSIFICATION_NOTICE = {
  pending: "Assessing command risk…",
  disabled: "Risk assessment disabled.",
  unavailable: "Risk assessment unavailable.",
  failed: "Risk assessment failed.",
  "timed-out": "Risk assessment timed out.",
  "invalid-response": "Risk assessment unavailable: invalid response.",
} as const;

// Concrete colors keep risk semantics even when a custom theme changes its semantic tokens.
const PALETTES = {
  dark: {
    green: rgbColor(100, 220, 140), blue: rgbColor(80, 160, 255),
    red: rgbColor(255, 100, 100), yellow: rgbColor(255, 215, 0),
  },
  light: {
    green: rgbColor(0, 125, 50), blue: rgbColor(0, 85, 205),
    red: rgbColor(190, 0, 0), yellow: rgbColor(145, 110, 0),
  },
};
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Render controls visibly instead of interpreting provider/command text as terminal instructions. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(/\t/g, "    ").replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Hard-wrap without dropping spaces or splitting graphemes; a grapheme wider than the viewport may overflow. */
export function wrapTerminalText(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) return [];
  const lines: string[] = [];
  for (const source of text.split("\n")) {
    let line = "";
    let columns = 0;
    const append = (part: string): void => {
      const size = visibleWidth(part);
      if (columns + size > width && columns > 0) {
        lines.push(line);
        line = "";
        columns = 0;
      }
      line += part;
      columns += size;
    };
    for (const { segment } of segmenter.segment(source)) append(segment);
    lines.push(line);
  }
  return lines;
}

function riskDisplay(classification: ClassificationState): { text: string; color: "green" | "blue" | "red" | "yellow" } {
  if (classification.status !== "complete") {
    return { text: CLASSIFICATION_NOTICE[classification.status], color: "yellow" };
  }
  const color = classification.risk === "safe-ro" ? "green" : classification.risk === "safe-rw" ? "blue"
    : classification.risk === "unsafe" ? "red" : "yellow";
  return { text: RISK_TEXT[classification.risk], color };
}

/** Non-interactive component: never owns focus or handles terminal input. */
export class CommandWidget implements Component {
  private cache: { width: number; record: CommandRecord; theme: Theme; lines: string[] } | undefined;

  constructor(private record: CommandRecord, private readonly getTheme: () => Theme) {}

  setRecord(record: CommandRecord): void { this.record = record; this.invalidate(); }
  invalidate(): void { this.cache = undefined; }

  render(width: number): string[] {
    if (!Number.isInteger(width) || width < 1) return [];
    const theme = this.getTheme();
    if (this.cache?.width === width && this.cache.record === this.record && this.cache.theme === theme) {
      return this.cache.lines;
    }
    const record = this.record;
    const palette = PALETTES[theme.appearance];
    const lines: string[] = [];
    const add = (text: string, color?: Color): void => {
      for (const line of wrapTerminalText(sanitizeTerminalText(text), width)) {
        lines.push(color ? theme.style(line, { fg: color }) : line);
      }
    };
    const status = record.decision ? `Completed: ${record.decision.result} (${record.decision.resolution})`
      : "Awaiting approval";
    add(`Bash command · Request: ${record.observation.requestId} · ${status}`);
    const requester = record.observation.requester;
    if (requester.forwarded) {
      add(`Requester: ${requester.agentName ?? "Subagent"} · Session: ${requester.sessionId ?? "unknown"}`);
    } else if (requester.agentName !== null) add(`Requester: ${requester.agentName}`);
    const risk = riskDisplay(record.classification);
    add(risk.text, palette[risk.color]);
    add("Command:");
    add(record.observation.fullCommand);
    add("Explanation:");
    add(record.explanation.status === "complete" ? record.explanation.text
      : record.explanation.status === "pending" ? "Analyzing command…" : "Command explanation unavailable.");
    this.cache = { width, record, theme, lines };
    return lines;
  }
}

export interface WidgetController {
  show(record: CommandRecord): void;
  hide(): void;
}

export function createWidgetController(ui: Pick<ExtensionUIContext, "setWidget" | "theme">): WidgetController {
  let component: CommandWidget | undefined;
  let requestRender: (() => void) | undefined;
  return {
    show(record) {
      if (component) {
        component.setRecord(record);
        requestRender?.();
        return;
      }
      ui.setWidget(WIDGET_KEY, (tui) => {
        component = new CommandWidget(record, () => ui.theme);
        requestRender = () => tui.requestRender();
        return component;
      }, { placement: "aboveEditor" });
    },
    hide() {
      if (!component) return;
      component = undefined;
      requestRender = undefined;
      ui.setWidget(WIDGET_KEY, undefined);
    },
  };
}
