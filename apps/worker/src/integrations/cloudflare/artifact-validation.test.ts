/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Artifact domains use tagged unions and assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { strToU8, zipSync } from "fflate";

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

const pptx = () =>
  zipSync({
    "[Content_Types].xml": strToU8(
      '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships><Relationship Target="ppt/presentation.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8("<Relationships></Relationships>"),
    "ppt/presentation.xml": strToU8(
      '<p:presentation><p:sldIdLst><p:sldId id="256"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/slides/slide1.xml": strToU8("<p:sld><p:cSld/></p:sld>"),
  });

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
};
