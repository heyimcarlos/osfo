import { and, eq, ne, sql } from "drizzle-orm";
import { Effect, Predicate, Schema } from "effect";

import type { AllowancePeriodId, UserId } from "../../../domain";
import {
  FileAnalysisRecord,
  FileAnalysisId,
  FileDeletionRecord,
  FileRecord,
  type FileId,
} from "../../../domain/file";
import type { DbTimestamp } from "../../../db";
import {
  fileAnalysisExecutionPending,
  FileStateTransitionConflict,
  type AcceptFileUpload,
} from "../../../services/files";
import type { AgentDb } from "./client";
import { fileAnalyses, fileDeletions, files } from "./schema";

/** Expected rejection when accepting a file would exceed the owning Plan gauge. */
export class RetainedFileLimitExceeded extends Schema.TaggedError<RetainedFileLimitExceeded>()(
  "RetainedFileLimitExceeded",
  {
    attemptedBytes: Schema.BigInt,
    limitBytes: Schema.BigInt,
    message: Schema.String,
    retainedBytes: Schema.BigInt,
  },
) {}

/** Expected conflict when one upload identity is retried with changed trusted facts. */
export class FileUploadConflict extends Schema.TaggedError<FileUploadConflict>()(
  "FileUploadConflict",
  { message: Schema.String, uploadId: Schema.String },
) {}

/** Expected dependency failure from Agent-local file persistence. */
export class FileStoreUnavailable extends Schema.TaggedError<FileStoreUnavailable>()(
  "FileStoreUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected failure when Agent SQLite returns an invalid file record. */
export class FileStoreRecordInvalid extends Schema.TaggedError<FileStoreRecordInvalid>()(
  "FileStoreRecordInvalid",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected failure when a file identity is not present in the Agent store. */
export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  fileId: Schema.String,
  message: Schema.String,
}) {}

/** Expected conflict when one analysis identity is retried with changed facts. */
export class FileAnalysisConflict extends Schema.TaggedError<FileAnalysisConflict>()(
  "FileAnalysisConflict",
  { analysisId: Schema.String, message: Schema.String },
) {}

/** Successful first acceptance of one upload. */
export interface FileAccepted {
  readonly _tag: "FileAccepted";
  readonly file: FileRecord;
}

/** Successful idempotent replay of one accepted upload. */
export interface FileUploadReplayed {
  readonly _tag: "FileUploadReplayed";
  readonly file: FileRecord;
}

