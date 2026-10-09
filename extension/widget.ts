import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Color, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import {
  launchExternalViewer, prepareCommandFile, type ViewerFileDependencies, type ViewerProcessDependencies,
} from "./external-viewer.ts";
import { DEFAULT_COMMAND_VIEWER_SHORTCUT, isShortcutPress, shortcutLabel } from "./shortcut.ts";
import { PALETTES, renderCommandText, sanitizeTerminalText, wrapTerminalText } from "./terminal-text.ts";
import type {
  ClassificationState, CommandRecord, CommandSnapshot, ExternalViewerConfig, RiskLevel,
} from "./types.ts";
import { notifyError, notifyWarning } from "./utils-pi.ts";

export { sanitizeTerminalText, wrapTerminalText } from "./terminal-text.ts";

export const WIDGET_KEY = "bash-cmd-checker";
export const MAX_COMMAND_PREVIEW_LINES = 4;

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

export interface ExternalViewerDependencies {
  readonly files: ViewerFileDependencies;
  readonly processes: ViewerProcessDependencies;
}

type WidgetUi = Pick<ExtensionUIContext, "setWidget" | "theme" | "custom" | "onTerminalInput" | "notify">;

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
      : record.verdictSettled ? "Awaiting approval" : "Assessing command…";
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

export function createWidgetController(
  ui: WidgetUi,
  sessionId: string,
  viewerConfig: ExternalViewerConfig,
  dependencies: ExternalViewerDependencies,
  shortcut: KeyId = DEFAULT_COMMAND_VIEWER_SHORTCUT,
): WidgetController {
  let component: CommandWidget | undefined;
  let tui: TUI | undefined;
  let disposed = false;
  let busy = false;
  let unsubscribe: (() => void) | undefined;

  const open = async (snapshot: CommandSnapshot): Promise<void> => {
    busy = true;
    try {
      if (viewerConfig.command === null) {
        notifyWarning(ui, "No external viewer command is configured.");
        return;
      }
      let path: string;
      try { path = prepareCommandFile(sessionId, viewerConfig.filePath, snapshot.fullCommand, dependencies.files); } catch {
        if (!disposed) notifyError(ui, "Failed to prepare the command file for the external viewer.");
        return;
      }
      const result = await launchExternalViewer(ui, viewerConfig, path, dependencies.processes);
      if (disposed) return;
      if (result === "failed") notifyError(ui, "Failed to run the external viewer.");
      else if (result === "terminal-failed") {
        notifyError(ui, "Failed to restore the terminal after running the external viewer.");
      } else if (result === "unconfigured") notifyWarning(ui, "No external viewer command is configured.");
    } catch {
      if (!disposed) notifyError(ui, "Failed to run the external viewer.");
    } finally { busy = false; }
  };

  try {
    unsubscribe = ui.onTerminalInput((data) => {
      if (disposed || !component || !matchesKey(data, shortcut)) return;
      if (!busy && isShortcutPress(data, shortcut)) void open(component.snapshot());
      return { consume: true };
    });
  } catch { notifyError(ui, "Failed to register external viewer input handling."); }

  const hide = (): void => {
    if (!component) return;
    component = undefined;
    tui = undefined;
    ui.setWidget(WIDGET_KEY, undefined);
  };
  return {
    show(record) {
      if (disposed) return;
      try {
        if (component && tui) {
          component.setRecord(record);
          tui.requestRender();
          return;
        }
        ui.setWidget(WIDGET_KEY, (owner) => {
          if (disposed) return { render: () => [], invalidate() {} };
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
      unsubscribe = undefined;
      hide();
    },
  };
}
