import { Crypto, DateTime, Effect, Option, Predicate, Result, Schedule, Schema } from "effect";

import { Db } from "../../db";
import { MemoryProvider } from "../../services/memory-provider";
import type { RecheckResult } from "../../services/authorization";
import type { DeletionAuthorization } from "./deletion-actions";
import type {
  ClaimedMemoryProviderWork,
  MemoryProviderDeletionProgress,
  MemoryProviderOutboxStore,
} from "./db/memory-provider-outbox";

/* oxlint-disable eslint/no-underscore-dangle -- Effect results and provider payloads use the canonical _tag discriminator. */

const retryDelaySeconds = 30;
export const memoryProviderClaimLeaseMilliseconds = 60_000;
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
  readonly authorizeDeletion: (
    authorization: DeletionAuthorization,
  ) => Effect.Effect<RecheckResult, ProviderDeletionDeferred>;
  readonly prepareDeletion: (
    claim: ClaimedMemoryProviderWork,
  ) => Effect.Effect<void, ProviderDeletionDeferred>;
  readonly canSaveConversation?: (
    userId: MemoryProvider.SaveConversationInput["userId"],
  ) => Effect.Effect<boolean, ProviderSaveDeferred>;
  readonly conversationStatusRetryMilliseconds?: number;
  readonly runSaveConversation?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/** Poll accepted conversation ingestion to a terminal provider status before User deletion. */
export const quiesceProcessingConversations = Effect.fn(
  "MemoryProviderOutbox.quiesceProcessingConversations",
)(function* (
  store: MemoryProviderOutboxStore,
  reconcile: () => Effect.Effect<void>,
  pollMilliseconds: number,
) {
  const poll = Effect.gen(function* () {
    if (!(yield* store.hasUnsettledProviderConversationWork)) return false;
    const now = yield* DateTime.now;
    yield* store.expediteProcessingConversationWork(toDbTimestamp(now));
    yield* reconcile();
    return yield* store.hasUnsettledProviderConversationWork;
  });
  yield* Effect.repeat(poll, {
    schedule: Schedule.spaced(pollMilliseconds),
    while: (processing) => processing,
  });
});

/** Reconcile a bounded batch of ordered provider work outside Agent SQLite transactions. */
export const reconcileMemoryProviderOutbox = Effect.fn("MemoryProviderOutbox.reconcile")(function* (
  store: MemoryProviderOutboxStore,
  options: ReconciliationOptions,
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
              toDbTimestamp(
                DateTime.add(claimedAt, { milliseconds: memoryProviderClaimLeaseMilliseconds }),
              ),
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
  const deleted = yield* processDeletionClaim(store, claim, options);
  if (!deleted) return undefined;
  const completedAt = yield* DateTime.now;
  yield* store.complete(claim, toDbTimestamp(completedAt));
  return undefined;
});

const processDeletionClaim = Effect.fn("MemoryProviderOutbox.processDeletionClaim")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  options: ReconciliationOptions,
) {
  const provider = yield* MemoryProvider.Service;
  const payload = claim.payload;
  if (payload._tag === "ForgetKnowledge") {
    const completed = new Set(
      claim.deletionProgress?._tag === "ForgetKnowledge"
        ? claim.deletionProgress.completedMemoryIds
        : [],
    );
    for (const memoryId of payload.memoryIds) {
      if (completed.has(memoryId)) continue;
      const permitted = yield* authorizeProviderRequest(
        store,
        claim,
        options,
        payload.authorization,
        "Knowledge deletion authority changed before the next provider memory",
      );
      if (!permitted) return false;
      const result = yield* provider
        .forgetKnowledge({ memoryId, userId: payload.userId })
        .pipe(Effect.result);
      if (Result.isFailure(result)) {
        yield* retryClaim(store, claim, result.failure.message, retryDelaySeconds);
        return false;
      }
      completed.add(memoryId);
      const retained = yield* store.recordDeletionProgress(claim, {
        _tag: "ForgetKnowledge",
        completedMemoryIds: [...completed],
      });
      if (!retained) return false;
    }
    return true;
  }
  if (payload._tag === "DeleteSessionConversation") {
    return yield* processSessionDeletion(store, claim, options, provider);
  }
  return yield* Effect.die(new Error("Unsupported MemoryProvider deletion operation"));
});

type SessionDeletionProgress = Extract<
  MemoryProviderDeletionProgress,
  { readonly _tag: "DeleteSessionConversation" }
>;