/** Construct Agent-local file persistence over one Durable SQLite authority. */
export const makeFileStore = (db: AgentDb) => {
  const acceptUpload = (
    input: AcceptFileUpload,
  ): Effect.Effect<
    FileAccepted | FileUploadReplayed,
    FileStoreRecordInvalid | FileStoreUnavailable | FileUploadConflict | RetainedFileLimitExceeded
  > =>
    Effect.gen(function* () {
      const outcome = yield* execute("acceptUpload", () =>
        db.transaction((transaction) => {
          const existing = transaction
            .select()
            .from(files)
            .where(eq(files.upload_id, input.uploadId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            if (!sameUpload(existing, input)) return { _tag: "Conflict" } as const;
            return { _tag: "Replay", row: existing } as const;
          }
          const total =
            transaction
              .select({ value: sql<number>`COALESCE(SUM(${files.byte_length}), 0)` })
              .from(files)
              .where(and(eq(files.user_id, input.userId), ne(files.state, "deleted")))
              .get()?.value ?? 0;
          const retainedBytes = BigInt(total);
          if (retainedBytes + input.byteLength > input.retainedByteLimit) {
            return { _tag: "OverLimit", retainedBytes } as const;
          }
          const inserted = transaction
            .insert(files)
            .values({
              accepted_at: input.acceptedAt,
              allowance_period_id: input.allowancePeriodId,
              byte_length: Number(input.byteLength),
              deleted_at: null,
              file_id: input.fileId,
              file_name: input.fileName,
              media_type: input.mediaType,
              normalization_claimed_at: null,
              normalization_error: null,
              normalized_text: null,
              object_key: input.objectKey,
              provenance_json: null,
              sha256: input.sha256,
              state: "pending_storage",
              upload_id: input.uploadId,
              user_id: input.userId,
            })
            .returning()
            .get();
          return { _tag: "Accepted", row: inserted } as const;
        }),
      );
      if (Predicate.isTagged(outcome, "Accepted")) {
        return {
          _tag: "FileAccepted",
          file: yield* decodeFile(outcome.row, "acceptUpload"),
        } as const;
      }
      if (Predicate.isTagged(outcome, "Replay")) {
        return {
          _tag: "FileUploadReplayed",
          file: yield* decodeFile(outcome.row, "acceptUpload"),
        } as const;
      }
      if (Predicate.isTagged(outcome, "Conflict")) {
        return yield* new FileUploadConflict({
          message: "The upload identity is already bound to different file facts",
          uploadId: input.uploadId,
        });
      }
      return yield* new RetainedFileLimitExceeded({
        attemptedBytes: input.byteLength,
        limitBytes: input.retainedByteLimit,
        message: "The upload would exceed the retained file byte limit",
        retainedBytes: outcome.retainedBytes,
      });
    });

  const retainedBytes = (ownerUserId: UserId): Effect.Effect<bigint, FileStoreUnavailable> =>
    execute("retainedBytes", () =>
      db
        .select({ value: sql<number>`COALESCE(SUM(${files.byte_length}), 0)` })
        .from(files)
        .where(and(eq(files.user_id, ownerUserId), ne(files.state, "deleted")))
        .get(),
    ).pipe(Effect.map((row) => BigInt(row?.value ?? 0)));

  const find = (
    fileId: FileId,
  ): Effect.Effect<FileRecord, FileNotFound | FileStoreRecordInvalid | FileStoreUnavailable> =>
    Effect.gen(function* () {
      const row = yield* execute("find", () =>
        db.select().from(files).where(eq(files.file_id, fileId)).limit(1).get(),
      );
      if (row === undefined) {
        return yield* new FileNotFound({ fileId, message: "The file does not exist" });
      }
      return yield* decodeFile(row, "find");
    });

  const findUpload = (uploadId: AcceptFileUpload["uploadId"]) =>
    execute("findUpload", () =>
      db.select().from(files).where(eq(files.upload_id, uploadId)).limit(1).get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.succeed(null) : decodeFile(row, "findUpload"),
      ),
    );

  const findAnalysis = (analysisId: FileAnalysisId) =>
    execute("findAnalysis", () =>
      db.select().from(fileAnalyses).where(eq(fileAnalyses.analysis_id, analysisId)).limit(1).get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.succeed(null) : decodeAnalysis(row, "findAnalysis"),
      ),
    );

  const analysisIds = (fileId: FileId) =>
    execute("analysisIds", () =>
      db
        .select({ analysisId: fileAnalyses.analysis_id })
        .from(fileAnalyses)
        .where(eq(fileAnalyses.file_id, fileId))
        .all(),
    ).pipe(
      Effect.flatMap((rows) =>
        Schema.decodeEffect(Schema.Array(FileAnalysisId))(rows.map(({ analysisId }) => analysisId)),
      ),
      Effect.mapError((cause) =>
        Schema.is(FileStoreUnavailable)(cause)
          ? cause
          : new FileStoreRecordInvalid({
              cause,
              message: "Agent SQLite returned an invalid file analysis identity",
              operation: "analysisIds",
            }),
      ),
    );

  const markStored = (fileId: FileId) =>
    Effect.gen(function* () {
      const currentState = yield* execute("markStored", () =>
        db.transaction((transaction) => {
          const current = transaction
            .select({ state: files.state })
            .from(files)
            .where(eq(files.file_id, fileId))
            .get();
          if (current?.state === "pending_storage" || current?.state === "normalization_failed") {
            transaction
              .update(files)
              .set({
                normalization_claimed_at: null,
                normalization_error: null,
                normalized_text: null,
                provenance_json: null,
                state: "stored",
              })
              .where(eq(files.file_id, fileId))
              .run();
            return "stored" as const;
          }
          return current?.state ?? null;
        }),
      );
      if (currentState === null) {
        return yield* new FileNotFound({ fileId, message: "The file does not exist" });
      }
      if (currentState !== "stored" && currentState !== "normalizing") {
        return yield* new FileStateTransitionConflict({
          currentState,
          fileId,
          operation: "markStored",
        });
      }
      return undefined;
    });

  const claimNormalization = (input: {
    readonly claimedAt: DbTimestamp;
    readonly expectedClaimedAt: DbTimestamp | null;
    readonly fileId: FileId;
  }) =>
    execute("claimNormalization", () =>
      db.transaction((transaction) => {
        const current = transaction
          .select({
            normalizationClaimedAt: files.normalization_claimed_at,
            state: files.state,
          })
          .from(files)
          .where(eq(files.file_id, input.fileId))
          .get();
        if (
          current === undefined ||
          (current.state !== "stored" &&
            current.state !== "normalization_failed" &&
            (current.state !== "normalizing" ||
              current.normalizationClaimedAt !== input.expectedClaimedAt))
        ) {
          return false;
        }
        transaction
          .update(files)
          .set({
            normalization_claimed_at: input.claimedAt,
            normalization_error: null,
            normalized_text: null,
            provenance_json: null,
            state: "normalizing",
          })
          .where(eq(files.file_id, input.fileId))
          .run();
        return true;
      }),
    );

  const completeNormalization = (
    fileId: FileId,
    claimedAt: DbTimestamp,
    normalized_text: string,
    provenance_json: string,
  ) =>
    finishNormalization(fileId, claimedAt, "completeNormalization", {
      normalization_claimed_at: null,
      normalization_error: null,
      normalized_text: normalized_text,
      provenance_json: provenance_json,
      state: "ready",
    });

  const failNormalization = (fileId: FileId, claimedAt: DbTimestamp, normalization_error: string) =>
    finishNormalization(fileId, claimedAt, "failNormalization", {
      normalization_claimed_at: null,
      normalization_error: normalization_error,
      normalized_text: null,
      provenance_json: null,
      state: "normalization_failed",
    });

  const releaseNormalization = (fileId: FileId, claimedAt: DbTimestamp) =>
    execute("releaseNormalization", () =>
      db
        .update(files)
        .set({ normalization_claimed_at: null, state: "stored" })
        .where(
          and(
            eq(files.file_id, fileId),
            eq(files.state, "normalizing"),
            eq(files.normalization_claimed_at, claimedAt),
          ),
        )
        .run(),
    ).pipe(Effect.asVoid);

  const beginAnalysis = (input: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly analysisId: FileAnalysisId;
    readonly createdAt: DbTimestamp;
    readonly fileId: FileId;
    readonly prompt: string;
  }): Effect.Effect<
    FileAnalysisRecord,
    FileAnalysisConflict | FileStoreRecordInvalid | FileStoreUnavailable
  > =>
    Effect.gen(function* () {
      const outcome = yield* execute("beginAnalysis", () =>
        db.transaction((transaction) => {
          const existing = transaction
            .select()
            .from(fileAnalyses)
            .where(eq(fileAnalyses.analysis_id, input.analysisId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            if (
              existing.allowance_period_id !== input.allowancePeriodId ||
              existing.file_id !== input.fileId ||
              existing.prompt !== input.prompt
            ) {
              return { _tag: "Conflict" } as const;
            }
            return { _tag: "Found", row: existing } as const;
          }
          const row = transaction
            .insert(fileAnalyses)
            .values({
              allowance_period_id: input.allowancePeriodId,
              analysis_id: input.analysisId,
              created_at: input.createdAt,
              failure: null,
              file_id: input.fileId,
              prompt: input.prompt,
              result_text: null,
              state: "pending",
              updated_at: input.createdAt,
              vendor_usd_micros: null,
            })
            .returning()
            .get();
          return { _tag: "Found", row } as const;
        }),
      );
      if (Predicate.isTagged(outcome, "Conflict")) {
        return yield* new FileAnalysisConflict({
          analysisId: input.analysisId,
          message: "The analysis identity is already bound to different facts",
        });
      }
      return yield* decodeAnalysis(outcome.row, "beginAnalysis");
    });

  const updateAnalysis = (input: {
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
  }) =>
    Effect.gen(function* () {
      const row = yield* execute("updateAnalysis", () =>
        db.transaction((transaction) => {
          const current = transaction
            .select()
            .from(fileAnalyses)
            .where(eq(fileAnalyses.analysis_id, input.analysisId))
            .get();
          if (current === undefined) return undefined;
          if (!analysisTransitionAllowed(current.state, input.state)) return current;
          return transaction
            .update(fileAnalyses)
            .set({
              analysis_id: input.analysisId,
              failure: input.failure,
              result_text: input.resultText,
              state: input.state,
              updated_at: input.updatedAt,
              vendor_usd_micros:
                input.vendorUsdMicros === null ? null : Number(input.vendorUsdMicros),
            })
            .where(eq(fileAnalyses.analysis_id, input.analysisId))
            .returning()
            .get();
        }),
      );
      if (row === undefined) {
        return yield* new FileNotFound({
          fileId: input.analysisId,
          message: "The file analysis does not exist",
        });
      }
      if (row.state !== input.state) {
        return yield* new FileStateTransitionConflict({
          currentState: row.state,
          fileId: row.file_id,
          operation: "updateAnalysis",
        });
      }
      return yield* decodeAnalysis(row, "updateAnalysis");
    });

  const claimAnalysis = (analysisId: FileAnalysisId, updated_at: DbTimestamp) =>
    execute("claimAnalysis", () =>
      db.transaction((transaction) => {
        const current = transaction
          .select({ fileId: fileAnalyses.file_id, state: fileAnalyses.state })
          .from(fileAnalyses)
          .where(eq(fileAnalyses.analysis_id, analysisId))
          .get();
        const file =
          current === undefined
            ? undefined
            : transaction
                .select({ state: files.state })
                .from(files)
                .where(eq(files.file_id, current.fileId))
                .get();
        if (current?.state !== "pending" || file?.state !== "ready") return false;
        transaction
          .update(fileAnalyses)
          .set({
            failure: fileAnalysisExecutionPending,
            state: "ambiguous",
            updated_at: updated_at,
          })
          .where(and(eq(fileAnalyses.analysis_id, analysisId), eq(fileAnalyses.state, "pending")))
          .run();
        return true;
      }),
    );

  const completeDeletion = (input: {
    readonly actionId: string;
    readonly deletedAt: DbTimestamp;
    readonly fileId: FileId;
  }): Effect.Effect<
    FileDeletionRecord,
    FileNotFound | FileStateTransitionConflict | FileStoreRecordInvalid | FileStoreUnavailable
  > =>
    Effect.gen(function* () {
      const outcome = yield* execute("completeDeletion", () =>
        db.transaction((transaction) => {
          const file = transaction
            .select()
            .from(files)
            .where(eq(files.file_id, input.fileId))
            .limit(1)
            .get();
          if (file === undefined) return null;
          if (file.state !== "deleting") return { _tag: "Conflict", file } as const;
          const analysisCount =
            transaction
              .select({ value: sql<number>`COUNT(*)` })
              .from(fileAnalyses)
              .where(eq(fileAnalyses.file_id, input.fileId))
              .get()?.value ?? 0;
          transaction
            .update(fileAnalyses)
            .set({
              failure: "source file deleted",
              result_text: null,
              state: "deleted",
              updated_at: input.deletedAt,
            })
            .where(eq(fileAnalyses.file_id, input.fileId))
            .run();
          transaction
            .update(files)
            .set({
              deleted_at: input.deletedAt,
              normalization_claimed_at: null,
              normalization_error: null,
              normalized_text: null,
              provenance_json: null,
              state: "deleted",
            })
            .where(eq(files.file_id, input.fileId))
            .run();
          return {
            _tag: "Deleted",
            row:
              transaction
                .insert(fileDeletions)
                .values({
                  action_id: input.actionId,
                  analysis_count: analysisCount,
                  deleted_at: input.deletedAt,
                  file_id: input.fileId,
                  source_object_key: file.object_key,
                  source_sha256: file.sha256,
                  user_id: file.user_id,
                })
                .onConflictDoNothing()
                .returning()
                .get() ??
              transaction
                .select()
                .from(fileDeletions)
                .where(eq(fileDeletions.file_id, input.fileId))
                .get(),
          } as const;
        }),
      );
      if (outcome === null || outcome === undefined) {
        return yield* new FileNotFound({
          fileId: input.fileId,
          message: "The file does not exist",
        });
      }
      if (Predicate.isTagged(outcome, "Conflict")) {
        return yield* new FileStateTransitionConflict({
          currentState: outcome.file.state,
          fileId: input.fileId,
          operation: "completeDeletion",
        });
      }
      return yield* decodeDeletion(outcome.row, "completeDeletion");
    });

  const readDeletion = (
    fileId: FileId,
  ): Effect.Effect<
    FileDeletionRecord,
    FileNotFound | FileStoreRecordInvalid | FileStoreUnavailable
  > =>
    Effect.gen(function* () {
      const row = yield* execute("readDeletion", () =>
        db.select().from(fileDeletions).where(eq(fileDeletions.file_id, fileId)).limit(1).get(),
      );
      if (row === undefined) {
        return yield* new FileNotFound({ fileId, message: "The file has no deletion lineage" });
      }
      return yield* decodeDeletion(row, "readDeletion");
    });

  function transitionFile(
    fileId: FileId,
    operation: string,
    allowedStates: ReadonlyArray<FileRow["state"]>,
    changes: Partial<FileRow>,
  ) {
    return Effect.gen(function* () {
      const current = yield* execute(operation, () =>
        db.select().from(files).where(eq(files.file_id, fileId)).get(),
      );
      if (current === undefined) {
        return yield* new FileNotFound({ fileId, message: "The file does not exist" });
      }
      if (!allowedStates.includes(current.state)) {
        return yield* new FileStateTransitionConflict({
          currentState: current.state,
          fileId,
          operation,
        });
      }
      yield* execute(operation, () =>
        db.update(files).set(changes).where(eq(files.file_id, fileId)).run(),
      );
      return undefined;
    });
  }

  function finishNormalization(
    fileId: FileId,
    claimedAt: DbTimestamp,
    operation: string,
    changes: Partial<FileRow>,
  ) {
    return Effect.gen(function* () {
      const outcome = yield* execute(operation, () =>
        db.transaction((transaction) => {
          const current = transaction
            .select({
              normalizationClaimedAt: files.normalization_claimed_at,
              state: files.state,
            })
            .from(files)
            .where(eq(files.file_id, fileId))
            .get();
          if (current?.state !== "normalizing" || current.normalizationClaimedAt !== claimedAt) {
            return current?.state ?? null;
          }
          transaction.update(files).set(changes).where(eq(files.file_id, fileId)).run();
          return "updated" as const;
        }),
      );
      if (outcome === null) {
        return yield* new FileNotFound({ fileId, message: "The file does not exist" });
      }
      if (outcome !== "updated") {
        return yield* new FileStateTransitionConflict({
          currentState: outcome,
          fileId,
          operation,
        });
      }
      return undefined;
    });
  }

  return {
    acceptUpload,
    analysisIds,
    beginAnalysis,
    claimAnalysis,
    claimNormalization,
    completeDeletion,
    completeNormalization,
    failNormalization,
    find,
    findAnalysis,
    findUpload,
    markDeleting: (fileId: FileId) =>
      transitionFile(
        fileId,
        "markDeleting",
        ["pending_storage", "stored", "normalizing", "ready", "normalization_failed", "deleting"],
        {
          deleted_at: null,
          normalization_claimed_at: null,
          normalization_error: null,
          normalized_text: null,
          provenance_json: null,
          state: "deleting",
        },
      ),
    markStored,
    readDeletion,
    releaseNormalization,
    retainedBytes,
    updateAnalysis,
  };
};

