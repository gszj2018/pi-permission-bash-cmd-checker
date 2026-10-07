import type { CommandObservation } from "./types.ts";
import { isNonBlankString, isNullableString, isRecord } from "./utils.ts";

/**
 * Read the command-bearing facts, never the UI projection or a path-shaped value.
 * Validate consumed fields defensively and tolerate unrelated additive upstream fields.
 * Upstream may already trim commands; this function does not further normalize them.
 */
export function extractCommandObservation(details: unknown): CommandObservation | undefined {
  if (!isRecord(details) || !isNonBlankString(details.requestId)) return undefined;
  const payload = details.payload;
  if (!isRecord(payload) || (payload.kind !== "bash" && payload.kind !== "bash_external_directory")) {
    return undefined;
  }
  const request = payload.request;
  if (!isRecord(request) || request.toolName !== "bash" || request.invokedToolName !== null) return undefined;
  if (!isNonBlankString(request.value)) return undefined;
  const requester = request.requester;
  if (!isRecord(requester) || typeof requester.forwarded !== "boolean"
    || !isNullableString(requester.agentName) || !isNullableString(requester.sessionId)) {
    return undefined;
  }

  if (!Array.isArray(payload.evidence)) return undefined;
  let evidenceCommand: string | undefined;
  for (const item of payload.evidence) {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.text !== "string") return undefined;
    if (payload.kind === "bash" && item.label === "full command") {
      // Ambiguous or malformed full-command evidence must not fall back to a partial unit.
      if (evidenceCommand !== undefined || !isNonBlankString(item.text)) return undefined;
      evidenceCommand = item.text;
    }
  }

  return {
    requestId: details.requestId,
    fullCommand: evidenceCommand ?? request.value,
    decisionValue: request.value,
    kind: payload.kind,
    requester: {
      agentName: requester.agentName,
      forwarded: requester.forwarded,
      sessionId: requester.sessionId,
    },
  };
}
