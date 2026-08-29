import { Data, Effect, Schema } from "effect";

import type {
  FaultInjection,
  ProductionQualificationManifest,
} from "../../qualification/qualification-manifest";
import type {
  QualificationArrivalAttempt,
  QualificationArrivalAuthorityRecord,
  QualificationCharacterizationArrival,
  QualificationExecutionPlan,
  QualificationExecutionRun,
  QualificationFaultAttempt,
} from "../../qualification/execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import type { FaultControllerReceipt } from "../../qualification/qualification-runs";
import type { OpenWorkloadArrival } from "../../qualification/workload-generation";
import type { QualificationExecutionBucket } from "./qualification-execution-artifacts";

export class QualificationArrivalAuthorityUnavailable extends Data.TaggedError(
  "QualificationArrivalAuthorityUnavailable",
)<{ readonly cause?: unknown; readonly message: string }> {}

export class QualificationFaultAuthorityUnavailable extends Data.TaggedError(
  "QualificationFaultAuthorityUnavailable",
)<{ readonly cause?: unknown; readonly message: string }> {}

export type QualificationArrivalReconciliation =
  | { readonly outcome: "Applied"; readonly record: QualificationArrivalAuthorityRecord }
  | { readonly outcome: "NotApplied" }
  | { readonly outcome: "Unknown" };

/**
 * The product authority must use attemptId as its own idempotency key before provider or store
 * effects. The R2 coordinator deliberately never substitutes for that product-owned guarantee.
 */
export interface IdempotentQualificationArrivalAuthority<E> {
  readonly executeIdempotent: (
    manifest: ProductionQualificationManifest,
    run: QualificationExecutionRun,
    arrival: OpenWorkloadArrival | QualificationCharacterizationArrival,
    attempt: QualificationArrivalAttempt,
  ) => Effect.Effect<QualificationArrivalAuthorityRecord, E>;
  readonly reconcile: (
    attempt: QualificationArrivalAttempt,
  ) => Effect.Effect<QualificationArrivalReconciliation, E>;
}

export type QualificationFaultReconciliation =
  | { readonly outcome: "Applied"; readonly receipt: FaultControllerReceipt }
  | { readonly outcome: "NotApplied" }
  | { readonly outcome: "Unknown" };

/** The controller waits for the frozen clock/state trigger and deduplicates attemptId itself. */
export interface IdempotentQualificationFaultController<E> {
  readonly applyIdempotent: (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
    run: QualificationExecutionRun,
    fault: FaultInjection,
    attempt: QualificationFaultAttempt,
  ) => Effect.Effect<FaultControllerReceipt, E>;
  readonly reconcile: (
    attempt: QualificationFaultAttempt,
  ) => Effect.Effect<QualificationFaultReconciliation, E>;
}

const AttemptIntent = Schema.Struct({
  attemptId: Schema.String,
  executionId: Schema.String,
  planChecksum: Schema.String,
  rootId: Schema.String,
  runId: Schema.String,
});
const ArrivalRecord = Schema.Struct({
  attemptId: Schema.String,
  authorityFactId: Schema.String,
  executedAtUtc: Schema.String,
  executionId: Schema.String,
  rootId: Schema.String,
  submittedAtUtc: Schema.String,
});
const FaultReceipt = Schema.Struct({
  applicationStatus: Schema.Literals(["applied", "notApplied"]),
  artifactChecksum: Schema.String,
  artifactId: Schema.String,
  controllerOperationId: Schema.String,
  controllerSource: Schema.String,
  durationSeconds: Schema.Int,
  endedAtUtc: Schema.String,
  executionId: Schema.String,
  injectedAtUtc: Schema.String,
  kind: Schema.Literals([
    "allowanceRace",
    "ambiguousSend",
    "coldActivation",
    "conflictingStatus",
    "costExhaustion",
    "dependencyOutage",
    "deploymentReplacement",
    "duplicateWebhook",
    "hotAgentFairness",
    "maximumFile",
    "maximumHistory",
    "regionalLatency",
    "synchronizedWake",
    "workflowRetryAfterEffect",
  ]),
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  runId: Schema.String,
  scheduledTriggerAtUtc: Schema.String,
  target: Schema.String,
  trigger: Schema.String,
  triggerAuthorityFactId: Schema.NullOr(Schema.String),
  triggerObservedAtUtc: Schema.String,
});
const EncodedAttemptIntent = Schema.fromJsonString(AttemptIntent);
const EncodedArrivalRecord = Schema.fromJsonString(ArrivalRecord);
const EncodedFaultReceipt = Schema.fromJsonString(FaultReceipt);

const unavailable = (message: string, cause?: unknown) =>
  new QualificationArrivalAuthorityUnavailable({ cause, message });
