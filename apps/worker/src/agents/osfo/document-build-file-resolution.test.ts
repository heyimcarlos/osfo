/* oxlint-disable vitest/no-standalone-expect, eslint/no-underscore-dangle -- Assertions execute inside Effect tests and inspect standard Effect discriminators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AgentId, AllowancePeriodId, UserId } from "../../domain";
import { DbTimestamp } from "../../db";
import { FileDigest } from "../../domain/file-content";
import { FileId, FileUploadId, type FileRecord } from "../../domain/file";
import { DocumentBuild } from "../../services/document-build";
import { makeAccountDeletionFence } from "./account-deletion-fence";
import { DocumentBuildFileResolution } from "./document-build-file-resolution";

it.effect("returns only the minimal ready owned source snapshot", () =>
  Effect.gen(function* () {
    const result = yield* resolve(() => Effect.succeed(readyFile(userId)));

    expect(result).toEqual({
      _tag: "Resolved",
      files: [
        {
          byteLength: 12n,
          fileId,
          fileName: "Source.txt",
          mediaType: "text/plain",
          normalizedText: "source text",
          sha256,
        },
      ],
    });
    expect(result._tag === "Resolved" && result.files.some((file) => "objectKey" in file)).toBe(
      false,
    );
  }),
);

const unavailableCases: ReadonlyArray<{
  readonly find: (fileId: FileId) => Effect.Effect<FileRecord, string>;
  readonly name: string;
}> = [
  { find: () => Effect.fail("missing"), name: "missing file" },
  { find: () => Effect.fail("sqlite unavailable"), name: "store failure" },
  { find: () => Effect.succeed(readyFile(UserId.make("foreign-user"))), name: "foreign owner" },
  { find: () => Effect.succeed(pendingFile()), name: "non-ready file" },
];

for (const { find, name } of unavailableCases) {
  it.effect(`fails closed for ${name}`, () =>
    Effect.gen(function* () {
      expect(yield* resolve(find)).toEqual({ _tag: "Unavailable", reason: "fileUnavailable" });
    }),
  );
}

it.effect("rejects an Agent route mismatch before reading the file store", () =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* DocumentBuildFileResolution.resolveFromFileStore(
      { ...request, agentId: AgentId.make("other-agent") },
      agentId,
      () => Effect.sync(() => (reads += 1)).pipe(Effect.as(readyFile(userId))),
    );

    expect(result).toEqual({ _tag: "Unavailable", reason: "routeMismatch" });
    expect(reads).toBe(0);
  }),
);

it.effect("distinguishes a closed account deletion fence from file-store failure", () =>
  Effect.gen(function* () {
    const fence = makeAccountDeletionFence();
    yield* fence.close;
    const result = yield* fence
      .run(
        resolve(() => Effect.succeed(readyFile(userId))),
        () => ({
          _tag: "Unavailable" as const,
          reason: "deletionFenced" as const,
        }),
      )
      .pipe(Effect.catch((failure) => Effect.succeed(failure)));

    expect(result).toEqual({ _tag: "Unavailable", reason: "deletionFenced" });
  }),
);

const userId = UserId.make("document-build-user");
const agentId = AgentId.make("document-build-agent");
const fileId = FileId.make("document-build-source");
const sha256 = FileDigest.make(`sha256:${"a".repeat(64)}`);
const request = DocumentBuild.FileResolutionRequest.make({ agentId, fileIds: [fileId], userId });

const resolve = (find: (fileId: FileId) => Effect.Effect<FileRecord, unknown>) =>
  DocumentBuildFileResolution.resolveFromFileStore(request, agentId, find);

const baseFile = {
  acceptedAt: DbTimestamp.make("2026-08-28T12:00:00.000Z"),
  allowancePeriodId: AllowancePeriodId.make("document-build-period"),
  byteLength: 12n,
  deletedAt: null,
  fileId,
  fileName: "Source.txt",
  mediaType: "text/plain" as const,
  normalizationClaimedAt: null,
  normalizationError: null,
  objectKey: "private/files/source",
  provenanceJson: null,
  sha256,
  uploadId: FileUploadId.make("document-build-upload"),
  userId,
};

const readyFile = (owner: UserId): FileRecord => ({
  ...baseFile,
  normalizedText: "source text",
  provenanceJson: "{}",
  state: "ready",
  userId: owner,
});

const pendingFile = (): FileRecord => ({
  ...baseFile,
  normalizedText: null,
  state: "stored",
});