const processSessionDeletion = Effect.fn("MemoryProviderOutbox.processSessionDeletion")(function* (
  store: MemoryProviderOutboxStore,
  claim: ClaimedMemoryProviderWork,
  options: ReconciliationOptions,
  provider: MemoryProvider.Interface,
) {
  const payload = claim.payload;
  if (payload._tag !== "DeleteSessionConversation") {
    return yield* Effect.die(new Error("Session deletion received invalid provider work"));
  }
  const retainedProgress =
    claim.deletionProgress?._tag === "DeleteSessionConversation"
      ? claim.deletionProgress
      : undefined;
  let progress: SessionDeletionProgress;
  if (retainedProgress === undefined) {
    const discovered = yield* discoverSessionConversation(store, claim, options, provider);
    if (discovered === undefined) return false;
    if (discovered._tag === "AlreadyAbsent") return true;
    progress = {
      _tag: "DeleteSessionConversation",
      awaitingDiscovery: false,
      targets: discovered.documentIds.map((documentId) => ({ documentId, status: "observed" })),
    };
    if (!(yield* store.recordDeletionProgress(claim, progress))) return false;
  } else {
    progress = retainedProgress;
  }

  for (const target of progress.targets) {
    if (target.status === "deleted") continue;
    const advanced: SessionDeletionProgress | undefined = yield* processSessionDeletionTarget(
      store,
      claim,
      options,
      provider,
      progress,
      target,
    );
    if (advanced === undefined) return false;
    progress = advanced;
  }
  if (!progress.awaitingDiscovery) return true;

  const discovered = yield* discoverSessionConversation(store, claim, options, provider);
  if (discovered === undefined) return false;
  if (discovered._tag === "AlreadyAbsent") {
    yield* retryClaim(
      store,
      claim,
      "A possibly accepted Session conversation is not yet discoverable",
      retryDelaySeconds,
    );
    return false;
  }
  const retainedDocumentIds = new Set(progress.targets.map(({ documentId }) => documentId));
  const newDocumentIds = discovered.documentIds.filter(
    (documentId) => !retainedDocumentIds.has(documentId),
  );
  const discoveredDocumentIds = new Set(discovered.documentIds);
  progress = {
    _tag: "DeleteSessionConversation",
    awaitingDiscovery: newDocumentIds.length === 0,
    targets: [
      ...progress.targets.map((target) =>
        discoveredDocumentIds.has(target.documentId) && target.status !== "deleted"
          ? { ...target, status: "observed" as const }
          : target,
      ),
      ...newDocumentIds.map((documentId) => ({ documentId, status: "observed" as const })),
    ],
  };
  if (!(yield* store.recordDeletionProgress(claim, progress))) return false;
  for (const documentId of discovered.documentIds) {
    const discoveredTarget = progress.targets.find((target) => target.documentId === documentId);
    if (discoveredTarget === undefined) {
      return yield* Effect.die(new Error("Session discovery target was not retained"));
    }
    if (discoveredTarget.status === "deleted") continue;
    const advanced: SessionDeletionProgress | undefined = yield* processSessionDeletionTarget(
      store,
      claim,
      options,
      provider,
      progress,
      discoveredTarget,
    );
    if (advanced === undefined) return false;
    progress = advanced;
  }
  return !progress.awaitingDiscovery;
});

const discoverSessionConversation = Effect.fn("MemoryProviderOutbox.discoverSessionConversation")(
  function* (
    store: MemoryProviderOutboxStore,
    claim: ClaimedMemoryProviderWork,
    options: ReconciliationOptions,
    provider: MemoryProvider.Interface,
  ) {
    const payload = claim.payload;
    if (payload._tag !== "DeleteSessionConversation") {
      return yield* Effect.die(new Error("Session discovery received invalid provider work"));
    }
    const permitted = yield* authorizeProviderRequest(
      store,
      claim,
      options,
      payload.authorization,
      "Session deletion authority changed before provider discovery",
    );
    if (!permitted) return undefined;
    const discovered = yield* provider.findSessionConversation(payload).pipe(Effect.result);
    if (Result.isFailure(discovered)) {
      yield* retryClaim(store, claim, discovered.failure.message, retryDelaySeconds);
      return undefined;
    }
    return discovered.success;
  },
);

