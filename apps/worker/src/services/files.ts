import { DateTime, Effect, Predicate, Schema } from "effect";

import type { AllowancePeriodId, UserId } from "../domain";
import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import { FileDigest, FileMediaType, inspectFileContent } from "../domain/file-content";
import { FilePagesEvidence } from "../domain/file-evidence";
import type {
  FileAnalysisId,
  FileAnalysisRecord,
  FileDeletionRecord,
  FileId,
  FileName,
  FileRecord,
  FileUploadId,
} from "../domain/file";
import type { PlanPolicyCatalog } from "../domain/plan-policy";
import { isLaunchPolicy, policyFor } from "../domain/plan-policy";
import type { DbTimestamp } from "../db";
import type { AuthorizationContext, Interface as Authorization } from "./authorization";

/** Fixed parser bounds supplied to disposable file compute. */
export const launchFileComputeLimits = {
  maximumCsvRows: 100_000,
  maximumImagePixels: 40_000_000,
  maximumNormalizedTextBytes: 2_000_000,
  maximumOfficeEntries: 10_000,
  maximumOcrPages: 10,
  maximumOcrImagePixels: 8_000_000,
  maximumPdfPages: 500,
} as const;

/** Trusted normalized provider-cost evidence. */
export interface FileVendorCost {
  readonly basis: "conservative" | "observed";
  readonly quantity: bigint;
}

/** Provenance retained with normalized file content. */
export const FileNormalizationProvenance = Schema.Struct({
  mediaType: FileMediaType,
  pages: Schema.optional(FilePagesEvidence),
  parser: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  sourceSha256: FileDigest,
});

/** Provenance retained with normalized file content. */
export type FileNormalizationProvenance = typeof FileNormalizationProvenance.Type;

/** Successful bounded normalization result. */
export interface FileNormalizationResult {
  readonly normalizedText: string;
  readonly provenance: FileNormalizationProvenance;
  readonly vendorCost: FileVendorCost | null;
}

/** Successful bounded analysis result. */
export interface FileAnalysisCompleted {
  readonly _tag: "AnalysisCompleted";
  readonly resultText: string;
  readonly vendorCost: FileVendorCost | null;
}

/** Ambiguous analysis result that must reconcile before retry. */
export interface FileAnalysisAmbiguous {
  readonly _tag: "AnalysisAmbiguous";
  readonly evidence: string;
  readonly vendorCost: FileVendorCost | null;
}

/** Analysis outcome returned by disposable compute. */
export type FileAnalysisComputeResult = FileAnalysisCompleted | FileAnalysisAmbiguous;

/** Disposable, bounded file compute required by the application service. */
/** Expected bounded-compute rejection with trusted incurred-cost evidence. */
export class FileComputeFailed extends Schema.TaggedError<FileComputeFailed>()(
  "FileComputeFailed",
  {
    basis: Schema.NullOr(Schema.Literals(["conservative", "observed"])),
    kind: Schema.Literals(["dependency_unavailable", "task_rejected"]),
    message: Schema.String,
    reason: Schema.Literals(["content_limit", "malicious", "parser_failure"]),
    vendorUsdMicros: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  },
) {}

/** Expected rejection when a file lifecycle operation loses its guarded durable state. */
export class FileStateTransitionConflict extends Schema.TaggedError<FileStateTransitionConflict>()(
  "FileStateTransitionConflict",
  { currentState: Schema.String, fileId: Schema.String, operation: Schema.String },
) {}

/** Disposable, bounded file compute required by the application service. */
export interface FileCompute {
  readonly analyze: (input: {
    readonly analysisId: FileAnalysisId;
    readonly mediaType: FileMediaType;
    readonly normalizedText: string;
    readonly prompt: string;
    readonly taskScope: string;
  }) => Effect.Effect<FileAnalysisComputeResult, FileComputeFailed>;
  readonly normalize: (input: {
    readonly bytes: Uint8Array;
    readonly conservativeVendorUsdMicros: bigint;
    readonly limits: typeof launchFileComputeLimits;
    readonly mediaType: FileMediaType;
    readonly sha256: FileDigest;
    readonly taskScope: string;
  }) => Effect.Effect<FileNormalizationResult, FileComputeFailed>;
  readonly releaseAnalysis: (taskScope: string) => Effect.Effect<void, FileComputeFailed>;
  readonly reconcileAnalysis: (
    taskScope: string,
  ) => Effect.Effect<FileAnalysisComputeResult, FileComputeFailed>;
}

