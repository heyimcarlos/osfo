import { PDFDocument } from "pdf-lib";
import { Effect, Schema } from "effect";
import { strFromU8, unzipSync } from "fflate";

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

/** Parse and describe one bounded generated artifact before it can be retained. */
export const parse = (
  contentId: ContentId,
  format: DocumentFormat,
  bytes: Uint8Array,
  expectedPageCount: number,
): Effect.Effect<ArtifactRef, InvalidGeneratedArtifact> =>
  Effect.gen(function* () {
    if (bytes.byteLength === 0 || bytes.byteLength > maximumDocumentBytes) {
      return yield* invalid(contentId, "byteLimit", "The generated document exceeds 5 MB");
    }
    const pageCount = yield* format === "pdf"
      ? parsePdfPageCount(contentId, bytes)
      : parseDocxPageCount(contentId, bytes);
    if (pageCount === 0 || pageCount > maximumDocumentPages) {
      return yield* invalid(contentId, "pageLimit", "The generated document exceeds 20 pages");
    }
    if (pageCount !== expectedPageCount) {
      return yield* invalid(
        contentId,
        "invalidDocument",
        "The generated document page count does not match its bounded source",
      );
    }
    const hash = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    );
    return ArtifactRef.make({
      artifactRole: { _tag: "GeneratedDocumentV1", format, pageCount },
      content: {
        byteLength: bytes.byteLength,
        contentId,
        mediaType:
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sha256: bytesToHex(new Uint8Array(hash)),
      },
    });
  });

const invalid = (
  contentId: ContentId,
  reason: "byteLimit" | "invalidDocument" | "pageLimit",
  message: string,
) => Effect.fail(new InvalidGeneratedArtifact({ contentId, message, reason }));

const parsePdfPageCount = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- pdf-lib exposes a Promise boundary.
    try: async () => (await PDFDocument.load(bytes)).getPageCount(),
    catch: () =>
      new InvalidGeneratedArtifact({
        contentId,
        message: "Disposable compute returned an invalid PDF",
        reason: "invalidDocument",
      }),
  });

const parseDocxPageCount = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.gen(function* () {
    let selectedBytes = 0;
    const required = new Set([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "word/_rels/document.xml.rels",
      "word/document.xml",
    ]);
    const entries = yield* Effect.try({
      try: () =>
        unzipSync(bytes, {
          filter: (entry) => {
            if (!required.has(entry.name)) return false;
            selectedBytes += entry.originalSize;
            return selectedBytes <= 20_000_000;
          },
        }),
      catch: () =>
        new InvalidGeneratedArtifact({
          contentId,
          message: "Disposable compute returned an invalid DOCX package",
          reason: "invalidDocument",
        }),
    });
    const contentTypes = entries["[Content_Types].xml"];
    const packageRelationships = entries["_rels/.rels"];
    const properties = entries["docProps/app.xml"];
    const documentRelationships = entries["word/_rels/document.xml.rels"];
    const document = entries["word/document.xml"];
    if (
      contentTypes === undefined ||
      packageRelationships === undefined ||
      properties === undefined ||
      documentRelationships === undefined ||
      document === undefined
    ) {
      return yield* invalid(
        contentId,
        "invalidDocument",
        "DOCX is missing a required package part",
      );
    }
    if (
      !strFromU8(contentTypes).includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ) ||
      !strFromU8(packageRelationships).includes(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      ) ||
      !strFromU8(packageRelationships).includes("word/document.xml") ||
      !strFromU8(documentRelationships).includes("<Relationships") ||
      !strFromU8(document).includes("<w:document")
    ) {
      return yield* invalid(
        contentId,
        "invalidDocument",
        "DOCX package does not contain a Word document",
      );
    }
    const documentXml = strFromU8(document);
    const match = /<Pages>\s*([1-9]\d*)\s*<\/Pages>/u.exec(strFromU8(properties));
    const pageCount = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(pageCount)) {
      return yield* invalid(
        contentId,
        "invalidDocument",
        "DOCX does not contain a trusted page count",
      );
    }
    const explicitPageCount =
      1 + (documentXml.match(/<w:br\b[^>]*w:type=["']page["'][^>]*\/?\s*>/gu)?.length ?? 0);
    if (explicitPageCount !== pageCount) {
      return yield* invalid(
        contentId,
        "invalidDocument",
        "DOCX page metadata does not match its explicit page breaks",
      );
    }
    return pageCount;
  });

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
