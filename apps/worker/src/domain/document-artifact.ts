import { Effect, Schema } from "effect";

import { ClientContentRefV1, ContentId } from "./client-content";

/* oxlint-disable eslint/no-underscore-dangle -- Domain owners and roles use tagged unions. */

export const maximumDocumentBytes = 5_000_000;
export const maximumDocumentPages = 20;
export const maximumPresentationBytes = 20_000_000;
export const maximumPresentationSlides = 20;
export const maximumImageBytes = 10_000_000;
export const maximumImagePixelsPerEdge = 2_048;

const ownerIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);

/** Existing product identity that owns one generated artifact and its Usage evidence. */
export const DocumentOwner = Schema.Union([
  Schema.TaggedStruct("ToolCall", { toolCallId: ownerIdentity }),
  Schema.TaggedStruct("Workflow", { workflowId: ownerIdentity }),
]);

export type DocumentOwner = typeof DocumentOwner.Type;

export const sameOwner = (left: DocumentOwner, right: DocumentOwner) =>
  left._tag === right._tag &&
  (left._tag === "ToolCall" && right._tag === "ToolCall"
    ? left.toolCallId === right.toolCallId
    : left._tag === "Workflow" &&
      right._tag === "Workflow" &&
      left.workflowId === right.workflowId);

export const DocumentFormat = Schema.Literals(["pdf", "docx"]);
export type DocumentFormat = typeof DocumentFormat.Type;

export const ArtifactFormat = Schema.Literals(["pdf", "docx", "pptx", "png"]);
export type ArtifactFormat = typeof ArtifactFormat.Type;

export const ArtifactKind = Schema.Literals(["pdf", "docx", "pptx", "image", "diagram"]);
export type ArtifactKind = typeof ArtifactKind.Type;

export const ArtifactLineage = Schema.Struct({
  sourceContentId: Schema.NullOr(ContentId),
});
export type ArtifactLineage = typeof ArtifactLineage.Type;

const GeneratedDocumentRole = Schema.TaggedStruct("GeneratedDocumentV1", {
  format: DocumentFormat,
  pageCount: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumDocumentPages),
  ),
});

const GeneratedPresentationRole = Schema.TaggedStruct("GeneratedPresentationV1", {
  format: Schema.Literal("pptx"),
  slideCount: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumPresentationSlides),
  ),
});

const GeneratedImageRole = Schema.TaggedStruct("GeneratedImageV1", {
  format: Schema.Literal("png"),
  height: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumImagePixelsPerEdge),
  ),
  width: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumImagePixelsPerEdge),
  ),
});

const GeneratedDiagramRole = Schema.TaggedStruct("GeneratedDiagramV1", {
  format: Schema.Literal("png"),
  height: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumImagePixelsPerEdge),
  ),
  width: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumImagePixelsPerEdge),
  ),
});

/** Immutable generated-artifact interpretation of one Client Content reference. */
export const ArtifactRef = Schema.Struct({
  artifactRole: Schema.Union([
    GeneratedDocumentRole,
    GeneratedPresentationRole,
    GeneratedImageRole,
    GeneratedDiagramRole,
  ]),
  content: ClientContentRefV1,
  lineage: ArtifactLineage.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ sourceContentId: null })),
  ),
});

export type ArtifactRef = typeof ArtifactRef.Type;

/** Absolute retained-byte bound for one decoded artifact role. */
export const maximumBytesForRole = (role: ArtifactRef["artifactRole"]) =>
  role._tag === "GeneratedDocumentV1"
    ? maximumDocumentBytes
    : role._tag === "GeneratedPresentationV1"
      ? maximumPresentationBytes
      : maximumImageBytes;

export const InvalidArtifactReason = Schema.Literals([
  "byteLimit",
  "invalidArtifact",
  "invalidDocument",
  "pageLimit",
  "pixelLimit",
  "slideLimit",
  "visualInspectionFailed",
]);
export type InvalidArtifactReason = typeof InvalidArtifactReason.Type;

export class InvalidGeneratedArtifact extends Schema.TaggedError<InvalidGeneratedArtifact>()(
  "InvalidGeneratedArtifact",
  {
    contentId: ContentId,
    message: Schema.String,
    reason: InvalidArtifactReason,
  },
) {}

/** Make a verified document reference. Retained callers keep this compatibility entry point. */
export const make = (
  contentId: ContentId,
  format: DocumentFormat,
  byteLength: number,
  pageCount: number,
  sha256: string,
  sourceContentId: ContentId | null = null,
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
            lineage: { sourceContentId },
          }),
        );

export const makePresentation = (
  contentId: ContentId,
  byteLength: number,
  slideCount: number,
  sha256: string,
  sourceContentId: ContentId | null,
): Effect.Effect<ArtifactRef, InvalidGeneratedArtifact> =>
  byteLength === 0 || byteLength > maximumPresentationBytes
    ? invalid(contentId, "byteLimit", "The generated presentation exceeds 20 MB")
    : slideCount === 0 || slideCount > maximumPresentationSlides
      ? invalid(contentId, "slideLimit", "The generated presentation exceeds 20 slides")
      : Effect.succeed(
          ArtifactRef.make({
            artifactRole: { _tag: "GeneratedPresentationV1", format: "pptx", slideCount },
            content: {
              byteLength,
              contentId,
              mediaType:
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              sha256,
            },
            lineage: { sourceContentId },
          }),
        );

export const makeVisual = (
  contentId: ContentId,
  kind: "image" | "diagram",
  byteLength: number,
  width: number,
  height: number,
  sha256: string,
  sourceContentId: ContentId | null = null,
): Effect.Effect<ArtifactRef, InvalidGeneratedArtifact> =>
  byteLength === 0 || byteLength > maximumImageBytes
    ? invalid(contentId, "byteLimit", "The generated visual exceeds 10 MB")
    : width === 0 ||
        height === 0 ||
        width > maximumImagePixelsPerEdge ||
        height > maximumImagePixelsPerEdge
      ? invalid(contentId, "pixelLimit", "The generated visual exceeds 2048 pixels per edge")
      : Effect.succeed(
          ArtifactRef.make({
            artifactRole:
              kind === "image"
                ? { _tag: "GeneratedImageV1", format: "png", height, width }
                : { _tag: "GeneratedDiagramV1", format: "png", height, width },
            content: {
              byteLength,
              contentId,
              mediaType: "image/png",
              sha256,
            },
            lineage: { sourceContentId },
          }),
        );

export const invalid = (contentId: ContentId, reason: InvalidArtifactReason, message: string) =>
  Effect.fail(new InvalidGeneratedArtifact({ contentId, message, reason }));

export const kindOf = (artifact: ArtifactRef): ArtifactKind => {
  switch (artifact.artifactRole._tag) {
    case "GeneratedDocumentV1":
      return artifact.artifactRole.format;
    case "GeneratedPresentationV1":
      return "pptx";
    case "GeneratedImageV1":
      return "image";
    case "GeneratedDiagramV1":
      return "diagram";
    default:
      return artifact.artifactRole satisfies never;
  }
};

export * as DocumentArtifact from "./document-artifact";
