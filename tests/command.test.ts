import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptPayload, PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { extractCommandObservation } from "../extension/command.ts";

function details(payload: Partial<PromptPayload> = {}): PromptPermissionDetails {
  return {
    requestId: "request-1",
    source: "tool_call",
    agentName: null,
    command: "do not use details.command",
    payload: {
      kind: "bash",
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "bash",
        toolName: "bash",
        invokedToolName: null,
        value: "printf 'second\\n'",
        matchedPattern: "*",
        commandContext: null,
        executedUnit: "do not use executedUnit",
      },
      evidence: [],
      annotations: [],
      ...payload,
    },
  };
}

test("simple bash commands fall back to the decision value, not other command-like fields", () => {
  const input = details();
  assert.deepEqual(extractCommandObservation(input), {
    requestId: "request-1",
    fullCommand: "printf 'second\\n'",
    decisionValue: "printf 'second\\n'",
    kind: "bash",
    requester: { agentName: null, forwarded: false, sessionId: null },
  });
});

test("full-command evidence preserves every unit, quote, newline and character without truncation", () => {
  const fullCommand = `  printf 'first\\n' && printf "second"\n# ${"x".repeat(12_000)}\n`;
  const input = details({ evidence: [{ label: "full command", text: fullCommand, detail: null }] });
  Object.freeze(input.payload.evidence[0]);
  Object.freeze(input.payload.evidence);
  Object.freeze(input.payload.request.requester);
  Object.freeze(input.payload.request);
  Object.freeze(input.payload);
  Object.freeze(input);
  const observed = extractCommandObservation(input);
  assert.equal(observed?.fullCommand, fullCommand);
  assert.equal(observed?.decisionValue, "printf 'second\\n'");
  assert.notEqual(observed?.requester, input.payload.request.requester);
  assert.equal(input.payload.evidence[0]?.text, fullCommand);
});

test("unrelated evidence does not suppress the simple-command fallback", () => {
  const input = details({ evidence: [{ label: "context", text: "not the full command", detail: null }] });
  assert.equal(extractCommandObservation(input)?.fullCommand, input.payload.request.value);
});

test("bash external-directory asks use request.value, never a path or evidence projection", () => {
  const input = details({
    kind: "bash_external_directory",
    evidence: [{ label: "full command", text: "not used for this kind", detail: null }],
  });
  input.payload = {
    ...input.payload,
    request: { ...input.payload.request, surface: "external_directory", value: "printf 'a' && printf 'b'" },
  };
  input.path = "/not/a/command";
  const observed = extractCommandObservation(input);
  assert.equal(observed?.kind, "bash_external_directory");
  assert.equal(observed?.fullCommand, input.payload.request.value);
});

test("forwarded requests retain the complete command and requesting session identity", () => {
  const input = details({ evidence: [{ label: "full command", text: "printf 'a' && printf 'b'", detail: null }] });
  input.payload = {
    ...input.payload,
    request: {
      ...input.payload.request,
      requester: { agentName: "Worker", forwarded: true, sessionId: "child-session" },
    },
  };
  input.forwarding = { requesterAgentName: "Worker", requesterSessionId: "child-session" };
  assert.deepEqual(extractCommandObservation(input)?.requester, {
    agentName: "Worker", forwarded: true, sessionId: "child-session",
  });
  assert.equal(extractCommandObservation(input)?.fullCommand, "printf 'a' && printf 'b'");
});

test("unsupported payloads and invoked tool aliases never masquerade as complete bash commands", () => {
  for (const kind of ["path", "external_directory", "forwarded", "tool", "mcp", "skill", "skill_read"] as const) {
    assert.equal(extractCommandObservation(details({ kind })), undefined);
  }
  for (const invokedToolName of ["exec_command", "bash"]) {
    const input = details();
    input.payload = { ...input.payload, request: { ...input.payload.request, invokedToolName } };
    assert.equal(extractCommandObservation(input), undefined);
  }
  const input = details();
  input.payload = { ...input.payload, request: { ...input.payload.request, toolName: "read" } };
  assert.equal(extractCommandObservation(input), undefined);
});

test("malformed consumed fields are rejected rather than guessed or normalized", () => {
  const baseline = details();
  const malformed: unknown[] = [
    undefined, null, [], "command", {},
    { ...baseline, requestId: " " }, { ...baseline, requestId: 42 },
    { ...baseline, payload: null }, { ...baseline, payload: { ...baseline.payload, request: [] } },
  ];
  for (const value of ["", " \n", undefined, 123, null]) {
    malformed.push({
      ...baseline, payload: { ...baseline.payload, request: { ...baseline.payload.request, value } },
    });
  }
  malformed.push({
    ...baseline,
    payload: { ...baseline.payload, request: { ...baseline.payload.request, invokedToolName: undefined } },
  });
  for (const requester of [null, [], {}, { agentName: null, forwarded: "false", sessionId: null }]) {
    malformed.push({
      ...baseline, payload: { ...baseline.payload, request: { ...baseline.payload.request, requester } },
    });
  }
  for (const evidence of [null, {}, [null], [{ label: "full command", text: 123 }],
    [{ label: "full command", text: " " }], [{ text: "printf 'a'" }],
    [{ label: "full command", text: "printf 'a'" }, { label: "full command", text: "printf 'b'" }]]) {
    malformed.push({ ...baseline, payload: { ...baseline.payload, evidence } });
  }
  for (const input of malformed) assert.equal(extractCommandObservation(input), undefined);
});

test("additive upstream fields are ignored and identical commands keep separate request IDs", () => {
  const first = { ...details(), extra: "future field" };
  const second = { ...details(), requestId: "request-2" };
  assert.equal(extractCommandObservation(first)?.requestId, "request-1");
  assert.equal(extractCommandObservation(second)?.requestId, "request-2");
  assert.equal(extractCommandObservation(first)?.fullCommand, extractCommandObservation(second)?.fullCommand);
});
