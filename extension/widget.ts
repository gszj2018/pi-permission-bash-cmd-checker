import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease, isKeyRepeat, matchesKey, type Color, type Component, type KeyId, type OverlayHandle, type TUI,
} from "@earendil-works/pi-tui";
import { CommandViewer, type CommandSnapshot } from "./command-viewer.ts";
import { DEFAULT_COMMAND_VIEWER_SHORTCUT, isShortcutPress, shortcutLabel } from "./shortcut.ts";
import { PALETTES, renderCommandText, sanitizeTerminalText, wrapTerminalText } from "./terminal-text.ts";
import type { ClassificationState, CommandRecord, RiskLevel } from "./types.ts";

export { sanitizeTerminalText, wrapTerminalText } from "./terminal-text.ts";

export const WIDGET_KEY = "bash-cmd-checker";
export const MAX_COMMAND_PREVIEW_LINES = 8;

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

  constructor(
    private record: CommandRecord,
    private readonly getTheme: () => Theme,
    private readonly shortcut: KeyId = DEFAULT_COMMAND_VIEWER_SHORTCUT,
  ) {}

  snapshot(): CommandSnapshot {
    return Object.freeze({ requestId: this.record.observation.requestId, fullCommand: this.record.observation.fullCommand });
  }

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
    const lines: string[] = ["─".repeat(width)];
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
    add("Command:");
    const commandLines = renderCommandText(record.observation.fullCommand, width, theme);
    lines.push(...commandLines.slice(0, MAX_COMMAND_PREVIEW_LINES));
    if (commandLines.length > MAX_COMMAND_PREVIEW_LINES) {
      add(`Command truncated. Press ${shortcutLabel(this.shortcut)} to view the full command.`, palette.yellow);
    }
    const risk = riskDisplay(record.classification);
    add(risk.text, palette[risk.color]);
    const explanation = record.explanation.status === "complete" ? record.explanation.text
      : record.explanation.status === "pending" ? "Analyzing command…" : "Command explanation unavailable.";
    add(explanation, palette[risk.color]);
    this.cache = { width, record, theme, lines };
    return lines;
  }
}

export interface WidgetController {
  show(record: CommandRecord): void;
  hide(): void;
  dispose(): void;
}

interface ViewerInteraction {
  closeRequested: boolean;
  component?: CommandViewer;
  handle?: OverlayHandle;
}

type WidgetUi = Pick<ExtensionUIContext, "setWidget" | "theme" | "onTerminalInput">;

export function createWidgetController(
  ui: WidgetUi,
  shortcut: KeyId = DEFAULT_COMMAND_VIEWER_SHORTCUT,
): WidgetController {
  let component: CommandWidget | undefined;
  let tui: TUI | undefined;
  let viewer: ViewerInteraction | undefined;
  let closingKey: KeyId | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const closeViewer = (interaction = viewer): void => {
    if (!interaction) return;
    interaction.closeRequested = true;
    interaction.component?.dispose();
    try { interaction.handle?.hide(); } catch {}
    if (viewer === interaction) viewer = undefined;
  };

  const openViewer = (snapshot: CommandSnapshot, owner: TUI): void => {
    const interaction: ViewerInteraction = { closeRequested: false };
    viewer = interaction;
    try {
      interaction.component = new CommandViewer(snapshot, shortcut, () => ui.theme, () => ({
        width: Math.max(1, Math.floor(owner.terminal.columns * 0.9)),
        height: Math.max(1, Math.floor(owner.terminal.rows * 0.8)),
      }), () => owner.requestRender(), (key) => { closingKey = key; closeViewer(interaction); });
      // Own this public TUI overlay directly: ctx.ui.custom's completion hides the last-created overlay.
      interaction.handle = owner.showOverlay(interaction.component,
        { width: "90%", maxHeight: "80%", anchor: "center" });
      if (disposed || interaction.closeRequested) closeViewer(interaction);
    } catch { closeViewer(interaction); }
  };

  try {
    unsubscribe = ui.onTerminalInput((data) => {
      if (disposed) return;
      // A reported held/released close key must not edit or approve the underlying UI after dismissal.
      if (closingKey && matchesKey(data, closingKey)) {
        if (isKeyRelease(data)) { closingKey = undefined; return { consume: true }; }
        if (isKeyRepeat(data)) return { consume: true };
        closingKey = undefined;
      }
      if (matchesKey(data, shortcut)) {
        if (!viewer && (!component || !tui)) return;
        if (isShortcutPress(data, shortcut)) {
          if (viewer) { closingKey = shortcut; closeViewer(); }
          else if (component && tui) openViewer(component.snapshot(), tui);
        }
        return { consume: true };
      }
    });
  } catch {
    // Input-listener failure must not disable command analysis or permission decisions.
  }

  const hide = (): void => {
    if (!component) return;
    component = undefined;
    tui = undefined;
    ui.setWidget(WIDGET_KEY, undefined);
  };
  return {
    show(record) {
      if (disposed) return;
      if (component) {
        component.setRecord(record);
        tui?.requestRender();
        return;
      }
      try {
        ui.setWidget(WIDGET_KEY, (owner) => {
          component = new CommandWidget(record, () => ui.theme, shortcut);
          tui = owner;
          return component;
        }, { placement: "aboveEditor" });
      } catch (error) {
        component = undefined;
        tui = undefined;
        throw error;
      }
    },
    hide,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unsubscribe?.(); } catch {}
      closeViewer();
      hide();
    },
  };
}
