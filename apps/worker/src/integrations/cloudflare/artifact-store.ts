import { Effect, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import type { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import {
  ArtifactIntegrityFailure,
  ArtifactIntentConflict,
  ArtifactIntentDigest,
  ArtifactStoreUnavailable,
  CostEvidence,
  type ArtifactStore,
  type StoredArtifact,
  type StoredArtifactMetadata,
} from "../../services/artifact-generation";
import { artifactAttemptKeyFor, contentKeyFor, ownerKeyFor } from "./document-storage-keys";
import { DocumentOwnershipIndex } from "./document-ownership-index";

/* oxlint-disable eslint/no-underscore-dangle -- Persisted unions use the _tag discriminator. */

const Metadata = Schema.fromJsonString(
  Schema.Struct({
    allowancePeriodId: AllowancePeriodId,
    artifact: DocumentArtifact.ArtifactRef,
    cost: CostEvidence,
    intentDigest: ArtifactIntentDigest,
    intentTag: Schema.Literals(["Presentation", "Image", "Diagram"]),
    owner: DocumentArtifact.DocumentOwner,
    retention: Schema.Literals(["accounted", "pending"]),
    userId: UserId,
  }),
);

/** Construct immutable generated-artifact storage over one R2 bucket binding. */
export const make = (bucket: R2Bucket): ArtifactStore => ({
  account: (contentId) =>
    Effect.gen(function* () {
      const object = yield* attempt("inspect", () => bucket.head(contentKeyFor(contentId)));
      if (object === null) return yield* integrityFailure(contentId, "Pending artifact is missing");
      const metadata = yield* decodeMetadata(object, contentId);
      if (metadata.retention === "accounted") return undefined;
      const body = yield* attempt("readBytes", () => bucket.get(contentKeyFor(contentId)));
      if (body === null || body.size !== metadata.artifact.content.byteLength) {
        return yield* integrityFailure(contentId, "Pending artifact bytes are missing or changed");
      }
      const bytes = yield* attempt("readBytes", () =>
        readBounded(
          body.body,
          DocumentArtifact.maximumBytesForRole(metadata.artifact.artifactRole),
        ),
      );
      yield* verifyDigest(metadata, bytes);
      const accounted = yield* attempt("account", () =>
        bucket.put(contentKeyFor(contentId), bytes, {
          customMetadata: {
            osfo: encodeMetadata({ ...metadata, bytes, retention: "accounted" }),
          },
          httpMetadata: { contentType: metadata.artifact.content.mediaType },
          onlyIf: { etagMatches: object.etag },
          sha256: metadata.artifact.content.sha256,
        }),
      );
      if (accounted !== null) return undefined;
      const current = yield* attempt("inspect", () => bucket.head(contentKeyFor(contentId)));
      if (current === null)
        return yield* integrityFailure(contentId, "Accounted artifact is missing");
      const currentMetadata = yield* decodeMetadata(current, contentId);
      if (currentMetadata.retention !== "accounted" || !sameMetadata(currentMetadata, metadata)) {
        return yield* integrityFailure(contentId, "Artifact accounting did not complete");
      }
      return undefined;
    }),
  delete: (metadata) =>
    attempt("delete", () =>
      bucket.delete([
        contentKeyFor(metadata.artifact.content.contentId),
        artifactAttemptKeyFor(metadata.artifact.content.contentId),
        ownerKeyFor(metadata.userId, metadata.artifact.content.contentId),
      ]),
    ).pipe(Effect.asVoid),
  inspect: (contentId) =>
    Effect.gen(function* () {
      const object = yield* attempt("inspect", () => bucket.head(contentKeyFor(contentId)));
      return object === null ? null : yield* decodeMetadata(object, contentId);
    }),
  put: (stored) =>
    Effect.gen(function* () {
      const content = stored.artifact.content;
      if (content.byteLength > DocumentArtifact.maximumBytesForRole(stored.artifact.artifactRole)) {
        return yield* integrityFailure(content.contentId, "Artifact exceeds its role byte limit");
      }
      yield* verifyDigest(stored, stored.bytes);
      yield* attempt("put", () =>
        DocumentOwnershipIndex.ensure(bucket, stored.userId, content.contentId),
      );
      const result = yield* attempt("put", () =>
        bucket.put(contentKeyFor(content.contentId), stored.bytes, {
          customMetadata: { osfo: encodeMetadata(stored) },
          httpMetadata: { contentType: content.mediaType },
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: content.sha256,
        }),
      );
      if (result !== null) return undefined;
      const object = yield* attempt("inspect", () => bucket.head(contentKeyFor(content.contentId)));
      const existing = object === null ? null : yield* decodeMetadata(object, content.contentId);
      if (existing === null || !sameMetadata(existing, stored)) {
        return yield* new ArtifactIntentConflict({
          contentId: content.contentId,
          message: "R2 already contains different Client Content for the owning identity",
        });
      }
      return undefined;
    }),
  readBytes: (metadata) =>
    Effect.gen(function* () {
      if (metadata.retention !== "accounted") {
        return yield* integrityFailure(
          metadata.artifact.content.contentId,
          "Artifact accounting evidence is incomplete",
        );
      }
      const content = metadata.artifact.content;
      if (
        content.byteLength > DocumentArtifact.maximumBytesForRole(metadata.artifact.artifactRole)
      ) {
        return yield* integrityFailure(content.contentId, "Artifact exceeds its role byte limit");
      }
      const object = yield* attempt("readBytes", () =>
        bucket.get(contentKeyFor(content.contentId)),
      );
      if (object === null || object.size !== content.byteLength) {
        return yield* integrityFailure(content.contentId, "Artifact bytes are missing or changed");
      }
      const bytes = yield* attempt("readBytes", () =>
        readBounded(
          object.body,
          DocumentArtifact.maximumBytesForRole(metadata.artifact.artifactRole),
        ),
      );
      yield* verifyDigest(metadata, bytes);
      return bytes;
    }),
});

const decodeMetadata = (object: R2Object, contentId: ContentId) =>
  Effect.gen(function* () {
    const encoded = object.customMetadata?.osfo;
    if (encoded === undefined)
      return yield* integrityFailure(contentId, "Artifact metadata is missing");
    const metadata = yield* Schema.decodeEffect(Metadata)(encoded).pipe(
      Effect.mapError(
        () => new ArtifactIntegrityFailure({ contentId, message: "Artifact metadata is invalid" }),
      ),
    );
    if (
      metadata.artifact.content.contentId !== contentId ||
      metadata.artifact.content.byteLength !== object.size ||
      metadata.artifact.content.byteLength >
        DocumentArtifact.maximumBytesForRole(metadata.artifact.artifactRole)
    ) {
      return yield* integrityFailure(
        contentId,
        "Artifact identity, length, or role byte limit does not match",
      );
    }
    return metadata satisfies StoredArtifactMetadata;
  });

const verifyDigest = (metadata: StoredArtifactMetadata, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    );
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      bytes.byteLength !== metadata.artifact.content.byteLength ||
      sha256 !== metadata.artifact.content.sha256
    ) {
      return yield* integrityFailure(
        metadata.artifact.content.contentId,
        "Artifact digest or length does not match",
      );
    }
    return undefined;
  });