type FileRow = typeof files.$inferSelect;

const sameUpload = (row: FileRow, input: AcceptFileUpload): boolean =>
  row.allowance_period_id === input.allowancePeriodId &&
  BigInt(row.byte_length) === input.byteLength &&
  row.file_id === input.fileId &&
  row.file_name === input.fileName &&
  row.media_type === input.mediaType &&
  row.object_key === input.objectKey &&
  row.sha256 === input.sha256 &&
  row.user_id === input.userId;

const decodeFile = (row: FileRow, operation: string) =>
  Schema.decodeUnknownEffect(FileRecord)({
    acceptedAt: row.accepted_at,
    allowancePeriodId: row.allowance_period_id,
    byteLength: BigInt(row.byte_length),
    deletedAt: row.deleted_at,
    fileId: row.file_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    normalizationClaimedAt: row.normalization_claimed_at,
    normalizationError: row.normalization_error,
    normalizedText: row.normalized_text,
    objectKey: row.object_key,
    provenanceJson: row.provenance_json,
    sha256: row.sha256,
    state: row.state,
    uploadId: row.upload_id,
    userId: row.user_id,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FileStoreRecordInvalid({
          cause,
          message: "Agent SQLite returned an invalid file record",
          operation,
        }),
    ),
  );

type FileAnalysisRow = typeof fileAnalyses.$inferSelect;
type FileDeletionRow = typeof fileDeletions.$inferSelect;