const request = <A>(operation: string, attempt: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => unavailable(`R2 qualification arrival ${operation} failed`, cause),
    try: attempt,
  });
const intentKey = (attemptId: string) =>
  `qualification/arrival-attempts/${encodeURIComponent(attemptId)}/intent.json`;
const completionKey = (attemptId: string) =>
  `qualification/arrival-attempts/${encodeURIComponent(attemptId)}/completion.json`;
const faultIntentKey = (attemptId: string) =>
  `qualification/fault-attempts/${encodeURIComponent(attemptId)}/intent.json`;
const faultCompletionKey = (attemptId: string) =>
  `qualification/fault-attempts/${encodeURIComponent(attemptId)}/completion.json`;
const encode = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      unavailable("Qualification arrival authority cannot be encoded", cause),
    ),
  );
const decode = <A, I>(schema: Schema.Codec<A, I>, value: I) =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      unavailable("Qualification arrival authority cannot be decoded", cause),
    ),
  );

const readText = (bucket: QualificationExecutionBucket, key: string) =>
  request("read", () => bucket.get(key)).pipe(
    Effect.flatMap((object) =>
      object === null ? Effect.succeed(null) : request("read body", () => object.text()),
    ),
  );

const writeOnce = (bucket: QualificationExecutionBucket, key: string, encoded: string) =>
  request("write", () =>
    bucket.put(key, encoded, {
      customMetadata: { "osfo-kind": "qualification-arrival-authority-v1" },
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    }),
  ).pipe(Effect.map((result) => result !== null));

const validRecord = (
  attempt: QualificationArrivalAttempt,
  rootId: string,
  record: QualificationArrivalAuthorityRecord,
) =>
  record.attemptId === attempt.attemptId &&
  record.executionId === attempt.executionId &&
  record.rootId === rootId &&
  record.authorityFactId.length > 0 &&
  Number.isFinite(Date.parse(record.submittedAtUtc)) &&
  Number.isFinite(Date.parse(record.executedAtUtc)) &&
  Date.parse(record.executedAtUtc) >= Date.parse(record.submittedAtUtc);

const retainCompletion = (
  bucket: QualificationExecutionBucket,
  attempt: QualificationArrivalAttempt,
  rootId: string,
  record: QualificationArrivalAuthorityRecord,
) =>
  Effect.gen(function* () {
    if (!validRecord(attempt, rootId, record)) {
      return yield* unavailable("Product authority returned a conflicting arrival record");
    }
    const encoded = yield* encode(EncodedArrivalRecord, record);
    const created = yield* writeOnce(bucket, completionKey(attempt.attemptId), encoded);
    if (created) return record;
    const retained = yield* readText(bucket, completionKey(attempt.attemptId));
    if (retained === null || retained !== encoded) {
      return yield* unavailable("Qualification arrival completion conflicts during reconciliation");
    }
    return yield* decode(EncodedArrivalRecord, retained);
  });

/**
 * Cloudflare-owned retry coordinator. It claims the stable attempt before effects, requires the
 * product adapter to execute with that same key, and reconciles every retry before any re-entry.
 */
export const makeQualificationArrivalExecutor =
  <E>(
    bucket: QualificationExecutionBucket,
    authority: IdempotentQualificationArrivalAuthority<E>,
  ) =>
  (
    manifest: ProductionQualificationManifest,
    run: QualificationExecutionRun,
    arrival: OpenWorkloadArrival | QualificationCharacterizationArrival,
    attempt: QualificationArrivalAttempt,
  ): Effect.Effect<
    QualificationArrivalAuthorityRecord,
    E | QualificationArrivalAuthorityUnavailable
  > =>
    Effect.gen(function* () {
      const existingCompletion = yield* readText(bucket, completionKey(attempt.attemptId));
      if (existingCompletion !== null) {
        const record = yield* decode(EncodedArrivalRecord, existingCompletion);
        if (!validRecord(attempt, arrival.rootId, record)) {
          return yield* unavailable("Retained qualification arrival completion conflicts");
        }
        return record;
      }

      const intent = {
        attemptId: attempt.attemptId,
        executionId: attempt.executionId,
        planChecksum: attempt.planChecksum,
        rootId: arrival.rootId,
        runId: attempt.runId,
      };
      const encodedIntent = yield* encode(EncodedAttemptIntent, intent);
      const claimed = yield* writeOnce(bucket, intentKey(attempt.attemptId), encodedIntent);
      if (!claimed) {
        const retainedIntent = yield* readText(bucket, intentKey(attempt.attemptId));
        if (retainedIntent === null || retainedIntent !== encodedIntent) {
          return yield* unavailable("Qualification arrival attempt identity conflicts");
        }
        const completionAfterClaim = yield* readText(bucket, completionKey(attempt.attemptId));
        if (completionAfterClaim !== null) {
          const record = yield* decode(EncodedArrivalRecord, completionAfterClaim);
          if (!validRecord(attempt, arrival.rootId, record)) {
            return yield* unavailable("Retained qualification arrival completion conflicts");
          }
          return record;
        }
        const reconciled = yield* authority.reconcile(attempt);
        if (reconciled.outcome === "Applied") {
          return yield* retainCompletion(bucket, attempt, arrival.rootId, reconciled.record);
        }
        if (reconciled.outcome === "Unknown") {
          return yield* unavailable(
            "Qualification arrival attempt is ambiguous; blind retry is forbidden",
          );
        }
      }

      const record = yield* authority.executeIdempotent(manifest, run, arrival, attempt);
      return yield* retainCompletion(bucket, attempt, arrival.rootId, record);
    });

