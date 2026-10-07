export interface ModelReference {
  readonly provider: string;
  readonly id: string;
}

export interface RiskThresholds {
  readonly safe: number;
  readonly unsafe: number;
  readonly confidence: number;
}

export interface Config {
  /** Null selects the current session model at request time. */
  readonly llm: {
    readonly model: ModelReference | null;
    readonly timeoutMs: number;
  };
  /** Null disables classification without disabling command explanations. */
  readonly classifier: {
    readonly model: ModelReference | null;
    readonly timeoutMs: number;
    readonly thresholds: RiskThresholds;
  };
  readonly autoBlockUnsafe: boolean;
}

/** Only these labels are sent to the classifier as criteria. */
export type ClassifierLabel = "safe-ro" | "safe-rw" | "unsafe";
/** Unknown is produced locally when a valid answer fails the configured thresholds. */
export type RiskLevel = ClassifierLabel | "unknown";

export interface CommandObservation {
  readonly requestId: string;
  readonly fullCommand: string;
  readonly decisionValue: string;
  readonly kind: "bash" | "bash_external_directory";
  readonly requester: {
    readonly agentName: string | null;
    readonly forwarded: boolean;
    readonly sessionId: string | null;
  };
}
