import assert from "node:assert/strict";
import type {
  Api, AssistantMessage, ClassifierApi, ClassifierContext, ClassifierModel, Context, Model,
  ModelsClassifierOptions, ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAnalyzer, type DeadlineScheduler } from "../../extension/analysis.ts";
import { classifyCommand } from "../../extension/classifier.ts";
import { extractCommandObservation } from "../../extension/command.ts";
import { explainCommand } from "../../extension/llm.ts";
import type { Config } from "../../extension/types.ts";
import { commandDetails, createContext } from "./mocks.ts";

export class MockClock {
  private now = 0;
  private readonly timers = new Map<symbol, { due: number; expire: () => void }>();
  readonly schedule: DeadlineScheduler = (timeoutMs, expire) => {
    const id = Symbol("deadline");
    this.timers.set(id, { due: this.now + timeoutMs, expire });
    return () => { this.timers.delete(id); };
  };
  get pending(): number { return this.timers.size; }
  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.now = next[1].due;
      this.timers.delete(next[0]);
      next[1].expire();
    }
    this.now = end;
  }
}

export function chatModel(id = "selected", provider = "mock"): Model<Api> {
  return { id, provider, api: "openai-completions", name: id, maxTokens: 2048 } as Model<Api>;
}

export function classifierModel(): ClassifierModel<ClassifierApi> {
  return { type: "classifier", provider: "typesafe", id: "jev-latest", api: "typesafe" } as ClassifierModel<ClassifierApi>;
}

export function explanationResponse(text = "Prints two values.", stopReason: AssistantMessage["stopReason"] = "stop") {
  return { stopReason, content: [{ type: "text", text }] };
}

export function riskResponse(unsafe = 0.05, confidence = 0.9) {
  return { stopReason: "stop", answers: { risk: {
    type: "choice", choice: "safe-ro", confidence,
    probabilities: { "safe-ro": 0.9, "safe-rw": 0.05, unsafe },
  } } };
}

/** In-memory model facade. No real registry, credentials, provider, file access, or model catalog is loaded. */
export class MockRegistry {
  selected: Model<Api> | undefined = chatModel();
  explicit: Model<Api> | undefined = chatModel("explicit");
  classifier: ClassifierModel<ClassifierApi> | undefined = classifierModel();
  readonly finds: [string, string][] = [];
  readonly classifierFinds: [string, string, string][] = [];
  readonly availabilityCalls: { type: string; provider: string; signal?: AbortSignal }[] = [];
  readonly streams: { model: Model<Api>; context: Context; options: ModelsSimpleStreamOptions }[] = [];
  readonly classifications: {
    model: ClassifierModel<ClassifierApi>; context: ClassifierContext; options: ModelsClassifierOptions;
  }[] = [];
  llmResult: () => Promise<unknown> = async () => explanationResponse();
  classifierResult: () => Promise<unknown> = async () => riskResponse();
  availability: (signal?: AbortSignal) => Promise<readonly ClassifierModel<ClassifierApi>[]> = async () =>
    this.classifier ? [this.classifier] : [];

  readonly registry = {
    find: (provider: string, id: string) => { this.finds.push([provider, id]); return this.explicit; },
    findOfType: (type: string, provider: string, id: string) => {
      this.classifierFinds.push([type, provider, id]); return this.classifier;
    },
    getAvailableOfType: (type: string, provider: string, options: { signal?: AbortSignal }) => {
      this.availabilityCalls.push({ type, provider, signal: options.signal });
      return this.availability(options.signal);
    },
    streamSimple: (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => {
      this.streams.push({ model, context, options });
      return { result: () => this.llmResult() };
    },
    classify: (model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options: ModelsClassifierOptions) => {
      this.classifications.push({ model, context, options });
      return this.classifierResult();
    },
  } as unknown as ExtensionContext["modelRegistry"];
}

export function createModelContext() {
  const { ctx, ui } = createContext();
  const models = new MockRegistry();
  Object.defineProperties(ctx, {
    modelRegistry: { value: models.registry },
    model: { get: () => models.selected },
  });
  return { ctx, ui, models };
}

export function observedCommand(fullCommand?: string) {
  const observation = extractCommandObservation(commandDetails("request-1", fullCommand));
  assert.ok(observation);
  return observation;
}

export function modelAnalyzer(ctx: ExtensionContext, config: Config, clock: MockClock) {
  return createAnalyzer(config, {
    explain: (command, signal) => explainCommand(ctx, config.llm, command, signal),
    classify: (command, signal) => classifyCommand(ctx, config.classifier, command, signal),
    schedule: clock.schedule,
  });
}
