import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from "@earendil-works/pi-tui";

export const DEFAULT_COMMAND_VIEWER_SHORTCUT: KeyId = "alt+c";

// Reserve viewer controls; omit '+' as a base key because the host splits identifiers on '+'.
// The equivalent explicit shift+= binding is supported. Modifiers must not repeat.
export const COMMAND_VIEWER_SHORTCUT_PATTERN =
  "^(?!(?:escape|esc|q|enter|return|up|down|pageUp|pageDown|home|end)$)" +
  "(?!.*\\b(ctrl|alt|shift|super)\\+.*\\b\\1\\+)" +
  "(?:(?:ctrl|alt|shift|super)\\+){0,4}" +
  "(?:[a-z0-9\\x60=\\[\\]\\\\;'.,/!@#$%^&*()_|~{}:<>?\\-]|" +
  "escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageUp|pageDown|up|down|left|right|f(?:[1-9]|1[0-2]))" +
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
