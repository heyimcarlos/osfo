import { Schema } from "effect";

import { managedSearchPrice } from "./web-search-price";

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const quantity = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Retained provider observations and independently reproducible search rating. */
export const ManagedSearchEvidence = Schema.Struct({
  attemptId: boundedText(512),
  cachedInputTokens: Schema.NullOr(quantity),
  executedSearches: Schema.Array(
    Schema.Struct({
      errorCode: Schema.NullOr(boundedText(512)),
      outcome: Schema.Literals(["succeeded", "failed"]),
      query: Schema.NullOr(boundedText(2_000)),
      queries: Schema.NullOr(Schema.Array(boundedText(2_000)).check(Schema.isMaxLength(100))),
      toolCallId: boundedText(512),
    }),
  ).check(Schema.isMaxLength(20)),
  inputTokens: Schema.NullOr(quantity),
  model: Schema.Literal("openai/gpt-4.1-mini"),
  outputTokens: Schema.NullOr(quantity),
  priceEntryId: Schema.Literal("openai-gpt-4.1-mini-web-search-2026-09-06"),
  provider: Schema.Literal("cloudflare-unified-openai"),
  providerRequestId: Schema.NullOr(boundedText(512)),
  ratedCostUsdMicros: Schema.NullOr(quantity),
  resourcePriceVersion: Schema.Literal("web-search-prices-2026-09-06"),
  searchCountBasis: Schema.Literal("terminal-web-search-call-blocks"),
  successfulSearches: Schema.NullOr(quantity),
});

export type ManagedSearchEvidence = typeof ManagedSearchEvidence.Type;

/** A dispatched attempt is an unknown cost until its provider usage is decoded. */
export const initialManagedSearchEvidence = (attemptId: string): ManagedSearchEvidence => ({
  attemptId,
  cachedInputTokens: null,
  executedSearches: [],
  inputTokens: null,
  model: managedSearchPrice.model,
  outputTokens: null,
  priceEntryId: managedSearchPrice.priceEntryId,
  provider: "cloudflare-unified-openai",
  providerRequestId: null,
  ratedCostUsdMicros: null,
  resourcePriceVersion: managedSearchPrice.resourcePriceVersion,
  searchCountBasis: "terminal-web-search-call-blocks",
  successfulSearches: null,
});
