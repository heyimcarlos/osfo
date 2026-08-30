import { bytesToHex } from "@noble/hashes/utils.js";
import { Effect, Schema } from "effect";

import type { ContentId } from "../../domain/client-content";
import { sameQualificationContext } from "../../domain/qualification-context";
import type { DocumentBuild } from "../../services/document-build";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import { DocumentArtifacts } from "./document-artifacts";
import { contentKeyFor, qualificationReceiptKeyFor } from "./document-storage-keys";

/* oxlint-disable eslint/no-underscore-dangle, typescript/consistent-return -- Durable authority unions use _tag and generator failure branches exit through Effect. */

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Immutable index joining final Document Build PostgreSQL truth to the actual R2 object. */
export const QualificationDocumentObjectReceipt = Schema.Struct({
  accountedMetadataSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  artifactChecksum: identity,
  artifactId: identity,
  attemptId: identity,
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  contentSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  etag: identity,
  executionId: identity,
  mediaType: identity,
  objectId: identity,
  objectKey: identity,
  objectVersion: identity,
  planChecksum: identity,
  rootId: identity,
  runId: identity,
  storageClass: Schema.String,
  uploadedAtUtc: Schema.String,
  workflowId: identity,
});
export type QualificationDocumentObjectReceipt = typeof QualificationDocumentObjectReceipt.Type;

export class QualificationDocumentAuthorityUnavailable extends Schema.TaggedError<QualificationDocumentAuthorityUnavailable>()(
  "QualificationDocumentAuthorityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Retain one create-or-identical post-accounting index before PostgreSQL terminal success. */
export const retain = (
  bucket: Pick<R2Bucket, "get" | "head" | "put">,
  build: Pick<
    DocumentBuild.Record,
    "artifactContentId" | "qualificationContext" | "request" | "state" | "workflowId"
  >,
  contentId: ContentId,
) =>
  Effect.gen(function* () {
    const context = build.qualificationContext;
    if (context === undefined) return undefined;
    if (
      context.journey !== "documentBuild" ||
      (build.state !== "publication_committed" && build.state !== "success") ||
      build.artifactContentId !== contentId ||
      contentId !== `document:workflow:${build.workflowId}`
    ) {
      return yield* unavailable("Document Build publication authority is incomplete");
    }
    const object = yield* request(() => bucket.head(contentKeyFor(contentId)));
    if (object === null) return yield* unavailable("The final Document Build object is absent");
    const sha256 = object.checksums.sha256;
    const objectMetadata = object.customMetadata;
    if (
      sha256 === undefined ||
      objectMetadata?.osfoAttemptId !== context.attemptId ||
      objectMetadata.osfoExecutionId !== context.executionId ||
      objectMetadata.osfoObjectId !== contentId ||
      objectMetadata.osfoPlanChecksum !== context.planChecksum ||
      objectMetadata.osfoRootId !== context.rootId ||
      objectMetadata.osfoRunId !== context.runId ||
      objectMetadata["osfo-sha256"] !== bytesToHex(new Uint8Array(sha256))
    ) {
      return yield* unavailable("The final Document Build object authority conflicts");
    }
    const stored = yield* DocumentArtifacts.decodeStoredArtifactMetadata(object, contentId).pipe(
      Effect.mapError(
        (cause) =>
          new QualificationDocumentAuthorityUnavailable({
            cause,
            message: "The final Document Build encoded object metadata conflicts",
          }),
      ),
    );
    if (
      stored.retention !== "accounted" ||
      stored.format !== build.request.format ||
      stored.artifact.content.mediaType !==
        (build.request.format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
      !sameQualificationContext(stored.qualificationContext, context) ||
      stored.owner._tag !== "Workflow" ||
      stored.owner.workflowId !== build.workflowId
    ) {
      return yield* unavailable("The final Document Build encoded authority is not accounted");
    }
    const artifactId = qualificationReceiptKeyFor(context.executionId, context.runId, contentId);
    const accountedMetadataSha256 = yield* Effect.promise(() =>
      sha256Hex(objectMetadata.osfo ?? ""),
    );
    const content = {
      accountedMetadataSha256,
      artifactId,
      attemptId: context.attemptId,
      byteLength: object.size,
      contentSha256: objectMetadata["osfo-sha256"],
      etag: object.etag,
      executionId: context.executionId,
      mediaType: stored.artifact.content.mediaType,
      objectId: contentId,
      objectKey: object.key,
      objectVersion: object.version,
      planChecksum: context.planChecksum,
      rootId: context.rootId,
      runId: context.runId,
      storageClass: object.storageClass,
      uploadedAtUtc: object.uploaded.toISOString(),
      workflowId: build.workflowId,
    };
    const receipt = QualificationDocumentObjectReceipt.make({
      ...content,
      artifactChecksum: qualificationChecksum(content),
    });
    const encoded = yield* Schema.encodeEffect(
      Schema.fromJsonString(QualificationDocumentObjectReceipt),
    )(receipt).pipe(Effect.orDie);
    const bodySha256 = yield* Effect.promise(() => sha256Hex(encoded));
    const receiptMetadata = {
      "osfo-artifact-checksum": receipt.artifactChecksum,
      "osfo-body-sha256": bodySha256,
      "osfo-execution-id": context.executionId,
      "osfo-kind": "qualification-document-object-receipt-v1",
      "osfo-object-id": contentId,
      "osfo-plan-checksum": context.planChecksum,
      "osfo-root-id": context.rootId,
      "osfo-run-id": context.runId,
    };
    const written = yield* request(() =>
      bucket.put(artifactId, encoded, {
        customMetadata: receiptMetadata,
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    );
    if (written !== null) return undefined;
    const existing = yield* request(() => bucket.get(artifactId));
    if (
      existing === null ||
      (yield* request(() => existing.text())) !== encoded ||
      Object.entries(receiptMetadata).some(
        ([key, value]) => existing.customMetadata?.[key] !== value,
      )
    ) {
      return yield* unavailable("The Document Build qualification index conflicts");
    }
  });

const request = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new QualificationDocumentAuthorityUnavailable({
        cause,
        message: "R2 qualification authority is unavailable",
      }),
  });

const unavailable = (message: string) =>
  Effect.fail(new QualificationDocumentAuthorityUnavailable({ cause: message, message }));

const sha256Hex = (value: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => bytesToHex(new Uint8Array(digest)));

export * as DocumentQualificationAuthority from "./document-qualification-authority";
