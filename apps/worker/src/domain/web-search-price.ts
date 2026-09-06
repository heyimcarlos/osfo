/** Immutable non-preview web search quote, separate from settled Company Cost.
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/models/gpt-4.1-mini
 * https://developers.cloudflare.com/ai-gateway/usage/web-search/#pricing-and-logging
 */
export const managedSearchPrice = {
  inputUsdMicrosPerMillionTokens: 400_000n,
  model: "openai/gpt-4.1-mini",
  outputUsdMicrosPerMillionTokens: 1_600_000n,
  priceEntryId: "openai-gpt-4.1-mini-web-search-2026-09-06",
  resourcePriceVersion: "web-search-prices-2026-09-06",
  searchUsdMicros: 10_000n,
  searchContentTokensPerCall: 8_000,
} as const;

/** The provider's input usage includes its fixed search-content tokens; do not add them twice. */
export const rateManagedSearch = (input: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly searches: number;
}) =>
  Number(
    (BigInt(input.inputTokens) * 2n + BigInt(input.outputTokens) * 8n + 4n) / 5n +
      BigInt(input.searches) * managedSearchPrice.searchUsdMicros,
  );
