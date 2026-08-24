/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated test Layer. */
/* oxlint-disable eslint/no-underscore-dangle -- Application outcomes use the _tag discriminator. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { estimateStringTokens } from "agents/experimental/memory/utils";
import type { ModelMessage } from "ai";

import { ThinkSubmissionId, UserId } from "../domain";
import { MemoryProvider } from "./memory-provider";
import { PromptAssembly } from "./prompt-assembly";

const userId = UserId.make("user-209");

it.effect("orders bounded provider evidence after Native Memory policy", () => {
  const recalledQueries: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* PromptAssembly.assemble({
      agentInstructions: [
        "Agent instructions",
        "## User Context",
        "Prefers direct answers",
        "## Agent Notes",
        "Shipping Ticket 209",
      ].join("\n"),
      query: "What should I remember about the deploy?",
      userId,
    });

    expect(recalledQueries).toEqual(["What should I remember about the deploy?"]);
    expect(result._tag).toBe("ProviderRecallAvailable");
    if (result._tag !== "ProviderRecallAvailable") return;
    expect(result.instructions).toContain("Agent instructions");
    expect(result.instructions).toContain("## User Context");
    expect(result.instructions).toContain(
      "current User correction > current direct User statement > User Context > provider recall > weak behavioral inference",
    );
    expect(result.providerContext.indexOf("## Provider profile")).toBeLessThan(
      result.providerContext.indexOf("## Query-relevant provider recall"),
    );
    expect(result.providerContext).toContain('"Prefers small releases"');
    expect(result.providerContext).toContain('"Production deploys require approval"');
    expect(result.usage.items).toEqual([
      {
        allowanceKind: "supermemoryRetrievals",
        basis: "known_at_start",
        quantity: 1n,
      },
    ]);
  }).pipe(
    Effect.provide(
      memoryLayerWithRecall((input) => {
        recalledQueries.push(input.query);
        return Effect.succeed({
          profile: {
            dynamic: ["Deploying the first service"],
            static: ["Prefers small releases"],
          },
          relevantMemories: [
            {
              content: "Production deploys require approval",
              id: MemoryProvider.KnowledgeMemoryId.make("memory-1"),
              similarity: 0.91,
            },
          ],
          usage: {
            items: [
              {
                allowanceKind: "supermemoryRetrievals",
                basis: "known_at_start",
                quantity: 1n,
              },
            ],
            rateCardVersion: "test-rate-card",
          },
        });
      }),
    ),
  );
});

it.effect("bounds provider profile and recall independently", () =>
  PromptAssembly.assemble({
    agentInstructions: "Agent instructions",
    limits: {
      providerProfileMaxTokens: 30,
      providerRecallMaxTokens: 40,
      recallDeadlineMillis: 1_000,
    },
    query: "deploy",
    userId,
  }).pipe(
    Effect.map((result) => {
      expect(result._tag).toBe("ProviderRecallAvailable");
      if (result._tag !== "ProviderRecallAvailable") return result;
      const profile = between(
        result.providerContext,
        "## Provider profile\n\n",
        "\n\n## Query-relevant provider recall",
      );
      const recall = result.providerContext.slice(
        result.providerContext.indexOf("## Query-relevant provider recall\n\n") +
          "## Query-relevant provider recall\n\n".length,
      );

      expect(estimateStringTokens(profile)).toBeLessThanOrEqual(30);
      expect(estimateStringTokens(recall)).toBeLessThanOrEqual(40);
      expect(() => JSON.parse(profile)).not.toThrow();
      expect(() => JSON.parse(recall)).not.toThrow();
      expect(profile).not.toContain("profile-tail");
      expect(recall).not.toContain("recall-tail");
      return result;
    }),
    Effect.provide(
      memoryLayer({
        profile: {
          dynamic: Array.from(
            { length: 25 },
            (_, index) => `${index} ${"dynamic ".repeat(100)}profile-tail`,
          ),
          static: Array.from(
            { length: 25 },
            (_, index) => `${index} ${"static ".repeat(100)}profile-tail`,
          ),
        },
        relevantMemories: [
          {
            content: `${"recalled ".repeat(100)}recall-tail`,
            id: MemoryProvider.KnowledgeMemoryId.make("memory-large"),
            similarity: 0.9,
          },
        ],
      }),
    ),
  ),
);

it.effect("fails open to Native Memory when the provider is unavailable", () =>
  PromptAssembly.assemble({
    agentInstructions: "Native Memory remains available",
    query: "What did I say before?",
    userId,
  }).pipe(
    Effect.map((result) => {
      expect(result).toEqual({
        _tag: "ProviderRecallUnavailable",
        instructions: [
          "Native Memory remains available",
          "## Memory availability",
          "The external Knowledge Base is unavailable for this turn. Continue with Native Memory. Tell the User only when missing Knowledge Base evidence prevents or weakens the requested task.",
        ].join("\n\n"),
        providerContext: null,
        usage: null,
      });
    }),
    Effect.provide(
      memoryFailureLayer(
        new MemoryProvider.MemoryProviderUnavailable({
          message: "provider outage",
          operation: "recall",
        }),
      ),
    ),
  ),
);

it.effect("fails open when provider recall exceeds its strict deadline", () =>
  Effect.gen(function* () {
    const fiber = yield* PromptAssembly.assemble({
      agentInstructions: "Native Memory remains available",
      limits: {
        providerProfileMaxTokens: 30,
        providerRecallMaxTokens: 40,
        recallDeadlineMillis: 50,
      },
      query: "What did I say before?",
      userId,
    }).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(50));
    const result = yield* Fiber.join(fiber);

    expect(result._tag).toBe("ProviderRecallUnavailable");
    expect(result.instructions).toContain("Native Memory remains available");
    expect(result.instructions).toContain("The external Knowledge Base is unavailable");
  }).pipe(Effect.provide(memoryLayerWithRecall(() => Effect.never))),
);

it.effect("retains provider evidence when a tool result extends the Think turn", () => {
  let recalls = 0;
  const messages: Array<ModelMessage> = [
    { content: "current User input", role: "user" },
    {
      content: [
        {
          input: { query: "deployment" },
          toolCallId: "call-1",
          toolName: "sessionRecall",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "Earlier Session result" },
          toolCallId: "call-1",
          toolName: "sessionRecall",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
  return PromptAssembly.forModelTurn({
    agentInstructions: "refreshed instructions",
    continuation: true,
    messages,
    retainedPrompt: {
      memoryState: "available",
      providerContext: '## Provider profile\n\n{"static":["retained fact"]}',
    },
    userId,
  }).pipe(
    Effect.map((result) => {
      expect(result).toEqual({
        _tag: "ProviderRecallRetained",
        instructions: expect.stringContaining("refreshed instructions"),
        memoryState: "available",
        messages: [
          {
            content: [
              {
                text: '## Provider profile\n\n{"static":["retained fact"]}',
                type: "text",
              },
              { text: "current User input", type: "text" },
            ],
            role: "user",
          },
          messages[1],
          messages[2],
        ],
        providerContext: '## Provider profile\n\n{"static":["retained fact"]}',
        usage: null,
      });
      expect(result.instructions).toContain("## Memory evidence policy");
      expect(recalls).toBe(0);
    }),
    Effect.provide(
      memoryLayerWithRecall(() => {
        recalls += 1;
        return Effect.die(new Error("unexpected recall"));
      }),
    ),
  );
});

it.effect("hands retained evidence to continuations and recalls after Agent eviction", () => {
  const submissionId = ThinkSubmissionId.make("submission-209");
  const initialMessages: Array<ModelMessage> = [{ content: "current User input", role: "user" }];
  const continuationMessages: Array<ModelMessage> = [
    ...initialMessages,
    { content: "Tool result extended the turn", role: "assistant" },
  ];
  const activeAssembly = PromptAssembly.makeRetainedPromptAssembly();
  let recalls = 0;

  return Effect.gen(function* () {
    yield* activeAssembly.forModelTurn({
      agentInstructions: "initial instructions",
      continuation: false,
      messages: initialMessages,
      submissionId,
      userId,
    });
    const continued = yield* activeAssembly.forModelTurn({
      agentInstructions: "refreshed instructions",
      continuation: true,
      messages: continuationMessages,
      submissionId,
      userId,
    });

    expect(recalls).toBe(1);
    expect(continued._tag).toBe("ProviderRecallRetained");
    expect(continued.messages.at(-1)).toEqual(continuationMessages.at(-1));
    expect(continued.messages[0]).toEqual({
      content: [
        { text: expect.stringContaining("## Provider profile"), type: "text" },
        { text: "current User input", type: "text" },
      ],
      role: "user",
    });

    const recoveredAssembly = PromptAssembly.makeRetainedPromptAssembly();
    const recovered = yield* recoveredAssembly.forModelTurn({
      agentInstructions: "recovered instructions",
      continuation: true,
      messages: continuationMessages,
      submissionId,
      userId,
    });

    expect(recalls).toBe(2);
    expect(recovered._tag).toBe("ProviderRecallAvailable");
    expect(recovered.messages.at(-1)).toEqual(continuationMessages.at(-1));
  }).pipe(
    Effect.provide(
      memoryLayerWithRecall(() => {
        recalls += 1;
        return Effect.succeed({
          profile: { dynamic: [], static: ["retained fact"] },
          relevantMemories: [],
          usage: { items: [], rateCardVersion: "test-rate-card" },
        });
      }),
    ),
  );
});

it.effect("places provider evidence after rolling context and before current User input", () => {
  const messages: Array<ModelMessage> = [
    { content: "Earlier question", role: "user" },
    { content: "Earlier answer", role: "assistant" },
    { content: "Current correction", role: "user" },
  ];
  const recalledQueries: Array<string> = [];
  return PromptAssembly.forModelTurn({
    agentInstructions: "Agent instructions and Core Memory",
    continuation: false,
    messages,
    userId,
  }).pipe(
    Effect.map((result) => {
      expect(recalledQueries).toEqual(["Current correction"]);
      expect(result.messages).toEqual([
        { content: "Earlier question", role: "user" },
        { content: "Earlier answer", role: "assistant" },
        {
          content: [
            {
              text: expect.stringContaining("## Provider profile"),
              type: "text",
            },
            { text: "Current correction", type: "text" },
          ],
          role: "user",
        },
      ]);
    }),
    Effect.provide(
      memoryLayerWithRecall((input) => {
        recalledQueries.push(input.query);
        return Effect.succeed({
          profile: { dynamic: [], static: ["Provider profile fact"] },
          relevantMemories: [
            {
              content: "Provider recall fact",
              id: MemoryProvider.KnowledgeMemoryId.make("memory-order"),
              similarity: 0.8,
            },
          ],
          usage: { items: [], rateCardVersion: "test-rate-card" },
        });
      }),
    ),
  );
});

const between = (value: string, start: string, end: string): string => {
  const startIndex = value.indexOf(start) + start.length;
  return value.slice(startIndex, value.indexOf(end, startIndex));
};

const memoryLayer = (result: Pick<MemoryProvider.RecallResult, "profile" | "relevantMemories">) =>
  memoryLayerWithRecall(() =>
    Effect.succeed({
      ...result,
      usage: { items: [], rateCardVersion: "test-rate-card" },
    }),
  );

const memoryLayerWithRecall = (recall: MemoryProvider.Interface["recall"]) =>
  Layer.succeed(
    MemoryProvider.Service,
    MemoryProvider.Service.of({
      deleteSessionConversation: () => Effect.die(new Error("unexpected Session delete")),
      deleteUserKnowledge: () => Effect.die(new Error("unexpected User delete")),
      forgetKnowledge: () => Effect.die(new Error("unexpected forget")),
      recall,
      saveConversation: () => Effect.die(new Error("unexpected conversation save")),
    }),
  );

const memoryFailureLayer = (
  failure: MemoryProvider.MemoryProviderRejected | MemoryProvider.MemoryProviderUnavailable,
) => memoryLayerWithRecall(() => Effect.fail(failure));
