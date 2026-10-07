import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { KeyId } from "@earendil-works/pi-tui";
import { extractCommandObservation } from "../extension/command.ts";
import { SessionState } from "../extension/state.ts";
import { createWidgetController, WIDGET_KEY } from "../extension/widget.ts";
import { MockUi, commandDetails, flushPromises } from "./helpers/mocks.ts";

const toggle = "\u001bc";

function record(id = "first", command = "printf 'first full command'") {
  const observation = extractCommandObservation(commandDetails(id, command));
  assert.ok(observation);
  const result = new SessionState().observe(observation);
  assert.ok(result);
  return result;
}

function setup(t: TestContext, shortcut?: KeyId) {
  const ui = new MockUi();
  const controller = createWidgetController(ui.ui, shortcut);
  t.after(() => controller.dispose());
  return { ui, controller };
}

test("toggle opens a focused read-only overlay only for a visible command and preserves ordinary input", async (t) => {
  const { ui, controller } = setup(t);
  assert.equal(ui.input(toggle), false);
  assert.equal(ui.overlays.length, 0);
  controller.show(record());
  assert.equal(ui.input(";"), false);
  assert.equal(ui.input("c"), false);
  assert.equal(ui.input("q"), false);
  assert.equal(ui.input("\r"), false);
  assert.equal(ui.input("\u001b[99;3:2u"), true);
  assert.equal(ui.input("\u001b[99;3:3u"), true);
  assert.equal(ui.overlayHistory.length, 0);
  const ordinaryInputs = ui.editorInputs.length;
  assert.equal(ui.input(toggle), true);
  await flushPromises();
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlays[0]!.handle.isFocused(), true);
  assert.deepEqual(ui.overlays[0]!.options, { width: "90%", maxHeight: "80%", anchor: "center" });
  assert.ok(ui.overlayText().includes("first full command"));
  assert.ok(ui.overlayText().includes("Esc/q/Enter/Alt+c Close"));
  ui.input("x");
  assert.equal(ui.editorInputs.length, ordinaryInputs);
  ui.input("\r");
  await flushPromises();
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.editorInputs.length, ordinaryInputs);
  assert.equal(ui.input("q"), false);
});

test("an open viewer retains its command while the widget updates, switches or disappears", async (t) => {
  const { ui, controller } = setup(t);
  const first = record();
  controller.show(first);
  ui.input(toggle);
  await flushPromises();
  const before = ui.overlayText();
  controller.show({ ...first, explanation: { status: "complete", text: "Later explanation." },
    decision: { result: "allow", resolution: "user_approved" } });
  assert.equal(ui.overlayText(), before);
  controller.show(record("second", "printf 'second full command'"));
  assert.ok(ui.text(WIDGET_KEY).includes("second full command"));
  assert.equal(ui.overlayText(), before);
  controller.hide();
  assert.equal(ui.components.size, 0);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlayText(), before);
  ui.input(toggle);
  await flushPromises();
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.closeCalls, 1);
  controller.show(record("third", "printf 'third full command'"));
  ui.input(toggle);
  await flushPromises();
  assert.ok(ui.overlayText().includes("third full command"));
  assert.equal(ui.overlayText().includes("first full command"), false);
});

test("Escape, q, Enter and the configured shortcut close without forwarding to the editor or reopening", async (t) => {
  for (const key of ["\u001b", "q", "\r", "\u001b[13u", "\u001bm"]) {
    const { ui, controller } = setup(t, "alt+m");
    controller.show(record());
    assert.equal(ui.input(toggle), false);
    ui.input("\u001bm");
    await flushPromises();
    assert.ok(ui.overlayText().includes("Esc/q/Enter/Alt+m Close"));
    const before = ui.editorInputs.length;
    ui.input(key);
    await flushPromises();
    assert.equal(ui.overlays.length, 0);
    assert.equal(ui.overlayHistory.length, 1);
    assert.equal(ui.closeCalls, 1);
    assert.equal(ui.editorInputs.length, before);
  }
});

test("reported repeats and releases of closing keys cannot reach the underlying editor after dismissal", (t) => {
  const cases = [
    ["\u001b", "\u001b[27;1:2u", "\u001b[27;1:3u"],
    ["q", "\u001b[113;1:2u", "\u001b[113;1:3u"],
    ["\r", "\u001b[13;1:2u", "\u001b[13;1:3u"],
    [toggle, "\u001b[99;3:2u", "\u001b[99;3:3u"],
  ];
  for (const [press, repeat, release] of cases) {
    const { ui, controller } = setup(t);
    controller.show(record());
    ui.input(toggle);
    ui.input(press!);
    assert.equal(ui.overlays.length, 0);
    assert.equal(ui.input(repeat!), true);
    assert.equal(ui.input(release!), true);
    assert.equal(ui.editorInputs.length, 0);
    assert.equal(ui.input("q"), false);
  }
});

