import { PDFDocument } from "pdf-lib";
import { Effect, Schema } from "effect";
import { strFromU8, unzipSync } from "fflate";

/** Maximum byte length of one generated document. */
export const maximumDocumentBytes = 5_000_000;

/** Maximum page count of one generated document. */
export const maximumDocumentPages = 20;

/** Stable identity derived from the ToolCall or Workflow that owns an artifact. */
export const ArtifactId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("ArtifactId"),
);

/** Stable identity derived from the ToolCall or Workflow that owns an artifact. */
export type ArtifactId = typeof ArtifactId.Type;

/** Supported generated document formats. */
export const DocumentFormat = Schema.Literals(["pdf", "docx"]);

/** Supported generated document formats. */
export type DocumentFormat = typeof DocumentFormat.Type;

/** Trusted metadata for one validated immutable artifact. */
export const Artifact = Schema.Struct({
  artifactId: ArtifactId,
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  mediaType: Schema.Literals([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  pageCount: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

/** Trusted metadata for one validated immutable artifact. */
export type Artifact = typeof Artifact.Type;

/** Expected failure when disposable compute returns an unsafe or invalid artifact. */
export class InvalidGeneratedArtifact extends Schema.TaggedError<InvalidGeneratedArtifact>()(
  "InvalidGeneratedArtifact",
  {
    artifactId: ArtifactId,
    message: Schema.String,
    reason: Schema.Literals(["byteLimit", "invalidDocument", "pageLimit"]),
  },
) {}

/** Parse and describe one bounded generated artifact before it can be retained. */
export const parse = (
  artifactId: ArtifactId,
  format: DocumentFormat,
  bytes: Uint8Array,
): Effect.Effect<Artifact, InvalidGeneratedArtifact> =>
  Effect.gen(function* () {
    if (bytes.byteLength === 0 || bytes.byteLength > maximumDocumentBytes) {
      return yield* invalid(artifactId, "byteLimit", "The generated document exceeds 5 MB");
    }
    const pageCount = yield* format === "pdf"
      ? parsePdfPageCount(artifactId, bytes)
      : parseDocxPageCount(artifactId, bytes);
    if (pageCount === 0 || pageCount > maximumDocumentPages) {
      return yield* invalid(artifactId, "pageLimit", "The generated document exceeds 20 pages");
    }
    const hash = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    );
    return Artifact.make({
      artifactId,
      byteLength: bytes.byteLength,
      mediaType:
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pageCount,
      sha256: bytesToHex(new Uint8Array(hash)),
    });
  });

const invalid = (
  artifactId: ArtifactId,
  reason: "byteLimit" | "invalidDocument" | "pageLimit",
  message: string,
) => Effect.fail(new InvalidGeneratedArtifact({ artifactId, message, reason }));

const parsePdfPageCount = (artifactId: ArtifactId, bytes: Uint8Array) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- pdf-lib exposes a Promise boundary.
    try: async () => (await PDFDocument.load(bytes)).getPageCount(),
    catch: () =>
      new InvalidGeneratedArtifact({
        artifactId,
        message: "Disposable compute returned an invalid PDF",
        reason: "invalidDocument",
      }),
  });

const parseDocxPageCount = (artifactId: ArtifactId, bytes: Uint8Array) =>
  Effect.gen(function* () {
    let selectedBytes = 0;
    const required = new Set(["[Content_Types].xml", "docProps/app.xml", "word/document.xml"]);
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
          artifactId,
          message: "Disposable compute returned an invalid DOCX package",
          reason: "invalidDocument",
        }),
    });
    const contentTypes = entries["[Content_Types].xml"];
    const properties = entries["docProps/app.xml"];
    const document = entries["word/document.xml"];
    if (contentTypes === undefined || properties === undefined || document === undefined) {
      return yield* invalid(
        artifactId,
        "invalidDocument",
        "DOCX is missing a required package part",
      );
    }
    if (
      !strFromU8(contentTypes).includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ) ||
      !strFromU8(document).includes("<w:document")
    ) {
      return yield* invalid(
        artifactId,
        "invalidDocument",
        "DOCX package does not contain a Word document",
      );
    }
    const match = /<Pages>\s*([1-9]\d*)\s*<\/Pages>/u.exec(strFromU8(properties));
    const pageCount = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(pageCount)) {
      return yield* invalid(
        artifactId,
        "invalidDocument",
        "DOCX does not contain a trusted page count",
      );
    }
    return pageCount;
  });

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
