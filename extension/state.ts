import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import type { AnalysisUpdate, CommandObservation, CommandRecord, PermissionOutcome } from "./types.ts";

/** One active session generation. Results are retained until this store is closed. */
export class SessionState {
  readonly generation = Symbol("bash-cmd-checker-session");
  private readonly records = new Map<string, CommandRecord>();
  private visibleRequestId: string | undefined;
  private closed = false;

  get active(): boolean { return !this.closed; }
  get size(): number { return this.records.size; }
  get visible(): CommandRecord | undefined {
    return this.visibleRequestId === undefined ? undefined : this.records.get(this.visibleRequestId);
  }

  get(requestId: string): CommandRecord | undefined { return this.records.get(requestId); }

  observe(observation: CommandObservation, classificationDisabled = false): CommandRecord | undefined {
    if (this.closed) return undefined;
    const existing = this.records.get(observation.requestId);
    if (existing) return existing;
    const record: CommandRecord = Object.freeze({
      identity: Symbol(observation.requestId),
      observation: Object.freeze({ ...observation, requester: Object.freeze({ ...observation.requester }) }),
      explanation: Object.freeze({ status: "pending" as const }),
      classification: Object.freeze({ status: classificationDisabled ? "disabled" as const : "pending" as const }),
      verdict: Object.freeze({ kind: "defer" as const }),
      verdictSettled: false,
      prompted: false,
    });
    this.records.set(observation.requestId, record);
    return record;
  }

  /** A captured record identifies its request even after subsequent immutable updates. */
  publish(record: CommandRecord, update: AnalysisUpdate): boolean {
    const current = this.records.get(record.observation.requestId);
    if (this.closed || current?.identity !== record.identity) return false;
    if (update.kind === "explanation") {
      if (current.explanation.status !== "pending") return false;
      this.records.set(record.observation.requestId, Object.freeze({
        ...current, explanation: Object.freeze({ ...update.value }),
      }));
    } else {
      if (current.classification.status !== "pending") return false;
      const classification = update.value.status === "complete"
        ? Object.freeze({ ...update.value, probabilities: Object.freeze({ ...update.value.probabilities }) })
        : Object.freeze({ ...update.value });
      this.records.set(record.observation.requestId, Object.freeze({ ...current, classification }));
    }
    return true;
  }

  /** A final verdict cannot be revised by a late classification or a repeated authorization call. */
  settleVerdict(record: CommandRecord, verdict: AuthorizerVerdict): boolean {
    const current = this.records.get(record.observation.requestId);
    if (this.closed || current?.identity !== record.identity || current.verdictSettled) return false;
    this.records.set(record.observation.requestId, Object.freeze({
      ...current, verdict: Object.freeze({ ...verdict }), verdictSettled: true,
    }));
    return true;
  }

  /** Make a record visible; only a real permission prompt marks it prompted. */
  show(requestId: string, fromPrompt = true): CommandRecord | undefined {
    if (this.closed) return undefined;
    const record = this.records.get(requestId);
    this.visibleRequestId = record ? requestId : undefined;
    if (!record || !fromPrompt) return record;
    const prompted = Object.freeze({ ...record, prompted: true });
    this.records.set(requestId, prompted);
    return prompted;
  }

  hide(): void { this.visibleRequestId = undefined; }

  decide(requestId: string, outcome: PermissionOutcome): boolean {
    const record = this.records.get(requestId);
    if (this.closed || !record || record.decision) return false;
    this.records.set(requestId, Object.freeze({ ...record, decision: Object.freeze({ ...outcome }) }));
    return true;
  }

  close(): void {
    this.closed = true;
    this.visibleRequestId = undefined;
    this.records.clear();
  }
}
