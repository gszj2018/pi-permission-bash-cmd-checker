import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ScrollView, stripTerminalSequences, visibleWidth, type KeyId, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { CommandViewer, createCommandViewerController } from "../extension/command-viewer.ts";
import { sanitizeTerminalText, wrapTerminalText } from "../extension/terminal-text.ts";
import { MockUi, mockTheme } from "./helpers/mocks.ts";

const toggle = "\u001bc";
const alternate = "\u001bm";

function commandLines(viewer: CommandViewer, width: number): string[] {
  const lines = viewer.render(width).map(stripTerminalSequences);
  if (width < 3 || !lines[0]?.startsWith("┌")) return lines;
  let rows = lines.slice(1, -1);
  const firstDivider = rows.findIndex((line) => line.startsWith("├"));
  if (firstDivider !== -1) {
    const lastDivider = rows.length - 1 - rows.slice().reverse().findIndex((line) => line.startsWith("├"));
    rows = rows.slice(firstDivider + 1, lastDivider);
  }
  return rows.map((line) => line.slice(1, -1));
}

function padded(lines: string[], width: number): string[] {
  return lines.map((line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))));
}

function setup(source: string, height = 12, width = 120) {
  let closes = 0;
  let renders = 0;
  const size = { width, height };
  const snapshot = { requestId: "snapshot-request", fullCommand: source };
  let theme = mockTheme();
  const viewer = new CommandViewer(snapshot, "alt+c", () => theme, () => size, () => { renders++; }, () => { closes++; });
  return { viewer, size, snapshot, setTheme: () => { theme = mockTheme("light"); },
    get closes() { return closes; }, get renders() { return renders; } };
}

function setupController(t: TestContext, ui = new MockUi(), shortcut?: KeyId) {
  const viewer = createCommandViewerController(ui.ui, shortcut);
  const source = viewer.createSource();
  t.after(() => { source.dispose(); viewer.dispose(); });
  return { ui, viewer, source };
}

test("the full-command viewer uses ScrollView, bounded height, complete content and real scroll bounds", () => {
  const source = Array.from({ length: 40 }, (_, index) => `printf '${index}'`).join("\n");
  const app = setup(source);
  assert.ok(app.viewer.scrollView instanceof ScrollView);
  const initial = commandLines(app.viewer, 120);
  assert.equal(initial.length, 6);
  assert.deepEqual(initial, padded(source.split("\n").slice(0, 6), 118));
  assert.equal(app.viewer.render(120).length, 12);
  assert.ok(app.viewer.render(120).map(stripTerminalSequences).join("\n").includes("Esc/q/Enter/Alt+c Close"));
  app.viewer.handleInput("\u001b[B");
  assert.equal(app.viewer.scrollView.scrollTop, 1);
  app.viewer.handleInput("\u001b[6~");
  assert.equal(app.viewer.scrollView.scrollTop, 7);
  app.viewer.handleInput("\u001b[5~");
  assert.equal(app.viewer.scrollView.scrollTop, 1);
  app.viewer.handleInput("\u001b[A");
  assert.equal(app.viewer.scrollView.scrollTop, 0);
  app.viewer.handleInput("\u001b[A");
  assert.equal(app.viewer.scrollView.scrollTop, 0);
  app.viewer.handleInput("\u001b[F");
  assert.deepEqual(commandLines(app.viewer, 120), padded(source.split("\n").slice(-6), 118));
  app.viewer.handleInput("\u001b[B");
  assert.equal(app.viewer.scrollView.scrollTop, 34);
  app.viewer.handleInput("\u001b[H");
  assert.equal(app.viewer.scrollView.scrollTop, 0);
  assert.ok(app.renders > 0);
});

