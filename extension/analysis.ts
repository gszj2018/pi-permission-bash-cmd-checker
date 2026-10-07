import type {
  AnalysisUpdate, ClassificationResult, CommandAnalyzer, CommandObservation, Config, ExplanationResult,
} from "./types.ts";

/** Returns a cancellation function; tests inject a manual scheduler, never real timers. */
export type DeadlineScheduler = (timeoutMs: number, expire: () => void) => () => void;

export interface AnalysisDependencies {
  explain(command: CommandObservation, signal: AbortSignal): Promise<ExplanationResult>;
  classify(command: CommandObservation, signal: AbortSignal): Promise<ClassificationResult>;
  schedule: DeadlineScheduler;
}

export const scheduleDeadline: DeadlineScheduler = (timeoutMs, expire) => {
  const timer = setTimeout(expire, timeoutMs);
  return () => { clearTimeout(timer); };
};

/** Bound the entire operation, including authentication/routing, even if a provider ignores abort. */
function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
  schedule: DeadlineScheduler,
  fallback: T,
  timedOut: T,
): Promise<T> {
  return new Promise((resolve) => {
    if (parent.aborted) { resolve(fallback); return; }
    const controller = new AbortController();
    let settled = false;
    let cancelTimer: (() => void) | undefined;
    const settle = (value: T, abort = false): void => {
      if (settled) return;
      settled = true;
      parent.removeEventListener("abort", cancel);
      cancelTimer?.();
      if (abort) controller.abort();
      resolve(value);
    };
    const cancel = (): void => { settle(fallback, true); };
    parent.addEventListener("abort", cancel, { once: true });
    try {
      cancelTimer = schedule(timeoutMs, () => { settle(timedOut, true); });
      // Also support a scheduler that fires synchronously without leaking its cancellation handle.
      if (settled) { cancelTimer(); return; }
      Promise.resolve(work(controller.signal)).then(
        (value) => { settle(value); },
        () => { settle(fallback, true); },
      );
    } catch {
      settle(fallback, true);
    }
  });
}

/** Start independent operations immediately; classification alone arbitrates the permission gate. */
export function createAnalyzer(config: Config, dependencies: AnalysisDependencies): CommandAnalyzer {
  return (command, signal, publish) => {
    const deliver = (update: AnalysisUpdate): void => {
      if (signal.aborted) return;
      try { publish(update); } catch { /* UI/state failures cannot fail a model task. */ }
    };
    const explanation = bounded<ExplanationResult>(
      (child) => dependencies.explain(command, child), signal, config.llm.timeoutMs, dependencies.schedule,
      { status: "unavailable" }, { status: "unavailable" },
    ).then((value) => { deliver({ kind: "explanation", value }); });
    const classification = (config.classifier.model === null
      ? Promise.resolve<ClassificationResult>({ status: "disabled" })
      : bounded<ClassificationResult>(
        (child) => dependencies.classify(command, child), signal, config.classifier.timeoutMs, dependencies.schedule,
        { status: "failed" }, { status: "timed-out" },
      )).then((value) => { deliver({ kind: "classification", value }); return value; });
    return { classification, done: Promise.all([explanation, classification]).then(() => {}) };
  };
}
