/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ContentId } from "../../domain/client-content";
import { make } from "./artifact-store";

it.effect("rejects retained artifact metadata above its absolute role byte limit", () => {
  const contentId = ContentId.make("artifact:toolCall:oversized-image");
  let bodyRead = false;
  const bucket = {
    head: () =>
      Promise.resolve({
        customMetadata: {
          osfo: JSON.stringify({
            allowancePeriodId: "period-1",
            artifact: {
              artifactRole: {
                _tag: "GeneratedImageV1",
                format: "png",
                height: 64,
                width: 64,
              },
              content: {
                byteLength: 10_000_001,
                contentId,
                mediaType: "image/png",
                sha256: "a".repeat(64),
              },
              lineage: { sourceContentId: null },
            },
            cost: { _tag: "ProvenNoUse" },
            intentDigest: "b".repeat(64),
            intentTag: "Image",
            owner: { _tag: "ToolCall", toolCallId: "tool-1" },
            retention: "accounted",
            userId: "user-1",
          }),
        },
        key: "client-content/oversized",
        size: 10_000_001,
      }),
    get: () => {
      bodyRead = true;
      return Promise.resolve(null);
    },
  };
  // SAFETY: The failure path uses only the head method; get detects an unsafe body read.
  // oxlint-disable-next-line osfo/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- This fake intentionally models a narrow R2 boundary.
  const artifacts = make(bucket as unknown as R2Bucket);

  return artifacts.inspect(contentId).pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(Result.isFailure(result)).toBe(true);
        expect(bodyRead).toBe(false);
      }),
    ),
  );
});