test("the entire panel shares the widget command background, with outer borders and two section dividers", () => {
  for (const appearance of ["dark", "light"] as const) {
    const viewer = new CommandViewer({ requestId: "framed-request", fullCommand: "  printf 'x'  \n" }, "alt+c",
      () => mockTheme(appearance), () => ({ width: 120, height: 12 }), () => {}, () => {});
    const lines = viewer.render(120);
    const plain = lines.map(stripTerminalSequences);
    const background = appearance === "dark" ? "35;55;80" : "220;235;255";
    for (const line of lines) {
      assert.ok(line.startsWith(`\u001b[48;2;${background}m`));
      assert.ok(line.endsWith("\u001b[49m"));
      assert.equal(visibleWidth(line), 120);
    }
    assert.equal(plain[0], `┌${"─".repeat(118)}┐`);
    assert.equal(plain.at(-1), `└${"─".repeat(118)}┘`);
    assert.equal(plain.filter((line) => line === `├${"─".repeat(118)}┤`).length, 2);
    assert.ok(plain[1]?.startsWith("│Bash command · Request: framed-request"));
    assert.ok(plain.at(-2)?.startsWith("│Esc/q/Enter/Alt+c Close"));
    assert.deepEqual(commandLines(viewer, 120), padded(["  printf 'x'  ", ""], 118));
  }
});

test("normalized fullscreen wheel events scroll the same viewport and cannot escape at its boundary", () => {
  const app = setup(Array.from({ length: 40 }, (_, index) => `printf '${index}'`).join("\n"));
  const event: TuiMouseEvent = {
    type: "wheel", button: "none", x: 0, y: 1, screenX: 0, screenY: 1, width: 120, height: 12,
    shift: false, alt: false, ctrl: false, wheelDelta: 3,
  };
  assert.deepEqual(app.viewer.handleMouse(event), { handled: true });
  assert.equal(app.viewer.scrollView.scrollTop, 3);
  app.viewer.handleInput("\u001b[F");
  assert.deepEqual(app.viewer.handleMouse(event), { handled: true });
  assert.equal(app.viewer.scrollView.scrollTop, 34);
  assert.equal(app.viewer.handleMouse({ ...event, type: "press" }), undefined);
  app.viewer.dispose();
  assert.equal(app.viewer.handleMouse(event), undefined);
});

test("resize and themes preserve the locked sanitized command, clamp offsets and retain whitespace and graphemes", () => {
  const source = "  printf '中😀e\u0301  b'\n\nprintf '\u001b[2J'  " + "x".repeat(200);
  const app = setup(source, 6, 20);
  app.snapshot.fullCommand = "different later command";
  const expected = wrapTerminalText(sanitizeTerminalText(source), 18);
  app.viewer.render(20);
  app.viewer.handleInput("\u001b[F");
  const height = app.viewer.scrollView.viewportHeight;
  assert.deepEqual(commandLines(app.viewer, 20), padded(expected.slice(-height), 18));
  app.size.width = 120;
  app.size.height = 20;
  app.setTheme();
  app.viewer.invalidate();
  const lines = app.viewer.render(120);
  for (const line of lines) assert.ok(line.startsWith("\u001b[48;2;220;235;255m"));
  assert.deepEqual(commandLines(app.viewer, 120), padded(wrapTerminalText(sanitizeTerminalText(source), 118), 118));
  assert.equal(app.viewer.scrollView.scrollTop, 0);
  assert.equal(lines.join("\n").includes("\u001b[48;2;35;55;80m"), false);
  assert.equal(lines.map(stripTerminalSequences).join("\n").includes("different later command"), false);
  assert.deepEqual(app.viewer.render(0), []);
});

test("each viewer close key completes once, while releases and held toggle keys cannot close it", () => {
  for (const key of ["\u001b", "q", "\r", "\u001b[13u", "\u001bc"]) {
    const app = setup("printf 'read only'");
    app.viewer.handleInput("\u001b[99;3:2u");
    app.viewer.handleInput("\u001b[99;3:3u");
    assert.equal(app.closes, 0);
    app.viewer.handleInput(key);
    app.viewer.handleInput(key);
    assert.equal(app.closes, 1);
    assert.deepEqual(app.viewer.render(120), []);
  }
  const app = setup("printf 'read only'");
  app.viewer.dispose();
  app.viewer.dispose();
  app.viewer.handleInput("q");
  assert.equal(app.closes, 0);
});

