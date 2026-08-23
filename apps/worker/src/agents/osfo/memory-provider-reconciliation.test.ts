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

it.effect("retains a rejected deletion for retry with its exact durable identity", () => {
  const claim = deletionClaim();
  const observed: Array<MemoryProviderOutboxPayload> = [];
  const { completed, retried, store } = testStore(claim);
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
        expect(retried).toEqual([claim.outboxId]);
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

it.effect("retries the exact append identity and payload during a provider outage", () => {
  const claim = appendClaim();
  const observed: Array<MemoryProvider.AppendConversationDeltaInput> = [];
  const { completed, retried, store } = testStore(claim);
  const provider = providerStub({
    appendConversationDelta: (input) => {
      observed.push(input);
      return Effect.fail(
        new MemoryProvider.MemoryProviderUnavailable({
          message: "Provider is unavailable",
          operation: "appendConversationDelta",
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
            messages: [
              { content: "Remember this", role: "user" },
              { content: "I will remember it", role: "assistant" },
            ],
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

it.effect("stops when a stale append claim loses settlement ownership", () => {
  const claim = appendClaim();
  const { completed, retried, store } = testStore(claim, { providerApplied: false });
  const provider = providerStub({
    appendConversationDelta: () =>
      Effect.succeed({
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
  providerApplied: false,
  sequence: 1,
  usage: null,
});

const appendClaim = (): ClaimedMemoryProviderWork => ({
  allowancePeriodId: AllowancePeriodId.make("allowance-1"),
  attemptCount: 1,
  claimToken: "claim-append-1",
  outboxId: MemoryProviderOutboxId.make("conversation:9:session-1:assistant-1"),
  payload: {
    _tag: "AppendConversationDelta",
    projection: {
      allowancePeriodId: AllowancePeriodId.make("allowance-1"),
      firstMessageId: "user-1",
      lastMessageId: AssistantMessageId.make("assistant-1"),
      messages: [
        { content: "Remember this", role: "user" },
        { content: "I will remember it", role: "assistant" },
      ],
      sessionId: SessionId.make("session-1"),
      userId: UserId.make("user-1"),
    },
  },
  providerApplied: false,
  sequence: 1,
  usage: null,
});

const testStore = (
  claim: ClaimedMemoryProviderWork,
  options: { readonly providerApplied?: boolean } = {},
) => {
  const completed: Array<MemoryProviderOutboxId> = [];
  const retried: Array<MemoryProviderOutboxId> = [];
  let available = true;
  const store = {
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
    hasRetryableWork: Effect.succeed(false),
    markProviderApplied: () => Effect.succeed(options.providerApplied ?? true),
    retry: (work: ClaimedMemoryProviderWork) =>
      Effect.sync(() => {
        retried.push(work.outboxId);
        return true;
      }),
  } satisfies MemoryProviderOutboxStore;
  return { completed, retried, store };
};

const providerStub = (overrides: Partial<MemoryProvider.Interface>): MemoryProvider.Interface => ({
  appendConversationDelta: () => Effect.die(new Error("Unexpected append")),
  deleteSessionConversation: () => Effect.die(new Error("Unexpected Session deletion")),
  deleteUserKnowledge: () => Effect.die(new Error("Unexpected User deletion")),
  forgetKnowledge: () => Effect.die(new Error("Unexpected forget")),
  recall: () => Effect.die(new Error("Unexpected recall")),
  ...overrides,
});

const unavailableDatabase: Db.Interface = {
  database: Effect.die(new Error("Unexpected PostgreSQL access")),
};
