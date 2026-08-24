import { Crypto, DateTime, Effect, Option, Predicate, Result } from "effect";

import { BillingDb } from "../../db/billing";
import { Db } from "../../db";
import { retainedCatalog } from "../../domain/plan-policy";
import { Allowances } from "../../services/allowances";
import { MemoryProvider } from "../../services/memory-provider";
import type {
  ClaimedMemoryProviderWork,
  MemoryProviderOutboxStore,
} from "./db/memory-provider-outbox";

/* oxlint-disable eslint/no-underscore-dangle -- Effect results and provider payloads use the canonical _tag discriminator. */

const retryDelaySeconds = 30;
const claimLeaseMilliseconds = 60_000;
const maximumClaimsPerRun = 100;

/** Reconcile a bounded batch of ordered provider work outside Agent SQLite transactions. */
export const reconcileMemoryProviderOutbox = Effect.fn("MemoryProviderOutbox.reconcile")(function* (
  store: MemoryProviderOutboxStore,
) {
  const crypto = yield* Crypto.Crypto;
  let drained = false;
  yield* Effect.forEach(
    Array.from({ length: maximumClaimsPerRun }),
    () =>
      drained
        ? Effect.void
        : Effect.gen(function* () {
            const claimedAt = yield* DateTime.now;
            const claimToken = yield* crypto.randomUUIDv4;
            const claimed = yield* store.claimNext(
              toDbTimestamp(claimedAt),
              toDbTimestamp(DateTime.add(claimedAt, { milliseconds: claimLeaseMilliseconds })),
              claimToken,
            );
            if (Option.isNone(claimed)) {
              drained = true;
              return;
            }
            yield* processClaim(store, claimed.value);
          }),
    { concurrency: 1, discard: true },
  );
});

const processClaim = Effect.fn("MemoryProviderOutbox.processClaim")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
) {
  if (claim.payload._tag === "SaveConversation") {
    return yield* processConversationClaim(store, claim);
  }

  const providerResult = yield* executeDeletionClaim(claim).pipe(Effect.result);
  if (Result.isFailure(providerResult)) {
    return yield* settleProviderFailure(store, claim, providerResult.failure, false);
  }
  const completedAt = yield* DateTime.now;
  yield* store.complete(claim, toDbTimestamp(completedAt));
  return undefined;
});

const processConversationClaim = Effect.fn("MemoryProviderOutbox.processConversationClaim")(
  function* (store: MemoryProviderOutboxStore, claim: ClaimedMemoryProviderWork) {
    const provider = yield* MemoryProvider.Service;
    const projection = claim.payload._tag === "SaveConversation" ? claim.payload.projection : null;
    if (projection === null) {
      return yield* Effect.die(new Error("Conversation processing received deletion work"));
    }

    let acceptance = claim.providerAcceptance;
    let usage = claim.usage;
    if (acceptance === null) {
      const saved = yield* provider
        .saveConversation({
          conversation: projection.conversation,
          sessionId: projection.sessionId,
          userId: projection.userId,
        })
        .pipe(Effect.result);
      if (Result.isFailure(saved)) {
        if (Predicate.isTagged(saved.failure, "MemoryProviderAcceptanceStatusInvalid")) {
          const acceptedAt = yield* DateTime.now;
          yield* store.failProviderAcceptance(claim, saved.failure, toDbTimestamp(acceptedAt));
          return undefined;
        }
        return yield* settleProviderFailure(store, claim, saved.failure, false);
      }
      const acceptedAt = yield* DateTime.now;
      const accepted = yield* store.markProviderAccepted(
        claim,
        saved.success,
        toDbTimestamp(acceptedAt),
      );
      if (!accepted) return undefined;
      acceptance = {
        documentId: saved.success.documentId,
        processingStatus: saved.success.processingStatus,
      };
      usage = saved.success.usage;
    }

    if (acceptance.processingStatus !== "done") {
      if (claim.providerAcceptance === null) {
        return yield* awaitProvider(store, claim, acceptance.processingStatus);
      }
      const status = yield* provider
        .getConversationStatus({ documentId: acceptance.documentId })
        .pipe(Effect.result);
      if (Result.isFailure(status)) {
        return yield* settleProviderFailure(store, claim, status.failure, true);
      }
      if (status.success.processingStatus !== "done") {
        return yield* awaitProvider(store, claim, status.success.processingStatus);
      }
      const updated = yield* store.markProviderStatus(claim, "done");
      if (!updated) return undefined;
    }

    const allowancePeriodId = claim.allowancePeriodId;
    if (usage === null || allowancePeriodId === null) {
      return yield* store.fail(claim, "MemoryProvider usage attribution is invalid");
    }

    const recorded = yield* Effect.scoped(
      Db.database.pipe(
        Effect.flatMap((database) => {
          const allowances = Allowances.make({
            billing: BillingDb.make(database),
            catalog: retainedCatalog,
            now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
          });
          return allowances.record(
            allowancePeriodId,
            { sourceId: claim.outboxId, sourceType: "MemoryProviderOutbox" },
            usage.items,
          );
        }),
      ),
    ).pipe(Effect.result);
    if (Result.isFailure(recorded)) {
      return yield* retryClaim(
        store,
        claim,
        "MemoryProvider usage recording is unavailable",
        retryDelaySeconds,
      );
    }
    const completedAt = yield* DateTime.now;
    yield* store.complete(claim, toDbTimestamp(completedAt));
    return undefined;
  },
);

const executeDeletionClaim = Effect.fn("MemoryProviderOutbox.executeDeletionClaim")(function* (
  claim: ClaimedMemoryProviderWork,
) {
  const provider = yield* MemoryProvider.Service;
  const payload = claim.payload;
  switch (payload._tag) {
    case "SaveConversation":
      return yield* Effect.die(new Error("Deletion processing received conversation work"));
    case "DeleteSessionConversation":
      return yield* provider.deleteSessionConversation(payload);
    case "DeleteUserKnowledge":
      return yield* provider.deleteUserKnowledge(payload);
    case "ForgetKnowledge":
      return yield* provider.forgetKnowledge(payload);
  }
  return yield* Effect.die(new Error("Unsupported MemoryProvider outbox operation"));
});

const settleProviderFailure = Effect.fn("MemoryProviderOutbox.settleProviderFailure")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  failure: MemoryProvider.MemoryProviderRejected | MemoryProvider.MemoryProviderUnavailable,
  accepted: boolean,
) {
  if (Predicate.isTagged(failure, "MemoryProviderRejected")) {
    return yield* store.fail(claim, failure.message, accepted ? "failed" : undefined);
  }
  return yield* retryClaim(store, claim, failure.message, retryDelaySeconds);
});

const awaitProvider = Effect.fn("MemoryProviderOutbox.awaitProvider")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  status: MemoryProvider.ConversationProcessingStatus,
) {
  const now = yield* DateTime.now;
  yield* store.awaitProvider(
    claim,
    status,
    toDbTimestamp(DateTime.add(now, { seconds: retryDelaySeconds })),
  );
});

const retryClaim = Effect.fn("MemoryProviderOutbox.retryClaim")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  message: string,
  delaySeconds: number,
) {
  const now = yield* DateTime.now;
  yield* store.retry(claim, toDbTimestamp(DateTime.add(now, { seconds: delaySeconds })), message);
});

const toDbTimestamp = (time: DateTime.Utc): Db.DbTimestamp =>
  Db.DbTimestamp.make(DateTime.toDateUtc(time).toISOString());
