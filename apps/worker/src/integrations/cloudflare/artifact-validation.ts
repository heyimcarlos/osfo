import { Effect } from "effect";
import { strFromU8, unzipSync, unzlibSync } from "fflate";

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
      const slideCount = yield* pptxSlides(contentId, bytes, intent.source.slides);
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

const pptxSlides = (
  contentId: ContentId,
  bytes: Uint8Array,
  sourceSlides: Extract<ArtifactIntent, { readonly _tag: "Presentation" }>["source"]["slides"],
) =>
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
            /^ppt\/slides\/slide[1-9]\d*\.xml$/u.test(entry.name) ||
            /^ppt\/slides\/_rels\/slide[1-9]\d*\.xml\.rels$/u.test(entry.name) ||
            /^ppt\/media\/[A-Za-z0-9_.-]+$/u.test(entry.name);
          if (!relevant) return false;
          expandedBytes += entry.originalSize;
          return expandedBytes <= 60_000_000;
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
        !strFromU8(presentation).includes("<p:presentation")
      ) {
        throw new Error("invalid PPTX package");
      }
      const slides = Object.keys(entries).filter((name) =>
        /^ppt\/slides\/slide[1-9]\d*\.xml$/u.test(name),
      );
      const declaredSlides = strFromU8(presentation).match(/<p:sldId\b/gu)?.length ?? 0;
      const presentationRelationshipXml = strFromU8(presentationRelationships);
      const slideRelationships = relationshipEntries(presentationRelationshipXml, "slide");
      const declaredRelationshipIds = [
        ...strFromU8(presentation).matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/gu),
      ].map((match) => match[1]);
      if (
        slides.length === 0 ||
        slides.length !== declaredSlides ||
        slideRelationships.length !== declaredSlides ||
        declaredRelationshipIds.length !== declaredSlides ||
        slides.length > DocumentArtifact.maximumPresentationSlides
      ) {
        throw new Error("invalid PPTX slide graph");
      }
      for (const [index, relationshipId] of declaredRelationshipIds.entries()) {
        const relationship = slideRelationships.find(({ id }) => id === relationshipId);
        if (relationship === undefined) throw new Error("invalid PPTX slide relationship");
        const slide = `ppt/${relationship.target}`;
        const xml = entries[slide];
        if (xml === undefined || !strFromU8(xml).includes("<p:sld")) {
          throw new Error("invalid PPTX slide");
        }
        const sourceSlide = sourceSlides[index];
        if (
          sourceSlide !== undefined &&
          (sourceSlide.imageContentId !== null || sourceSlide.diagramContentId !== null)
        ) {
          const relationshipName = slide.replace(
            /^ppt\/slides\/(slide[1-9]\d*\.xml)$/u,
            "ppt/slides/_rels/$1.rels",
          );
          const slideRelationship = entries[relationshipName];
          if (slideRelationship === undefined) throw new Error("missing PPTX image relationship");
          const images = relationshipEntries(strFromU8(slideRelationship), "image");
          if (
            images.length === 0 ||
            images.some(
              ({ target }) => entries[`ppt/${target.replace(/^\.\.\//u, "")}`] === undefined,
            )
          ) {
            throw new Error("broken PPTX image relationship");
          }
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

const relationshipEntries = (xml: string, type: "image" | "slide") =>
  [...xml.matchAll(/<Relationship\b[^>]*>/gu)].flatMap(([tag]) => {
    const id = /\bId="([^"]+)"/u.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/u.exec(tag)?.[1];
    const relationshipType = /\bType="([^"]+)"/u.exec(tag)?.[1];
    return id !== undefined &&
      target !== undefined &&
      relationshipType?.endsWith(`/relationships/${type}`) === true
      ? [{ id, target }]
      : [];
  });