const validFaultReceipt = (attempt: QualificationFaultAttempt, receipt: FaultControllerReceipt) =>
  receipt.executionId === attempt.executionId &&
  receipt.planChecksum === attempt.planChecksum &&
  receipt.runId === attempt.runId &&
  receipt.scheduledTriggerAtUtc === attempt.scheduledTriggerAtUtc &&
  receipt.applicationStatus === "applied" &&
  (attempt.requiresAuthorityFact
    ? receipt.triggerAuthorityFactId !== null
    : receipt.triggerAuthorityFactId === null);

const retainFaultCompletion = (
  bucket: QualificationExecutionBucket,
  attempt: QualificationFaultAttempt,
  receipt: FaultControllerReceipt,
) =>
  Effect.gen(function* () {
    if (!validFaultReceipt(attempt, receipt)) {
      return yield* new QualificationFaultAuthorityUnavailable({
        message: "Fault controller returned a receipt that conflicts with the frozen trigger",
      });
    }
    const encoded = yield* encode(EncodedFaultReceipt, receipt);
    const created = yield* writeOnce(bucket, faultCompletionKey(attempt.attemptId), encoded);
    if (created) return receipt;
    const retained = yield* readText(bucket, faultCompletionKey(attempt.attemptId));
    if (retained === null || retained !== encoded) {
      return yield* new QualificationFaultAuthorityUnavailable({
        message: "Qualification fault completion conflicts during reconciliation",
      });
    }
    return yield* decode(EncodedFaultReceipt, retained);
  });

/** Durable, reconcile-before-retry coordinator for the owning fault controller. */
export const makeQualificationFaultExecutor =
  <E>(
    bucket: QualificationExecutionBucket,
    controller: IdempotentQualificationFaultController<E>,
  ) =>
  (
    manifest: ProductionQualificationManifest,
    plan: QualificationExecutionPlan,
    run: QualificationExecutionRun,
    fault: FaultInjection,
    attempt: QualificationFaultAttempt,
  ): Effect.Effect<
    FaultControllerReceipt,
    E | QualificationArrivalAuthorityUnavailable | QualificationFaultAuthorityUnavailable
  > =>
    Effect.gen(function* () {
      const existing = yield* readText(bucket, faultCompletionKey(attempt.attemptId));
      if (existing !== null) {
        const receipt = yield* decode(EncodedFaultReceipt, existing);
        if (!validFaultReceipt(attempt, receipt)) {
          return yield* new QualificationFaultAuthorityUnavailable({
            message: "Retained qualification fault completion conflicts",
          });
        }
        return receipt;
      }
      const encodedIntent = canonicalQualificationJson({
        attempt,
        fault,
        manifestChecksum: manifest.manifestChecksum,
        runDescriptorChecksum: qualificationChecksum(run),
      });
      const claimed = yield* writeOnce(bucket, faultIntentKey(attempt.attemptId), encodedIntent);
      if (!claimed) {
        const retainedIntent = yield* readText(bucket, faultIntentKey(attempt.attemptId));
        if (retainedIntent === null || retainedIntent !== encodedIntent) {
          return yield* new QualificationFaultAuthorityUnavailable({
            message: "Qualification fault attempt identity conflicts",
          });
        }
        const reconciled = yield* controller.reconcile(attempt);
        if (reconciled.outcome === "Applied") {
          return yield* retainFaultCompletion(bucket, attempt, reconciled.receipt);
        }
        if (reconciled.outcome === "Unknown") {
          return yield* new QualificationFaultAuthorityUnavailable({
            message: "Qualification fault attempt is ambiguous; blind retry is forbidden",
          });
        }
      }
      const receipt = yield* controller.applyIdempotent(manifest, plan, run, fault, attempt);
      return yield* retainFaultCompletion(bucket, attempt, receipt);
    });

/** Stable diagnostic identity for an authority adapter configuration. */
export const qualificationArrivalAuthorityIdentity = (executionId: string, sourceVersion: string) =>
  qualificationChecksum({ executionId, sourceVersion, type: "qualification-arrival-v1" });
