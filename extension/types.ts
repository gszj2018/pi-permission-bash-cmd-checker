import type { KeyId } from "@earendil-works/pi-tui";
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
export type ExternalViewerMode = "detach" | "wait";

export interface ExternalViewerConfig {
  readonly command: string | null;
  readonly args: readonly string[];
  readonly mode: ExternalViewerMode;
  /** Directory for session command files; null uses the default temporary directory. */
  readonly filePath: string | null;
}

/** File metadata needed by the viewer, independent of Node's concrete filesystem types. */
export interface ViewerFileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ViewerFileSystem {
  lstatSync(path: string): ViewerFileInfo;
  mkdirSync(path: string, options: { recursive: true; mode: number }): void;
  openSync(path: string, flags: number, mode: number): number;
  writeFileSync(fd: number, text: string, encoding: "utf8"): void;
  closeSync(fd: number): void;
}

export interface ViewerFileDependencies {
  readonly fileSystem: ViewerFileSystem;
  temporaryDirectory(): string;
}

export interface DetachedViewerProcess {
  on(event: "error", handler: (error: Error) => void): unknown;
  once(event: "spawn" | "close", handler: () => void): unknown;
  removeListener(event: "error", handler: (error: Error) => void): unknown;
  removeListener(event: "spawn", handler: () => void): unknown;
  unref(): void;
}

export interface ViewerProcessDependencies {
  spawn(command: string, args: readonly string[], options: {
    shell: false; detached: true; stdio: "ignore";
  }): DetachedViewerProcess;
  spawnSync(command: string, args: readonly string[], options: {
    shell: false; stdio: "inherit";
  }): { status: number | null; signal: string | null; error?: Error };
  writeTerminal(text: string): void;
}

/** Shared operation ports; neither widgets nor Node adapters are part of this contract. */
export interface ExternalViewerDependencies {
  readonly files: ViewerFileDependencies;
  readonly processes: ViewerProcessDependencies;
}

export type ViewerLaunchResult = "started" | "completed" | "failed" | "terminal-failed" | "unconfigured";

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
  readonly externalViewer: ExternalViewerConfig;
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