const pngDimensions = (contentId: ContentId, bytes: Uint8Array) =>
  Effect.try({
    try: () => {
      if (
        bytes.byteLength < 57 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      ) {
        throw new Error("invalid PNG");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 8;
      let width = 0;
      let height = 0;
      let bitsPerPixel = 0;
      let sawHeader = false;
      let sawImageData = false;
      let sawPalette = false;
      let sawEnd = false;
      const imageData: Array<Uint8Array> = [];
      while (offset < bytes.byteLength) {
        if (offset + 12 > bytes.byteLength) throw new Error("truncated PNG chunk");
        const length = view.getUint32(offset);
        const chunkEnd = offset + 12 + length;
        if (chunkEnd > bytes.byteLength) throw new Error("truncated PNG payload");
        const typeBytes = bytes.subarray(offset + 4, offset + 8);
        const type = strFromU8(typeBytes);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        const retainedCrc = view.getUint32(offset + 8 + length);
        if (crc32(typeBytes, data) !== retainedCrc) throw new Error("invalid PNG checksum");
        if (!sawHeader && type !== "IHDR") throw new Error("PNG header is not first");
        if (type === "IHDR") {
          if (sawHeader || length !== 13) throw new Error("invalid PNG header");
          width = view.getUint32(offset + 8);
          height = view.getUint32(offset + 12);
          const bitDepth = bytes[offset + 16];
          const colorType = bytes[offset + 17];
          const compression = bytes[offset + 18];
          const filter = bytes[offset + 19];
          const interlace = bytes[offset + 20];
          if (
            width === 0 ||
            height === 0 ||
            bitDepth === undefined ||
            colorType === undefined ||
            compression !== 0 ||
            filter !== 0 ||
            interlace !== 0
          ) {
            throw new Error("unsupported PNG header");
          }
          bitsPerPixel = pngBitsPerPixel(bitDepth, colorType);
          sawHeader = true;
        } else if (type === "PLTE") {
          if (sawImageData || length === 0 || length % 3 !== 0 || length > 768) {
            throw new Error("invalid PNG palette");
          }
          sawPalette = true;
        } else if (type === "IDAT") {
          if (!sawHeader || sawEnd || length === 0) throw new Error("invalid PNG image data");
          imageData.push(data);
          sawImageData = true;
        } else if (type === "IEND") {
          if (!sawImageData || length !== 0 || chunkEnd !== bytes.byteLength) {
            throw new Error("invalid PNG end");
          }
          sawEnd = true;
        } else if ((typeBytes[0] ?? 0) >= 65 && (typeBytes[0] ?? 0) <= 90) {
          throw new Error("unsupported critical PNG chunk");
        }
        offset = chunkEnd;
      }
      if (!sawHeader || !sawImageData || !sawEnd) throw new Error("incomplete PNG");
      if (bitsPerPixel === 0 || (bitsPerPixel <= 8 && !sawPalette && pngRequiresPalette(bytes))) {
        throw new Error("invalid PNG color model");
      }
      const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
      const expectedBytes = height * (rowBytes + 1);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes > 70_000_000) {
        throw new Error("PNG decode exceeds its bound");
      }
      const compressed = concat(imageData);
      const pixels = unzlibSync(compressed, { out: new Uint8Array(expectedBytes) });
      if (
        pixels.byteLength !== expectedBytes ||
        compressed.byteLength < 6 ||
        adler32(pixels) !==
          new DataView(
            compressed.buffer,
            compressed.byteOffset + compressed.byteLength - 4,
            4,
          ).getUint32(0)
      ) {
        throw new Error("invalid PNG pixel payload");
      }
      for (let row = 0; row < height; row += 1) {
        const filterByte = pixels[row * (rowBytes + 1)];
        if (filterByte === undefined || filterByte > 4) throw new Error("invalid PNG row filter");
      }
      return { height, width };
    },
    catch: () =>
      new DocumentArtifact.InvalidGeneratedArtifact({
        contentId,
        message: "Disposable compute returned an invalid PNG",
        reason: "invalidArtifact",
      }),
  });

const pngBitsPerPixel = (bitDepth: number, colorType: number) => {
  const allowedDepths =
    colorType === 0
      ? [1, 2, 4, 8, 16]
      : colorType === 2
        ? [8, 16]
        : colorType === 3
          ? [1, 2, 4, 8]
          : colorType === 4 || colorType === 6
            ? [8, 16]
            : [];
  if (!allowedDepths.includes(bitDepth)) throw new Error("invalid PNG bit depth");
  const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  return bitDepth * channels;
};

const pngRequiresPalette = (bytes: Uint8Array) => bytes[25] === 3;

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const crc32 = (type: Uint8Array, data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const bytes of [type, data]) {
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes: Uint8Array) => {
  let first = 1;
  let second = 0;
  for (const byte of bytes) {
    first = (first + byte) % 65_521;
    second = (second + first) % 65_521;
  }
  return ((second << 16) | first) >>> 0;
};

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
