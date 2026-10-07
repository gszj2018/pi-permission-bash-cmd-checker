import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { KeyId } from "@earendil-works/pi-tui";
import { createCommandViewerController } from "../extension/command-viewer-controller.ts";
import { MockUi, mockTheme } from "./helpers/mocks.ts";

const toggle = "\u001bc";
const alternate = "\u001bm";

function setup(t: TestContext, ui = new MockUi(), shortcut?: KeyId) {
  const viewer = createCommandViewerController(ui.ui, shortcut);
  const source = viewer.createSource();
  t.after(() => { source.dispose(); viewer.dispose(); });
  return { ui, viewer, source };
}

test("command sources provide immutable opening data but do not own viewer lifetime", (t) => {
  const { ui, viewer, source } = setup(t);
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
    const { ui, source } = setup(t);
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
  const { ui, viewer, source } = setup(t);
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
    const { ui, viewer, source } = setup(t);
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
  const { ui, viewer, source } = setup(t);
  source.update({ requestId: "current", fullCommand: "printf 'current command'" }, ui.tui);
  const unused = viewer.createSource();
  t.after(() => unused.dispose());
  unused.clear();
  unused.dispose();
  ui.input(toggle);
  assert.ok(ui.overlayText().includes("current command"));
});

test("controllers in the same TUI keep separate slots and close only their own viewers", (t) => {
  const first = setup(t);
  const second = setup(t, first.ui, "alt+m");
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
  const { ui, source } = setup(t);
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
  const { ui, source } = setup(t);
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
  const { ui, source } = setup(t);
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
      const { ui, source } = setup(t);
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
  const first = setup(t);
  const second = setup(t);
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
