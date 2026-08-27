/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Artifact domains use tagged unions and assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { strToU8, zipSync, zlibSync } from "fflate";

import { ContentId } from "../../domain/client-content";
import { ArtifactValidation } from "./artifact-validation";

const contentId = ContentId.make("artifact:toolCall:validation");

it.effect("accepts a structurally valid rendered PPTX with clean visual evidence", () =>
  Effect.gen(function* () {
    const artifact = yield* ArtifactValidation.validate(
      contentId,
      {
        _tag: "Presentation",
        source: {
          audience: "Reviewers",
          purpose: "Explain",
          slides: [
            {
              body: ["Point"],
              diagramContentId: null,
              imageContentId: null,
              sourceNotes: ["https://example.test/source"],
              speakerNotes: "",
              title: "Title",
            },
          ],
          title: "Deck",
        },
      },
      pptx(),
      { _tag: "Presentation", issues: [], renderedSlideCount: 1 },
      null,
    );

    expect(artifact.artifactRole).toMatchObject({
      _tag: "GeneratedPresentationV1",
      slideCount: 1,
    });
  }),
);

it.effect("rejects corrupt PPTX and visual issues", () =>
  Effect.gen(function* () {
    const corrupt = yield* Effect.exit(
      ArtifactValidation.validate(
        contentId,
        {
          _tag: "Presentation",
          source: {
            audience: "Reviewers",
            purpose: "Explain",
            slides: [
              {
                body: [],
                diagramContentId: null,
                imageContentId: null,
                sourceNotes: [],
                speakerNotes: "",
                title: "Title",
              },
            ],
            title: "Deck",
          },
        },
        Uint8Array.from([1, 2, 3]),
        { _tag: "Presentation", issues: [], renderedSlideCount: 1 },
        null,
      ),
    );
    const clipped = yield* Effect.exit(
      ArtifactValidation.validate(
        contentId,
        {
          _tag: "Presentation",
          source: {
            audience: "Reviewers",
            purpose: "Explain",
            slides: [
              {
                body: [],
                diagramContentId: null,
                imageContentId: null,
                sourceNotes: [],
                speakerNotes: "",
                title: "Title",
              },
            ],
            title: "Deck",
          },
        },
        pptx(),
        { _tag: "Presentation", issues: ["slide 1: text overflow"], renderedSlideCount: 1 },
        null,
      ),
    );

    expect(corrupt._tag).toBe("Failure");
    expect(clipped._tag).toBe("Failure");
  }),
);

it.effect("reads PNG dimensions and rejects a mismatched inspection", () =>
  Effect.gen(function* () {
    const artifact = yield* ArtifactValidation.validate(
      contentId,
      { _tag: "Image", source: { altText: "image", height: 2, prompt: "image", width: 3 } },
      png(3, 2),
      { _tag: "Visual", height: 2, width: 3 },
      null,
    );
    const mismatch = yield* Effect.exit(
      ArtifactValidation.validate(
        contentId,
        {
          _tag: "Diagram",
          source: {
            direction: "leftToRight",
            edges: [],
            height: 2,
            nodes: [{ id: "one", label: "One" }],
            title: "One",
            width: 3,
          },
        },
        png(3, 2),
        { _tag: "Visual", height: 2, width: 4 },
        null,
      ),
    );

    expect(artifact.artifactRole._tag).toBe("GeneratedImageV1");
    expect(mismatch._tag).toBe("Failure");
  }),
);

it.effect("rejects truncated or checksum-corrupt PNG data", () =>
  Effect.gen(function* () {
    const complete = png(3, 2);
    const truncated = yield* Effect.exit(
      ArtifactValidation.validate(
        contentId,
        { _tag: "Image", source: { altText: "image", height: 2, prompt: "image", width: 3 } },
        complete.subarray(0, 33),
        { _tag: "Visual", height: 2, width: 3 },
        null,
      ),
    );
    const corrupt = Uint8Array.from(complete);
    const corruptIndex = corrupt.length - 5;
    const retainedByte = corrupt[corruptIndex];
    if (retainedByte === undefined) throw new Error("PNG fixture is unexpectedly empty");
    corrupt[corruptIndex] = retainedByte ^ 1;
    const checksum = yield* Effect.exit(
      ArtifactValidation.validate(
        contentId,
        { _tag: "Image", source: { altText: "image", height: 2, prompt: "image", width: 3 } },
        corrupt,
        { _tag: "Visual", height: 2, width: 3 },
        null,
      ),
    );
    const corruptAdler = yield* Effect.exit(
      ArtifactValidation.validate(
        contentId,
        { _tag: "Image", source: { altText: "image", height: 2, prompt: "image", width: 3 } },
        png(3, 2, true),
        { _tag: "Visual", height: 2, width: 3 },
        null,
      ),
    );

    expect(truncated._tag).toBe("Failure");
    expect(checksum._tag).toBe("Failure");
    expect(corruptAdler._tag).toBe("Failure");
  }),
);

const pptx = () =>
  zipSync({
    "[Content_Types].xml": strToU8(
      '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships><Relationship Target="ppt/presentation.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>',
    ),
    "ppt/presentation.xml": strToU8(
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/slides/slide1.xml": strToU8("<p:sld><p:cSld/></p:sld>"),
  });

const png = (width: number, height: number, corruptAdler = false) => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  const compressed = zlibSync(scanlines);
  if (corruptAdler) {
    const checksumByte = compressed.at(-1);
    if (checksumByte === undefined) throw new Error("PNG zlib fixture is unexpectedly empty");
    compressed[compressed.length - 1] = checksumByte ^ 1;
  }
  return concatPng([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ]);
};

const chunk = (type: string, data: Uint8Array) => {
  const typeBytes = strToU8(type);
  const bytes = new Uint8Array(data.byteLength + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.byteLength);
  bytes.set(typeBytes, 4);
  bytes.set(data, 8);
  view.setUint32(data.byteLength + 8, crc32(typeBytes, data));
  return bytes;
};

const concatPng = (parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const crc32 = (type: Uint8Array, data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const bytes of [type, data]) {
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};
