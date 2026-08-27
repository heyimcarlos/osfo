import type { ContextOverflowConfig } from "@cloudflare/think";
import type { ModelMessage } from "ai";
import type { Observability, ObservabilityEvent } from "agents/observability";
import { estimateStringTokens } from "agents/experimental/memory/utils";
import { Effect } from "effect";

/* oxlint-disable eslint/no-underscore-dangle -- Application evidence uses the canonical _tag discriminator. */

/** Model-specific limits that drive Think's bounded compaction safeguards. */
export interface CompactionPolicyInput {
  readonly contextWindowTokens: number;
  readonly proactiveCompactionLimit: number;
  readonly reactiveRetryLimit: number;
  readonly targetInputTokens: number;
}

/** Numeric prompt categories safe to export without prompt or customer content. */
export interface PromptCategoryTokens {
  readonly conversation: number;
  readonly memoryProviderBridge: number;
  readonly memoryProviderProfile: number;
  readonly memoryProviderRecall: number;
  readonly memoryProviderSources: number;
  readonly systemInstructions: number;
}

export interface PromptAssembledInput {
  readonly categoryTokens: PromptCategoryTokens;
  readonly estimatedInputTokens: number;
}

export interface StepStartedInput {
  readonly estimatedInputTokens: number;
  readonly stepNumber: number;
}

export interface StepCompletedInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stepNumber: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
}

export interface CompactionInput {
  readonly attempt?: number;
  readonly reason: "proactive" | "reactive";
  readonly shortened: boolean;
}

export type Evidence =
  | ({ readonly _tag: "PromptAssembled" } & PromptAssembledInput)
  | {
      readonly _tag: "StepStarted";
      readonly contextWindowTokens: number;
      readonly estimateScope: "modelInput" | "preCompaction";
      readonly estimatedInputTokens: number;
      readonly estimatedInputUtilization: number;
      readonly peakInputUtilization: number;
      readonly stepNumber: number;
    }
  | {
      readonly _tag: "StepCompleted";
      readonly contextWindowTokens: number;
      readonly inputTokens: number;
      readonly inputTokensAfterCompaction?: number;
      readonly inputUtilization: number;
      readonly inputUtilizationAfterCompaction?: number;
      readonly outputTokens: number;
      readonly peakInputUtilization: number;
      readonly stepNumber: number;
      readonly toolCallCount: number;
      readonly toolHeavyGrowthTokens: number;
      readonly toolResultCount: number;
    }
  | {
      readonly _tag: "Compacted";
      readonly compactionCount: number;
      readonly inputTokensBeforeCompaction: number;
      readonly inputTokensBeforeCompactionBasis: "estimated" | "reported";
      readonly inputUtilizationBeforeCompaction: number;
      readonly reason: CompactionInput["reason"];
      readonly shortened: boolean;
    }
  | {
      readonly _tag: "OverflowRetry";
      readonly attempt: number;
      readonly overflowCount: number;
      readonly retryLimit: number;
    }
  | {
      readonly _tag: "OverflowTerminal";
      readonly overflowCount: number;
      readonly retryLimit: number;
    };

export interface Observer {
  readonly compacted: (input: CompactionInput) => Evidence;
  readonly overflowRetry: (input: {
    readonly attempt: number;
    readonly retryLimit: number;
  }) => Evidence;
  readonly overflowTerminal: (input: { readonly retryLimit: number }) => Evidence;
  readonly promptAssembled: (input: PromptAssembledInput) => Evidence;
  readonly stepCompleted: (input: StepCompletedInput) => Evidence;
  readonly stepStarted: (input: StepStartedInput) => Evidence;
}

export interface ThinkObservabilityOptions {
  readonly delegate: Observability;
  readonly onCompacted: (input: CompactionInput) => void;
}

/** Translate one model's configured target into Think's proactive and reactive policy. */
export const compactionPolicy = (input: CompactionPolicyInput): ContextOverflowConfig => ({
  maxRetries: input.reactiveRetryLimit,
  proactive: {
    headroom: input.targetInputTokens / input.contextWindowTokens,
    maxCompactions: input.proactiveCompactionLimit,
    maxInputTokens: input.contextWindowTokens,
  },
  reactive: true,
});

