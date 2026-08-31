import { expect, it } from "@effect/vitest";

import { contextOverflowPolicy } from "./context-overflow-policy";

it("derives compaction headroom and retry bounds from each model policy", () => {
  expect(
    contextOverflowPolicy({
      contextWindowTokens: 200_000,
      proactiveCompactionLimit: 2,
      reactiveRetryLimit: 1,
      targetInputTokens: 110_000,
    }),
  ).toEqual({
    maxRetries: 1,
    proactive: {
      headroom: 0.55,
      maxCompactions: 2,
      maxInputTokens: 200_000,
    },
    reactive: true,
  });
  expect(
    contextOverflowPolicy({
      contextWindowTokens: 128_000,
      proactiveCompactionLimit: 1,
      reactiveRetryLimit: 2,
      targetInputTokens: 96_000,
    }).proactive?.headroom,
  ).toBe(0.75);
});
