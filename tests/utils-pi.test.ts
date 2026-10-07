import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyError, notifyWarning } from "../extension/utils-pi.ts";
import { MockUi } from "./helpers/mocks.ts";

test("Pi notification helpers apply the checker prefix and the requested severity", () => {
  const ui = new MockUi();
  notifyWarning(ui.ui, "Warning message.");
  notifyError(ui.ui, "Error message.");
  assert.deepEqual(ui.notifications, [
    { message: "[bash-cmd-checker] Warning message.", type: "warning" },
    { message: "[bash-cmd-checker] Error message.", type: "error" },
  ]);
});

test("Pi notification failures never escape or retry notification delivery", () => {
  let calls = 0;
  const ui = { notify() { calls++; throw new Error("SENSITIVE_NOTIFICATION_ERROR"); } };
  assert.doesNotThrow(() => notifyWarning(ui, "Warning message."));
  assert.doesNotThrow(() => notifyError(ui, "Error message."));
  assert.equal(calls, 2);
});
