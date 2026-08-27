import { expect, it } from "@effect/vitest";
import { Clock, Config, Effect, Random } from "effect";

import { SessionId, UserId } from "../../src/domain";
import { SupermemoryMemoryProvider } from "../../src/integrations/supermemory/memory-provider";
import { MemoryProvider } from "../../src/services/memory-provider";
import { PromptAssembly } from "../../src/services/prompt-assembly";

/* oxlint-disable eslint/no-underscore-dangle -- Application outcomes use the _tag discriminator. */

const pollIntervalMillis = 2_000;

it.live("qualifies bounded exhausted profile-and-query recall", () =>
  Config.redacted("SUPERMEMORY_API_KEY").pipe(
    Effect.flatMap((apiKey) =>
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* MemoryProvider.Service;
          const startedAt = yield* Clock.currentTimeMillis;
          const [runHigh, runLow] = yield* Effect.all([Random.next, Random.next]);
          const runId = `${startedAt.toString(36)}${runHigh.toString(36).slice(2)}${runLow.toString(36).slice(2)}`;
          const userId = UserId.make(`qualification-exhausted-${runId}`);
          yield* Effect.addFinalizer(() =>
            provider.deleteUserKnowledge({ userId }).pipe(Effect.ignore),
          );

          yield* provider.configureUserGuidance({ userId });
          const result = yield* PromptAssembly.assemble({
            agentInstructions: "Qualification instructions",
            limits: {
              providerBridgeMaxTokens: 5_000,
              providerProfileMaxTokens: 5_000,
              providerRecallMaxTokens: 5_000,
              providerSourceMaxTokens: 5_000,
              recallDeadlineMillis: 10_000,
            },
            mode: "exhausted",
            query: "What should I remember?",
            recentTurns: [
              {
                messages: [{ content: "Local bridge evidence", role: "user" }],
                recordedAt: "2026-08-24T12:00:00.000Z",
                sourceId: `bridge-${runId}`,
              },
            ],
            userId,
          });

          expect(result._tag).toBe("ProviderRecallAvailable");
          if (result._tag !== "ProviderRecallAvailable") return;
          expect(result.providerContext).not.toContain("Indexed conversation source evidence");
          expect(result.providerContext).not.toContain(
            "Recent unindexed conversation source evidence",
          );
          expect(result.providerContext).not.toContain("Local bridge evidence");
          expect(result.usage.completedNonModelCost).toEqual([
            {
              activity: "conversationsAndMemory",
              ratedCostUsdMicros: 5n,
              resourcePriceVersion: "resource-prices-2026-08-22",
            },
          ]);
          yield* reportStage("exhausted-profile-query-passed", startedAt);
        }),
      ).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This credentialed test is the live application entry point.
        Effect.provide(
          SupermemoryMemoryProvider.layer({
            apiKey,
            rateCard: SupermemoryMemoryProvider.publicRateCard,
          }),
        ),
      ),
    ),
  ),
);

