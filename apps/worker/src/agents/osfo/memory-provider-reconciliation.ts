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
const rejectedRetryDelaySeconds = 60 * 60;
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
  let usage = claim.usage;
  if (!claim.providerApplied) {
    const providerResult = yield* executeProviderClaim(claim).pipe(Effect.result);
    if (Result.isFailure(providerResult)) {
      const delaySeconds = Predicate.isTagged(providerResult.failure, "MemoryProviderRejected")
        ? rejectedRetryDelaySeconds
        : retryDelaySeconds;
      return yield* retryClaim(store, claim, providerResult.failure.message, delaySeconds);
    }
    usage = providerResult.success;
    if (usage === null) {
      const completedAt = yield* DateTime.now;
      yield* store.complete(claim, toDbTimestamp(completedAt));
      return undefined;
    }
    const appliedAt = yield* DateTime.now;
    const applied = yield* store.markProviderApplied(claim, usage, toDbTimestamp(appliedAt));
    if (!applied) return undefined;
  }

  const allowancePeriodId = claim.allowancePeriodId;
  if (usage === null || allowancePeriodId === null) {
    return yield* retryClaim(
      store,
      claim,
      "MemoryProvider usage attribution is invalid",
      rejectedRetryDelaySeconds,
    );
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
});

const executeProviderClaim = Effect.fn("MemoryProviderOutbox.executeProviderClaim")(function* (
  claim: ClaimedMemoryProviderWork,
) {
  const provider = yield* MemoryProvider.Service;
  const payload = claim.payload;
  switch (payload._tag) {
    case "SaveConversation":
      return yield* provider
        .saveConversation({
          conversation: payload.projection.conversation,
          sessionId: payload.projection.sessionId,
          userId: payload.projection.userId,
        })
        .pipe(Effect.map(({ usage }) => usage));
    case "DeleteSessionConversation":
      return yield* provider.deleteSessionConversation(payload).pipe(Effect.as(null));
    case "DeleteUserKnowledge":
      return yield* provider.deleteUserKnowledge(payload).pipe(Effect.as(null));
    case "ForgetKnowledge":
      return yield* provider.forgetKnowledge(payload).pipe(Effect.as(null));
  }
  return yield* Effect.die(new Error("Unsupported MemoryProvider outbox operation"));
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
