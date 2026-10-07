import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_VIEWER_SHORTCUT_PATTERN, DEFAULT_COMMAND_VIEWER_SHORTCUT, isCommandViewerShortcut,
  isShortcutPress, shortcutLabel,
} from "../extension/shortcut.ts";

const toggle = "\u001b[59;5u";

test("shortcut syntax preserves canonical Pi identifiers and rejects invalid or repeated modifiers", () => {
  const schemaPattern = new RegExp(COMMAND_VIEWER_SHORTCUT_PATTERN);
  for (const key of ["alt+c", "ctrl+;", "alt+m", "ctrl+shift+=", "ctrl+\\",
    "shift+ctrl+alt+super+pageDown", "ctrl+enter"]) {
    assert.equal(isCommandViewerShortcut(key), true, key);
    assert.equal(schemaPattern.test(key), true, key);
  }
  for (const key of ["", "ctrl+ctrl+x", "alt+ctrl+alt+x", "shift+shift+m", "super+super+k", "Ctrl+;", "ctrl+;\n",
    " ctrl+;", "ctrl+; ", "ctrl+f13", "unknown", "escape", "esc", "q", "enter", "return", "up", "down", "pageUp",
    "pageDown", "home", "end", "ctrl+", "ctrl++", "+", "ctrl+x+alt", "meta+k"]) {
    assert.equal(isCommandViewerShortcut(key), false, key);
    assert.equal(schemaPattern.test(key), false, key);
  }
  assert.equal(isCommandViewerShortcut(null), false);
  assert.equal(shortcutLabel(DEFAULT_COMMAND_VIEWER_SHORTCUT), "Alt+c");
  assert.equal(shortcutLabel("ctrl+;"), "Ctrl+;");
  assert.equal(shortcutLabel("alt+ctrl+v"), "Alt+Ctrl+v");
});

test("every supported base key requires at least one modifier to toggle the viewer", () => {
  const pattern = new RegExp(COMMAND_VIEWER_SHORTCUT_PATTERN);
  const baseKeys = [
    ..."abcdefghijklmnopqrstuvwxyz0123456789`=[]\\;'.,/!@#$%^&*()_|~{}:<>?-",
    "enter", "return", "tab", "space", "backspace", "delete", "insert", "home", "end",
    "pageUp", "pageDown", "up", "down", "left", "right",
  ];
  for (const baseKey of baseKeys) {
    assert.equal(isCommandViewerShortcut(baseKey), false, baseKey);
    assert.equal(pattern.test(baseKey), false, baseKey);
    for (const modifier of ["ctrl", "alt", "shift", "super"]) {
      const shortcut = `${modifier}+${baseKey}`;
      assert.equal(isCommandViewerShortcut(shortcut), true, shortcut);
      assert.equal(pattern.test(shortcut), true, shortcut);
    }
  }
});

test("excluded base keys cannot be configured as viewer shortcuts, even with modifiers", () => {
  const pattern = new RegExp(COMMAND_VIEWER_SHORTCUT_PATTERN);
  const excludedKeys = ["escape", "esc", "clear", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)];
  for (const prefix of ["", "ctrl+", "alt+", "shift+", "super+", "ctrl+alt+", "shift+ctrl+alt+super+"]) {
    for (const baseKey of excludedKeys) {
      const shortcut = `${prefix}${baseKey}`;
      assert.equal(isCommandViewerShortcut(shortcut), false, shortcut);
      assert.equal(pattern.test(shortcut), false, shortcut);
    }
  }
});

test("toggle matching requires the actual combination and ignores key repeat and release without global protocol changes", () => {
  assert.equal(DEFAULT_COMMAND_VIEWER_SHORTCUT, "alt+c");
  assert.equal(isShortcutPress("\u001bc", DEFAULT_COMMAND_VIEWER_SHORTCUT), true);
  assert.equal(isShortcutPress("\u001b[99;3u", DEFAULT_COMMAND_VIEWER_SHORTCUT), true);
  assert.equal(isShortcutPress("c", DEFAULT_COMMAND_VIEWER_SHORTCUT), false);
  assert.equal(isShortcutPress("\u001b[99;3:2u", DEFAULT_COMMAND_VIEWER_SHORTCUT), false);
  assert.equal(isShortcutPress("\u001b[99;3:3u", DEFAULT_COMMAND_VIEWER_SHORTCUT), false);
  assert.equal(isShortcutPress(toggle, "ctrl+;"), true);
  assert.equal(isShortcutPress(";", "ctrl+;"), false);
  assert.equal(isShortcutPress("\u001b[59;5:2u", "ctrl+;"), false);
  assert.equal(isShortcutPress("\u001b[59;5:3u", "ctrl+;"), false);
  assert.equal(isShortcutPress("\u001bm", "alt+m"), true);
  assert.equal(isShortcutPress(toggle, "alt+m"), false);
  assert.equal(isShortcutPress("\u001b[61;6u", "ctrl+shift+="), true);
});
