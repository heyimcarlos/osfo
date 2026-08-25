import { Crypto, DateTime, Effect, Option, Predicate, Result, Schema } from "effect";

import { Db } from "../../db";
import { MemoryProvider } from "../../services/memory-provider";
import type { RecheckResult } from "../../services/authorization";
import type { DeletionAuthorization } from "./deletion-actions";
import type {
  ClaimedMemoryProviderWork,
  MemoryProviderOutboxStore,
} from "./db/memory-provider-outbox";

/* oxlint-disable eslint/no-underscore-dangle -- Effect results and provider payloads use the canonical _tag discriminator. */

const retryDelaySeconds = 30;
const claimLeaseMilliseconds = 60_000;
const maximumClaimsPerRun = 100;

/** Retryable inability to authorize or finish local preparation for provider deletion. */
export class ProviderDeletionDeferred extends Schema.TaggedError<ProviderDeletionDeferred>()(
  "ProviderDeletionDeferred",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Retryable inability to prove that a conversation append is still permitted. */
export class ProviderSaveDeferred extends Schema.TaggedError<ProviderSaveDeferred>()(
  "ProviderSaveDeferred",
  { cause: Schema.Defect(), message: Schema.String },
) {}

export interface ReconciliationOptions {
  readonly authorizeDeletion?: (
    authorization: DeletionAuthorization,
  ) => Effect.Effect<RecheckResult, ProviderDeletionDeferred>;
  readonly prepareDeletion?: (
    claim: ClaimedMemoryProviderWork,
  ) => Effect.Effect<void, ProviderDeletionDeferred>;
  readonly canSaveConversation?: (
    userId: MemoryProvider.SaveConversationInput["userId"],
  ) => Effect.Effect<boolean, ProviderSaveDeferred>;
  readonly conversationStatusRetryMilliseconds?: number;
}

/** Poll accepted conversation ingestion to a terminal provider status before User deletion. */
export const quiesceProcessingConversations = Effect.fn(
  "MemoryProviderOutbox.quiesceProcessingConversations",
)(function* (
  store: MemoryProviderOutboxStore,
  reconcile: () => Effect.Effect<void>,
  pollMilliseconds: number,
) {
  while (yield* store.hasProcessingConversationWork) {
    const now = yield* DateTime.now;
    yield* store.expediteProcessingConversationWork(toDbTimestamp(now));
    yield* reconcile();
    if (yield* store.hasProcessingConversationWork) yield* Effect.sleep(pollMilliseconds);
  }
});

/** Reconcile a bounded batch of ordered provider work outside Agent SQLite transactions. */
export const reconcileMemoryProviderOutbox = Effect.fn("MemoryProviderOutbox.reconcile")(function* (
  store: MemoryProviderOutboxStore,
  options: ReconciliationOptions = {},
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
            yield* processClaim(store, claimed.value, options);
          }),
    { concurrency: 1, discard: true },
  );
});

const processClaim = Effect.fn("MemoryProviderOutbox.processClaim")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  options: ReconciliationOptions,
) {
  if (claim.payload._tag === "SaveConversation") {
    return yield* processConversationClaim(store, claim, options);
  }

  const prepared = yield* prepareDeletionClaim(store, claim, options);
  if (!prepared) return undefined;
  const providerResult = yield* executeDeletionClaim(claim).pipe(Effect.result);
  if (Result.isFailure(providerResult)) {
    return yield* retryClaim(store, claim, providerResult.failure.message, retryDelaySeconds);
  }
  const completedAt = yield* DateTime.now;
  yield* store.complete(claim, toDbTimestamp(completedAt));
  return undefined;
});

const prepareDeletionClaim = Effect.fn("MemoryProviderOutbox.prepareDeletionClaim")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  options: ReconciliationOptions,
) {
  if (claim.payload._tag === "DeleteUserKnowledge") {
    yield* retryClaim(
      store,
      claim,
      "User deletion authority belongs to the PostgreSQL Deletion Case",
      retryDelaySeconds,
    );
    return false;
  }
  const authorization =
    claim.payload._tag === "DeleteSessionConversation" || claim.payload._tag === "ForgetKnowledge"
      ? claim.payload.authorization
      : undefined;
  if (
    authorization === undefined &&
    (claim.payload._tag === "DeleteSessionConversation" || claim.payload._tag === "ForgetKnowledge")
  ) {
    yield* retryClaim(store, claim, "Deletion authorization is unavailable", retryDelaySeconds);
    return false;
  }
  if (authorization === undefined) return true;
  if (options.authorizeDeletion === undefined || options.prepareDeletion === undefined) {
    yield* retryClaim(store, claim, "Deletion authorization is unavailable", retryDelaySeconds);
    return false;
  }
  const firstCheck = yield* options.authorizeDeletion(authorization).pipe(Effect.result);
  if (Result.isFailure(firstCheck) || Predicate.isTagged(firstCheck.success, "Denied")) {
    yield* retryClaim(
      store,
      claim,
      "Deletion authorization is not currently valid",
      retryDelaySeconds,
    );
    return false;
  }
  const preparation = yield* options.prepareDeletion(claim).pipe(Effect.result);
  if (Result.isFailure(preparation)) {
    yield* retryClaim(store, claim, preparation.failure.message, retryDelaySeconds);
    return false;
  }
  const finalCheck = yield* options.authorizeDeletion(authorization).pipe(Effect.result);
  if (Result.isFailure(finalCheck) || Predicate.isTagged(finalCheck.success, "Denied")) {
    yield* retryClaim(
      store,
      claim,
      "Deletion authorization changed before provider use",
      retryDelaySeconds,
    );
    return false;
  }
  return true;
});