it.live("qualifies live Supermemory correction ordering and semantic extraction", () =>
  Config.redacted("SUPERMEMORY_API_KEY").pipe(
    Effect.flatMap((apiKey) =>
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* MemoryProvider.Service;
          const startedAt = yield* Clock.currentTimeMillis;
          const [runHigh, runLow] = yield* Effect.all([Random.next, Random.next]);
          const runId = `${startedAt.toString(36)}${runHigh.toString(36).slice(2)}${runLow.toString(36).slice(2)}`;
          const userId = UserId.make(`qualification-user-${runId}`);
          const correctionSessionId = SessionId.make(`qualification-correction-${runId}`);
          const associationSessionId = SessionId.make(`qualification-association-${runId}`);
          yield* Effect.addFinalizer(() =>
            provider.deleteUserKnowledge({ userId }).pipe(Effect.ignore),
          );
          yield* reportStage("started", startedAt);

          const staleCity = "Porto";
          const correctedCity = "Valencia";
          const assistantOnlyClaim = "collect antique compasses";
          const hypotheticalClaim = "commute by ferry in Oslo";
          const fictionalClaim = "own Citrine Studio";
          const confirmedProject = "Lattice Harbor";
          const rememberedPerson = "Rowan Ellis";
          const opportunityCompany = "Meridian Supply";
          const initialMessages: readonly [
            MemoryProvider.ConversationMessage,
            ...ReadonlyArray<MemoryProvider.ConversationMessage>,
          ] = [
            {
              content: `My ceramics workshop is in ${staleCity}.`,
              role: "user" as const,
            },
            {
              content: `You ${assistantOnlyClaim}.`,
              role: "assistant" as const,
            },
            {
              content: `Hypothetically, if I lived in Oslo, I would commute by ferry. I do not live there.`,
              role: "user" as const,
            },
            {
              content: `A novel I am reading says, "I own Citrine Studio." That line is fictional and not about me.`,
              role: "user" as const,
            },
            {
              content: `Your project is named ${confirmedProject}, correct?`,
              role: "assistant" as const,
            },
            {
              content: `Yes, I confirm my project is named ${confirmedProject}.`,
              role: "user" as const,
            },
            {
              content: `My friend ${rememberedPerson} leads procurement at ${opportunityCompany}.`,
              role: "user" as const,
            },
          ];
          const correction = {
            content: `Correction: my ceramics workshop is now in ${correctedCity}, not ${staleCity}.`,
            role: "user" as const,
          };

          yield* provider.configureOrganizationGuidance;
          yield* provider.configureUserGuidance({ userId });
          yield* reportStage("guidance-configured", startedAt);
          const initial = yield* provider.saveConversation({
            conversation: MemoryProvider.ConversationSnapshot.make({
              messages: initialMessages,
              usageStartIndex: 0,
            }),
            sessionId: correctionSessionId,
            userId,
          });
          yield* reportStage("initial-accepted", startedAt);

          const beforeIndexing = yield* PromptAssembly.assemble({
            agentInstructions: "Qualification instructions",
            limits: {
              ...PromptAssembly.defaultLimits,
              recallDeadlineMillis: 10_000,
            },
            query: `Where is my ceramics workshop now?`,
            recentTurns: [
              {
                messages: [correction],
                recordedAt: "2026-08-24T12:00:00.000Z",
                sourceId: `bridge-${runId}`,
              },
            ],
            userId,
          });
          expect(beforeIndexing.providerContext).toContain("source=recent-unindexed");
          expect(beforeIndexing.providerContext).toContain(correctedCity);
          yield* reportStage("before-indexing-bridge-passed", startedAt);

          yield* waitUntil({
            description: "the initial conversation to finish processing",
            read: () => provider.getConversationStatus({ documentId: initial.documentId }),
            ready: ({ processingStatus }) => processingStatus === "done",
          });
          yield* reportStage("initial-done", startedAt);
          yield* waitUntil({
            description: "the initial conversation source to become searchable",
            read: () =>
              provider.checkConversationSearchability({ expectedSource: staleCity, userId }),
            ready: (searchable) => searchable,
          });
          yield* reportStage("initial-searchable", startedAt);

          const corrected = yield* provider.saveConversation({
            conversation: MemoryProvider.ConversationSnapshot.make({
              messages: [...initialMessages, correction],
              usageStartIndex: initialMessages.length,
            }),
            sessionId: correctionSessionId,
            userId,
          });
          expect(corrected.documentId).toBe(initial.documentId);
          yield* reportStage("correction-accepted", startedAt);
          yield* waitUntil({
            description: "the corrected conversation to finish processing",
            read: () => provider.getConversationStatus({ documentId: corrected.documentId }),
            ready: ({ processingStatus }) => processingStatus === "done",
          });
          yield* reportStage("correction-done", startedAt);
          yield* waitUntil({
            description: "the corrected source to become searchable",
            read: () =>
              provider.checkConversationSearchability({ expectedSource: correctedCity, userId }),
            ready: (searchable) => searchable,
          });
          yield* reportStage("correction-searchable", startedAt);

          const afterIndexing = yield* provider.recall({
            mode: "normal",
            query: `What is my current qualification workshop city ${correctedCity}?`,
            userId,
          });
          expect(
            afterIndexing.sourceChunks.some(({ content }) => content.includes(correctedCity)),
          ).toBe(true);
          yield* reportStage("after-indexing-source-passed", startedAt);

          const opportunity = `I am evaluating a procurement-audit opportunity for ${opportunityCompany}.`;
          const association = yield* provider.saveConversation({
            conversation: MemoryProvider.ConversationSnapshot.make({
              messages: [{ content: opportunity, role: "user" }],
              usageStartIndex: 0,
            }),
            sessionId: associationSessionId,
            userId,
          });
          yield* reportStage("association-accepted", startedAt);
          yield* waitUntil({
            description: "the association conversation to finish processing",
            read: () => provider.getConversationStatus({ documentId: association.documentId }),
            ready: ({ processingStatus }) => processingStatus === "done",
          });
          yield* reportStage("association-done", startedAt);
          yield* waitUntil({
            description: "the association source to become searchable",
            read: () =>
              provider.checkConversationSearchability({
                expectedSource: opportunityCompany,
                userId,
              }),
            ready: (searchable) => searchable,
          });
          yield* reportStage("association-searchable", startedAt);

          const crossSession = yield* provider.recall({
            mode: "normal",
            query: `Who in my network relates to the ${opportunityCompany} procurement opportunity?`,
            userId,
          });
          const rememberedPersonSourceFound = crossSession.sourceChunks.some(({ content }) =>
            content.includes(rememberedPerson),
          );
          expect(
            crossSession.sourceChunks.some(({ content }) => content.includes(opportunityCompany)),
          ).toBe(true);
          yield* reportStage(
            rememberedPersonSourceFound
              ? "cross-session-person-source-passed"
              : "cross-session-person-source-missing",
            startedAt,
          );

          const afterDreaming = yield* waitUntil({
            attempts: 40,
            description: "derived memories to reflect the correction and confirmed facts",
            intervalMillis: 15_000,
            read: () =>
              Effect.all(
                {
                  association: provider.recall({
                    mode: "normal",
                    query: `Who is related to the ${opportunityCompany} procurement opportunity?`,
                    userId,
                  }),
                  confirmation: provider.recall({
                    mode: "normal",
                    query: `What project did I explicitly confirm? ${confirmedProject}`,
                    userId,
                  }),
                  correction: provider.recall({
                    mode: "normal",
                    query: `What is my corrected workshop city? ${correctedCity}`,
                    userId,
                  }),
                },
                { concurrency: 1 },
              ).pipe(
                Effect.map((recalls) => {
                  const associationEvidence = providerMemoryText(recalls.association);
                  const confirmationEvidence = providerMemoryText(recalls.confirmation);
                  const correctionEvidence = providerMemoryText(recalls.correction);
                  const allEvidence = [
                    associationEvidence,
                    confirmationEvidence,
                    correctionEvidence,
                  ].join("\n");
                  return {
                    assistantOnlyLearned: allEvidence.includes(assistantOnlyClaim),
                    associationLearned:
                      associationEvidence.includes(rememberedPerson) &&
                      associationEvidence.includes(opportunityCompany),
                    available: true,
                    confirmationLearned: confirmationEvidence.includes(confirmedProject),
                    correctionLearned: correctionEvidence.includes(correctedCity),
                    fictionalLearned: allEvidence.includes(fictionalClaim),
                    hypotheticalLearned: allEvidence.includes(hypotheticalClaim),
                  };
                }),
                Effect.catchTag("MemoryProviderUnavailable", () =>
                  Effect.succeed({
                    assistantOnlyLearned: false,
                    associationLearned: false,
                    available: false,
                    confirmationLearned: false,
                    correctionLearned: false,
                    fictionalLearned: false,
                    hypotheticalLearned: false,
                  }),
                ),
                Effect.tap((observation) => reportSemanticObservation(observation, startedAt)),
              ),
            ready: (observation) =>
              observation.available &&
              observation.associationLearned &&
              observation.confirmationLearned &&
              observation.correctionLearned,
          });
          yield* reportStage("dreaming-positive-matrix-passed", startedAt);
          expect(afterDreaming.correctionLearned).toBe(true);
          expect(afterDreaming.confirmationLearned).toBe(true);
          expect(afterDreaming.associationLearned).toBe(true);
          expect(afterDreaming.assistantOnlyLearned).toBe(false);
          expect(afterDreaming.hypotheticalLearned).toBe(false);
          expect(afterDreaming.fictionalLearned).toBe(false);
          yield* reportStage("semantic-negative-matrix-passed", startedAt);
        }),
      ).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This credentialed test is the live application entry point.
        Effect.provide(
          SupermemoryMemoryProvider.layer({
            apiKey,
            rateCard: SupermemoryMemoryProvider.publicRateCard,
          }),
        ),
      ),
    ),
  ),
);