/** Estimate one model call without exposing any of its input text in evidence. */
export const estimateInputTokens = (input: {
  readonly instructions: string;
  readonly messages: ReadonlyArray<ModelMessage>;
}): number =>
  estimateStringTokens(input.instructions) + estimateStringTokens(JSON.stringify(input.messages));

/** Count the prompt categories Osfo can distinguish before Think adds provider protocol tokens. */
export const categoryTokens = (input: {
  readonly conversationMessages: ReadonlyArray<ModelMessage>;
  readonly memoryProviderBridge: string;
  readonly memoryProviderProfile: string;
  readonly memoryProviderRecall: string;
  readonly memoryProviderSources: string;
  readonly systemInstructions: string;
}): PromptCategoryTokens => ({
  conversation: estimateStringTokens(JSON.stringify(input.conversationMessages)),
  memoryProviderBridge: estimateStringTokens(input.memoryProviderBridge),
  memoryProviderProfile: estimateStringTokens(input.memoryProviderProfile),
  memoryProviderRecall: estimateStringTokens(input.memoryProviderRecall),
  memoryProviderSources: estimateStringTokens(input.memoryProviderSources),
  systemInstructions: estimateStringTokens(input.systemInstructions),
});

/** Split the provider-memory prompt sections that PromptAssembly owns. */
export const categoryTokensForTurn = (input: {
  readonly conversationMessages: ReadonlyArray<ModelMessage>;
  readonly providerContext: string | null;
  readonly systemInstructions: string;
}): PromptCategoryTokens => {
  const sections = providerSections(input.providerContext);
  return categoryTokens({
    conversationMessages: input.conversationMessages,
    memoryProviderBridge: sections.bridge,
    memoryProviderProfile: sections.profile,
    memoryProviderRecall: sections.recall,
    memoryProviderSources: sections.sources,
    systemInstructions: input.systemInstructions,
  });
};

/** Keep Agents SDK delivery intact and project compaction events into a safe Osfo callback. */
export const makeThinkObservability = (options: ThinkObservabilityOptions): Observability => ({
  emit: (event: ObservabilityEvent) => {
    options.delegate.emit(event);
    if (event.type !== "chat:context:compacted") return;
    const compacted = {
      reason: event.payload.reason,
      shortened: event.payload.shortened,
    } satisfies CompactionInput;
    options.onCompacted(
      event.payload.attempt === undefined
        ? compacted
        : { ...compacted, attempt: event.payload.attempt },
    );
  },
});

/** Project one Think compaction into truthful compaction and retry evidence. */
export const compactionEvidence = (
  observer: Observer,
  event: CompactionInput,
  retryLimit: number,
): ReadonlyArray<Evidence> => {
  const compacted = observer.compacted(event);
  if (event.reason !== "reactive" || !event.shortened || event.attempt === undefined) {
    return [compacted];
  }
  return [compacted, observer.overflowRetry({ attempt: event.attempt, retryLimit })];
};

