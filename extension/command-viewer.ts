import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease, isKeyRepeat, Key, matchesKey, ScrollView, truncateToWidth, visibleWidth, type Component, type KeyId,
  type OverlayHandle, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { DEFAULT_COMMAND_VIEWER_SHORTCUT, isShortcutPress, shortcutLabel } from "./shortcut.ts";
import { PALETTES, sanitizeTerminalText, wrapTerminalText } from "./terminal-text.ts";
import type { CommandSnapshot, CommandViewerController } from "./types.ts";

/** One immutable command interaction, independent of the live widget and permission events. */
export class CommandViewer implements Component {
  readonly scrollView: ScrollView;
  private readonly snapshot: CommandSnapshot;
  private contentCache: { width: number; lines: string[] } | undefined;
  private lastWidth: number | undefined;
  private closed = false;

  constructor(
    snapshot: CommandSnapshot,
    private readonly shortcut: KeyId,
    private readonly getTheme: () => Theme,
    private readonly getSize: () => { width: number; height: number },
    private readonly requestRender: () => void,
    private readonly close: (key: KeyId) => void,
  ) {
    this.snapshot = Object.freeze({ ...snapshot });
    this.scrollView = new ScrollView({
      render: (width) => {
        if (!this.contentCache || this.contentCache.width !== width) {
          this.contentCache = {
            width, lines: wrapTerminalText(sanitizeTerminalText(this.snapshot.fullCommand), width),
          };
        }
        return this.contentCache.lines;
      },
      invalidate: () => { this.contentCache = undefined; },
    }, { follow: "none", overscroll: "contain", scrollbar: "hidden" });
  }

  invalidate(): void { this.contentCache = undefined; }
  dispose(): void { this.closed = true; this.contentCache = undefined; }

  render(width: number): string[] {
    if (this.closed || !Number.isInteger(width) || width < 1) return [];
    this.lastWidth = width;
    const height = Math.max(1, Math.floor(this.getSize().height));
    const theme = this.getTheme();
    const palette = PALETTES[theme.appearance];
    const bordered = width >= 3 && height >= 3;
    const innerWidth = bordered ? width - 2 : width;
    const innerHeight = height - (bordered ? 2 : 0);
    const showControls = bordered && innerHeight >= 5;
    const title = sanitizeTerminalText(`Bash command · Request: ${this.snapshot.requestId}`).replace(/\n/g, "\\n");
    const header = showControls ? [truncateToWidth(title, innerWidth)] : [];
    const hint = `Esc/q/Enter/${shortcutLabel(this.shortcut)} Close · ↑/↓ Scroll · PgUp/PgDn Page · Home/End`;
    const footer = showControls ? wrapTerminalText(hint, innerWidth).slice(0, innerHeight - 4) : [];
    const content = this.scrollView.render(innerWidth);
    const viewportHeight = Math.min(content.length, innerHeight - header.length - footer.length - (showControls ? 2 : 0));
    // Line-array overlays need an explicit ScrollView viewport, excluding the frame and both separators.
    this.scrollView.updateLayout(content.length, viewportHeight, this.requestRender);
    const background = (line: string): string => theme.style(line, { bg: palette.commandBackground });
    const row = (line: string, footerRow = false): string => {
      const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      const text = footerRow ? theme.style(padded, { fg: palette.yellow }) : padded;
      return background(bordered ? `│${text}│` : text);
    };
    const divider = background(`├${"─".repeat(innerWidth)}┤`);
    const lines: string[] = [];
    if (bordered) lines.push(background(`┌${"─".repeat(innerWidth)}┐`));
    if (showControls) lines.push(row(header[0]!), divider);
    lines.push(...content.slice(this.scrollView.scrollTop, this.scrollView.scrollTop + viewportHeight).map((line) => row(line)));
    if (showControls) lines.push(divider, ...footer.map((line) => row(line, true)));
    if (bordered) lines.push(background(`└${"─".repeat(innerWidth)}┘`));
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== "wheel") return;
    this.render(event.width);
    this.scrollView.scrollBy(event.wheelDelta ?? 0);
    return { handled: true };
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    const closeKey = matchesKey(data, Key.escape) ? Key.escape : matchesKey(data, "q") ? "q"
      : matchesKey(data, Key.enter) ? Key.enter : isShortcutPress(data, this.shortcut) ? this.shortcut : undefined;
    if (closeKey) {
      this.closed = true;
      this.close(closeKey);
      return;
    }
    // Also synchronize bounds before input that arrives ahead of the first render or just after a resize.
    this.render(this.lastWidth ?? this.getSize().width);
    if (matchesKey(data, Key.up)) this.scrollView.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollView.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollView.scrollBy(-this.scrollView.viewportHeight);
    else if (matchesKey(data, Key.pageDown)) this.scrollView.scrollBy(this.scrollView.viewportHeight);
    else if (matchesKey(data, Key.home)) this.scrollView.scrollToStart();
    else if (matchesKey(data, Key.end)) this.scrollView.scrollToEnd();
  }
}

