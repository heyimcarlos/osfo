/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside Effect Vitest generators. */
/* oxlint-disable effecttsgo/async-function -- Fixtures implement the installed fetch Promise boundary. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Each test owns its HTTP transport composition. */
import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import { checkAvailability, coverageGap, httpLayer } from "./production-monitor";

const health = JSON.stringify({
  activationId: "fixture-activation",
  executionUnit: "worker",
  identity: "request",
  kind: "RuntimeProbe",
  stage: "production",
});
const html = '<html><head><title>Osfo</title></head><body><div id="root"></div></body></html>';

it.effect("checks real response contracts and releases both request scopes", () =>
  Effect.gen(function* () {
    const signals: Array<AbortSignal> = [];
    const results = yield* checkAvailability().pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async (input, options) => {
        if (options?.signal) signals.push(options.signal);
        expect(options?.redirect).toBe("manual");
        expect(options?.cache).toBe("no-store");
        const api = input instanceof URL && input.pathname === "/health";
        return new Response(api ? health : html, {
          headers: { "content-type": api ? "application/json" : "text/html" },
        });
      }),
    );
    expect(results).toEqual([
      { name: "API", available: true },
      { name: "Web", available: true },
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(coverageGap).toContain("NO_DATA is not zero errors");
  }),
);

it.effect.each([
  { name: "HTTP failure", body: health, status: 503, contentType: "application/json" },
  { name: "redirect", body: health, status: 302, contentType: "application/json" },
  {
    name: "wrong stage",
    body: health.replace("production", "preview"),
    status: 200,
    contentType: "application/json",
  },
  { name: "malformed JSON", body: "{", status: 200, contentType: "application/json" },
  { name: "missing identity", body: "{}", status: 200, contentType: "application/json" },
  { name: "wrong content type", body: health, status: 200, contentType: "text/html" },
  {
    name: "oversized body",
    body: " ".repeat(262_145),
    status: 200,
    contentType: "application/json",
  },
])("reports $name after a bounded retry while still probing the web", (fixture) =>
  Effect.gen(function* () {
    let apiCalls = 0;
    let webCalls = 0;
    const fiber = yield* checkAvailability().pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async (input) => {
        if (input instanceof URL && input.pathname === "/health") {
          apiCalls += 1;
          return new Response(fixture.body, {
            status: fixture.status,
            headers: { "content-type": fixture.contentType },
          });
        }
        webCalls += 1;
        return new Response(html, { headers: { "content-type": "text/html" } });
      }),
      Effect.forkChild,
    );
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toEqual([
      { name: "API", available: false },
      { name: "Web", available: true },
    ]);
    expect(apiCalls).toBe(2);
    expect(webCalls).toBe(1);
  }),
);

it.effect("recovers a transient failure but rejects unrelated web HTML", () =>
  Effect.gen(function* () {
    let apiCalls = 0;
    const fiber = yield* checkAvailability().pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async (input) => {
        if (input instanceof URL && input.pathname === "/health") {
          apiCalls += 1;
          return new Response(health, {
            status: apiCalls === 1 ? 503 : 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("<html>Welcome to another site</html>", {
          headers: { "content-type": "text/html" },
        });
      }),
      Effect.forkChild,
    );
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toEqual([
      { name: "API", available: true },
      { name: "Web", available: false },
    ]);
  }),
);

it.effect("times out stalled bodies and cancels both bounded attempts", () =>
  Effect.gen(function* () {
    let cancellations = 0;
    const fiber = yield* checkAvailability().pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async (input) => {
        if (input instanceof URL && input.pathname === "/health") {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                cancellations += 1;
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(html, { headers: { "content-type": "text/html" } });
      }),
      Effect.forkChild,
    );
    yield* TestClock.adjust("23 seconds");
    expect(yield* Fiber.join(fiber)).toEqual([
      { name: "API", available: false },
      { name: "Web", available: true },
    ]);
    expect(cancellations).toBe(2);
  }),
);
