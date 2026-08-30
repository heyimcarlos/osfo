import { Effect, Schema } from "effect";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { AllowancePeriodId, UserId } from "../../domain";
import type { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import { QualificationContext } from "../../domain/qualification-context";
import { DocumentArtifactValidation } from "./document-artifact-validation";
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
import { attemptKeyFor, contentKeyFor, ownerKeyFor } from "./document-storage-keys";
import { DocumentOwnershipIndex } from "./document-ownership-index";

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
    qualificationContext: Schema.optionalKey(QualificationContext),
    retention: Schema.Literals(["accounted", "pending"]),
    userId: UserId,
  }),
);

/** Construct immutable generated-document storage over one R2 bucket binding. */
export const make = (bucket: R2Bucket): ArtifactStore => ({
  account: (contentId) =>
    Effect.gen(function* () {
      const object = yield* attempt("inspect", () => bucket.head(contentKeyFor(contentId)));
      if (object === null) {
        return yield* integrityFailure(contentId, "Pending retained Client Content is missing");
      }
      const metadata = yield* decodeMetadata(object, contentId);
      if (metadata.retention === "accounted") return undefined;
      const body = yield* attempt("readBytes", () => bucket.get(contentKeyFor(contentId)));
      if (body === null || body.size !== metadata.artifact.content.byteLength) {
        return yield* integrityFailure(
          contentId,
          "Pending retained Client Content is missing or changed",
        );
      }
      const bytes = new Uint8Array(yield* attempt("readBytes", () => body.arrayBuffer()));
      const accounted = yield* attempt("account", () =>
        bucket.put(contentKeyFor(contentId), bytes, {
          customMetadata: {
            ...qualificationMetadata(metadata),
            osfo: encodeMetadata({
              ...metadata,
              bytes,
              retention: "accounted",
            }),
          },
          httpMetadata: { contentType: metadata.artifact.content.mediaType },
          onlyIf: { etagMatches: object.etag },
          sha256: hexToBytes(metadata.artifact.content.sha256),
        }),
      );
      if (accounted === null) {
        const current = yield* attempt("inspect", () => bucket.head(contentKeyFor(contentId)));
        if (current === null) {
          return yield* integrityFailure(contentId, "Pending retained Client Content is missing");
        }
        const currentMetadata = yield* decodeMetadata(current, contentId);
        if (
          currentMetadata.retention !== "accounted" ||
          !sameStoredArtifact(currentMetadata, metadata)
        ) {
          return yield* integrityFailure(
            contentId,
            "Retained Client Content accounting did not complete",
          );
        }
      } else {
        const currentMetadata = yield* decodeMetadata(accounted, contentId);
        if (
          currentMetadata.retention !== "accounted" ||
          !sameStoredArtifact(currentMetadata, metadata)
        ) {
          return yield* integrityFailure(
            contentId,
            "Retained Client Content accounting returned changed authority",
          );
        }
      }
      return undefined;
    }),
  delete: (metadata) =>
    attempt("delete", () =>
      bucket.delete([
        contentKeyFor(metadata.artifact.content.contentId),
        attemptKeyFor(metadata.artifact.content.contentId),
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
      yield* attempt("put", () =>
        DocumentOwnershipIndex.ensure(bucket, stored.userId, content.contentId),
      );
      const result = yield* attempt("put", () =>
        bucket.put(contentKeyFor(content.contentId), stored.bytes, {
          customMetadata: {
            ...qualificationMetadata(stored),
            osfo: encodeMetadata(stored),
          },
          httpMetadata: { contentType: content.mediaType },
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: hexToBytes(content.sha256),
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
      } else {
        yield* decodeMetadata(result, content.contentId);
      }
      return undefined;
    }),
  readBytes: (metadata) => readBytes(bucket, metadata),
});

/** Delete only pending artifact bytes; attempt and ownership evidence have an independent lifecycle. */
export const deletePendingBytes = (bucket: R2Bucket, contentId: ContentId) =>
  attempt("delete", () => bucket.delete(contentKeyFor(contentId))).pipe(Effect.asVoid);

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
    if (!qualificationObjectMatches(object, metadata)) {
      return yield* integrityFailure(
        contentId,
        "The retained Client Content qualification identity or SHA-256 does not match",
      );
    }
    return metadata satisfies StoredArtifactMetadata;
  });

const readBytes = (bucket: R2Bucket, metadata: StoredArtifactMetadata) =>
  Effect.gen(function* () {
    if (metadata.retention !== "accounted") {
      return yield* integrityFailure(
        metadata.artifact.content.contentId,
        "Retained Client Content allowance evidence is not complete",
      );
    }
    if (metadata.artifact.artifactRole._tag !== "GeneratedDocumentV1") {
      return yield* integrityFailure(
        metadata.artifact.content.contentId,
        "The retained Client Content is not a generated document",
      );
    }
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
    const parsed = yield* DocumentArtifactValidation.validate(
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
      parsed.artifactRole._tag !== "GeneratedDocumentV1" ||
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
    ...qualificationContextFields(stored.qualificationContext),
    retention: stored.retention,
    userId: stored.userId,
  });

const attempt = <A>(
  operation: "account" | "delete" | "inspect" | "put" | "readBytes",
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
  sameQualificationContext(left.qualificationContext, right.qualificationContext) &&
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

const qualificationMetadata = (stored: StoredArtifactMetadata) => {
  const context = stored.qualificationContext;
  if (context === undefined) return {};
  return {
    "osfo-sha256": stored.artifact.content.sha256,
    osfoAttemptId: context.attemptId,
    osfoExecutionId: context.executionId,
    osfoObjectId: stored.artifact.content.contentId,
    osfoPlanChecksum: context.planChecksum,
    osfoRootId: context.rootId,
    osfoRunId: context.runId,
  };
};

const qualificationContextFields = (
  qualificationContext: StoredArtifactMetadata["qualificationContext"],
) => (qualificationContext === undefined ? {} : { qualificationContext });

const qualificationObjectMatches = (object: R2Object, stored: StoredArtifactMetadata) => {
  const context = stored.qualificationContext;
  if (context === undefined) return true;
  const metadata = object.customMetadata;
  return (
    object.checksums.sha256 !== undefined &&
    bytesToHex(new Uint8Array(object.checksums.sha256)) === stored.artifact.content.sha256 &&
    metadata?.["osfo-sha256"] === stored.artifact.content.sha256 &&
    metadata.osfoAttemptId === context.attemptId &&
    metadata.osfoExecutionId === context.executionId &&
    metadata.osfoObjectId === stored.artifact.content.contentId &&
    metadata.osfoPlanChecksum === context.planChecksum &&
    metadata.osfoRootId === context.rootId &&
    metadata.osfoRunId === context.runId
  );
};

const sameQualificationContext = (
  left: StoredArtifactMetadata["qualificationContext"],
  right: StoredArtifactMetadata["qualificationContext"],
) =>
  left === undefined || right === undefined
    ? left === right
    : left.attemptId === right.attemptId &&
      left.executionId === right.executionId &&
      left.journey === right.journey &&
      left.offeredAtEpochMs === right.offeredAtEpochMs &&
      left.planChecksum === right.planChecksum &&
      left.region === right.region &&
      left.rootId === right.rootId &&
      left.runId === right.runId;

export * as DocumentArtifacts from "./document-artifacts";