/** Immutable object metadata needed to reconcile R2 ambiguity. */
export interface FileObjectStat {
  readonly byteLength: bigint;
  readonly sha256: FileDigest;
}

/** Immutable source-byte operations owned by the file capability. */
export interface FileObjects<Error> {
  readonly delete: (key: string) => Effect.Effect<void, Error>;
  readonly get: (key: string) => Effect.Effect<Uint8Array | null, Error>;
  readonly put: (key: string, bytes: Uint8Array, sha256: FileDigest) => Effect.Effect<void, Error>;
  readonly stat: (key: string) => Effect.Effect<FileObjectStat | null, Error>;
}

/** Allowance recording subset required by file work. */
export interface FileAllowanceRecorder<Error> {
  readonly record: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<unknown, Error>;
}

/** Stable facts used to accept one bounded file upload. */
export interface AcceptFileUpload {
  readonly acceptedAt: DbTimestamp;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly byteLength: bigint;
  readonly fileId: FileId;
  readonly fileName: FileName;
  readonly mediaType: FileMediaType;
  readonly objectKey: string;
  readonly retainedByteLimit: bigint;
  readonly sha256: FileDigest;
  readonly uploadId: FileUploadId;
  readonly userId: UserId;
}

/** Successful first acceptance or idempotent replay of one upload. */
export interface AcceptedFileUpload {
  readonly _tag: "FileAccepted" | "FileUploadReplayed";
  readonly file: FileRecord;
}

/** Narrow Agent-local persistence required by the file application service. */
export interface FilePersistence<Error> {
  readonly acceptUpload: (input: AcceptFileUpload) => Effect.Effect<AcceptedFileUpload, Error>;
  readonly analysisIds: (fileId: FileId) => Effect.Effect<ReadonlyArray<FileAnalysisId>, Error>;
  readonly beginAnalysis: (input: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly analysisId: FileAnalysisId;
    readonly createdAt: DbTimestamp;
    readonly fileId: FileId;
    readonly prompt: string;
  }) => Effect.Effect<FileAnalysisRecord, Error>;
  readonly claimAnalysis: (
    analysisId: FileAnalysisId,
    updatedAt: DbTimestamp,
  ) => Effect.Effect<boolean, Error>;
  readonly claimNormalization: (input: {
    readonly claimedAt: DbTimestamp;
    readonly expectedClaimedAt: DbTimestamp | null;
    readonly fileId: FileId;
  }) => Effect.Effect<boolean, Error>;
  readonly completeDeletion: (input: {
    readonly actionId: string;
    readonly deletedAt: DbTimestamp;
    readonly fileId: FileId;
  }) => Effect.Effect<FileDeletionRecord, Error>;
  readonly completeNormalization: (
    fileId: FileId,
    claimedAt: DbTimestamp,
    normalizedText: string,
    provenanceJson: string,
  ) => Effect.Effect<void, Error>;
  readonly failNormalization: (
    fileId: FileId,
    claimedAt: DbTimestamp,
    normalizationError: string,
  ) => Effect.Effect<void, Error>;
  readonly find: (fileId: FileId) => Effect.Effect<FileRecord, Error>;
  readonly findAnalysis: (
    analysisId: FileAnalysisId,
  ) => Effect.Effect<FileAnalysisRecord | null, Error>;
  readonly findUpload: (uploadId: FileUploadId) => Effect.Effect<FileRecord | null, Error>;
  readonly markDeleting: (fileId: FileId) => Effect.Effect<void, Error>;
  readonly markStored: (fileId: FileId) => Effect.Effect<void, Error | FileStateTransitionConflict>;
  readonly readDeletion: (fileId: FileId) => Effect.Effect<FileDeletionRecord, Error>;
  readonly releaseNormalization: (
    fileId: FileId,
    claimedAt: DbTimestamp,
  ) => Effect.Effect<void, Error>;
  readonly retainedBytes: (userId: UserId) => Effect.Effect<bigint, Error>;
  readonly updateAnalysis: (input: {
    readonly analysisId: FileAnalysisId;
    readonly failure: string | null;
    readonly resultText: string | null;
    readonly state:
      | "ambiguous"
      | "completed_cleanup_pending"
      | "failed_cleanup_pending"
      | "completed"
      | "failed";
    readonly updatedAt: DbTimestamp;
    readonly vendorUsdMicros: bigint | null;
  }) => Effect.Effect<FileAnalysisRecord, Error>;
}

