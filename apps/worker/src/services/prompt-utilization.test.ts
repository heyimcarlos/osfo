/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect owns its isolated logger. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import type { ObservabilityEvent } from "agents/observability";

import { PromptUtilization } from "./prompt-utilization";

it("derives compaction headroom from each model policy without a fixed utilization target", () => {
  expect(
    PromptUtilization.compactionPolicy({
      contextWindowTokens: 200_000,
      proactiveCompactionLimit: 2,
      reactiveRetryLimit: 1,
      targetInputTokens: 110_000,
    }),
  ).toEqual({
    maxRetries: 1,
    proactive: {
      headroom: 0.55,
      maxCompactions: 2,
      maxInputTokens: 200_000,
    },
    reactive: true,
  });
  expect(
    PromptUtilization.compactionPolicy({
      contextWindowTokens: 128_000,
      proactiveCompactionLimit: 1,
      reactiveRetryLimit: 2,
      targetInputTokens: 96_000,
    }).proactive?.headroom,
  ).toBe(0.75);
});

it("forwards Think events while exposing only safe compaction facts to Osfo", () => {
  const forwarded: Array<ObservabilityEvent> = [];
  const compacted: Array<PromptUtilization.CompactionInput> = [];
  const observability = PromptUtilization.makeThinkObservability({
    delegate: { emit: (event) => forwarded.push(event) },
    onCompacted: (event) => compacted.push(event),
  });
  const event: ObservabilityEvent = {
    agent: "OsfoAgent",
    name: "private-agent-identity",
    payload: {
      attempt: 1,
      reason: "reactive",
      requestId: "private-request-identity",
      shortened: true,
    },
    timestamp: 1,
    type: "chat:context:compacted",
  };

  observability.emit(event);

  expect(forwarded).toEqual([event]);
  expect(compacted).toEqual([{ attempt: 1, reason: "reactive", shortened: true }]);
  expect(JSON.stringify(compacted)).not.toContain("private-");
});

it("counts provider prompt categories without retaining their content", () => {
  const categories = PromptUtilization.categoryTokensForTurn({
    conversationMessages: [{ content: "current private request", role: "user" }],
    providerContext: [
      "## Provider profile evidence",
      "private profile",
      "## Derived provider memory evidence",
      "private recall",
      "## Indexed conversation source evidence",
      "private indexed source",
      "## Recent unindexed conversation source evidence",
      "private bridge",
    ].join("\n"),
    systemInstructions: "private system instructions",
  });

  expect(Object.values(categories).every((tokens) => tokens > 0)).toBe(true);
  expect(categories).toEqual({
    conversation: expect.any(Number),
    memoryProviderBridge: expect.any(Number),
    memoryProviderProfile: expect.any(Number),
    memoryProviderRecall: expect.any(Number),
    memoryProviderSources: expect.any(Number),
    systemInstructions: expect.any(Number),
  });
});

it("attributes next-step input growth to the preceding tool-heavy step", () => {
  const observer = PromptUtilization.makeObserver({ contextWindowTokens: 1_000 });
  observer.stepCompleted({
    inputTokens: 300,
    outputTokens: 50,
    stepNumber: 1,
    toolCallCount: 1,
    toolResultCount: 1,
  });
  observer.stepStarted({ estimatedInputTokens: 410, stepNumber: 2 });

  expect(
    observer.stepCompleted({
      inputTokens: 400,
      outputTokens: 30,
      stepNumber: 2,
      toolCallCount: 0,
      toolResultCount: 0,
    }),
  ).toMatchObject({ toolHeavyGrowthTokens: 100 });
});

it.effect("emits privacy-safe prompt, step, compaction, retry, and tool-growth evidence", () => {
  const logs: Array<{ readonly annotations: object; readonly message: unknown }> = [];
  const logger = Logger.make<unknown, void>((options) => {
    logs.push({
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      message: options.message,
    });
  });
  const observer = PromptUtilization.makeObserver({ contextWindowTokens: 1_000 });

  return Effect.gen(function* () {
    yield* PromptUtilization.emit(
      observer.promptAssembled({
        categoryTokens: {
          conversation: 120,
          memoryProviderBridge: 20,
          memoryProviderProfile: 30,
          memoryProviderRecall: 40,
          memoryProviderSources: 50,
          systemInstructions: 80,
        },
        estimatedInputTokens: 340,
      }),
    );
    yield* PromptUtilization.emit(
      observer.stepStarted({ estimatedInputTokens: 350, stepNumber: 1 }),
    );
    yield* PromptUtilization.emit(
      observer.stepCompleted({
        inputTokens: 400,
        outputTokens: 60,
        stepNumber: 1,
        toolCallCount: 2,
        toolResultCount: 2,
      }),
    );
    yield* PromptUtilization.emit(observer.compacted({ reason: "proactive", shortened: true }));
    yield* PromptUtilization.emit(
      observer.stepStarted({ estimatedInputTokens: 260, stepNumber: 2 }),
    );
    yield* PromptUtilization.emit(
      observer.stepCompleted({
        inputTokens: 250,
        outputTokens: 25,
        stepNumber: 2,
        toolCallCount: 0,
        toolResultCount: 0,
      }),
    );
    yield* PromptUtilization.emit(observer.overflowRetry({ attempt: 1, retryLimit: 1 }));
    yield* PromptUtilization.emit(observer.overflowTerminal({ retryLimit: 1 }));

    expect(logs.map(({ message }) => message)).toEqual([
      ["Prompt utilization assembled"],
      ["Prompt model step started"],
      ["Prompt model step completed"],
      ["Prompt context compacted"],
      ["Prompt model step started"],
      ["Prompt model step completed"],
      ["Prompt overflow retrying"],
      ["Prompt overflow exhausted"],
    ]);
    expect(logs[2]?.annotations).toMatchObject({
      inputTokens: 400,
      inputUtilization: 0.4,
      outputTokens: 60,
      peakInputUtilization: 0.4,
      toolCallCount: 2,
      toolResultCount: 2,
      toolHeavyGrowthTokens: 0,
    });
    expect(logs[3]?.annotations).toMatchObject({
      compactionCount: 1,
      inputTokensBeforeCompaction: 400,
      inputUtilizationBeforeCompaction: 0.4,
      reason: "proactive",
      shortened: true,
    });
    expect(logs[5]?.annotations).toMatchObject({
      inputTokens: 250,
      inputTokensAfterCompaction: 250,
      inputUtilizationAfterCompaction: 0.25,
      peakInputUtilization: 0.4,
      toolHeavyGrowthTokens: 0,
    });
    expect(logs[6]?.annotations).toMatchObject({ attempt: 1, retryLimit: 1 });
    expect(logs[7]?.annotations).toMatchObject({ overflowCount: 2, retryLimit: 1 });

    expect(
      logs.every(({ annotations }) => !Object.values(annotations).includes("private-user-id")),
    ).toBe(true);
  }).pipe(Effect.provide(Logger.layer([logger])));
});
