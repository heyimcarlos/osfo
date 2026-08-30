import { Effect, Option, Predicate, Schema } from "effect";

import { AgentId, UserId } from "../../domain";
import { FileDigest, FileMediaType } from "../../domain/file-content";
import { FileId, type FileRecord } from "../../domain/file";
import type { DocumentBuild } from "../../services/document-build";

/* oxlint-disable eslint/no-underscore-dangle -- RPC and local resolution results use Effect-style discriminators. */

/** Resolve only ready, exactly owned FileRecords without misclassifying store outages. */
export const resolveFromFileStore = <E>(
  request: DocumentBuild.FileResolutionRequest,
  owningAgentId: AgentId,
  find: (fileId: FileId) => Effect.Effect<FileRecord, E>,
): Effect.Effect<DocumentBuild.FileResolutionResult> => {
  if (request.agentId !== owningAgentId) {
    return Effect.succeed({ _tag: "Unavailable", reason: "routeMismatch" });
  }
  return Effect.gen(function* () {
    const resolution = yield* Effect.forEach(
      request.fileIds,
      (fileId) =>
        find(fileId).pipe(
          Effect.map(Option.some),
          Effect.catch((failure) =>
            Predicate.isTagged(failure, "FileNotFound")
              ? Effect.succeed(Option.none())
              : Effect.fail(failure),
          ),
        ),
      { concurrency: 1 },
    ).pipe(
      Effect.map((records) => ({ _tag: "Records" as const, records })),
      Effect.orElseSucceed(() => ({ _tag: "Unavailable", reason: "resolverUnavailable" }) as const),
    );
    if (resolution._tag === "Unavailable") return resolution;
    const records = resolution.records;
    if (records.some(Option.isNone)) {
      return { _tag: "Unavailable", reason: "fileUnavailable" } as const;
    }
    const files = records.map((record) => Option.getOrThrow(record));
    const ready = files.flatMap((file) =>
      file.userId === request.userId && file.state === "ready" ? [file] : [],
    );
    if (ready.length !== files.length) {
      return { _tag: "Unavailable", reason: "fileUnavailable" } as const;
    }
    return {
      _tag: "Resolved",
      files: ready.map(({ byteLength, fileId, fileName, mediaType, normalizedText, sha256 }) => ({
        byteLength,
        fileId,
        fileName,
        mediaType,
        normalizedText,
        sha256,
      })),
    } as const;
  });
};

export const VerificationRequest = Schema.Struct({
  agentId: AgentId,
  fileId: FileId,
  userId: UserId,
});
export type VerificationRequest = typeof VerificationRequest.Type;

export const VerificationResult = Schema.Union([
  Schema.TaggedStruct("Found", {
    byteLength: Schema.BigInt,
    fileId: FileId,
    mediaType: FileMediaType,
    sha256: FileDigest,
    state: Schema.Literal("ready"),
    userId: UserId,
  }),
  Schema.TaggedStruct("Unavailable", {}),
]);
export type VerificationResult = typeof VerificationResult.Type;

/** Inspect immutable source facts without exposing normalized content or storage identity. */
export const inspectVerificationSnapshot = <FindError, StatError>(
  request: VerificationRequest,
  owningAgentId: AgentId,
  find: (fileId: FileId) => Effect.Effect<FileRecord, FindError>,
  stat: (
    objectKey: string,
  ) => Effect.Effect<
    { readonly byteLength: bigint; readonly sha256: FileDigest } | null,
    StatError
  >,
): Effect.Effect<VerificationResult> => {
  if (request.agentId !== owningAgentId) return Effect.succeed({ _tag: "Unavailable" });
  return find(request.fileId).pipe(
    Effect.flatMap((file) =>
      file.userId !== request.userId || file.state !== "ready"
        ? Effect.succeed({ _tag: "Unavailable" as const })
        : stat(file.objectKey).pipe(
            Effect.map((object): VerificationResult =>
              object !== null &&
              object.byteLength === file.byteLength &&
              object.sha256 === file.sha256
                ? {
                    _tag: "Found",
                    byteLength: file.byteLength,
                    fileId: file.fileId,
                    mediaType: file.mediaType,
                    sha256: file.sha256,
                    state: "ready",
                    userId: file.userId,
                  }
                : { _tag: "Unavailable" },
            ),
          ),
    ),
    Effect.orElseSucceed(() => ({ _tag: "Unavailable" as const })),
  );
};

export * as DocumentBuildFileResolution from "./document-build-file-resolution";