/** Durable marker for one claimed analysis whose external outcome is not yet known. */
export const fileAnalysisExecutionPending = "analysis outcome pending reconciliation";

const analysisExecutionLeaseMilliseconds = 60_000;

/** Expected failure when retained policy history is internally incomplete. */
export class FilePolicyUnavailable extends Schema.TaggedError<FilePolicyUnavailable>()(
  "FilePolicyUnavailable",
  { message: Schema.String },
) {}

/** Expected failure when R2 cannot prove the requested immutable object outcome. */
export class FileStorageAmbiguous extends Schema.TaggedError<FileStorageAmbiguous>()(
  "FileStorageAmbiguous",
  { fileId: Schema.String, message: Schema.String, operation: Schema.String },
) {}

/** Expected failure when durable metadata and immutable bytes cannot produce a readable file. */
export class FileContentUnavailable extends Schema.TaggedError<FileContentUnavailable>()(
  "FileContentUnavailable",
  { fileId: Schema.String, message: Schema.String },
) {}

/** Construct the bounded file capability from its owning policy and boundary ports. */
export const makeFiles = <AllowanceError, ContextError, ObjectError, PersistenceError>(options: {
  readonly allowances: FileAllowanceRecorder<AllowanceError>;
  readonly authorization: Authorization;
  readonly catalog: PlanPolicyCatalog;
  readonly compute: FileCompute;
  readonly currentAuthorizationContext: (
    admittedContext: AuthorizationContext,
  ) => Effect.Effect<AuthorizationContext, ContextError>;
  readonly now: Effect.Effect<DbTimestamp>;
  readonly objects: FileObjects<ObjectError>;
  readonly store: FilePersistence<PersistenceError>;
}) => {
  const deleteAndVerify = (fileId: FileId, objectKey: string) =>
    options.objects.delete(objectKey).pipe(
      Effect.matchEffect({
        onFailure: () => options.objects.stat(objectKey),
        onSuccess: () => options.objects.stat(objectKey),
      }),
      Effect.flatMap((stat) =>
        stat === null
          ? Effect.void
          : new FileStorageAmbiguous({
              fileId,
              message: "R2 could not prove source deletion",
              operation: "delete",
            }),
      ),
    );

  const currentContext = (
    admittedContext: AuthorizationContext,
    resourceOwnerUserId: UserId,
    retainedFileBytes: bigint,
    requestVendorUsdMicros: bigint,
  ) =>
    options
      .currentAuthorizationContext(admittedContext)
      .pipe(
        Effect.map((context) =>
          withFileFacts(context, resourceOwnerUserId, retainedFileBytes, requestVendorUsdMicros),
        ),
      );

  const upload = (input: {
    readonly actionId: string;
    readonly bytes: Uint8Array;
    readonly context: AuthorizationContext;
    readonly declaredMediaType: string;
    readonly fileId: FileId;
    readonly fileName: FileName;
    readonly uploadId: FileUploadId;
  }) =>
    Effect.gen(function* () {
      const inspected = yield* inspectFileContent(input);
      const admittedContext = yield* options.currentAuthorizationContext(input.context);
      const existing = yield* options.store.findUpload(input.uploadId);
      const ownerUserId = existing?.userId ?? admittedContext.user.userId;
      const retainedFileBytes = yield* options.store.retainedBytes(ownerUserId);
      const policy = options.catalog.policies.find(
        ({ version }) => version === admittedContext.subscription.planPolicyVersion,
      );
      if (policy === undefined) {
        return yield* new FilePolicyUnavailable({ message: "The file Plan policy is unavailable" });
      }
      if (!isLaunchPolicy(policy)) {
        return yield* new FilePolicyUnavailable({
          message: "Shared Plan Usage is not active for file work",
        });
      }
      const rules = policyFor(policy, admittedContext.subscription.plan);
      const normalizationVendorUsdMicros = rules.operationLimits.vendorUsdMicrosPerRequest;
      const context = withFileFacts(
        admittedContext,
        ownerUserId,
        retainedFileBytes,
        normalizationVendorUsdMicros,
      );
      let allowancePeriodId = existing?.allowancePeriodId;
      if (allowancePeriodId === undefined) {
        const admission = options.authorization.admit(context, {
          actionId: input.actionId,
          bytes: inspected.byteLength,
          kind: "file.upload",
        });
        if (!Predicate.isTagged(admission, "Admitted")) return admission;
        if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
          return yield* new FilePolicyUnavailable({
            message: "File upload admission did not return its allowance period",
          });
        }
        allowancePeriodId = admission.allowancePeriod.allowancePeriodId;
      }
      const retainedByteLimit = rules.liveLimits.retainedFileBytes;
      const acceptedAt = yield* options.now;
      const objectKey = existing?.objectKey ?? objectKeyFor(ownerUserId, input.fileId);
      const accepted = yield* options.store.acceptUpload({
        acceptedAt,
        allowancePeriodId,
        byteLength: inspected.byteLength,
        fileId: input.fileId,
        fileName: input.fileName,
        mediaType: inspected.mediaType,
        objectKey,
        retainedByteLimit,
        sha256: inspected.sha256,
        uploadId: input.uploadId,
        userId: ownerUserId,
      });
      yield* options.allowances.record(
        allowancePeriodId,
        { sourceId: input.fileId, sourceType: "file" },
        [{ allowanceKind: "fileUploads", basis: "known_at_start", quantity: 1n }],
      );
      const acceptedFileOperation = { actionId: input.actionId, kind: "file.read" } as const;
      const storageRecheck = options.authorization.recheck(
        yield* currentContext(context, ownerUserId, retainedFileBytes, 0n),
        acceptedFileOperation,
      );
      if (Predicate.isTagged(storageRecheck, "Denied")) return storageRecheck;
      if (accepted.file.state === "ready")
        return { _tag: "FileReady", file: accepted.file } as const;
      if (accepted.file.state === "deleting" || accepted.file.state === "deleted") {
        if (accepted.file.state === "deleted") {
          yield* deleteAndVerify(accepted.file.fileId, accepted.file.objectKey);
        }
        return yield* new FileContentUnavailable({
          fileId: accepted.file.fileId,
          message: "A deleted file upload cannot be restarted",
        });
      }

      yield* options.objects.put(objectKey, input.bytes, inspected.sha256).pipe(
        Effect.matchEffect({
          onFailure: () =>
            options.objects.stat(objectKey).pipe(
              Effect.flatMap((stat) =>
                stat !== null &&
                stat.byteLength === inspected.byteLength &&
                stat.sha256 === inspected.sha256
                  ? Effect.void
                  : new FileStorageAmbiguous({
                      fileId: input.fileId,
                      message: "R2 could not prove the immutable source write",
                      operation: "put",
                    }),
              ),
            ),
          onSuccess: () => Effect.void,
        }),
      );
      const concurrentReady = yield* options.store.markStored(input.fileId).pipe(
        Effect.matchEffect({
          onFailure: (failure) =>
            options.store.find(input.fileId).pipe(
              Effect.flatMap((current) =>
                current.state === "stored"
                  ? Effect.succeed(null)
                  : current.state === "ready"
                    ? Effect.succeed(current)
                    : Effect.gen(function* () {
                        yield* deleteAndVerify(input.fileId, objectKey);
                        return yield* Effect.fail(failure);
                      }),
              ),
            ),
          onSuccess: () => Effect.succeed(null),
        }),
      );
      if (concurrentReady !== null) return { _tag: "FileReady", file: concurrentReady } as const;
      const normalizationCandidate = yield* options.store.find(input.fileId);
      if (
        normalizationCandidate.state === "normalizing" &&
        claimIsFresh(normalizationCandidate.normalizationClaimedAt, acceptedAt)
      ) {
        return { _tag: "FileNormalizationPending", file: normalizationCandidate } as const;
      }
      const claimedNormalization = yield* options.store.claimNormalization({
        claimedAt: acceptedAt,
        expectedClaimedAt:
          normalizationCandidate.state === "normalizing"
            ? normalizationCandidate.normalizationClaimedAt
            : null,
        fileId: input.fileId,
      });
      if (!claimedNormalization) {
        const current = yield* options.store.find(input.fileId);
        if (current.state === "ready") return { _tag: "FileReady", file: current } as const;
        if (current.state === "normalizing") {
          return { _tag: "FileNormalizationPending", file: current } as const;
        }
        if (current.state === "deleted") {
          yield* deleteAndVerify(current.fileId, current.objectKey);
        }
        if (current.state === "deleting" || current.state === "deleted") {
          return yield* new FileContentUnavailable({
            fileId: current.fileId,
            message: "A deleted file upload cannot be normalized",
          });
        }
        return yield* new FileStateTransitionConflict({
          currentState: current.state,
          fileId: current.fileId,
          operation: "claimNormalization",
        });
      }
      const computeRecheck = options.authorization.recheck(
        yield* currentContext(context, ownerUserId, retainedFileBytes, 0n),
        acceptedFileOperation,
      );
      if (Predicate.isTagged(computeRecheck, "Denied")) {
        yield* options.store.releaseNormalization(input.fileId, acceptedAt);
        return computeRecheck;
      }
      const normalized = yield* options.compute
        .normalize({
          bytes: input.bytes,
          conservativeVendorUsdMicros: normalizationVendorUsdMicros,
          limits: launchFileComputeLimits,
          mediaType: inspected.mediaType,
          sha256: inspected.sha256,
          taskScope: fileComputeScope(input.context.user.userId, "normalization", input.fileId),
        })
        .pipe(
          Effect.catchTag("FileComputeFailed", (failure) =>
            Effect.gen(function* () {
              if (failure.kind === "dependency_unavailable") {
                yield* options.store.releaseNormalization(input.fileId, acceptedAt);
              } else {
                yield* options.store.failNormalization(input.fileId, acceptedAt, failure.reason);
              }
              yield* recordCost(
                options.allowances,
                allowancePeriodId,
                { sourceId: input.fileId, sourceType: "file" },
                costFromFailure(failure),
              );
              return yield* failure;
            }),
          ),
        );
      yield* recordCost(
        options.allowances,
        allowancePeriodId,
        { sourceId: input.fileId, sourceType: "file" },
        normalized.vendorCost,
      );
      if (
        normalized.provenance.mediaType !== inspected.mediaType ||
        normalized.provenance.sourceSha256 !== inspected.sha256
      ) {
        yield* options.store.failNormalization(input.fileId, acceptedAt, "parser_failure");
        return yield* new FileComputeFailed({
          basis: null,
          kind: "task_rejected",
          message: "File normalization provenance does not match trusted source facts",
          reason: "parser_failure",
          vendorUsdMicros: 0n,
        });
      }
      const provenanceJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(FileNormalizationProvenance),
      )(normalized.provenance).pipe(
        Effect.mapError(
          () =>
            new FileComputeFailed({
              basis: null,
              kind: "task_rejected",
              message: "File normalization returned invalid provenance",
              reason: "parser_failure",
              vendorUsdMicros: 0n,
            }),
        ),
      );
      yield* options.store.completeNormalization(
        input.fileId,
        acceptedAt,
        normalized.normalizedText,
        provenanceJson,
      );
      const file = yield* options.store.find(input.fileId);
      return { _tag: "FileReady", file } as const;
    });

  const read = (input: {
    readonly actionId: string;
    readonly context: AuthorizationContext;
    readonly fileId: FileId;
  }) =>
    Effect.gen(function* () {
      const file = yield* options.store.find(input.fileId);
      const admittedContext = yield* options.currentAuthorizationContext(input.context);
      const retainedFileBytes = yield* options.store.retainedBytes(file.userId);
      const context = withFileFacts(admittedContext, file.userId, retainedFileBytes, 0n);
      const admission = options.authorization.admit(context, {
        actionId: input.actionId,
        kind: "file.read",
      });
      if (!Predicate.isTagged(admission, "Admitted")) return admission;
      const recheck = options.authorization.recheck(
        yield* currentContext(context, file.userId, retainedFileBytes, 0n),
        { actionId: input.actionId, kind: "file.read" },
      );
      if (Predicate.isTagged(recheck, "Denied")) return recheck;
      // Retained source bytes also recover an interrupted normalization without provider re-download.
      if (file.state !== "ready" && file.state !== "stored" && file.state !== "normalizing") {
        return yield* new FileContentUnavailable({
          fileId: file.fileId,
          message: "The file is not readable in its current state",
        });
      }
      const bytes = yield* options.objects.get(file.objectKey);
      if (bytes === null) {
        return yield* new FileStorageAmbiguous({
          fileId: file.fileId,
          message: "R2 is missing retained source bytes",
          operation: "get",
        });
      }
      const inspected = yield* inspectFileContent({ bytes, declaredMediaType: file.mediaType });
      if (inspected.byteLength !== file.byteLength || inspected.sha256 !== file.sha256) {
        return yield* new FileStorageAmbiguous({
          fileId: file.fileId,
          message: "R2 source bytes do not match Agent metadata",
          operation: "get",
        });
      }
      return { _tag: "FileRead" as const, bytes, file };
    });

  const analyze = (input: {
    readonly actionId: string;
    readonly analysisId: FileAnalysisId;
    readonly context: AuthorizationContext;
    readonly fileId: FileId;
    readonly prompt: string;
  }) =>
    Effect.gen(function* () {
      const file = yield* options.store.find(input.fileId);
      if (file.state !== "ready" || file.normalizedText === null) {
        return yield* new FileContentUnavailable({
          fileId: file.fileId,
          message: "The file has no normalized content to analyze",
        });
      }
      let existingAnalysis = yield* options.store.findAnalysis(input.analysisId);
      const now = yield* options.now;
      if (
        existingAnalysis !== null &&
        existingAnalysis.fileId === input.fileId &&
        existingAnalysis.prompt === input.prompt &&
        (existingAnalysis.state === "completed_cleanup_pending" ||
          existingAnalysis.state === "failed_cleanup_pending")
      ) {
        existingAnalysis = yield* finishAnalysisCleanup(file.userId, existingAnalysis, now);
      }
      const admittedContext = yield* options.currentAuthorizationContext(input.context);
      const retainedFileBytes = yield* options.store.retainedBytes(file.userId);
      const policy = options.catalog.policies.find(
        ({ version }) => version === admittedContext.subscription.planPolicyVersion,
      );
      if (policy === undefined) {
        return yield* new FilePolicyUnavailable({ message: "The file Plan policy is unavailable" });
      }
      if (!isLaunchPolicy(policy)) {
        return yield* new FilePolicyUnavailable({
          message: "Shared Plan Usage is not active for file work",
        });
      }
      const analysisVendorUsdMicros = policyFor(policy, admittedContext.subscription.plan)
        .operationLimits.vendorUsdMicrosPerRequest;
      const context = withFileFacts(
        admittedContext,
        file.userId,
        retainedFileBytes,
        analysisVendorUsdMicros,
      );
      let allowancePeriodId = existingAnalysis?.allowancePeriodId;
      if (allowancePeriodId === undefined) {
        const admission = options.authorization.admit(context, {
          actionId: input.actionId,
          kind: "file.analyze",
        });
        if (!Predicate.isTagged(admission, "Admitted")) return admission;
        if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
          return yield* new FilePolicyUnavailable({
            message: "File analysis admission did not return its allowance period",
          });
        }
        allowancePeriodId = admission.allowancePeriod.allowancePeriodId;
      }
      const analysis = yield* options.store.beginAnalysis({
        allowancePeriodId,
        analysisId: input.analysisId,
        createdAt: now,
        fileId: file.fileId,
        prompt: input.prompt,
      });
      const operation = { actionId: input.actionId, kind: "file.analyze" } as const;
      const recheck = options.authorization.recheck(
        yield* currentContext(context, file.userId, retainedFileBytes, analysisVendorUsdMicros),
        operation,
      );
      if (Predicate.isTagged(recheck, "Denied")) return recheck;
      if (analysis.state === "completed" || analysis.state === "failed") return analysis;
      if (
        analysis.state === "completed_cleanup_pending" ||
        analysis.state === "failed_cleanup_pending"
      ) {
        return yield* finishAnalysisCleanup(file.userId, analysis, now);
      }
      if (
        analysis.state === "ambiguous" &&
        analysis.failure === fileAnalysisExecutionPending &&
        claimIsFresh(analysis.updatedAt, now)
      ) {
        return analysis;
      }
      let claimedExecution = false;
      if (analysis.state === "pending") {
        claimedExecution = yield* options.store.claimAnalysis(input.analysisId, now);
        if (!claimedExecution) {
          const inFlight = yield* options.store.findAnalysis(input.analysisId);
          if (inFlight !== null) return inFlight;
        }
      }
      const computed = yield* (
        !claimedExecution
          ? options.compute.reconcileAnalysis(
              fileComputeScope(file.userId, "analysis", input.analysisId),
            )
          : options.compute.analyze({
              analysisId: input.analysisId,
              mediaType: file.mediaType,
              normalizedText: file.normalizedText,
              prompt: input.prompt,
              taskScope: fileComputeScope(file.userId, "analysis", input.analysisId),
            })
      ).pipe(
        Effect.catchTag("FileComputeFailed", (failure) =>
          Effect.gen(function* () {
            const failureCost =
              costFromFailure(failure) ??
              (analysis.state === "ambiguous"
                ? ({ basis: "conservative", quantity: analysisVendorUsdMicros } as const)
                : null);
            yield* recordCost(
              options.allowances,
              allowancePeriodId,
              { sourceId: input.analysisId, sourceType: "fileAnalysis" },
              failureCost,
            );
            const cleanupPending = yield* options.store
              .updateAnalysis({
                analysisId: input.analysisId,
                failure: failure.reason,
                resultText: null,
                state: "failed_cleanup_pending",
                updatedAt: now,
                vendorUsdMicros: failureCost?.quantity ?? null,
              })
              .pipe(Effect.flatMap(requireAnalysisCleanupPending));
            yield* finishAnalysisCleanup(file.userId, cleanupPending, now);
            return yield* failure;
          }),
        ),
      );
      if (Predicate.isTagged(computed, "AnalysisAmbiguous")) {
        if (analysis.state !== "ambiguous") {
          return yield* options.store.updateAnalysis({
            analysisId: input.analysisId,
            failure: computed.evidence,
            resultText: null,
            state: "ambiguous",
            updatedAt: now,
            vendorUsdMicros: null,
          });
        }
        const ambiguityCost =
          computed.vendorCost ??
          ({ basis: "conservative", quantity: analysisVendorUsdMicros } as const);
        yield* recordCost(
          options.allowances,
          allowancePeriodId,
          { sourceId: input.analysisId, sourceType: "fileAnalysis" },
          ambiguityCost,
        );
        const cleanupPending = yield* options.store
          .updateAnalysis({
            analysisId: input.analysisId,
            failure: computed.evidence,
            resultText: null,
            state: "failed_cleanup_pending",
            updatedAt: now,
            vendorUsdMicros: ambiguityCost.quantity,
          })
          .pipe(Effect.flatMap(requireAnalysisCleanupPending));
        return yield* finishAnalysisCleanup(file.userId, cleanupPending, now);
      }
      yield* recordCost(
        options.allowances,
        allowancePeriodId,
        { sourceId: input.analysisId, sourceType: "fileAnalysis" },
        computed.vendorCost,
      );
      const cleanupPending = yield* options.store
        .updateAnalysis({
          analysisId: input.analysisId,
          failure: null,
          resultText: computed.resultText,
          state: "completed_cleanup_pending",
          updatedAt: now,
          vendorUsdMicros: computed.vendorCost?.quantity ?? null,
        })
        .pipe(Effect.flatMap(requireAnalysisCleanupPending));
      return yield* finishAnalysisCleanup(file.userId, cleanupPending, now);
    });

  const remove = (input: {
    readonly actionId: string;
    readonly context: AuthorizationContext;
    readonly fileId: FileId;
  }) =>
    Effect.gen(function* () {
      const file = yield* options.store.find(input.fileId);
      const admittedContext = yield* options.currentAuthorizationContext(input.context);
      const retainedFileBytes = yield* options.store.retainedBytes(file.userId);
      const context = withFileFacts(admittedContext, file.userId, retainedFileBytes, 0n);
      const operation = { actionId: input.actionId, kind: "file.delete" } as const;
      const admission = options.authorization.admit(context, operation);
      if (!Predicate.isTagged(admission, "Admitted")) return admission;
      const recheck = options.authorization.recheck(
        yield* currentContext(context, file.userId, retainedFileBytes, 0n),
        operation,
      );
      if (Predicate.isTagged(recheck, "Denied")) return recheck;
      if (file.state === "deleted") {
        yield* deleteAndVerify(file.fileId, file.objectKey);
        yield* releaseFileAnalyses(file.userId, file.fileId);
        return yield* options.store.readDeletion(file.fileId);
      }
      yield* options.store.markDeleting(file.fileId);
      yield* releaseFileAnalyses(file.userId, file.fileId);
      yield* deleteAndVerify(file.fileId, file.objectKey);
      const deletedAt = yield* options.now;
      return yield* options.store.completeDeletion({
        actionId: input.actionId,
        deletedAt,
        fileId: file.fileId,
      });
    });

  const releaseFileAnalyses = (userId: UserId, fileId: FileId) =>
    options.store
      .analysisIds(fileId)
      .pipe(
        Effect.flatMap((analysisIds) =>
          Effect.forEach(
            analysisIds,
            (analysisId) =>
              options.compute.releaseAnalysis(fileComputeScope(userId, "analysis", analysisId)),
            { discard: true },
          ),
        ),
      );

  const finishAnalysisCleanup = (
    userId: UserId,
    analysis: Extract<
      FileAnalysisRecord,
      { readonly state: "completed_cleanup_pending" | "failed_cleanup_pending" }
    >,
    updatedAt: DbTimestamp,
  ) =>
    options.compute.releaseAnalysis(fileComputeScope(userId, "analysis", analysis.analysisId)).pipe(
      Effect.andThen(
        options.store.updateAnalysis({
          analysisId: analysis.analysisId,
          failure: analysis.failure,
          resultText: analysis.resultText,
          state: analysis.state === "completed_cleanup_pending" ? "completed" : ("failed" as const),
          updatedAt,
          vendorUsdMicros: analysis.vendorUsdMicros,
        }),
      ),
    );

  const requireAnalysisCleanupPending = (analysis: FileAnalysisRecord) =>
    analysis.state === "completed_cleanup_pending" || analysis.state === "failed_cleanup_pending"
      ? Effect.succeed(analysis)
      : Effect.fail(
          new FileStateTransitionConflict({
            currentState: analysis.state,
            fileId: analysis.fileId,
            operation: "persistAnalysisCleanupEvidence",
          }),
        );

  return { analyze, read, remove, upload };
};

