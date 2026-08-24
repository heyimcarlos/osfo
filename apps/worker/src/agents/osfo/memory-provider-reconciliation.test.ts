/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each it.effect is the entry point for its isolated service Layers. */
import { expect, it } from "@effect/vitest";
import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Option } from "effect";

import { Db } from "../../db";
import { AllowancePeriodId, AssistantMessageId, SessionId, UserId } from "../../domain";
import { MemoryProvider } from "../../services/memory-provider";
import type {
  ClaimedMemoryProviderWork,
  MemoryProviderOutboxPayload,
  MemoryProviderOutboxStore,
} from "./db/memory-provider-outbox";
import { MemoryProviderOutboxId } from "./db/memory-provider-outbox";
import { reconcileMemoryProviderOutbox } from "./memory-provider-reconciliation";

it.effect("retains a rejected deletion in an explicit terminal state", () => {
  const claim = deletionClaim();
  const observed: Array<MemoryProviderOutboxPayload> = [];
  const { completed, failed, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: (input) => {
      observed.push({ _tag: "DeleteSessionConversation", ...input });
      return Effect.fail(
        new MemoryProvider.MemoryProviderRejected({
          message: "Provider policy is temporarily inconsistent",
          operation: "deleteSessionConversation",
        }),
      );
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([claim.payload]);
        expect(failed).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("completes deletion work only after provider confirmation", () => {
  const claim = deletionClaim();
  const observed: Array<MemoryProviderOutboxPayload> = [];
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    deleteSessionConversation: (input) => {
      observed.push({ _tag: "DeleteSessionConversation", ...input });
      return Effect.succeed({ _tag: "AlreadyAbsent" as const });
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([claim.payload]);
        expect(completed).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
      }),
    ),
  );
});

it.effect("retries the exact conversation snapshot during a provider outage", () => {
  const claim = conversationClaim();
  const observed: Array<MemoryProvider.SaveConversationInput> = [];
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    saveConversation: (input) => {
      observed.push(input);
      return Effect.fail(
        new MemoryProvider.MemoryProviderUnavailable({
          message: "Provider is unavailable",
          operation: "saveConversation",
        }),
      );
    },
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(observed).toEqual([
          {
            conversation: MemoryProvider.ConversationSnapshot.make({
              messages: [
                { content: "Remember this", role: "user" },
                { content: "I will remember it", role: "assistant" },
              ],
              usageStartIndex: 0,
            }),
            sessionId: "session-1",
            userId: "user-1",
          },
        ]);
        expect(retried).toEqual([claim.outboxId]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("terminalizes an accepted conversation whose provider status is invalid", () => {
  const claim = conversationClaim();
  const { completed, failed, retried, store } = testStore(claim);
  const provider = providerStub({
    saveConversation: () =>
      Effect.fail(
        new MemoryProvider.MemoryProviderAcceptanceStatusInvalid({
          documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
          message: "The MemoryProvider accepted the conversation with an invalid status",
          operation: "saveConversation",
          usage: {
            items: [
              {
                allowanceKind: "supermemoryIngestionTokens",
                basis: "conservative",
                quantity: 1n,
              },
            ],
            rateCardVersion: "test-rate-card",
          },
        }),
      ),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(failed).toEqual([claim.outboxId]);
        expect(retried).toEqual([]);
        expect(completed).toEqual([]);
      }),
    ),
  );
});

it.effect("stops when a stale conversation claim loses settlement ownership", () => {
  const claim = conversationClaim();
  const { completed, retried, store } = testStore(claim, { providerAccepted: false });
  const provider = providerStub({
    saveConversation: () =>
      Effect.succeed({
        documentId: MemoryProvider.ProviderDocumentId.make("document-1"),
        processingStatus: "processing",
        usage: {
          items: [
            {
              allowanceKind: "supermemoryIngestionTokens",
              basis: "conservative",
              quantity: 1n,
            },
          ],
          rateCardVersion: "test-rate-card",
        },
      }),
  });

  return Effect.scoped(reconcileMemoryProviderOutbox(store)).pipe(
    Effect.provideService(MemoryProvider.Service, provider),
    Effect.provideService(Db.Service, unavailableDatabase),
    Effect.provide(BrowserCrypto.layer),
    Effect.andThen(
      Effect.sync(() => {
        expect(completed).toEqual([]);
        expect(retried).toEqual([]);
      }),
    ),
  );
});

const deletionClaim = (): ClaimedMemoryProviderWork => ({
  allowancePeriodId: null,
  attemptCount: 1,
  claimToken: "claim-1",
  outboxId: MemoryProviderOutboxId.make("deletion:session-1"),
  payload: {
    _tag: "DeleteSessionConversation",
    sessionId: SessionId.make("session-1"),
    userId: UserId.make("user-1"),
  },
  providerAcceptance: null,
  sequence: 1,
  usage: null,
});

const conversationClaim = (): ClaimedMemoryProviderWork => ({
  allowancePeriodId: AllowancePeriodId.make("allowance-1"),
  attemptCount: 1,
  claimToken: "claim-append-1",
  outboxId: MemoryProviderOutboxId.make("conversation:9:session-1:assistant-1"),
  payload: {
    _tag: "SaveConversation",
    projection: {
      allowancePeriodId: AllowancePeriodId.make("allowance-1"),
      conversation: MemoryProvider.ConversationSnapshot.make({
        messages: [
          { content: "Remember this", role: "user" },
          { content: "I will remember it", role: "assistant" },
        ],
        usageStartIndex: 0,
      }),
      lastMessageId: AssistantMessageId.make("assistant-1"),
      sessionId: SessionId.make("session-1"),
      userId: UserId.make("user-1"),
    },
  },
  providerAcceptance: null,
  sequence: 1,
  usage: null,
});

const testStore = (
  claim: ClaimedMemoryProviderWork,
  options: { readonly providerAccepted?: boolean } = {},
) => {
  const failed: Array<MemoryProviderOutboxId> = [];
  const completed: Array<MemoryProviderOutboxId> = [];
  const retried: Array<MemoryProviderOutboxId> = [];
  let available = true;
  const store = {
    awaitProvider: () => Effect.succeed(true),
    claimNext: () =>
      Effect.sync(() => {
        if (!available) return Option.none<ClaimedMemoryProviderWork>();
        available = false;
        return Option.some(claim);
      }),
    complete: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        completed.push(work.outboxId);
        return true;
      }),
    // oxlint-disable-next-line effecttsgo/sync-to-succeed -- The exact undefined return matches the store contract; Effect.void widens it to void.
    enqueueDeletion: () => Effect.sync(() => undefined),
    fail: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        failed.push(work.outboxId);
        return true;
      }),
    failProviderAcceptance: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        failed.push(work.outboxId);
        return true;
      }),
    hasRetryableWork: Effect.succeed(false),
    markProviderAccepted: () => Effect.succeed(options.providerAccepted ?? true),
    markProviderStatus: () => Effect.succeed(true),
    retry: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        retried.push(work.outboxId);
        return true;
      }),
  } satisfies MemoryProviderOutboxStore;
  return { completed, failed, retried, store };
};

const providerStub = (overrides: Partial<MemoryProvider.Interface>): MemoryProvider.Interface => ({
  deleteSessionConversation: () => Effect.die(new Error("Unexpected Session deletion")),
  deleteUserKnowledge: () => Effect.die(new Error("Unexpected User deletion")),
  forgetKnowledge: () => Effect.die(new Error("Unexpected forget")),
  getConversationStatus: () => Effect.die(new Error("Unexpected conversation status read")),
  recall: () => Effect.die(new Error("Unexpected recall")),
  saveConversation: () => Effect.die(new Error("Unexpected conversation save")),
  ...overrides,
});

const unavailableDatabase: Db.Interface = {
  database: Effect.die(new Error("Unexpected PostgreSQL access")),
};
