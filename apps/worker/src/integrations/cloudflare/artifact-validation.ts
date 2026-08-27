import { Effect } from "effect";
import { strFromU8, unzipSync } from "fflate";

import type { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import type {
  ArtifactInspection,
  ArtifactIntent,
  ArtifactValidator,
} from "../../services/artifact-generation";

/* oxlint-disable eslint/no-underscore-dangle -- Artifact domains use tagged unions. */

/** Parse and verify exported artifact bytes after disposable compute completes. */
export const validate: ArtifactValidator["validate"] = (
  contentId,
  intent,
  bytes,
  inspection,
  sourceContentId,
) =>
  Effect.gen(function* () {
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    );
    const sha256 = hex(new Uint8Array(digest));
    if (intent._tag === "Presentation") {
      if (inspection._tag !== "Presentation") {
        return yield* invalid(contentId, "Presentation inspection evidence is missing");
      }
      if (inspection.issues.length > 0) {
        return yield* DocumentArtifact.invalid(
          contentId,
          "visualInspectionFailed",
          "Presentation visual inspection found clipping, overflow, contrast, font, image, or diagram defects",
        );
      }
      const slideCount = yield* pptxSlides(contentId, bytes);
      if (
        slideCount !== intent.source.slides.length ||
        slideCount !== inspection.renderedSlideCount
      ) {
        return yield* invalid(
          contentId,
          "The presentation slide count does not match its source and rendered evidence",
        );
      }
      return yield* DocumentArtifact.makePresentation(
        contentId,
        bytes.byteLength,
        slideCount,
        sha256,
        sourceContentId,
      );
    }

    if (inspection._tag !== "Visual") {
      return yield* invalid(contentId, "Visual inspection evidence is missing");
    }
    const dimensions = yield* pngDimensions(contentId, bytes);
    if (
      dimensions.width !== intent.source.width ||
      dimensions.height !== intent.source.height ||
      dimensions.width !== inspection.width ||
      dimensions.height !== inspection.height
    ) {
      return yield* invalid(contentId, "The visual dimensions do not match its bounded intent");
    }
    return yield* DocumentArtifact.makeVisual(
      contentId,
      intent._tag === "Image" ? "image" : "diagram",
      bytes.byteLength,
      dimensions.width,
      dimensions.height,
      sha256,
      sourceContentId,
    );
  });

const pptxSlides = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.try({
    try: () => {
      let expandedBytes = 0;
      const entries = unzipSync(bytes, {
        filter: (entry) => {
          const relevant =
            entry.name === "[Content_Types].xml" ||
            entry.name === "_rels/.rels" ||
            entry.name === "ppt/presentation.xml" ||
            entry.name === "ppt/_rels/presentation.xml.rels" ||
            /^ppt\/slides\/slide[1-9]\d*\.xml$/u.test(entry.name);
          if (!relevant) return false;
          expandedBytes += entry.originalSize;
          return expandedBytes <= 40_000_000;
        },
      });
      const types = entries["[Content_Types].xml"];
      const relationships = entries["_rels/.rels"];
      const presentationRelationships = entries["ppt/_rels/presentation.xml.rels"];
      const presentation = entries["ppt/presentation.xml"];
      if (
        types === undefined ||
        relationships === undefined ||
        presentationRelationships === undefined ||
        presentation === undefined ||
        !strFromU8(types).includes(
          "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        ) ||
        !strFromU8(relationships).includes(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
        ) ||
        !strFromU8(relationships).includes("ppt/presentation.xml") ||
        !strFromU8(presentationRelationships).includes("<Relationships") ||
        !strFromU8(presentation).includes("<p:presentation")
      ) {
        throw new Error("invalid PPTX package");
      }
      const slides = Object.keys(entries).filter((name) =>
        /^ppt\/slides\/slide[1-9]\d*\.xml$/u.test(name),
      );
      const declaredSlides = strFromU8(presentation).match(/<p:sldId\b/gu)?.length ?? 0;
      if (
        slides.length === 0 ||
        slides.length !== declaredSlides ||
        slides.length > DocumentArtifact.maximumPresentationSlides
      ) {
        throw new Error("invalid PPTX slide graph");
      }
      for (const slide of slides) {
        const xml = entries[slide];
        if (xml === undefined || !strFromU8(xml).includes("<p:sld")) {
          throw new Error("invalid PPTX slide");
        }
      }
      return slides.length;
    },
    catch: () =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        message: "Disposable compute returned an invalid PPTX package",
        reason: "invalidArtifact",
      }),
  });

const pngDimensions = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.try({
    try: () => {
      if (
        bytes.byteLength < 29 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
        strFromU8(bytes.subarray(12, 16)) !== "IHDR"
      ) {
        throw new Error("invalid PNG");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(16);
      const height = view.getUint32(20);
      if (width === 0 || height === 0) throw new Error("invalid PNG dimensions");
      return { height, width };
    },
    catch: () =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        message: "Disposable compute returned an invalid PNG",
        reason: "invalidArtifact",
      }),
  });

const invalid = (contentId: ContentId, message: string) =>
  DocumentArtifact.invalid(contentId, "invalidArtifact", message);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const assertInspectionMatches = (intent: ArtifactIntent, inspection: ArtifactInspection) =>
  intent._tag === "Presentation"
    ? inspection._tag === "Presentation" &&
      inspection.renderedSlideCount === intent.source.slides.length &&
      inspection.issues.length === 0
    : inspection._tag === "Visual" &&
      inspection.width === intent.source.width &&
      inspection.height === intent.source.height;

export * as ArtifactValidation from "./artifact-validation";