test("very small viewports still keep command graphemes intact and header controls are escaped", () => {
  for (const width of [1, 2, 3, 12, 120]) {
    for (const height of [1, 2, 3, 6, 7, 12]) {
      const bounded = setup(Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n"), height, width);
      const lines = bounded.viewer.render(width);
      assert.ok(lines.length <= height);
      assert.ok(bounded.viewer.scrollView.viewportHeight >= 1);
      assert.ok(commandLines(bounded.viewer, width).length >= 1);
      if (width >= 3 && height >= 3) {
        assert.ok(stripTerminalSequences(lines[0]!).startsWith("┌"));
        assert.ok(stripTerminalSequences(lines.at(-1)!).startsWith("└"));
      }
      bounded.viewer.handleInput("\u001b[F");
      const innerWidth = width >= 3 && height >= 3 ? width - 2 : width;
      const expected = wrapTerminalText(bounded.snapshot.fullCommand, innerWidth)
        .slice(-bounded.viewer.scrollView.viewportHeight);
      assert.deepEqual(commandLines(bounded.viewer, width), padded(expected, innerWidth));
    }
  }
  const viewer = new CommandViewer({ requestId: "id\u001b[2J", fullCommand: "中😀e\u0301" }, "alt+m",
    () => mockTheme(), () => ({ width: 1, height: 1 }), () => {}, () => {});
  assert.deepEqual(commandLines(viewer, 1), ["中"]);
  viewer.handleInput("\u001b[B");
  assert.deepEqual(commandLines(viewer, 1), ["😀"]);
  viewer.handleInput("\u001b[F");
  assert.deepEqual(commandLines(viewer, 1), ["e\u0301"]);
  const larger = new CommandViewer({ requestId: "id\u001b[2J\nnext", fullCommand: "printf 'x'" }, "alt+m",
    () => mockTheme(), () => ({ width: 120, height: 12 }), () => {}, () => {});
  const lines = larger.render(120);
  assert.ok(lines.map(stripTerminalSequences).join("\n").includes("id\\u001b[2J\\nnext"));
  for (const line of lines) assert.equal(line.includes("\n"), false);
});

test("command sources provide immutable opening data but do not own viewer lifetime", (t) => {
  const { ui, viewer, source } = setupController(t);
  const command = { requestId: "first", fullCommand: "printf 'original command'" };
  source.update(command, ui.tui);
  assert.equal(ui.overlayHistory.length, 0);
  command.fullCommand = "printf 'mutated source'";
  ui.input(toggle);
  assert.ok(ui.overlayText().includes("original command"));
  const before = ui.overlayText();
  source.clear();
  source.dispose();
  source.update({ requestId: "later", fullCommand: "printf 'released source'" }, ui.tui);
  assert.equal(ui.overlayText(), before);
  assert.equal(ui.inputHandlers.size, 1);
  ui.input(toggle);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.overlayHistory.length, 1);
  assert.equal(ui.input(toggle), false);
  viewer.dispose();
  assert.equal(ui.inputHandlers.size, 0);
});

test("an open viewer retains its captured TUI after its current source is removed", (t) => {
  for (const operation of ["clear", "dispose"] as const) {
    const { ui, source } = setupController(t);
    const fullCommand = Array.from({ length: 40 }, (_, index) => `printf 'captured-${index}'`).join("\n");
    source.update({ requestId: "captured", fullCommand }, ui.tui);
    ui.input(toggle);
    assert.ok(ui.overlayText().includes("captured-0"));
    source[operation]();
    ui.columns = 32;
    ui.rows = 12;
    ui.currentTheme = mockTheme("light");
    assert.ok(ui.overlayText().includes("captured-0"));
    const renders = ui.renders;
    ui.input("\u001b[F");
    assert.ok(ui.overlayText().includes("captured-39"));
    assert.ok(ui.renders > renders);
    const rows = ui.overlays[0]!.component.render(Math.floor(ui.columns * 0.9));
    assert.ok(rows.length <= Math.floor(ui.rows * 0.8));
    assert.ok(rows.every((row) => row.includes("\u001b[48;2;220;235;255m")));
    ui.input("\u001b[H");
    assert.ok(ui.overlayText().includes("captured-0"));
    assert.equal(ui.input(toggle), true);
    assert.equal(ui.overlays.length, 0);
    assert.equal(ui.input(toggle), false);
    assert.equal(ui.overlayHistory.length, 1);
  }
});