const encodeMetadata = (stored: StoredArtifact) =>
  Schema.encodeSync(Metadata)({
    allowancePeriodId: stored.allowancePeriodId,
    artifact: stored.artifact,
    cost: stored.cost,
    intentDigest: stored.intentDigest,
    intentTag: stored.intentTag,
    owner: stored.owner,
    retention: stored.retention,
    userId: stored.userId,
  });

// oxlint-disable-next-line effecttsgo/async-function -- ReadableStream is an external Promise boundary.
const readBounded = async (stream: ReadableStream<Uint8Array>, maximum: number) => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stream chunks must be read in order.
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancellation closes this one ordered read boundary.
        await reader.cancel("artifact exceeded its bounded size");
        throw new Error("artifact exceeded its bounded size");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const attempt = <A>(
  operation: "account" | "delete" | "inspect" | "put" | "readBytes",
  effect: () => Promise<A>,
): Effect.Effect<A, ArtifactStoreUnavailable> =>
  Effect.tryPromise({
    try: effect,
    catch: (cause) =>
      new ArtifactStoreUnavailable({
        cause,
        message: `R2 could not ${operation} the generated artifact`,
        operation,
      }),
  });

const integrityFailure = (contentId: ContentId, message: string) =>
  Effect.fail(new ArtifactIntegrityFailure({ contentId, message }));

const sameMetadata = (left: StoredArtifactMetadata, right: StoredArtifactMetadata) =>
  left.artifact.content.sha256 === right.artifact.content.sha256 &&
  left.intentDigest === right.intentDigest &&
  left.intentTag === right.intentTag &&
  left.userId === right.userId &&
  left.artifact.lineage.sourceContentId === right.artifact.lineage.sourceContentId &&
  DocumentArtifact.sameOwner(left.owner, right.owner) &&
  sameCost(left.cost, right.cost);

const sameCost = (left: CostEvidence, right: CostEvidence) =>
  left._tag === right._tag &&
  (left._tag === "ProvenNoUse" && right._tag === "ProvenNoUse"
    ? true
    : left._tag === "Incurred" &&
      right._tag === "Incurred" &&
      left.allowancePeriodId === right.allowancePeriodId &&
      left.basis === right.basis &&
      left.providerOperationId === right.providerOperationId &&
      left.usdMicros === right.usdMicros);

export * as ArtifactStore from "./artifact-store";
