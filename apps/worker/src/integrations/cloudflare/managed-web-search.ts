import { DateTime, Effect, Schema } from "effect";

import {
  initialManagedSearchEvidence,
  type ManagedSearchEvidence,
} from "../../domain/web-search-evidence";
import { managedSearchPrice, rateManagedSearch } from "../../domain/web-search-price";
import { limits, type DiscoveryResult } from "../../services/web";
import { WebProviderUnavailable } from "./web";

const text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const tokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000_000 }));
const Envelope = Schema.Struct({
  id: text(512),
  max_output_tokens: Schema.Literal(512),
  max_tool_calls: Schema.Literal(1),
  output: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100)),
  status: Schema.String,
  tools: Schema.Array(Schema.Struct({ type: Schema.Literal("web_search") })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
  usage: Schema.Struct({
    input_tokens: tokenCount,
    input_tokens_details: Schema.Struct({ cached_tokens: tokenCount }),
    output_tokens: tokenCount,
  }),
});
const Citation = Schema.Struct({
  title: text(2_000),
  type: Schema.Literal("url_citation"),
  url: text(4_096),
});
const Output = Schema.Array(
  Schema.Union([
    Schema.Struct({
      action: Schema.Struct({
        query: text(2_000),
        sources: Schema.Array(
          Schema.Struct({ type: Schema.Literal("url"), url: text(4_096) }),
        ).check(Schema.isMaxLength(100)),
        type: Schema.Literal("search"),
      }),
      id: text(512),
      status: Schema.Literals(["completed", "failed", "in_progress", "searching"]),
      type: Schema.Literal("web_search_call"),
    }),
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({
          annotations: Schema.Array(Citation),
          type: Schema.Literal("output_text"),
        }),
      ),
      type: Schema.Literal("message"),
    }),
  ]),
);

/** One native paid search through Cloudflare-managed credentials, without provider retries. */
export const makeDiscovery = (binding: Pick<Ai, "run">, gatewayId: string) =>
  Effect.fn("ManagedWebSearch.discover")(function* (
    query: string,
    limit: number,
    dispatched?: ManagedSearchEvidence,
  ) {
    const initial =
      // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect -- The provider boundary supplies an opaque request identity when no durable attempt was supplied.
      dispatched ?? initialManagedSearchEvidence(yield* Effect.sync(() => crypto.randomUUID()));
    const inputs = {
      include: ["web_search_call.action.sources"],
      input: query,
      max_output_tokens: 512,
      max_tool_calls: 1,
      store: false,
      tool_choice: "required",
      tools: [{ search_context_size: "low", type: "web_search" }],
    };
    if (
      gatewayId.trim().length === 0 ||
      query.length === 0 ||
      query.length > limits.queryCharacters ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > limits.resultsPerSearch ||
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Measure the exact serialized provider request, not untrusted JSON.
      new TextEncoder().encode(JSON.stringify(inputs)).byteLength > 4_096
    ) {
      return yield* unavailable(initial, "The managed search configuration or request is invalid.");
    }
    const startedAt = yield* DateTime.nowAsDate;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        binding.run(managedSearchPrice.model, inputs, {
          gateway: {
            eventId: initial.attemptId,
            id: gatewayId,
            requestTimeoutMs: limits.providerDeadlineMilliseconds,
            retries: { maxAttempts: 1 },
            skipCache: true,
          },
          signal,
        }),
      catch: () =>
        unavailable(initial, "The managed search attempt has unknown provider acceptance."),
    });
    const parsed = yield* decodeResponse(response, initial);
    const completedAt = yield* DateTime.nowAsDate;
    return {
      evidence: {
        latencyMs: completedAt.getTime() - startedAt.getTime(),
        managedSearch: parsed.evidence,
        requestId: parsed.evidence.providerRequestId ?? initial.attemptId,
      },
      results: parsed.results.slice(0, limit),
    } satisfies DiscoveryResult;
  });

/** Retain actual native search calls and sources; generated answer text is not page evidence. */
// oxlint-disable-next-line osfo/no-unknown-parameters -- This is the owning provider response decoder.
export const decodeResponse = (response: unknown, initial: ManagedSearchEvidence) =>
  Effect.gen(function* () {
    const envelope = yield* Schema.decodeUnknownEffect(Envelope)(response).pipe(
      Effect.mapError(() =>
        unavailable(initial, "Managed search returned an invalid usage envelope."),
      ),
    );
    const observed = {
      ...initial,
      cachedInputTokens: envelope.usage.input_tokens_details.cached_tokens,
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
      providerRequestId: envelope.id,
    };
    if (observed.cachedInputTokens > observed.inputTokens) {
      return yield* unavailable(
        observed,
        "Managed search returned inconsistent cached token usage.",
      );
    }
    const output = yield* Schema.decodeUnknownEffect(Output)(envelope.output).pipe(
      Effect.mapError(() =>
        unavailable(observed, "Managed search returned invalid tool evidence."),
      ),
    );
    const calls = output.filter((item) => item.type === "web_search_call");
    if (
      calls.length > 1 ||
      calls.some((call) => call.status !== "completed" && call.status !== "failed")
    ) {
      return yield* unavailable(
        observed,
        "Managed search did not finish within its one-call bound.",
      );
    }
    const executedSearches = calls.map((call) => ({
      errorCode: call.status === "failed" ? "web-search-call-failed" : null,
      outcome: call.status === "completed" ? ("succeeded" as const) : ("failed" as const),
      query: call.action.query,
      toolCallId: call.id,
    }));
    const successfulSearches = executedSearches.filter(
      (search) => search.outcome === "succeeded",
    ).length;
    const evidence: ManagedSearchEvidence = {
      ...observed,
      executedSearches,
      ratedCostUsdMicros: rateManagedSearch({
        cachedInputTokens: observed.cachedInputTokens,
        inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens,
        searches: calls.length,
      }),
      successfulSearches,
    };
    if (envelope.status !== "completed" || successfulSearches !== 1) {
      return yield* unavailable(evidence, "Managed search did not complete one successful search.");
    }
    const citations = output.flatMap((item) =>
      item.type === "message" ? item.content.flatMap((content) => content.annotations) : [],
    );
    return {
      evidence,
      results: calls.flatMap((call) =>
        call.action.sources.map((source) => ({
          title:
            citations.find((citation) => citation.url === source.url)?.title ??
            source.url.slice(0, 2_000),
          url: source.url,
        })),
      ),
    };
  });

const unavailable = (managedSearch: ManagedSearchEvidence, message: string) =>
  new WebProviderUnavailable({ managedSearch, message, operation: "discover", retry: "ambiguous" });

export * as ManagedWebSearch from "./managed-web-search";
