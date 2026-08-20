import { Effect, Schema } from "effect";

import { ClientContentRefV1, ContentId } from "./client-content";

/* oxlint-disable eslint/no-underscore-dangle -- Domain owners use the _tag discriminator. */

/** Maximum byte length of one generated document. */
export const maximumDocumentBytes = 5_000_000;

/** Maximum page count of one generated document. */
export const maximumDocumentPages = 20;

const ownerIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);

/** Existing product identity that owns one generated artifact and its allowance use. */
export const DocumentOwner = Schema.Union([
  Schema.TaggedStruct("ToolCall", { toolCallId: ownerIdentity }),
  Schema.TaggedStruct("Workflow", { workflowId: ownerIdentity }),
]);

/** Existing product identity that owns one generated artifact and its allowance use. */
export type DocumentOwner = typeof DocumentOwner.Type;

/** Test whether two document owners name the same existing product identity. */
export const sameOwner = (left: DocumentOwner, right: DocumentOwner) =>
  left._tag === right._tag &&
  (left._tag === "ToolCall" && right._tag === "ToolCall"
    ? left.toolCallId === right.toolCallId
    : left._tag === "Workflow" &&
      right._tag === "Workflow" &&
      left.workflowId === right.workflowId);

/** Supported generated document formats. */
export const DocumentFormat = Schema.Literals(["pdf", "docx"]);

/** Supported generated document formats. */
export type DocumentFormat = typeof DocumentFormat.Type;

/** Immutable generated-document interpretation of one Client Content reference. */
export const ArtifactRef = Schema.Struct({
  artifactRole: Schema.TaggedStruct("GeneratedDocumentV1", {
    format: DocumentFormat,
    pageCount: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(maximumDocumentPages),
    ),
  }),
  content: ClientContentRefV1,
});

/** Immutable generated-document interpretation of one Client Content reference. */
export type ArtifactRef = typeof ArtifactRef.Type;

/** Expected failure when disposable compute returns an unsafe or invalid artifact. */
export class InvalidGeneratedArtifact extends Schema.TaggedError<InvalidGeneratedArtifact>()(
  "InvalidGeneratedArtifact",
  {
    contentId: ContentId,
    message: Schema.String,
    reason: Schema.Literals(["byteLimit", "invalidDocument", "pageLimit"]),
  },
) {}

/** Make the domain reference after an adapter verifies the byte sequence. */
export const make = (
  contentId: ContentId,
  format: DocumentFormat,
  byteLength: number,
  pageCount: number,
  sha256: string,
): Effect.Effect<ArtifactRef, InvalidGeneratedArtifact> =>
  byteLength === 0 || byteLength > maximumDocumentBytes
    ? invalid(contentId, "byteLimit", "The generated document exceeds 5 MB")
    : pageCount === 0 || pageCount > maximumDocumentPages
      ? invalid(contentId, "pageLimit", "The generated document exceeds 20 pages")
      : Effect.succeed(
          ArtifactRef.make({
            artifactRole: { _tag: "GeneratedDocumentV1", format, pageCount },
            content: {
              byteLength,
              contentId,
              mediaType:
                format === "pdf"
                  ? "application/pdf"
                  : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              sha256,
            },
          }),
        );

/** Construct one invalid generated-artifact failure. */
export const invalid = (
  contentId: ContentId,
  reason: "byteLimit" | "invalidDocument" | "pageLimit",
  message: string,
) => Effect.fail(new InvalidGeneratedArtifact({ contentId, message, reason }));

export * as DocumentArtifact from "./document-artifact";