const processConversationClaim = Effect.fn("MemoryProviderOutbox.processConversationClaim")(
  function* (
    store: MemoryProviderOutboxStore,
    claim: ClaimedMemoryProviderWork,
    options: ReconciliationOptions,
  ) {
    const provider = yield* MemoryProvider.Service;
    const projection = claim.payload._tag === "SaveConversation" ? claim.payload.projection : null;
    if (projection === null) {
      return yield* Effect.die(new Error("Conversation processing received deletion work"));
    }

    const organizationConfigured = yield* ensureConfiguration(
      store,
      claim,
      "organization",
      MemoryProvider.organizationGuidanceVersion,
      provider.configureOrganizationGuidance,
      claim.providerAcceptance !== null,
    );
    if (!organizationConfigured) return undefined;

    const userConfigured = yield* ensureConfiguration(
      store,
      claim,
      "user",
      MemoryProvider.userGuidanceVersion,
      provider.configureUserGuidance({ userId: projection.userId }),
      claim.providerAcceptance !== null,
    );
    if (!userConfigured) return undefined;

    let acceptance = claim.providerAcceptance;
    let usage = claim.usage;
    if (acceptance === null) {
      const permitted = yield* (
        options.canSaveConversation?.(projection.userId) ?? Effect.succeed(true)
      ).pipe(Effect.result);
      if (Result.isFailure(permitted) || !permitted.success) {
        return yield* retryClaim(
          store,
          claim,
          Result.isFailure(permitted)
            ? permitted.failure.message
            : "Account deletion fences new provider conversation saves",
          retryDelaySeconds,
        );
      }
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
        return yield* awaitProvider(
          store,
          claim,
          acceptance.processingStatus,
          options.conversationStatusRetryMilliseconds,
        );
      }
      const status = yield* provider
        .getConversationStatus({ documentId: acceptance.documentId })
        .pipe(Effect.result);
      if (Result.isFailure(status)) {
        return yield* settleProviderFailure(store, claim, status.failure, true);
      }
      if (status.success.processingStatus !== "done") {
        return yield* awaitProvider(
          store,
          claim,
          status.success.processingStatus,
          options.conversationStatusRetryMilliseconds,
        );
      }
      const updated = yield* store.markProviderStatus(claim, "done");
      if (!updated) return undefined;
    }

    const searchable = yield* provider
      .checkConversationSearchability({
        expectedSource: conversationSearchSource(projection.conversation.messages),
        userId: projection.userId,
      })
      .pipe(Effect.result);
    if (Result.isFailure(searchable)) {
      return yield* settleProviderFailure(store, claim, searchable.failure, true);
    }
    if (!searchable.success) {
      return yield* awaitProvider(store, claim, "done");
    }

    if (usage === null || claim.allowancePeriodId === null) {
      return yield* store.fail(claim, "MemoryProvider cost attribution is invalid");
    }
    const summary = MemoryProvider.summarizeUsageEvidence(usage);
    yield* Effect.logInfo("MemoryProvider conversation work completed").pipe(
      Effect.annotateLogs({
        allowancePeriodId: claim.allowancePeriodId,
        companyCostContinuity: claim.attemptCount > 1,
        outboxId: claim.outboxId,
        providerDocumentId: acceptance.documentId,
        providerStatus: "done",
        ratedCostUsdMicros: String(summary.ratedCostUsdMicros),
        resourcePriceVersions: summary.resourcePriceVersions.join(","),
      }),
    );
    const completedAt = yield* DateTime.now;
    yield* store.complete(claim, toDbTimestamp(completedAt));
    return undefined;
  },
);

const conversationSearchSource = (
  messages: MemoryProvider.ConversationSnapshot["messages"],
): string => {
  const source =
    messages.reduceRight<string | undefined>(
      (query, message) => query ?? (message.role === "user" ? message.content : undefined),
      undefined,
    ) ?? messages[0].content;
  return Array.from(source).slice(0, 256).join("");
};

const ensureConfiguration = Effect.fn("MemoryProviderOutbox.ensureConfiguration")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  scope: "organization" | "user",
  version: MemoryProvider.ConfigurationVersion,
  configure: Effect.Effect<
    void,
    MemoryProvider.MemoryProviderRejected | MemoryProvider.MemoryProviderUnavailable
  >,
  accepted: boolean,
) {
  const requiredAt = yield* DateTime.now;
  const current = yield* store.requireConfiguration(scope, version, toDbTimestamp(requiredAt));
  if (current) return true;
  const configured = yield* configure.pipe(Effect.result);
  if (Result.isFailure(configured)) {
    yield* settleProviderFailure(store, claim, configured.failure, accepted);
    return false;
  }
  const configuredAt = yield* DateTime.now;
  return yield* store.completeConfiguration(scope, version, toDbTimestamp(configuredAt));
});

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
  retryMilliseconds = retryDelaySeconds * 1_000,
) {
  const now = yield* DateTime.now;
  yield* store.awaitProvider(
    claim,
    status,
    toDbTimestamp(DateTime.add(now, { milliseconds: retryMilliseconds })),
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
