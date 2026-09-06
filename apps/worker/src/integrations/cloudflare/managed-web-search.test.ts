import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { initialManagedSearchEvidence } from "../../domain/web-search-evidence";
import { managedSearchAdmissionUsdMicros } from "../../domain/web-search-price";
import { decodeResponse, makeDiscovery } from "./managed-web-search";

/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Tagged assertions execute inside Effect Vitest generators. */

const initial = initialManagedSearchEvidence("attempt-1");
const source = "https://example.com/source";
const call = {
  action: { query: "example query", sources: [{ type: "url", url: source }], type: "search" },
  id: "search-1",
  status: "completed",
  type: "web_search_call",
};
const response = {
  id: "response-1",
  max_output_tokens: 512,
  max_tool_calls: 1,
  output: [
    call,
    {
      content: [
        {
          annotations: [{ title: "Source title", type: "url_citation", url: source }],
          text: "Untrusted generated answer",
          type: "output_text",
        },
      ],
      type: "message",
    },
  ],
  status: "completed",
  tools: [{ type: "web_search" }],
  usage: { input_tokens: 8541, input_tokens_details: { cached_tokens: 0 }, output_tokens: 91 },
};

describe("managed public search", () => {
  it("keeps the conservative admission allowance separate from rated provider cost", () => {
    expect(managedSearchAdmissionUsdMicros).toBe(50_000n);
  });
  it.effect("rates provider prompt-cache hits at the pinned cached-input price", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeResponse(
        {
          ...response,
          usage: { ...response.usage, input_tokens_details: { cached_tokens: 1_000 } },
        },
        initial,
      );
      expect(decoded.evidence.cachedInputTokens).toBe(1_000);
      expect(decoded.evidence.ratedCostUsdMicros).toBe(13_262);
    }),
  );
  it.effect("refuses inconsistent provider cached-input usage", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeResponse(
          {
            ...response,
            usage: { ...response.usage, input_tokens_details: { cached_tokens: 9_000 } },
          },
          initial,
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.managedSearch?.ratedCostUsdMicros).toBeNull();
    }),
  );
  it.effect("rates one real search including its input tokens exactly once", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeResponse(response, initial);
      expect(decoded.results).toEqual([{ title: "Source title", url: source }]);
      expect(decoded.evidence.ratedCostUsdMicros).toBe(13_562);
      expect(decoded.evidence.successfulSearches).toBe(1);
      expect(decoded.evidence.executedSearches).toEqual([
        { errorCode: null, outcome: "succeeded", query: "example query", toolCallId: "search-1" },
      ]);
    }),
  );
  it.effect("retains unknown cost rather than inventing zero for malformed response", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decodeResponse({ output: [] }, initial));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.managedSearch?.ratedCostUsdMicros).toBeNull();
    }),
  );
  it.effect("refuses answer-only output while retaining paid model usage", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decodeResponse({ ...response, output: [] }, initial));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.managedSearch?.ratedCostUsdMicros).toBe(3_562);
        expect(result.failure.managedSearch?.successfulSearches).toBe(0);
      }
    }),
  );
  it.effect("refuses multiple search calls without understating ambiguous search cost", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeResponse({ ...response, output: [call, { ...call, id: "search-2" }] }, initial),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.managedSearch?.ratedCostUsdMicros).toBeNull();
    }),
  );
  it.effect("never retries an ambiguous paid request", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const discover = makeDiscovery(
        {
          run: (_model, inputs, options) => {
            requests.push({ inputs, options });
            return Promise.reject(new Error("lost acknowledgement"));
          },
        },
        "default",
      );
      const result = yield* Effect.result(discover("example query", 10, initial));
      expect(Result.isFailure(result)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        inputs: { max_tool_calls: 1, max_output_tokens: 512, tools: [{ type: "web_search" }] },
        options: { gateway: { retries: { maxAttempts: 1 }, skipCache: true } },
      });
    }),
  );
});
