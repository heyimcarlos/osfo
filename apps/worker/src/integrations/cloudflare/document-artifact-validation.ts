import { PDFDocument } from "pdf-lib";
import { Effect } from "effect";
import { strFromU8, unzipSync } from "fflate";

import type { ContentId } from "../../domain/client-content";
import * as DocumentArtifact from "../../domain/document-artifact";

/** Validate disposable or retained bytes with document parsers owned by this adapter. */
export const validate = (
  contentId: ContentId,
  format: DocumentArtifact.DocumentFormat,
  bytes: Uint8Array,
  expectedPageCount: number,
) =>
  Effect.gen(function* () {
    if (bytes.byteLength === 0 || bytes.byteLength > DocumentArtifact.maximumDocumentBytes) {
      return yield* DocumentArtifact.invalid(
        contentId,
        "byteLimit",
        "The generated document exceeds 5 MB",
      );
    }
    const pageCount = yield* format === "pdf"
      ? pdfPages(contentId, bytes)
      : docxPages(contentId, bytes);
    if (pageCount > DocumentArtifact.maximumDocumentPages) {
      return yield* DocumentArtifact.invalid(
        contentId,
        "pageLimit",
        "The generated document exceeds 20 pages",
      );
    }
    if (pageCount !== expectedPageCount) {
      return yield* DocumentArtifact.invalid(
        contentId,
        "invalidDocument",
        "The generated document page count does not match its bounded source",
      );
    }
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    );
    return yield* DocumentArtifact.make(
      contentId,
      format,
      bytes.byteLength,
      pageCount,
      hex(new Uint8Array(digest)),
    );
  });

const pdfPages = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- pdf-lib exposes a Promise boundary.
    try: async () => (await PDFDocument.load(bytes)).getPageCount(),
    catch: () =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        message: "Disposable compute returned an invalid PDF",
        reason: "invalidDocument",
      }),
  });

const docxPages = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.try({
    try: () => {
      let selectedBytes = 0;
      const required = new Set([
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/app.xml",
        "word/_rels/document.xml.rels",
        "word/document.xml",
      ]);
      const entries = unzipSync(bytes, {
        filter: (entry) => {
          if (!required.has(entry.name)) return false;
          selectedBytes += entry.originalSize;
          return selectedBytes <= 20_000_000;
        },
      });
      const types = entries["[Content_Types].xml"];
      const relationships = entries["_rels/.rels"];
      const properties = entries["docProps/app.xml"];
      const documentRelationships = entries["word/_rels/document.xml.rels"];
      const document = entries["word/document.xml"];
      if (
        types === undefined ||
        relationships === undefined ||
        properties === undefined ||
        documentRelationships === undefined ||
        document === undefined ||
        !strFromU8(types).includes(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ) ||
        !strFromU8(relationships).includes(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
        ) ||
        !strFromU8(relationships).includes("word/document.xml") ||
        !strFromU8(documentRelationships).includes("<Relationships") ||
        !strFromU8(document).includes("<w:document")
      )
        throw new Error("invalid DOCX");
      const explicitPageCount =
        1 +
        (strFromU8(document).match(/<w:br\b[^>]*w:type=["']page["'][^>]*\/?\s*>/gu)?.length ?? 0);
      const pageMatch = /<Pages>\s*([1-9]\d*)\s*<\/Pages>/u.exec(strFromU8(properties));
      const pageCount = pageMatch?.[1] === undefined ? Number.NaN : Number(pageMatch[1]);
      if (!Number.isSafeInteger(pageCount) || pageCount !== explicitPageCount) {
        throw new Error("invalid DOCX page count");
      }
      return pageCount;
    },
    catch: () =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        message: "Disposable compute returned an invalid DOCX package",
        reason: "invalidDocument",
      }),
  });

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
