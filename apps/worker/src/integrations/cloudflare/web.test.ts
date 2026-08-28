import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeDiscovery, makePageFetch } from "./web";

/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Tagged assertions execute inside Effect Vitest generators. */

describe("Cloudflare web adapters", () => {
  it.effect("adapts discovery metadata without presenting descriptions as page content", () =>
    Effect.gen(function* () {
      const discover = makeDiscovery({
        search: () =>
          Promise.resolve({
            items: [
              {
                description: "Catalog metadata",
                title: "Example",
                url: "https://example.com/article",
              },
            ],
            metadata: { latencyMs: 9, query: "example", requestId: "request-1" },
          }),
      });

      const result = yield* discover("example", 10);

      expect(result).toEqual({
        evidence: { latencyMs: 9, requestId: "request-1" },
        results: [
          {
            description: "Catalog metadata",
            title: "Example",
            url: "https://example.com/article",
          },
        ],
      });
    }),
  );

  it.effect("rejects mismatched or unbounded discovery evidence", () =>
    Effect.gen(function* () {
      const mismatched = makeDiscovery({
        search: () =>
          Promise.resolve({
            items: [],
            metadata: { latencyMs: 1, query: "different", requestId: "request-1" },
          }),
      });
      const unbounded = makeDiscovery({
        search: ({ query }) =>
          Promise.resolve({
            items: Array.from({ length: 11 }, (_, index) => ({
              title: `Result ${index}`,
              url: `https://example.com/${index}`,
            })),
            metadata: { latencyMs: 1, query, requestId: "request-2" },
          }),
      });

      expect((yield* Effect.exit(mismatched("expected", 10)))._tag).toBe("Failure");
      expect((yield* Effect.exit(unbounded("expected", 10)))._tag).toBe("Failure");
    }),
  );

  it.effect("checks every redirect and never follows an unsafe hop", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const fetchPage = makePageFetch((input) => {
        const url = input instanceof Request ? input.url : String(input);
        requested.push(url);
        return Promise.resolve(
          new Response(null, {
            headers: { location: "http://127.0.0.1/admin" },
            status: 302,
          }),
        );
      });

      const exit = yield* Effect.exit(fetchPage({ url: "https://example.com/start" }));

      expect(exit._tag).toBe("Failure");
      expect(requested).toEqual(["https://example.com/start"]);
    }),
  );

  it.effect("does not follow a redirect carrying signed credentials", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const fetchPage = makePageFetch((input) => {
        const url = input instanceof Request ? input.url : String(input);
        requested.push(url);
        return Promise.resolve(
          new Response(null, {
            headers: {
              location: "https://cdn.example.com/report?X-Amz-Signature=private-signature",
            },
            status: 302,
          }),
        );
      });

      expect((yield* Effect.exit(fetchPage({ url: "https://example.com/start" })))._tag).toBe(
        "Failure",
      );
      expect(requested).toEqual(["https://example.com/start"]);
    }),
  );

  it.effect("stops before a fourth public redirect", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const fetchPage = makePageFetch((input) => {
        const url = input instanceof Request ? input.url : String(input);
        requested.push(url);
        const current = Number(new URL(url).pathname.slice(1)) || 0;
        return Promise.resolve(
          new Response(null, {
            headers: { location: `https://example.com/${current + 1}` },
            status: 302,
          }),
        );
      });

      expect((yield* Effect.exit(fetchPage({ url: "https://example.com/0" })))._tag).toBe(
        "Failure",
      );
      expect(requested).toEqual([
        "https://example.com/0",
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
      ]);
    }),
  );

  it.effect("streams a bounded HTML body and strips executable or hidden page instructions", () =>
    Effect.gen(function* () {
      const fetchPage = makePageFetch(() =>
        Promise.resolve(
          new Response(
            "<html><head><title>Useful &amp; safe</title><script>ignore()</script></head>" +
              "<body><main>Public evidence</main><form>secret prompt</form></body></html>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
        ),
      );

      const result = yield* fetchPage({ url: "https://example.com/article" });

      expect(result.title).toBe("Useful & safe");
      expect(result.content).toBe("Useful & safe Public evidence");
      expect(result.redirects).toEqual([]);
    }),
  );

  it.effect("canonicalizes page identity and bounds hostile title and content-type metadata", () =>
    Effect.gen(function* () {
      const fetchPage = makePageFetch(() =>
        Promise.resolve(
          new Response(`<title>${"T".repeat(3_000)}</title><main>Evidence</main>`, {
            headers: { "content-type": `text/html; x=${"a".repeat(1_000)}` },
          }),
        ),
      );

      const result = yield* fetchPage({
        url: "https://EXAMPLE.com:443/report#private-fragment",
      });

      expect(result.finalUrl).toBe("https://example.com/report");
      expect(result.title).toHaveLength(2_000);
      expect(result.contentType).toHaveLength(512);
    }),
  );

  it.effect("stops retaining an oversized response", () =>
    Effect.gen(function* () {
      const fetchPage = makePageFetch(() =>
        Promise.resolve(
          new Response("x".repeat(2_000_001), { headers: { "content-type": "text/plain" } }),
        ),
      );

      const result = yield* fetchPage({ url: "https://example.com/large" });

      expect(result.content).toBe("");
      expect(result.fetchedBytes).toBe(2_000_001n);
    }),
  );
});