const providerMemoryText = (recall: MemoryProvider.RecallResult): string =>
  [
    ...recall.profile.static,
    ...recall.profile.dynamic,
    ...recall.relevantMemories.map(({ content }) => content),
  ].join("\n");

const reportStage = (stage: string, startedAt: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((currentTime) =>
      Effect.sync(() => {
        // oxlint-disable-next-line eslint/no-console, effecttsgo/global-console-in-effect, effecttsgo/prefer-schema-over-json -- Live qualification emits a known privacy-safe JSON timing record.
        console.info(
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This known control-plane record needs compact line-delimited JSON.
          JSON.stringify({
            elapsedMillis: currentTime - startedAt,
            stage,
            test: "supermemory-live",
          }),
        );
      }),
    ),
  );

const reportSemanticObservation = (
  observation: {
    readonly assistantOnlyLearned: boolean;
    readonly associationLearned: boolean;
    readonly available: boolean;
    readonly confirmationLearned: boolean;
    readonly correctionLearned: boolean;
    readonly fictionalLearned: boolean;
    readonly hypotheticalLearned: boolean;
  },
  startedAt: number,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((currentTime) =>
      Effect.sync(() => {
        // oxlint-disable-next-line eslint/no-console, effecttsgo/global-console-in-effect, effecttsgo/prefer-schema-over-json -- Live qualification emits known privacy-safe semantic booleans as JSON.
        console.info(
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This known control-plane record needs compact line-delimited JSON.
          JSON.stringify({
            elapsedMillis: currentTime - startedAt,
            ...observation,
            stage: "dreaming-observation",
            test: "supermemory-live",
          }),
        );
      }),
    ),
  );

const waitUntil = <A, E, R>(options: {
  readonly attempts?: number;
  readonly description: string;
  readonly intervalMillis?: number;
  readonly read: () => Effect.Effect<A, E, R>;
  readonly ready: (value: A) => boolean;
}): Effect.Effect<A, E, R> => {
  const poll = (attempts: number): Effect.Effect<A, E, R> =>
    options.read().pipe(
      Effect.flatMap((value) => {
        if (options.ready(value)) return Effect.succeed(value);
        if (attempts <= 1) {
          return Effect.die(new Error(`Timed out waiting for ${options.description}`));
        }
        return Effect.sleep(options.intervalMillis ?? pollIntervalMillis).pipe(
          Effect.andThen(poll(attempts - 1)),
        );
      }),
    );
  return poll(options.attempts ?? 30);
};
