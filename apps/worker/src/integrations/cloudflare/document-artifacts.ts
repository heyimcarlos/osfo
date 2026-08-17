import { Effect, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import * as DocumentArtifact from "../../domain/document-artifact";
import {
  ArtifactIntegrityFailure,
  ArtifactStoreUnavailable,
  DocumentIntentDigest,
  DocumentIntentConflict,
  type ArtifactStore,
  type CostEvidence,
  type StoredArtifact,
} from "../../services/document-generation";

/* oxlint-disable eslint/no-underscore-dangle -- Persisted unions use the _tag discriminator. */

const Metadata = Schema.fromJsonString(
  Schema.Struct({
    allowancePeriodId: AllowancePeriodId,
    artifact: DocumentArtifact.Artifact,
    cost: Schema.Union([
      Schema.TaggedStruct("ProvenNoUse", {}),
      Schema.TaggedStruct("Incurred", {
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

type Metadata = typeof Metadata.Type;

/** Construct immutable generated-document storage over one R2 bucket binding. */
export const make = (bucket: R2Bucket): ArtifactStore => ({
  delete: (artifactId) =>
    attempt("delete", () => bucket.delete(keyFor(artifactId))).pipe(Effect.asVoid),
  get: (artifactId) => read(bucket, artifactId),
  put: (stored) =>
    Effect.gen(function* () {
      const result = yield* attempt("put", () =>
        bucket.put(keyFor(stored.artifact.artifactId), stored.bytes, {
          customMetadata: { osfo: encodeMetadata(stored) },
          httpMetadata: { contentType: stored.artifact.mediaType },
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: stored.artifact.sha256,
        }),
      );
      if (result === null) {
        const existing = yield* read(bucket, stored.artifact.artifactId);
        if (existing === null || !sameStoredArtifact(existing, stored)) {
          return yield* new DocumentIntentConflict({
            artifactId: stored.artifact.artifactId,
            message: "R2 already contains a different artifact for the owning identity",
          });
        }
      }
      return undefined;
    }),
});

const read = (bucket: R2Bucket, artifactId: DocumentArtifact.ArtifactId) =>
  Effect.gen(function* () {
    const object = yield* attempt("get", () => bucket.get(keyFor(artifactId)));
    if (object === null) return null;
    const encoded = object.customMetadata?.osfo;
    if (encoded === undefined) {
      return yield* integrityFailure(artifactId, "The retained artifact has no Osfo metadata");
    }
    const metadata = yield* Schema.decodeEffect(Metadata)(encoded).pipe(
      Effect.mapError(
        () =>
          new ArtifactIntegrityFailure({
            artifactId,
            message: "The retained artifact metadata is invalid",
          }),
      ),
    );
    if (metadata.artifact.artifactId !== artifactId) {
      return yield* integrityFailure(artifactId, "The retained artifact identity does not match");
    }
    const bytes = new Uint8Array(yield* attempt("get", () => object.arrayBuffer()));
    const parsed = yield* DocumentArtifact.parse(
      artifactId,
      metadata.format,
      bytes,
      metadata.artifact.pageCount,
    ).pipe(
      Effect.mapError(
        () =>
          new ArtifactIntegrityFailure({
            artifactId,
            message: "The retained artifact bytes are invalid",
          }),
      ),
    );
    if (
      parsed.sha256 !== metadata.artifact.sha256 ||
      parsed.byteLength !== metadata.artifact.byteLength ||
      parsed.mediaType !== metadata.artifact.mediaType ||
      parsed.pageCount !== metadata.artifact.pageCount
    ) {
      return yield* integrityFailure(artifactId, "The retained artifact digest does not match");
    }
    return {
      allowancePeriodId: metadata.allowancePeriodId,
      artifact: parsed,
      bytes,
      cost: metadata.cost,
      format: metadata.format,
      intentDigest: metadata.intentDigest,
      owner: metadata.owner,
      userId: metadata.userId,
    } satisfies StoredArtifact;
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

const keyFor = (artifactId: DocumentArtifact.ArtifactId) =>
  `generated-documents/${Array.from(new TextEncoder().encode(artifactId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

const attempt = <A>(
  operation: "delete" | "get" | "put",
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

const integrityFailure = (artifactId: DocumentArtifact.ArtifactId, message: string) =>
  Effect.fail(new ArtifactIntegrityFailure({ artifactId, message }));

const sameStoredArtifact = (left: StoredArtifact, right: StoredArtifact) =>
  left.artifact.sha256 === right.artifact.sha256 &&
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
      left.basis === right.basis &&
      left.providerOperationId === right.providerOperationId &&
      left.usdMicros === right.usdMicros);
