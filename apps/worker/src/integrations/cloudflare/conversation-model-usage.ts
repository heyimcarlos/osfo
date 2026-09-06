import type { LanguageModelUsage } from "ai";
import { Option, Schema } from "effect";

const CompleteUsage = Schema.Struct({
  inputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedInputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(Schema.makeFilter((usage) => usage.cachedInputTokens <= usage.inputTokens));

/** Workers AI omits cached-token details on cold calls with otherwise complete usage.
 * https://developers.cloudflare.com/workers-ai/features/prompt-caching/#monitoring-cached-tokens
 * workers-ai-provider 4.0 initializes absent stream usage to 0/0, which remains unknown here.
 */
export const readConversationModelUsage = (usage: LanguageModelUsage) =>
  Option.getOrElse(
    Schema.decodeUnknownOption(CompleteUsage)({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    }),
    () => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null }),
  );
