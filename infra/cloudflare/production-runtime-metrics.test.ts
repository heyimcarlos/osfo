/* oxlint-disable vitest/no-standalone-expect -- Assertions run inside Effect Vitest generators. */
/* oxlint-disable effecttsgo/async-function -- Fixtures implement the installed fetch Promise boundary. */
/* oxlint-disable effecttsgo/strict-effect-provide -- Tests own the HTTP transport. */
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { httpLayer } from "./production-monitor";
import { checkRuntimeMetrics, query } from "./production-runtime-metrics";

const credentials = { accountId: "a".repeat(32), token: Redacted.make("fixture-secret") };
const Request = Schema.fromJsonString(
  Schema.Struct({
    query: Schema.String,
    variables: Schema.Struct({
      accountTag: Schema.String,
      scriptName: Schema.String,
      datetimeStart: Schema.String,
      datetimeEnd: Schema.String,
    }),
  }),
);

it.effect.each([
  { name: "observed zero", requests: 3, errors: 0, expected: "PASS" },
  { name: "observed error", requests: 3, errors: 1, expected: "FAIL" },
  { name: "zero traffic", requests: 0, errors: 0, expected: "NO_DATA" },
  { name: "negative count", requests: -1, errors: 0, expected: "UNAVAILABLE" },
  { name: "inconsistent counts", requests: 1, errors: 2, expected: "UNAVAILABLE" },
])("classifies $name and fixes exact script/window/transport", (fixture) =>
  Effect.gen(function* () {
    const result = yield* checkRuntimeMetrics(credentials).pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async (url, options) => {
        expect(url instanceof URL ? url.href : url).toBe(
          "https://api.cloudflare.com/client/v4/graphql",
        );
        expect(options?.redirect).toBe("manual");
        expect(options?.method).toBe("POST");
        const body = Schema.decodeSync(Request)(await new Response(options?.body).text());
        expect(body.query).toBe(query);
        expect(body.variables.accountTag).toBe(credentials.accountId);
        expect(body.variables.scriptName).toMatch(/^osfo-(api|web)-production-/);
        expect(
          Date.parse(body.variables.datetimeEnd) - Date.parse(body.variables.datetimeStart),
        ).toBe(900_000);
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      dimensions: { scriptName: body.variables.scriptName },
                      sum: { requests: fixture.requests, errors: fixture.errors },
                    },
                  ],
                },
              ],
            },
          },
          errors: null,
        });
      }),
    );
    expect(result.map((value) => value.status)).toEqual([fixture.expected, "NOT_APPLICABLE"]);
  }),
);

it.effect.each([
  {
    name: "empty rows",
    body: { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } },
    status: 200,
    expected: "NO_DATA",
  },
  {
    name: "missing account",
    body: { data: { viewer: { accounts: [] } } },
    status: 200,
    expected: "UNAVAILABLE",
  },
  {
    name: "partial GraphQL error",
    body: {
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } },
      errors: [{ message: "private fixture" }],
    },
    status: 200,
    expected: "UNAVAILABLE",
  },
  { name: "HTTP permission denial", body: {}, status: 403, expected: "UNAVAILABLE" },
  { name: "redirect", body: {}, status: 302, expected: "UNAVAILABLE" },
  { name: "malformed response", body: {}, status: 200, expected: "UNAVAILABLE" },
])("does not turn $name into zero errors", (fixture) =>
  Effect.gen(function* () {
    const result = yield* checkRuntimeMetrics(credentials).pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async () =>
        Response.json(fixture.body, { status: fixture.status }),
      ),
    );
    expect(result.map((value) => value.status)).toEqual([fixture.expected, "NOT_APPLICABLE"]);
  }),
);

it.effect("missing credentials never make a request", () =>
  Effect.gen(function* () {
    const result = yield* checkRuntimeMetrics(undefined).pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        throw new Error("must not dispatch");
      }),
    );
    expect(result.map((value) => value.status)).toEqual(["MISSING", "NOT_APPLICABLE"]);
  }),
);

it.effect("bounds and cancels a stalled analytics body without retry", () =>
  Effect.gen(function* () {
    let cancelled = 0;
    const fiber = yield* checkRuntimeMetrics(credentials).pipe(
      Effect.provide(httpLayer),
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelled += 1;
              },
            }),
          ),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("11 seconds");
    expect((yield* Fiber.join(fiber)).map((value) => value.status)).toEqual([
      "UNAVAILABLE",
      "NOT_APPLICABLE",
    ]);
    expect(cancelled).toBe(1);
  }),
);

it.effect.each([
  { name: "oversized body", body: " ".repeat(65_537) },
  {
    name: "wrong script",
    body: JSON.stringify({
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptive: [
                { dimensions: { scriptName: "another-worker" }, sum: { requests: 1, errors: 0 } },
              ],
            },
          ],
        },
      },
    }),
  },
  {
    name: "unexpected multiple groups",
    body: JSON.stringify({
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptive: [1, 2].map(() => ({
                dimensions: { scriptName: "osfo-api-production-z523cwnu5fuebaer" },
                sum: { requests: 1, errors: 0 },
              })),
            },
          ],
        },
      },
    }),
  },
])("rejects $name rather than reporting a partial zero", (fixture) =>
  Effect.gen(function* () {
    const result = yield* checkRuntimeMetrics(credentials).pipe(
      Effect.provide(httpLayer),
      Effect.provideService(FetchHttpClient.Fetch, async () => new Response(fixture.body)),
    );
    expect(result).toEqual([
      { name: "API", status: "UNAVAILABLE" },
      { name: "Web", status: "NOT_APPLICABLE" },
    ]);
  }),
);
