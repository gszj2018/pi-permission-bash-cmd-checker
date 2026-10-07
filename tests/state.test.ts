import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCommandObservation } from "../extension/command.ts";
import { SessionState } from "../extension/state.ts";
import { commandDetails } from "./helpers/mocks.ts";

function observe(state: SessionState, id = "request-1", disabled = false) {
  const observation = extractCommandObservation(commandDetails(id));
  assert.ok(observation);
  const record = state.observe(observation, disabled);
  assert.ok(record);
  return record;
}

test("state deduplicates only request IDs, retains all completed records and keeps immutable snapshots", () => {
  const state = new SessionState();
  const first = observe(state);
  assert.equal(observe(state), first);
  const second = observe(state, "request-2");
  assert.notEqual(first.identity, second.identity);
  assert.equal(state.size, 2);
  assert.ok(Object.isFrozen(first.observation.requester));
  const initiallyVisible = state.visible;
  assert.equal(initiallyVisible, undefined);
  state.show("request-1");
  state.decide("request-1", { result: "allow", resolution: "user_approved" });
  assert.equal(state.visible?.prompted, true);
  assert.equal(state.visible?.decision?.result, "allow");
  assert.equal(state.size, 2);
  assert.equal(first.decision, undefined);
  assert.equal(state.decide("request-1", { result: "deny", resolution: "user_denied" }), false);
});

test("final verdicts are immutable, settle once and cannot cross a session generation", () => {
  const state = new SessionState();
  const record = observe(state);
  assert.equal(record.verdictSettled, false);
  assert.equal(state.settleVerdict(record, { kind: "deny", reason: "Fixed policy reason." }), true);
  const settled = state.get("request-1")!;
  assert.equal(settled.verdictSettled, true);
  assert.deepEqual(settled.verdict, { kind: "deny", reason: "Fixed policy reason." });
  assert.ok(Object.isFrozen(settled.verdict));
  assert.equal(state.settleVerdict(record, { kind: "defer" }), false);
  assert.equal(record.verdictSettled, false);
  assert.deepEqual(record.verdict, { kind: "defer" });
  const fresh = new SessionState();
  observe(fresh);
  assert.equal(fresh.settleVerdict(record, { kind: "deny", reason: "Stale policy reason." }), false);
  state.close();
  assert.equal(state.settleVerdict(record, { kind: "defer" }), false);
});

test("captured identities permit independent late results without changing the visible request", () => {
  const state = new SessionState();
  const first = observe(state);
  const second = observe(state, "request-2");
  state.show("request-2");
  assert.equal(state.publish(first, { kind: "explanation", value: { status: "complete", text: "First explanation" } }), true);
  assert.equal(state.publish(first, { kind: "classification", value: { status: "failed" } }), true);
  assert.equal(state.get("request-1")?.explanation.status, "complete");
  assert.equal(state.visible?.identity, second.identity);
  assert.equal(state.publish(first, { kind: "classification", value: { status: "unavailable" } }), false);
  assert.equal(state.publish(first, { kind: "explanation", value: { status: "unavailable" } }), false);
});

test("disabled classification cannot accidentally become a risk assessment", () => {
  const state = new SessionState();
  const record = observe(state, "request-1", true);
  assert.equal(record.classification.status, "disabled");
  assert.equal(state.publish(record, { kind: "classification", value: { status: "failed" } }), false);
  assert.equal(state.publish(record, { kind: "explanation", value: { status: "complete", text: "Explanation" } }), true);
});

test("hiding an unsupported prompt clears only visibility, not the cache", () => {
  const state = new SessionState();
  observe(state);
  state.show("request-1");
  assert.equal(state.show("unsupported"), undefined);
  assert.equal(state.visible, undefined);
  assert.equal(state.size, 1);
  state.show("request-1");
  state.hide();
  assert.equal(state.size, 1);
});

test("session closure is idempotent and old generation identities cannot update a new session", () => {
  const old = new SessionState();
  const record = observe(old);
  old.show("request-1");
  old.close();
  old.close();
  assert.equal(old.active, false);
  assert.equal(old.size, 0);
  assert.equal(old.visible, undefined);
  assert.equal(old.observe(record.observation), undefined);
  assert.equal(old.decide("request-1", { result: "allow", resolution: "user_approved" }), false);
  assert.equal(old.publish(record, { kind: "explanation", value: { status: "unavailable" } }), false);
  const fresh = new SessionState();
  observe(fresh);
  assert.notEqual(fresh.generation, old.generation);
  assert.equal(fresh.publish(record, { kind: "explanation", value: { status: "unavailable" } }), false);
});
