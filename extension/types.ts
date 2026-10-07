import type { KeyId, TUI } from "@earendil-works/pi-tui";
import type { AuthorizerVerdict, PermissionsService } from "@gotgenes/pi-permission-system";

export interface ModelReference {
  readonly provider: string;
  readonly id: string;
}

export interface RiskThresholds {
  readonly safe: number;
  readonly unsafe: number;
  readonly confidence: number;
}

export type ExplanationLanguage = "en" | "zh";

export interface Config {
  /** Null selects the current session model at request time. */
  readonly llm: {
    readonly model: ModelReference | null;
    /** English by default; zh requests Simplified Chinese explanations only. */
    readonly language: ExplanationLanguage;
    readonly timeoutMs: number;
  };
  /** Null disables classification without disabling command explanations. */
  readonly classifier: {
    readonly model: ModelReference | null;
    readonly timeoutMs: number;
    readonly thresholds: RiskThresholds;
  };
  readonly autoBlockUnsafe: boolean;
  readonly widget: {
    readonly commandViewerShortcut: KeyId;
  };
}

export type ConfigLoadResult =
  | { readonly status: "loaded" | "missing"; readonly config: Config }
  | { readonly status: "invalid"; readonly issues: readonly string[] }
  | { readonly status: "unreadable" };

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

export type ServiceAccessor = (sessionId: string) => Pick<PermissionsService, "registerAuthorizer"> | undefined;

/** Public session state contract, independent of storage and concrete runtime classes. */
export interface SessionStateContract {
  readonly generation: symbol;
  readonly active: boolean;
  readonly size: number;
  readonly visible: CommandRecord | undefined;
  get(requestId: string): CommandRecord | undefined;
  observe(observation: CommandObservation, classificationDisabled?: boolean): CommandRecord | undefined;
  publish(record: CommandRecord, update: AnalysisUpdate): boolean;
  settleVerdict(record: CommandRecord, verdict: AuthorizerVerdict): boolean;
  show(requestId: string): CommandRecord | undefined;
  hide(): void;
  decide(requestId: string, outcome: PermissionOutcome): boolean;
  close(): void;
}

export interface PermissionRuntime {
  readonly state: SessionStateContract;
  dispose(): void;
}

export interface CommandSnapshot {
  readonly requestId: string;
  readonly fullCommand: string;
}

export interface CommandViewerSource {
  update(snapshot: CommandSnapshot, owner: TUI): void;
  clear(): void;
  dispose(): void;
}

export interface CommandViewerController {
  createSource(): CommandViewerSource;
  dispose(): void;
}

export interface PermissionOutcome {
  readonly result: "allow" | "deny";
  readonly resolution: string;
}

export interface CommandRecord {
  /** A frozen observation whose reference remains stable across this request's snapshots. */
  readonly observation: CommandObservation;
  readonly explanation: ExplanationState;
  readonly classification: ClassificationState;
  readonly verdict: AuthorizerVerdict;
  readonly verdictSettled: boolean;
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
