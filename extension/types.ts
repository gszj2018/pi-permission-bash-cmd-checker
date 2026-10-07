import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

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

export type ExplanationState =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly text: string }
  | { readonly status: "unavailable" };

export type ExplanationResult = Exclude<ExplanationState, { readonly status: "pending" }>;

export type ClassificationResult =
  | { readonly status: "disabled" | "unavailable" | "failed" | "timed-out" | "invalid-response" }
  | {
    readonly status: "complete";
    readonly risk: RiskLevel;
    readonly probabilities: Readonly<Record<ClassifierLabel, number>>;
    readonly confidence: number;
  };

export type AnalysisUpdate =
  | { readonly kind: "explanation"; readonly value: ExplanationState }
  | { readonly kind: "classification"; readonly value: ClassificationState };

export type ClassificationState = { readonly status: "pending" } | ClassificationResult;

export interface AnalysisTask {
  /** The only result the Authorizer waits for. */
  readonly classification: Promise<ClassificationResult>;
  /** Both bounded tasks have ended; used for cleanup, never for authorization. */
  readonly done: Promise<void>;
}

export type CommandAnalyzer = (
  command: CommandObservation,
  signal: AbortSignal,
  publish: (update: AnalysisUpdate) => void,
) => AnalysisTask;

export interface PermissionOutcome {
  readonly result: "allow" | "deny";
  readonly resolution: string;
}

export interface CommandRecord {
  readonly identity: symbol;
  readonly observation: CommandObservation;
  readonly explanation: ExplanationState;
  readonly classification: ClassificationState;
  readonly verdict: AuthorizerVerdict;
  readonly verdictSettled: boolean;
  readonly prompted: boolean;
  readonly decision?: PermissionOutcome;
}

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
