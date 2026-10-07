import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease, Key, matchesKey, ScrollView, truncateToWidth, visibleWidth, type Component, type KeyId,
  type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { isShortcutPress, shortcutLabel } from "./shortcut.ts";
import { PALETTES, sanitizeTerminalText, wrapTerminalText } from "./terminal-text.ts";

export interface CommandSnapshot {
  readonly requestId: string;
  readonly fullCommand: string;
}

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