/** Track one turn's utilization without retaining prompt text or identities. */
export const makeObserver = (input: { readonly contextWindowTokens: number }): Observer => {
  let compactionCount = 0;
  let currentEstimatedInputTokens = 0;
  let lastCompletedInputTokens = 0;
  let lastCompletedHadTools = false;
  let peakInputUtilization = 0;
  let pendingCompaction = false;
  let pendingCompactionReason: CompactionInput["reason"] | undefined;
  let overflowCount = 0;

  const utilization = (tokens: number) => tokens / input.contextWindowTokens;
  const observeReportedInput = (tokens: number) => {
    peakInputUtilization = Math.max(peakInputUtilization, utilization(tokens));
  };

  return {
    compacted: (event) => {
      compactionCount += 1;
      pendingCompaction = event.shortened;
      pendingCompactionReason = event.shortened ? event.reason : undefined;
      const inputTokensBeforeCompaction =
        event.reason === "proactive" ? lastCompletedInputTokens : currentEstimatedInputTokens;
      return {
        _tag: "Compacted",
        compactionCount,
        inputTokensBeforeCompaction,
        inputTokensBeforeCompactionBasis: event.reason === "proactive" ? "reported" : "estimated",
        inputUtilizationBeforeCompaction: utilization(inputTokensBeforeCompaction),
        reason: event.reason,
        shortened: event.shortened,
      };
    },
    overflowRetry: ({ attempt, retryLimit }) => {
      overflowCount += 1;
      return { _tag: "OverflowRetry", attempt, overflowCount, retryLimit };
    },
    overflowTerminal: ({ retryLimit }) => {
      overflowCount += 1;
      return { _tag: "OverflowTerminal", overflowCount, retryLimit };
    },
    promptAssembled: (event) => ({ _tag: "PromptAssembled", ...event }),
    stepCompleted: (event) => {
      observeReportedInput(event.inputTokens);
      const afterCompaction = pendingCompaction
        ? {
            inputTokensAfterCompaction: event.inputTokens,
            inputUtilizationAfterCompaction: utilization(event.inputTokens),
          }
        : {};
      const evidence = {
        _tag: "StepCompleted",
        contextWindowTokens: input.contextWindowTokens,
        inputTokens: event.inputTokens,
        inputUtilization: utilization(event.inputTokens),
        outputTokens: event.outputTokens,
        peakInputUtilization,
        stepNumber: event.stepNumber,
        toolCallCount: event.toolCallCount,
        toolHeavyGrowthTokens: lastCompletedHadTools
          ? Math.max(0, event.inputTokens - lastCompletedInputTokens)
          : 0,
        toolResultCount: event.toolResultCount,
        ...afterCompaction,
      } satisfies Evidence;
      lastCompletedHadTools = event.toolCallCount > 0 || event.toolResultCount > 0;
      lastCompletedInputTokens = event.inputTokens;
      pendingCompaction = false;
      pendingCompactionReason = undefined;
      return evidence;
    },
    stepStarted: (event) => {
      currentEstimatedInputTokens = event.estimatedInputTokens;
      return {
        _tag: "StepStarted",
        contextWindowTokens: input.contextWindowTokens,
        estimateScope: pendingCompactionReason === "proactive" ? "preCompaction" : "modelInput",
        estimatedInputTokens: event.estimatedInputTokens,
        estimatedInputUtilization: utilization(event.estimatedInputTokens),
        peakInputUtilization,
        stepNumber: event.stepNumber,
      };
    },
  };
};

/** Publish one numeric event through the Worker's structured Effect logger. */
export const emit = Effect.fn("PromptUtilization.emit")((evidence: Evidence) => {
  const { _tag, ...annotations } = evidence;
  return Effect.logInfo(messageFor(evidence)).pipe(Effect.annotateLogs(annotations));
});

const messageFor = (evidence: Evidence): string => {
  switch (evidence._tag) {
    case "Compacted":
      return "Prompt context compacted";
    case "OverflowRetry":
      return "Prompt overflow retrying";
    case "OverflowTerminal":
      return "Prompt overflow exhausted";
    case "PromptAssembled":
      return "Prompt utilization assembled";
    case "StepCompleted":
      return "Prompt model step completed";
    case "StepStarted":
      return "Prompt pre-step input estimated";
  }
  return evidence satisfies never;
};

interface ProviderSections {
  readonly bridge: string;
  readonly profile: string;
  readonly recall: string;
  readonly sources: string;
}

const providerSections = (context: string | null): ProviderSections => {
  if (context === null) return { bridge: "", profile: "", recall: "", sources: "" };
  const profileHeading = "## Provider profile evidence";
  const recallHeading = "## Derived provider memory evidence";
  const sourcesHeading = "## Indexed conversation source evidence";
  const bridgeHeading = "## Recent unindexed conversation source evidence";
  return {
    bridge: after(context, bridgeHeading),
    profile: between(context, profileHeading, recallHeading),
    recall: between(context, recallHeading, sourcesHeading),
    sources: between(context, sourcesHeading, bridgeHeading),
  };
};

const between = (value: string, start: string, end: string): string => {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return "";
  return value.slice(startIndex + start.length, endIndex).trim();
};

const after = (value: string, start: string): string => {
  const startIndex = value.indexOf(start);
  return startIndex < 0 ? "" : value.slice(startIndex + start.length).trim();
};

export * as PromptUtilization from "./prompt-utilization";
