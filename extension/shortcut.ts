import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from "@earendil-works/pi-tui";

export const DEFAULT_COMMAND_VIEWER_SHORTCUT: KeyId = "alt+c";

// Require at least one non-repeated modifier; bare keys must not toggle the viewer.
// Exclude escape/esc, clear and function keys from configuration; Escape remains a fixed viewer close key.
// Omit '+' as a base key because the host splits identifiers on '+'; use explicit shift+= instead.
export const COMMAND_VIEWER_SHORTCUT_PATTERN =
  "^(?!.*\\b(ctrl|alt|shift|super)\\+.*\\b\\1\\+)" +
  "(?:(?:ctrl|alt|shift|super)\\+){1,4}" +
  "(?:[a-z0-9\\x60=\\[\\]\\\\;'.,/!@#$%^&*()_|~{}:<>?\\-]|" +
  "enter|return|tab|space|backspace|delete|insert|home|end|pageUp|pageDown|up|down|left|right)" +
  "(?![\\s\\S])";
const shortcutPattern = new RegExp(COMMAND_VIEWER_SHORTCUT_PATTERN);

export function isCommandViewerShortcut(value: unknown): value is KeyId {
  return typeof value === "string" && shortcutPattern.test(value);
}

/** A held or released toggle key must not immediately reopen or close the viewer. */
export function isShortcutPress(data: string, shortcut: KeyId): boolean {
  return !isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, shortcut);
}

export function shortcutLabel(shortcut: KeyId): string {
  return shortcut.replace(/\b(ctrl|alt|shift|super)\b/g, (modifier) =>
    modifier[0]!.toUpperCase() + modifier.slice(1));
}