test("clearing an older source cannot revoke a newer source or change an open snapshot", (t) => {
  const { ui, viewer, source } = setupController(t);
  const newer = viewer.createSource();
  t.after(() => newer.dispose());
  source.update({ requestId: "older", fullCommand: "printf 'older command'" }, ui.tui);
  newer.update({ requestId: "newer", fullCommand: "printf 'newer command'" }, ui.tui);
  source.clear();
  source.dispose();
  ui.input(toggle);
  assert.ok(ui.overlayText().includes("newer command"));
  newer.update({ requestId: "updated", fullCommand: "printf 'updated command'" }, ui.tui);
  assert.ok(ui.overlayText().includes("newer command"));
  assert.equal(ui.input("\u001b[99;3:2u"), true);
  assert.equal(ui.input("\u001b[99;3:3u"), true);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlayHistory.length, 1);
  ui.input(toggle);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.overlayHistory.length, 1);
  ui.input(toggle);
  assert.ok(ui.overlayText().includes("updated command"));
});

test("clearing or disposing the current source never falls back to an older command", (t) => {
  for (const operation of ["clear", "dispose"] as const) {
    const { ui, viewer, source } = setupController(t);
    const newer = viewer.createSource();
    t.after(() => newer.dispose());
    source.update({ requestId: "older", fullCommand: "printf 'older command'" }, ui.tui);
    newer.update({ requestId: "newer", fullCommand: "printf 'newer command'" }, ui.tui);
    ui.input(toggle);
    const before = ui.overlayText();
    assert.ok(before.includes("newer command"));
    newer[operation]();
    assert.equal(ui.overlayText(), before);
    assert.equal(ui.input(toggle), true);
    assert.equal(ui.overlays.length, 0);
    assert.equal(ui.input(toggle), false);
    assert.equal(ui.overlayHistory.length, 1);
    // An older live source can become current again only by explicitly supplying a fresh update.
    source.update({ requestId: "fresh", fullCommand: "printf 'fresh command'" }, ui.tui);
    newer.dispose();
    assert.equal(ui.input(toggle), true);
    assert.equal(ui.overlays.length, 1);
    assert.ok(ui.overlayText().includes("fresh command"));
  }
});

test("creating a new source without an update cannot replace the current command", (t) => {
  const { ui, viewer, source } = setupController(t);
  source.update({ requestId: "current", fullCommand: "printf 'current command'" }, ui.tui);
  const unused = viewer.createSource();
  t.after(() => unused.dispose());
  unused.clear();
  unused.dispose();
  ui.input(toggle);
  assert.ok(ui.overlayText().includes("current command"));
});

test("controllers in the same TUI keep separate slots and close only their own viewers", (t) => {
  const first = setupController(t);
  const second = setupController(t, first.ui, "alt+m");
  first.source.update({ requestId: "first", fullCommand: "printf 'first command'" }, first.ui.tui);
  second.source.update({ requestId: "second", fullCommand: "printf 'second command'" }, first.ui.tui);
  first.ui.input(toggle);
  const firstOverlay = first.ui.overlays[0]!;
  first.ui.input(alternate);
  const secondOverlay = first.ui.overlays[1]!;
  assert.equal(first.ui.overlays.length, 2);
  assert.equal(firstOverlay.closed, false);
  assert.ok(first.ui.overlayText().includes("second command"));
  first.source.dispose();
  first.ui.input(toggle);
  assert.equal(first.ui.overlays.length, 1);
  assert.equal(first.ui.overlayHistory.length, 2);
  assert.equal(firstOverlay.closed, true);
  assert.equal(secondOverlay.closed, false);
  first.viewer.dispose();
  assert.equal(first.ui.overlays.length, 1);
  assert.equal(first.ui.inputHandlers.size, 1);
  first.ui.input(alternate);
  assert.equal(first.ui.overlays.length, 0);
  assert.equal(first.ui.overlayHistory.length, 2);
  first.ui.input(alternate);
  assert.equal(first.ui.overlays.length, 1);
  assert.equal(first.ui.overlayHistory.length, 3);
  second.viewer.dispose();
  assert.equal(first.ui.overlays.length, 0);
  assert.equal(first.ui.inputHandlers.size, 0);
});

