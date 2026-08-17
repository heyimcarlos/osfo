import { Schema } from "effect";

import { AllowancePeriodId, UserId } from "../domain";
import { DbTimestamp } from "../db";
import { FileDigest, FileMediaType } from "./file-content";

/** Stable server-issued identity of one User-owned file. */
export const FileId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)).pipe(
  Schema.brand("FileId"),
);

/** Stable server-issued identity of one User-owned file. */
export type FileId = typeof FileId.Type;

/** Stable caller identity for one retryable upload. */
export const FileUploadId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
).pipe(Schema.brand("FileUploadId"));

/** Stable caller identity for one retryable upload. */
export type FileUploadId = typeof FileUploadId.Type;

/** Stable identity for one retryable file analysis. */
export const FileAnalysisId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
).pipe(Schema.brand("FileAnalysisId"));

/** Stable identity for one retryable file analysis. */
export type FileAnalysisId = typeof FileAnalysisId.Type;

/** Bounded display name retained for one uploaded file. */
export const FileName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));

/** Bounded display name retained for one uploaded file. */
export type FileName = typeof FileName.Type;

/** Durable lifecycle of source bytes and their normalized content. */
export const FileState = Schema.Literals([
  "pending_storage",
  "stored",
  "normalizing",
  "ready",
  "normalization_failed",
  "deleting",
  "deleted",
]);

/** Durable lifecycle of source bytes and their normalized content. */
export type FileState = typeof FileState.Type;

const FileRecordBase = {
  acceptedAt: DbTimestamp,
  allowancePeriodId: AllowancePeriodId,
  byteLength: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
  fileId: FileId,
  fileName: FileName,
  mediaType: FileMediaType,
  objectKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  sha256: FileDigest,
  uploadId: FileUploadId,
  userId: UserId,
} as const;

const FileWithoutNormalizedContent = {
  ...FileRecordBase,
  deletedAt: Schema.Null,
  normalizationError: Schema.Null,
  normalizationClaimedAt: Schema.Null,
  normalizedText: Schema.Null,
  provenanceJson: Schema.Null,
} as const;

/** Trusted Agent-local metadata with state-specific content invariants. */
export const FileRecord = Schema.Union([
  Schema.Struct({ ...FileWithoutNormalizedContent, state: Schema.Literal("pending_storage") }),
  Schema.Struct({ ...FileWithoutNormalizedContent, state: Schema.Literal("stored") }),
  Schema.Struct({
    ...FileRecordBase,
    deletedAt: Schema.Null,
    normalizationClaimedAt: DbTimestamp,
    normalizationError: Schema.Null,
    normalizedText: Schema.Null,
    provenanceJson: Schema.Null,
    state: Schema.Literal("normalizing"),
  }),
  Schema.Struct({ ...FileWithoutNormalizedContent, state: Schema.Literal("deleting") }),
  Schema.Struct({
    ...FileRecordBase,
    deletedAt: Schema.Null,
    normalizationError: Schema.Null,
    normalizationClaimedAt: Schema.Null,
    normalizedText: Schema.String,
    provenanceJson: Schema.String,
    state: Schema.Literal("ready"),
  }),
  Schema.Struct({
    ...FileRecordBase,
    deletedAt: Schema.Null,
    normalizationError: Schema.String,
    normalizationClaimedAt: Schema.Null,
    normalizedText: Schema.Null,
    provenanceJson: Schema.Null,
    state: Schema.Literal("normalization_failed"),
  }),
  Schema.Struct({
    ...FileRecordBase,
    deletedAt: DbTimestamp,
    normalizationError: Schema.Null,
    normalizationClaimedAt: Schema.Null,
    normalizedText: Schema.Null,
    provenanceJson: Schema.Null,
    state: Schema.Literal("deleted"),
  }),
]);

/** Trusted Agent-local metadata for one User-owned file. */
export type FileRecord = typeof FileRecord.Type;

/** Durable state of one idempotent analysis operation. */
export const FileAnalysisState = Schema.Literals([
  "pending",
  "ambiguous",
  "completed_cleanup_pending",
  "failed_cleanup_pending",
  "completed",
  "failed",
  "deleted",
]);

/** Durable state of one idempotent analysis operation. */
export type FileAnalysisState = typeof FileAnalysisState.Type;

const FileAnalysisBase = {
  allowancePeriodId: AllowancePeriodId,
  analysisId: FileAnalysisId,
  createdAt: DbTimestamp,
  fileId: FileId,
  prompt: Schema.String,
  updatedAt: DbTimestamp,
} as const;

/** Agent-local analysis result with state-specific recovery invariants. */
export const FileAnalysisRecord = Schema.Union([
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.Null,
    resultText: Schema.String,
    state: Schema.Literal("completed_cleanup_pending"),
    vendorUsdMicros: Schema.NullOr(Schema.BigInt),
  }),
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.String,
    resultText: Schema.Null,
    state: Schema.Literal("failed_cleanup_pending"),
    vendorUsdMicros: Schema.NullOr(Schema.BigInt),
  }),
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.Null,
    resultText: Schema.Null,
    state: Schema.Literal("pending"),
    vendorUsdMicros: Schema.Null,
  }),
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.String,
    resultText: Schema.Null,
    state: Schema.Literal("ambiguous"),
    vendorUsdMicros: Schema.NullOr(Schema.BigInt),
  }),
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.Null,
    resultText: Schema.String,
    state: Schema.Literal("completed"),
    vendorUsdMicros: Schema.NullOr(Schema.BigInt),
  }),
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.String,
    resultText: Schema.Null,
    state: Schema.Literal("failed"),
    vendorUsdMicros: Schema.NullOr(Schema.BigInt),
  }),
  Schema.Struct({
    ...FileAnalysisBase,
    failure: Schema.String,
    resultText: Schema.Null,
    state: Schema.Literal("deleted"),
    vendorUsdMicros: Schema.NullOr(Schema.BigInt),
  }),
]);

/** Agent-local analysis result and recovery facts. */
export type FileAnalysisRecord = typeof FileAnalysisRecord.Type;

/** Durable proof that source bytes and derived analyses share one deletion lineage. */
export const FileDeletionRecord = Schema.Struct({
  actionId: Schema.String,
  analysisCount: Schema.Natural,
  deletedAt: DbTimestamp,
  fileId: FileId,
  sourceObjectKey: Schema.String,
  sourceSha256: FileDigest,
  userId: UserId,
});

/** Durable proof that source bytes and derived analyses share one deletion lineage. */
export type FileDeletionRecord = typeof FileDeletionRecord.Type;