const decodeAnalysis = (row: FileAnalysisRow, operation: string) =>
  Schema.decodeUnknownEffect(FileAnalysisRecord)({
    allowancePeriodId: row.allowance_period_id,
    analysisId: row.analysis_id,
    createdAt: row.created_at,
    failure: row.failure,
    fileId: row.file_id,
    prompt: row.prompt,
    resultText: row.result_text,
    state: row.state,
    updatedAt: row.updated_at,
    vendorUsdMicros: row.vendor_usd_micros === null ? null : BigInt(row.vendor_usd_micros),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FileStoreRecordInvalid({
          cause,
          message: "Agent SQLite returned an invalid file analysis record",
          operation,
        }),
    ),
  );

const decodeDeletion = (row: FileDeletionRow, operation: string) =>
  Schema.decodeEffect(FileDeletionRecord)({
    actionId: row.action_id,
    analysisCount: row.analysis_count,
    deletedAt: row.deleted_at,
    fileId: row.file_id,
    sourceObjectKey: row.source_object_key,
    sourceSha256: row.source_sha256,
    userId: row.user_id,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FileStoreRecordInvalid({
          cause,
          message: "Agent SQLite returned an invalid file deletion record",
          operation,
        }),
    ),
  );

const analysisTransitionAllowed = (
  current: FileAnalysisRow["state"],
  next:
    | "ambiguous"
    | "completed_cleanup_pending"
    | "failed_cleanup_pending"
    | "completed"
    | "failed",
): boolean =>
  (current === "pending" && (next === "ambiguous" || next === "failed")) ||
  (current === "ambiguous" &&
    (next === "ambiguous" ||
      next === "completed_cleanup_pending" ||
      next === "failed_cleanup_pending")) ||
  (current === "completed_cleanup_pending" && next === "completed") ||
  (current === "failed_cleanup_pending" && next === "failed");

const execute = <A>(operation: string, query: () => A): Effect.Effect<A, FileStoreUnavailable> =>
  Effect.try({
    try: query,
    catch: (cause) =>
      new FileStoreUnavailable({
        cause,
        message: "Agent SQLite could not complete a file operation",
        operation,
      }),
  });
