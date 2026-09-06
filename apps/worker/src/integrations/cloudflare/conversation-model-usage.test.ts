import { expect, it } from "@effect/vitest";
import type { LanguageModelUsage } from "ai";

import { readConversationModelUsage } from "./conversation-model-usage";

const usage = (
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheReadTokens?: number,
): LanguageModelUsage => ({
  inputTokens,
  outputTokens,
  inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens, cacheWriteTokens: undefined },
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens:
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens,
});

it("uses the documented Workers AI cold-cache omission only with complete usage", () => {
  expect(readConversationModelUsage(usage(100, 20))).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
  });
  expect(readConversationModelUsage(usage(100, 20, 80))).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
  });
});

it("does not fabricate a rating from absent, partial, or malformed usage", () => {
  for (const sample of [
    usage(undefined, undefined),
    usage(0, 0),
    usage(100, undefined),
    usage(100, 20, 101),
    usage(100, -1),
    usage(Number.NaN, 20),
  ]) {
    expect(readConversationModelUsage(sample)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
  }
});