interface ViewerSlot {
  interaction?: ViewerInteraction;
  closingKey?: KeyId;
}

interface ViewerInteraction {
  mounting: boolean;
  hiding: boolean;
  closeRequested: boolean;
  component?: CommandViewer;
  handle?: OverlayHandle;
}

type ViewerUi = Pick<ExtensionUIContext, "theme" | "onTerminalInput">;

/** Owns input and overlay lifetime; command sources cannot close or dispose an open viewer. */
export function createCommandViewerController(
  ui: ViewerUi,
  shortcut: KeyId = DEFAULT_COMMAND_VIEWER_SHORTCUT,
): CommandViewerController {
  // One private slot per controller, reserved throughout synchronous/reentrant creation and closing.
  const slot: ViewerSlot = {};
  let currentSource: { token: symbol; snapshot: CommandSnapshot; owner: TUI } | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const closeViewer = (interaction: ViewerInteraction): void => {
    interaction.closeRequested = true;
    interaction.component?.dispose();
    if (interaction.mounting || interaction.hiding) return;
    interaction.hiding = true;
    try {
      interaction.handle?.hide();
      interaction.handle = undefined;
      if (slot.interaction === interaction) slot.interaction = undefined;
    } catch {
      // Keep the slot reserved if hiding fails; a later close can retry without creating a second overlay.
    } finally { interaction.hiding = false; }
  };

  const openViewer = (snapshot: CommandSnapshot, tui: TUI): void => {
    const interaction: ViewerInteraction = { mounting: true, hiding: false, closeRequested: false };
    slot.interaction = interaction;
    try {
      interaction.component = new CommandViewer(snapshot, shortcut, () => ui.theme, () => ({
        width: Math.max(1, Math.floor(tui.terminal.columns * 0.9)),
        height: Math.max(1, Math.floor(tui.terminal.rows * 0.8)),
      }), () => tui.requestRender(), (key) => {
        slot.closingKey = key;
        closeViewer(interaction);
      });
      // Own the public handle; ctx.ui.custom's completion may hide an unrelated last-created overlay.
      interaction.handle = tui.showOverlay(interaction.component, { width: "90%", maxHeight: "80%", anchor: "center" });
    } catch { interaction.closeRequested = true; }
    finally {
      interaction.mounting = false;
      if (disposed || interaction.closeRequested) closeViewer(interaction);
    }
  };

  try {
    unsubscribe = ui.onTerminalInput((data) => {
      if (disposed) return;
      // Closing-key suppression belongs to this controller, not to any live command source.
      if (slot.closingKey && matchesKey(data, slot.closingKey)) {
        if (isKeyRelease(data)) { slot.closingKey = undefined; return { consume: true }; }
        if (isKeyRepeat(data)) return { consume: true };
        slot.closingKey = undefined;
      }
      if (!matchesKey(data, shortcut)) return;
      const source = currentSource;
      if (!slot.interaction && !source) return;
      if (isShortcutPress(data, shortcut)) {
        if (slot.interaction) {
          slot.closingKey = shortcut;
          closeViewer(slot.interaction);
        } else if (source) openViewer(source.snapshot, source.owner);
      }
      return { consume: true };
    });
  } catch {
    // Input-listener failure must not disable command analysis or permission decisions.
  }

  return {
    createSource() {
      const source = Symbol("command-viewer-source");
      let released = false;
      const clear = (): void => {
        if (currentSource?.token === source) currentSource = undefined;
      };
      return {
        update(snapshot, tui) {
          if (disposed || released) return;
          // Only the latest update is retained; clearing it must not restore an older command.
          currentSource = { token: source, snapshot: Object.freeze({ ...snapshot }), owner: tui };
        },
        clear,
        dispose() { released = true; clear(); },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      currentSource = undefined;
      try { unsubscribe?.(); } catch {}
      if (slot.interaction) closeViewer(slot.interaction);
      slot.closingKey = undefined;
    },
  };
}