const processSessionDeletionTarget = Effect.fn("MemoryProviderOutbox.processSessionDeletionTarget")(
  function* (
    store: MemoryProviderOutboxStore,
    claim: ClaimedMemoryProviderWork,
    options: ReconciliationOptions,
    provider: MemoryProvider.Interface,
    progress: SessionDeletionProgress,
    retainedTarget: SessionDeletionProgress["targets"][number],
  ) {
    const payload = claim.payload;
    if (payload._tag !== "DeleteSessionConversation") {
      return yield* Effect.die(new Error("Session target deletion received invalid provider work"));
    }
    const target = {
      documentId: retainedTarget.documentId,
      sessionId: payload.sessionId,
      userId: payload.userId,
    };
    const canVerify = yield* authorizeProviderRequest(
      store,
      claim,
      options,
      payload.authorization,
      "Session deletion authority changed before provider ownership verification",
    );
    if (!canVerify) return undefined;
    const verified = yield* provider.verifySessionConversation(target).pipe(Effect.result);
    if (Result.isFailure(verified)) {
      yield* retryClaim(store, claim, verified.failure.message, retryDelaySeconds);
      return undefined;
    }
    if (verified.success._tag === "AlreadyAbsent") {
      if (retainedTarget.status === "accepted") {
        yield* retryClaim(
          store,
          claim,
          "An accepted Session conversation is not yet available for deletion",
          retryDelaySeconds,
        );
        return undefined;
      }
      return yield* recordSessionTargetStatus(store, claim, progress, retainedTarget, "deleted");
    }
    const observed =
      retainedTarget.status === "observed"
        ? progress
        : yield* recordSessionTargetStatus(store, claim, progress, retainedTarget, "observed");
    if (observed === undefined) return undefined;
    const canDelete = yield* authorizeProviderRequest(
      store,
      claim,
      options,
      payload.authorization,
      "Session deletion authority changed before provider deletion",
    );
    if (!canDelete) return undefined;
    const deleted = yield* provider.deleteSessionConversation(target).pipe(Effect.result);
    if (Result.isFailure(deleted)) {
      yield* retryClaim(store, claim, deleted.failure.message, retryDelaySeconds);
      return undefined;
    }
    return yield* recordSessionTargetStatus(store, claim, observed, retainedTarget, "deleted");
  },
);

const recordSessionTargetStatus = Effect.fn("MemoryProviderOutbox.recordSessionTargetStatus")(
  function* (
    store: MemoryProviderOutboxStore,
    claim: ClaimedMemoryProviderWork,
    progress: SessionDeletionProgress,
    retainedTarget: SessionDeletionProgress["targets"][number],
    status: "deleted" | "observed",
  ) {
    const updated: SessionDeletionProgress = {
      ...progress,
      targets: progress.targets.map((target) =>
        target.documentId === retainedTarget.documentId ? { ...target, status } : target,
      ),
    };
    return (yield* store.recordDeletionProgress(claim, updated)) ? updated : undefined;
  },
);

const authorizeProviderRequest = Effect.fn("MemoryProviderOutbox.authorizeProviderRequest")(
  function* (
    store: MemoryProviderOutboxStore,
    claim: ClaimedMemoryProviderWork,
    options: ReconciliationOptions,
    authorization: DeletionAuthorization,
    message: string,
  ) {
    const result = yield* options.authorizeDeletion(authorization).pipe(Effect.result);
    if (Result.isSuccess(result) && !Predicate.isTagged(result.success, "Denied")) {
      return true;
    }
    yield* retryClaim(store, claim, message, retryDelaySeconds);
    return false;
  },
);

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
  if (
    claim.payload._tag !== "DeleteSessionConversation" &&
    claim.payload._tag !== "ForgetKnowledge"
  ) {
    return yield* Effect.die(new Error("Unsupported MemoryProvider deletion preparation"));
  }
  const authorization = claim.payload.authorization;
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
  const correctionAlreadyCommitted =
    claim.payload._tag === "ForgetKnowledge" && claim.deletionProgress?._tag === "ForgetKnowledge";
  if (!correctionAlreadyCommitted) {
    const preparation = yield* options.prepareDeletion(claim).pipe(Effect.result);
    if (Result.isFailure(preparation)) {
      yield* retryClaim(store, claim, preparation.failure.message, retryDelaySeconds);
      return false;
    }
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
      const saveAndSettle = Effect.gen(function* () {
        const permitted = yield* (
          options.canSaveConversation?.(projection.userId) ?? Effect.succeed(true)
        ).pipe(Effect.result);
        if (Result.isFailure(permitted) || !permitted.success) {
          yield* retryClaim(
            store,
            claim,
            Result.isFailure(permitted)
              ? permitted.failure.message
              : "Account deletion fences new provider conversation saves",
            retryDelaySeconds,
          );
          return undefined;
        }
        const claimIsCurrent = yield* store.isClaimCurrent(claim);
        if (!claimIsCurrent) return undefined;
        const submissionStarted = yield* store.beginProviderSubmission(claim);
        if (!submissionStarted) return undefined;
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
          if (Predicate.isTagged(saved.failure, "MemoryProviderUnavailable")) {
            yield* store.retainAmbiguousProviderSubmission(claim, saved.failure.message);
            return undefined;
          }
          yield* store.fail(claim, saved.failure.message);
          return undefined;
        }
        const acceptedAt = yield* DateTime.now;
        const accepted = yield* store.markProviderAccepted(
          claim,
          saved.success,
          toDbTimestamp(acceptedAt),
        );
        if (!accepted) return undefined;
        return {
          acceptance: {
            documentId: saved.success.documentId,
            processingStatus: saved.success.processingStatus,
          },
          usage: saved.success.usage,
        };
      });
      const saved = yield* options.runSaveConversation?.(saveAndSettle) ?? saveAndSettle;
      if (saved === undefined) return undefined;
      acceptance = saved.acceptance;
      usage = saved.usage;
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
