import { Effect, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import type { ContentId } from "../../domain/client-content";
import * as DocumentArtifact from "../../domain/document-artifact";
import {
  ArtifactIntegrityFailure,
  ArtifactStoreUnavailable,
  DocumentIntentConflict,
  DocumentIntentDigest,
  type ArtifactStore,
  type CostEvidence,
  type StoredArtifact,
  type StoredArtifactMetadata,
} from "../../services/document-generation";
import { attemptKeyFor, contentKeyFor } from "./document-storage-keys";

/* oxlint-disable eslint/no-underscore-dangle -- Persisted unions use the _tag discriminator. */

const Metadata = Schema.fromJsonString(
  Schema.Struct({
    allowancePeriodId: AllowancePeriodId,
    artifact: DocumentArtifact.ArtifactRef,
    cost: Schema.Union([
      Schema.TaggedStruct("ProvenNoUse", {}),
      Schema.TaggedStruct("Incurred", {
        allowancePeriodId: AllowancePeriodId,
        basis: Schema.Literals(["conservative", "observed"]),
        providerOperationId: Schema.String.check(Schema.isMinLength(1)),
        usdMicros: Schema.BigIntFromString,
      }),
    ]),
    format: DocumentArtifact.DocumentFormat,
    intentDigest: DocumentIntentDigest,
    owner: DocumentArtifact.DocumentOwner,
    userId: UserId,
  }),
);

/** Construct immutable generated-document storage over one R2 bucket binding. */
export const make = (bucket: R2Bucket): ArtifactStore => ({
  delete: (contentId) =>
    attempt("delete", () =>
      bucket.delete([contentKeyFor(contentId), attemptKeyFor(contentId)]),
    ).pipe(Effect.asVoid),
  inspect: (contentId) =>
    Effect.gen(function* () {
      const object = yield* attempt("inspect", () => bucket.head(contentKeyFor(contentId)));
      return object === null ? null : yield* decodeMetadata(object, contentId);
    }),
  put: (stored) =>
    Effect.gen(function* () {
      const content = stored.artifact.content;
      const result = yield* attempt("put", () =>
        bucket.put(contentKeyFor(content.contentId), stored.bytes, {
          customMetadata: { osfo: encodeMetadata(stored) },
          httpMetadata: { contentType: content.mediaType },
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: content.sha256,
        }),
      );
      if (result === null) {
        const object = yield* attempt("inspect", () =>
          bucket.head(contentKeyFor(content.contentId)),
        );
        const existing = object === null ? null : yield* decodeMetadata(object, content.contentId);
        if (existing === null || !sameStoredArtifact(existing, stored)) {
          return yield* new DocumentIntentConflict({
            contentId: content.contentId,
            message: "R2 already contains different Client Content for the owning identity",
          });
        }
      }
      return undefined;
    }),
  readBytes: (metadata) => readBytes(bucket, metadata),
});

const decodeMetadata = (object: R2Object, contentId: ContentId) =>
  Effect.gen(function* () {
    const encoded = object.customMetadata?.osfo;
    if (encoded === undefined) {
      return yield* integrityFailure(contentId, "The retained Client Content has no Osfo metadata");
    }
    const metadata = yield* Schema.decodeEffect(Metadata)(encoded).pipe(
      Effect.mapError(
        () =>
          new ArtifactIntegrityFailure({
            contentId,
            message: "The retained Client Content metadata is invalid",
          }),
      ),
    );
    if (
      metadata.artifact.content.contentId !== contentId ||
      metadata.artifact.content.byteLength !== object.size ||
      object.size > DocumentArtifact.maximumDocumentBytes
    ) {
      return yield* integrityFailure(
        contentId,
        "The retained Client Content identity or bounded length does not match",
      );
    }
    return metadata satisfies StoredArtifactMetadata;
  });

const readBytes = (bucket: R2Bucket, metadata: StoredArtifactMetadata) =>
  Effect.gen(function* () {
    const content = metadata.artifact.content;
    const object = yield* attempt("readBytes", () => bucket.get(contentKeyFor(content.contentId)));
    if (object === null) {
      return yield* integrityFailure(content.contentId, "The retained Client Content is missing");
    }
    if (object.size > DocumentArtifact.maximumDocumentBytes || object.size !== content.byteLength) {
      return yield* integrityFailure(
        content.contentId,
        "The retained Client Content exceeds or differs from its trusted length",
      );
    }
    const bytes = new Uint8Array(yield* attempt("readBytes", () => object.arrayBuffer()));
    const parsed = yield* DocumentArtifact.parse(
      content.contentId,
      metadata.format,
      bytes,
      metadata.artifact.artifactRole.pageCount,
    ).pipe(
      Effect.mapError(
        () =>
          new ArtifactIntegrityFailure({
            contentId: content.contentId,
            message: "The retained Client Content bytes are invalid",
          }),
      ),
    );
    if (
      parsed.content.sha256 !== content.sha256 ||
      parsed.content.byteLength !== content.byteLength ||
      parsed.content.mediaType !== content.mediaType ||
      parsed.artifactRole.pageCount !== metadata.artifact.artifactRole.pageCount
    ) {
      return yield* integrityFailure(
        content.contentId,
        "The retained Client Content digest does not match",
      );
    }
    return bytes;
  });

const encodeMetadata = (stored: StoredArtifact) =>
  Schema.encodeSync(Metadata)({
    allowancePeriodId: stored.allowancePeriodId,
    artifact: stored.artifact,
    cost: stored.cost,
    format: stored.format,
    intentDigest: stored.intentDigest,
    owner: stored.owner,
    userId: stored.userId,
  });

const attempt = <A>(
  operation: "delete" | "inspect" | "put" | "readBytes",
  effect: () => Promise<A>,
): Effect.Effect<A, ArtifactStoreUnavailable> =>
  Effect.tryPromise({
    try: effect,
    catch: (cause) =>
      new ArtifactStoreUnavailable({
        cause,
        message: `R2 could not ${operation} the generated document`,
        operation,
      }),
  });

const integrityFailure = (contentId: ContentId, message: string) =>
  Effect.fail(new ArtifactIntegrityFailure({ contentId, message }));

const sameStoredArtifact = (left: StoredArtifactMetadata, right: StoredArtifactMetadata) =>
  left.artifact.content.sha256 === right.artifact.content.sha256 &&
  left.intentDigest === right.intentDigest &&
  left.userId === right.userId &&
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
