import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth } from "@earendil-works/pi-tui";

// Concrete colors keep risk semantics even when a custom theme changes its semantic tokens.
export const PALETTES = {
  dark: {
    green: rgbColor(100, 220, 140), blue: rgbColor(80, 160, 255),
    red: rgbColor(255, 100, 100), yellow: rgbColor(255, 215, 0),
    commandBackground: rgbColor(35, 55, 80),
  },
  light: {
    green: rgbColor(0, 125, 50), blue: rgbColor(0, 85, 205),
    red: rgbColor(190, 0, 0), yellow: rgbColor(145, 110, 0),
    commandBackground: rgbColor(220, 235, 255),
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

export function renderCommandText(command: string, width: number, theme: Theme): string[] {
  return wrapTerminalText(sanitizeTerminalText(command), width).map((line) =>
    theme.style(line, { bg: PALETTES[theme.appearance].commandBackground }));
}