test("keyboard scrolling reaches the entire captured command beyond the eight-line preview", async (t) => {
  const { ui, controller } = setup(t);
  const source = Array.from({ length: 70 }, (_, index) => `printf 'line-${index}'`).join("\n");
  controller.show(record("long", source));
  assert.ok(ui.text(WIDGET_KEY).includes("Command truncated. Press Alt+c"));
  assert.equal(ui.text(WIDGET_KEY).includes("line-69"), false);
  ui.input(toggle);
  await flushPromises();
  ui.input("\u001b[F");
  assert.ok(ui.overlayText().includes("line-69"));
  assert.equal(ui.overlayText().includes("line-0'"), false);
  ui.input("\u001b[H");
  assert.ok(ui.overlayText().includes("line-0'"));
  assert.equal(ui.overlayText().includes("line-69"), false);
});

test("rapid open and close never dismisses the underlying interaction", async (t) => {
  const { ui, controller } = setup(t);
  let closeOther!: () => void;
  const otherResult = ui.ui.custom<void>((_tui, _theme, _keys, done) => {
    closeOther = () => { done(undefined); };
    return { render: () => ["Underlying dialog"], invalidate() {} };
  }, { overlay: true });
  t.after(() => closeOther());
  void otherResult.then(() => {});
  await flushPromises();
  const other = ui.overlays[0]!;
  controller.show(record());
  ui.input(toggle);
  ui.input(toggle);
  assert.equal(other.closed, false);
  assert.equal(ui.overlays.length, 1);
  await flushPromises();
  assert.equal(other.closed, false);
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlays[0], other);
  assert.equal(ui.closeCalls, 1);
});

test("the scoped handle closes only its viewer beneath a later overlay without relying on creation or focus order", async (t) => {
  const { ui, controller } = setup(t);
  controller.show(record());
  ui.input(toggle);
  await flushPromises();
  let closeOther!: () => void;
  const otherResult = ui.ui.custom<void>((_tui, _theme, _keys, done) => {
    closeOther = () => { done(undefined); };
    return { render: () => ["Later overlay"], invalidate() {} };
  }, { overlay: true });
  void otherResult.then(() => {});
  t.after(() => closeOther());
  await flushPromises();
  const other = ui.overlays.at(-1)!;
  const own = ui.overlays[0]!;
  own.handle.focus();
  assert.equal(ui.overlays.at(-1), other);
  assert.equal(own.handle.isFocused(), true);
  ui.input(toggle);
  await flushPromises();
  assert.equal(ui.overlays.length, 1);
  assert.equal(ui.overlays[0], other);
  assert.equal(other.closed, false);
});

test("dispose cancels reentrant creation, closes existing viewers and releases input subscriptions exactly once", async (t) => {
  const { ui, controller } = setup(t);
  const original = ui.tui.showOverlay;
  ui.tui.showOverlay = (component, options) => {
    controller.dispose();
    return original(component, options);
  };
  controller.show(record());
  ui.input(toggle);
  controller.dispose();
  assert.equal(ui.inputHandlers.size, 0);
  assert.equal(ui.components.size, 0);
  assert.equal(ui.overlayHistory.length, 1);
  assert.equal(ui.overlays.length, 0);
  assert.equal(ui.closeCalls, 1);
  controller.show(record());
  assert.equal(ui.components.size, 0);

  const mounted = setup(t);
  mounted.controller.show(record());
  mounted.ui.input(toggle);
  await flushPromises();
  mounted.controller.dispose();
  mounted.controller.dispose();
  await flushPromises();
  assert.equal(mounted.ui.closeCalls, 1);
  assert.equal(mounted.ui.inputHandlers.size, 0);
  assert.equal(mounted.ui.overlays.length, 0);
});

test("overlay failure is contained and a later shortcut can retry the same visible command", async (t) => {
  const { ui, controller } = setup(t);
  controller.show(record());
  ui.overlayError = new Error("SENSITIVE_UI_ERROR");
  ui.input(toggle);
  await flushPromises();
  assert.equal(ui.overlays.length, 0);
  assert.ok(ui.components.has(WIDGET_KEY));
  assert.equal(JSON.stringify(ui.notifications).includes("SENSITIVE_UI_ERROR"), false);
  ui.overlayError = undefined;
  ui.input(toggle);
  await flushPromises();
  assert.ok(ui.overlayText().includes("first full command"));
});
