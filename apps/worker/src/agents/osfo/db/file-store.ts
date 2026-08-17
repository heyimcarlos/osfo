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
            .where(eq(files.uploadId, input.uploadId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            if (!sameUpload(existing, input)) return { _tag: "Conflict" } as const;
            return { _tag: "Replay", row: existing } as const;
          }
          const total =
            transaction
              .select({ value: sql<number>`COALESCE(SUM(${files.byteLength}), 0)` })
              .from(files)
              .where(and(eq(files.userId, input.userId), ne(files.state, "deleted")))
              .get()?.value ?? 0;
          const retainedBytes = BigInt(total);
          if (retainedBytes + input.byteLength > input.retainedByteLimit) {
            return { _tag: "OverLimit", retainedBytes } as const;
          }
          const inserted = transaction
            .insert(files)
            .values({
              ...input,
              byteLength: Number(input.byteLength),
              deletedAt: null,
              normalizationClaimedAt: null,
              normalizationError: null,
              normalizedText: null,
              provenanceJson: null,
              state: "pending_storage",
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
        .select({ value: sql<number>`COALESCE(SUM(${files.byteLength}), 0)` })
        .from(files)
        .where(and(eq(files.userId, ownerUserId), ne(files.state, "deleted")))
        .get(),
    ).pipe(Effect.map((row) => BigInt(row?.value ?? 0)));

  const find = (
    fileId: FileId,
  ): Effect.Effect<FileRecord, FileNotFound | FileStoreRecordInvalid | FileStoreUnavailable> =>
    Effect.gen(function* () {
      const row = yield* execute("find", () =>
        db.select().from(files).where(eq(files.fileId, fileId)).limit(1).get(),
      );
      if (row === undefined) {
        return yield* new FileNotFound({ fileId, message: "The file does not exist" });
      }
      return yield* decodeFile(row, "find");
    });

  const findUpload = (uploadId: AcceptFileUpload["uploadId"]) =>
    execute("findUpload", () =>
      db.select().from(files).where(eq(files.uploadId, uploadId)).limit(1).get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.succeed(null) : decodeFile(row, "findUpload"),
      ),
    );

  const findAnalysis = (analysisId: FileAnalysisId) =>
    execute("findAnalysis", () =>
      db.select().from(fileAnalyses).where(eq(fileAnalyses.analysisId, analysisId)).limit(1).get(),
    ).pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.succeed(null) : decodeAnalysis(row, "findAnalysis"),
      ),
    );

  const analysisIds = (fileId: FileId) =>
    execute("analysisIds", () =>
      db
        .select({ analysisId: fileAnalyses.analysisId })
        .from(fileAnalyses)
        .where(eq(fileAnalyses.fileId, fileId))
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
            .where(eq(files.fileId, fileId))
            .get();
          if (current?.state === "pending_storage" || current?.state === "normalization_failed") {
            transaction
              .update(files)
              .set({
                normalizationClaimedAt: null,
                normalizationError: null,
                normalizedText: null,
                provenanceJson: null,
                state: "stored",
              })
              .where(eq(files.fileId, fileId))
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
            normalizationClaimedAt: files.normalizationClaimedAt,
            state: files.state,
          })
          .from(files)
          .where(eq(files.fileId, input.fileId))
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
            normalizationClaimedAt: input.claimedAt,
            normalizationError: null,
            normalizedText: null,
            provenanceJson: null,
            state: "normalizing",
          })
          .where(eq(files.fileId, input.fileId))
          .run();
        return true;
      }),
    );

  const completeNormalization = (
    fileId: FileId,
    claimedAt: DbTimestamp,
    normalizedText: string,
    provenanceJson: string,
  ) =>
    finishNormalization(fileId, claimedAt, "completeNormalization", {
      normalizationClaimedAt: null,
      normalizationError: null,
      normalizedText,
      provenanceJson,
      state: "ready",
    });

  const failNormalization = (fileId: FileId, claimedAt: DbTimestamp, normalizationError: string) =>
    finishNormalization(fileId, claimedAt, "failNormalization", {
      normalizationClaimedAt: null,
      normalizationError,
      normalizedText: null,
      provenanceJson: null,
      state: "normalization_failed",
    });

  const releaseNormalization = (fileId: FileId, claimedAt: DbTimestamp) =>
    execute("releaseNormalization", () =>
      db
        .update(files)
        .set({ normalizationClaimedAt: null, state: "stored" })
        .where(
          and(
            eq(files.fileId, fileId),
            eq(files.state, "normalizing"),
            eq(files.normalizationClaimedAt, claimedAt),
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
            .where(eq(fileAnalyses.analysisId, input.analysisId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            if (
              existing.allowancePeriodId !== input.allowancePeriodId ||
              existing.fileId !== input.fileId ||
              existing.prompt !== input.prompt
            ) {
              return { _tag: "Conflict" } as const;
            }
            return { _tag: "Found", row: existing } as const;
          }
          const row = transaction
            .insert(fileAnalyses)
            .values({
              ...input,
              failure: null,
              resultText: null,
              state: "pending",
              updatedAt: input.createdAt,
              vendorUsdMicros: null,
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
            .where(eq(fileAnalyses.analysisId, input.analysisId))
            .get();
          if (current === undefined) return undefined;
          if (!analysisTransitionAllowed(current.state, input.state)) return current;
          return transaction
            .update(fileAnalyses)
            .set({
              ...input,
              vendorUsdMicros:
                input.vendorUsdMicros === null ? null : Number(input.vendorUsdMicros),
            })
            .where(eq(fileAnalyses.analysisId, input.analysisId))
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
          fileId: row.fileId,
          operation: "updateAnalysis",
        });
      }
      return yield* decodeAnalysis(row, "updateAnalysis");
    });

  const claimAnalysis = (analysisId: FileAnalysisId, updatedAt: DbTimestamp) =>
    execute("claimAnalysis", () =>
      db.transaction((transaction) => {
        const current = transaction
          .select({ fileId: fileAnalyses.fileId, state: fileAnalyses.state })
          .from(fileAnalyses)
          .where(eq(fileAnalyses.analysisId, analysisId))
          .get();
        const file =
          current === undefined
            ? undefined
            : transaction
                .select({ state: files.state })
                .from(files)
                .where(eq(files.fileId, current.fileId))
                .get();
        if (current?.state !== "pending" || file?.state !== "ready") return false;
        transaction
          .update(fileAnalyses)
          .set({
            failure: fileAnalysisExecutionPending,
            state: "ambiguous",
            updatedAt,
          })
          .where(and(eq(fileAnalyses.analysisId, analysisId), eq(fileAnalyses.state, "pending")))
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
            .where(eq(files.fileId, input.fileId))
            .limit(1)
            .get();
          if (file === undefined) return null;
          if (file.state !== "deleting") return { _tag: "Conflict", file } as const;
          const analysisCount =
            transaction
              .select({ value: sql<number>`COUNT(*)` })
              .from(fileAnalyses)
              .where(eq(fileAnalyses.fileId, input.fileId))
              .get()?.value ?? 0;
          transaction
            .update(fileAnalyses)
            .set({
              failure: "source file deleted",
              resultText: null,
              state: "deleted",
              updatedAt: input.deletedAt,
            })
            .where(eq(fileAnalyses.fileId, input.fileId))
            .run();
          transaction
            .update(files)
            .set({
              deletedAt: input.deletedAt,
              normalizationClaimedAt: null,
              normalizationError: null,
              normalizedText: null,
              provenanceJson: null,
              state: "deleted",
            })
            .where(eq(files.fileId, input.fileId))
            .run();
          return {
            _tag: "Deleted",
            row:
              transaction
                .insert(fileDeletions)
                .values({
                  actionId: input.actionId,
                  analysisCount,
                  deletedAt: input.deletedAt,
                  fileId: input.fileId,
                  sourceObjectKey: file.objectKey,
                  sourceSha256: file.sha256,
                  userId: file.userId,
                })
                .onConflictDoNothing()
                .returning()
                .get() ??
              transaction
                .select()
                .from(fileDeletions)
                .where(eq(fileDeletions.fileId, input.fileId))
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
        db.select().from(fileDeletions).where(eq(fileDeletions.fileId, fileId)).limit(1).get(),
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
        db.select().from(files).where(eq(files.fileId, fileId)).get(),
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
        db.update(files).set(changes).where(eq(files.fileId, fileId)).run(),
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
              normalizationClaimedAt: files.normalizationClaimedAt,
              state: files.state,
            })
            .from(files)
            .where(eq(files.fileId, fileId))
            .get();
          if (current?.state !== "normalizing" || current.normalizationClaimedAt !== claimedAt) {
            return current?.state ?? null;
          }
          transaction.update(files).set(changes).where(eq(files.fileId, fileId)).run();
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
          deletedAt: null,
          normalizationClaimedAt: null,
          normalizationError: null,
          normalizedText: null,
          provenanceJson: null,
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
  row.allowancePeriodId === input.allowancePeriodId &&
  BigInt(row.byteLength) === input.byteLength &&
  row.fileId === input.fileId &&
  row.fileName === input.fileName &&
  row.mediaType === input.mediaType &&
  row.objectKey === input.objectKey &&
  row.sha256 === input.sha256 &&
  row.userId === input.userId;

const decodeFile = (row: FileRow, operation: string) =>
  Schema.decodeUnknownEffect(FileRecord)({ ...row, byteLength: BigInt(row.byteLength) }).pipe(
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
    ...row,
    vendorUsdMicros: row.vendorUsdMicros === null ? null : BigInt(row.vendorUsdMicros),
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
  Schema.decodeEffect(FileDeletionRecord)(row).pipe(
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