test("the controller slot stays reserved during reentrant creation and closes the returned handle", (t) => {
  const { ui, source } = setupController(t);
  source.update({ requestId: "first", fullCommand: "printf 'first command'" }, ui.tui);
  const showOverlay = ui.tui.showOverlay;
  let reenter = true;
  ui.tui.showOverlay = (component, options) => {
    if (reenter) {
      reenter = false;
      source.update({ requestId: "second", fullCommand: "printf 'second command'" }, ui.tui);
      assert.equal(ui.input(toggle), true);
      assert.equal(ui.overlayHistory.length, 0);
    }
    return showOverlay(component, options);
  };
  ui.input(toggle);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.overlayHistory.length, 1);
  assert.equal(ui.closeCalls, 1);
  ui.input(toggle);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlayHistory.length, 2);
  assert.ok(ui.overlayText().includes("second command"));
});

test("the controller slot stays reserved while a handle is being hidden", (t) => {
  const { ui, source } = setupController(t);
  source.update({ requestId: "first", fullCommand: "printf 'first command'" }, ui.tui);
  ui.input(toggle);
  const overlay = ui.overlays[0]!;
  const hide = overlay.handle.hide;
  overlay.handle.hide = () => {
    assert.equal(ui.input(toggle), true);
    assert.equal(ui.overlayHistory.length, 1);
    hide();
  };
  ui.input(toggle);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.closeCalls, 1);
  ui.input(toggle);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlayHistory.length, 2);
});

test("a failed hide retains the single-viewer reservation until a later close succeeds", (t) => {
  const { ui, source } = setupController(t);
  source.update({ requestId: "first", fullCommand: "printf 'first command'" }, ui.tui);
  ui.input(toggle);
  const handle = ui.overlays[0]!.handle;
  const hide = handle.hide;
  let fail = true;
  handle.hide = () => {
    if (fail) { fail = false; throw new Error("SENSITIVE_HIDE_ERROR"); }
    hide();
  };
  ui.input(toggle);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlayHistory.length, 1);
  assert.equal(JSON.stringify(ui.notifications).includes("SENSITIVE_HIDE_ERROR"), false);
  ui.input(toggle);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.overlayHistory.length, 1);
  ui.input(toggle);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlayHistory.length, 2);
});

test("closing-key repeat and release suppression survives clearing or disposing the current source", (t) => {
  const cases = [
    ["\u001b", "\u001b[27;1:2u", "\u001b[27;1:3u"],
    ["q", "\u001b[113;1:2u", "\u001b[113;1:3u"],
    ["\r", "\u001b[13;1:2u", "\u001b[13;1:3u"],
    [toggle, "\u001b[99;3:2u", "\u001b[99;3:3u"],
  ];
  for (const operation of ["clear", "dispose"] as const) {
    for (const [press, repeat, release] of cases) {
      const { ui, source } = setupController(t);
      source.update({ requestId: "first", fullCommand: "printf 'first command'" }, ui.tui);
      ui.input(toggle);
      source[operation]();
      assert.equal(ui.input(press!), true);
      assert.equal(ui.overlays.length, 0);
      assert.equal(ui.input(repeat!), true);
      assert.equal(ui.input(release!), true);
      assert.equal(ui.editorInputs.length, 0);
      assert.equal(ui.input("q"), false);
    }
  }
});

test("independent host TUIs do not share viewers or close each other's overlays", (t) => {
  const first = setupController(t);
  const second = setupController(t);
  first.source.update({ requestId: "first", fullCommand: "printf 'first host'" }, first.ui.tui);
  second.source.update({ requestId: "second", fullCommand: "printf 'second host'" }, second.ui.tui);
  first.ui.input(toggle);
  second.ui.input(toggle);
  assert.equal(first.ui.overlays.length, 1);
  assert.equal(second.ui.overlays.length, 1);
  first.viewer.dispose();
  assert.equal(first.ui.overlays.length, 0);
  assert.equal(second.ui.overlays.length, 1);
  assert.ok(second.ui.overlayText().includes("second host"));
});