const withFileFacts = (
  context: AuthorizationContext,
  resourceOwnerUserId: UserId,
  retainedFileBytes: bigint,
  requestVendorUsdMicros: bigint,
): AuthorizationContext => ({
  ...context,
  liveFacts: { ...context.liveFacts, retainedFileBytes },
  requestVendorUsdMicros,
  resourceOwnerUserId,
});

const objectKeyFor = (userId: UserId, fileId: FileId): string =>
  `users/${encodeURIComponent(userId)}/files/${encodeURIComponent(fileId)}/source`;

const fileComputeScope = (
  userId: UserId,
  operation: "analysis" | "normalization",
  identity: FileAnalysisId | FileId,
): string => `${operation}-${encodeURIComponent(userId)}-${encodeURIComponent(identity)}`;

const claimIsFresh = (updatedAt: DbTimestamp, now: DbTimestamp): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(now)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(updatedAt)) <
  analysisExecutionLeaseMilliseconds;

const recordCost = <Error>(
  allowances: FileAllowanceRecorder<Error>,
  allowancePeriodId: AllowancePeriodId,
  source: AllowanceSource,
  cost: FileVendorCost | null,
): Effect.Effect<void, Error> =>
  cost === null
    ? Effect.void
    : allowances
        .record(allowancePeriodId, source, [
          { allowanceKind: "vendorUsdMicros", basis: cost.basis, quantity: cost.quantity },
        ])
        .pipe(Effect.asVoid);

const costFromFailure = (failure: FileComputeFailed): FileVendorCost | null =>
  failure.vendorUsdMicros === 0n || failure.basis === null
    ? null
    : { basis: failure.basis, quantity: failure.vendorUsdMicros };

/** Public file capability inferred from its single owning factory. */
export type Interface = ReturnType<typeof makeFiles>;
