/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
/* oxlint-disable effecttsgo/global-date -- Fixed R2 timestamps make authority evidence deterministic. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { bytesToHex } from "@noble/hashes/utils.js";

import { AllowancePeriodId, UserId } from "../../domain";
import { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import type { QualificationContext } from "../../domain/qualification-context";
import {
  DocumentIntentConflict,
  DocumentIntentDigest,
  type StoredArtifact,
} from "../../services/document-generation";
import { DocumentArtifacts } from "./document-artifacts";
import { contentKeyFor } from "./document-storage-keys";

const context: QualificationContext = {
  attemptId: "attempt-1",
  executionId: "execution-1",
  journey: "documentBuild",
  offeredAtEpochMs: 1_788_000_000_000,
  planChecksum: "plan-1",
  region: "americas",
  rootId: "root-1",
  runId: "run-1",
};

it.effect(
  "retains qualification identity and SHA-256 on the actual content object through accounting",
  () =>
    Effect.gen(function* () {
      const fixture = r2Fixture();
      const artifacts = DocumentArtifacts.make(fixture.bucket);
      const stored = yield* qualifiedArtifact();

      yield* artifacts.put(stored);
      yield* artifacts.account(stored.artifact.content.contentId);

      const object = fixture.object(contentKeyFor(stored.artifact.content.contentId));
      expect(object?.customMetadata).toMatchObject({
        "osfo-sha256": stored.artifact.content.sha256,
        osfoAttemptId: context.attemptId,
        osfoExecutionId: context.executionId,
        osfoObjectId: stored.artifact.content.contentId,
        osfoPlanChecksum: context.planChecksum,
        osfoRootId: context.rootId,
        osfoRunId: context.runId,
      });
      expect(
        object?.checksums.sha256 === undefined
          ? undefined
          : bytesToHex(new Uint8Array(object.checksums.sha256)),
      ).toBe(stored.artifact.content.sha256);
      expect((yield* artifacts.inspect(stored.artifact.content.contentId))?.retention).toBe(
        "accounted",
      );
    }),
);

it.effect("rejects replay of the same content identity under a different qualification root", () =>
  Effect.gen(function* () {
    const fixture = r2Fixture();
    const artifacts = DocumentArtifacts.make(fixture.bucket);
    const stored = yield* qualifiedArtifact();
    yield* artifacts.put(stored);

    const replay = yield* artifacts
      .put({
        ...stored,
        qualificationContext: { ...context, rootId: "root-2" },
      })
      .pipe(Effect.result);

    expect(Result.isFailure(replay)).toBe(true);
    if (Result.isFailure(replay)) expect(replay.failure).toBeInstanceOf(DocumentIntentConflict);
  }),
);

it.effect("rejects qualified content whose actual object SHA-256 metadata is missing", () =>
  Effect.gen(function* () {
    const fixture = r2Fixture();
    const artifacts = DocumentArtifacts.make(fixture.bucket);
    const stored = yield* qualifiedArtifact();
    yield* artifacts.put(stored);
    fixture.mutate(contentKeyFor(stored.artifact.content.contentId), (object) => {
      const customMetadata = { ...object.customMetadata };
      delete customMetadata["osfo-sha256"];
      return Object.assign(object, { customMetadata });
    });

    expect(
      Result.isFailure(
        yield* artifacts.inspect(stored.artifact.content.contentId).pipe(Effect.result),
      ),
    ).toBe(true);
  }),
);

const qualifiedArtifact = Effect.fn("qualifiedArtifact")(function* () {
  const bytes = new Uint8Array([1, 2, 3]);
  const contentId = ContentId.make("document:workflow:qualification-1");
  const artifact = yield* DocumentArtifact.make(contentId, "pdf", bytes.length, 1, "a".repeat(64));
  return {
    allowancePeriodId: AllowancePeriodId.make("period-1"),
    artifact,
    bytes,
    cost: { _tag: "ProvenNoUse" },
    format: "pdf",
    intentDigest: DocumentIntentDigest.make("b".repeat(64)),
    owner: DocumentArtifact.DocumentOwner.make({
      _tag: "Workflow",
      workflowId: "document-build:qualification-1",
    }),
    qualificationContext: context,
    retention: "pending",
    userId: UserId.make("qualification-user-1"),
  } satisfies StoredArtifact;
});

interface StoredR2Object extends R2Object {
  readonly bytes: Uint8Array;
}

const r2Fixture = () => {
  const objects = new Map<string, StoredR2Object>();
  let revision = 0;
  const objectFor = (key: string, bytes: Uint8Array, options: R2PutOptions): StoredR2Object => {
    revision += 1;
    if (options.sha256 !== undefined && !(options.sha256 instanceof Uint8Array)) {
      throw new Error("The adapter must provide SHA-256 bytes to R2");
    }
    const checksum =
      options.sha256 === undefined ? undefined : Uint8Array.from(options.sha256).buffer;
    const checksums: R2Checksums =
      checksum === undefined
        ? { toJSON: () => ({}) }
        : { sha256: checksum, toJSON: () => ({ sha256: "runtime-encoded" }) };
    return {
      bytes,
      checksums,
      customMetadata: options.customMetadata ?? {},
      etag: `etag-${revision}`,
      httpEtag: `"etag-${revision}"`,
      key,
      size: bytes.byteLength,
      storageClass: "Standard",
      uploaded: new Date("2026-08-30T12:00:00.000Z"),
      version: `version-${revision}`,
      writeHttpMetadata: () => undefined,
    };
  };
  const bucket = {
    delete: () => Promise.resolve(),
    get: (key: string) => {
      const object = objects.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : { ...object, arrayBuffer: () => Promise.resolve(object.bytes.buffer) },
      );
    },
    head: (key: string) => Promise.resolve(objects.get(key) ?? null),
    put: (key: string, body: Uint8Array, options: R2PutOptions) => {
      const current = objects.get(key);
      if (options.onlyIf !== undefined) {
        if ("etagDoesNotMatch" in options.onlyIf && current !== undefined) {
          return Promise.resolve(null);
        }
        if ("etagMatches" in options.onlyIf && current?.etag !== options.onlyIf.etagMatches) {
          return Promise.resolve(null);
        }
      }
      const object = objectFor(key, body, options);
      objects.set(key, object);
      return Promise.resolve(object);
    },
  };
  return {
    // SAFETY: This fake implements the exact R2 methods exercised by DocumentArtifacts.
    // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Narrow test double.
    bucket: bucket as unknown as R2Bucket,
    mutate: (key: string, change: (object: StoredR2Object) => StoredR2Object) => {
      const object = objects.get(key);
      if (object !== undefined) objects.set(key, change(object));
    },
    object: (key: string) => objects.get(key),
  };
};
