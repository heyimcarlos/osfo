import { runMain } from "@effect/platform-bun/BunRuntime";
import {
  Config,
  Console,
  Data,
  Effect,
  Layer,
  Redacted,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { checkRuntimeMetrics } from "./production-runtime-metrics";

class ProbeFailed extends Data.TaggedError("ProbeFailed") {}

// The probe requires the production identity, not just a successful HTTP status.
const ProductionRuntime = Schema.Struct({
  activationId: Schema.NonEmptyString,
  executionUnit: Schema.Literal("worker"),
  identity: Schema.Literal("request"),
  kind: Schema.Literal("RuntimeProbe"),
  stage: Schema.Literal("production"),
});

const targets = [
  { name: "API", url: "https://api.osfo.ai/health" },
  { name: "Web", url: "https://osfo.ai/" },
] as const;

export const coverageGap =
  "Runtime metrics cover delayed sampled Worker invocations only; NO_DATA is not zero errors. Database, providers and user journeys are not checked.";

export const httpLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual", cache: "no-store" }),
  ),
);

/** Check both public surfaces even when one fails; each GET gets one bounded retry. */
export const checkAvailability = Effect.fn("ProductionMonitor.checkAvailability")(function* () {
  return yield* Effect.forEach(
    targets,
    (target) =>
      probe(target).pipe(
        Effect.retry(Schedule.recurs(1).pipe(Schedule.addDelay(() => Effect.succeed("2 seconds")))),
        Effect.result,
        Effect.map((result) => ({ name: target.name, available: Result.isSuccess(result) })),
      ),
    { concurrency: 2 },
  );
});

const probe = Effect.fn("ProductionMonitor.probe")(
  function* (target: (typeof targets)[number]) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClient.withScope(http).get(target.url, {
      headers: { "cache-control": "no-cache" },
    });
    if (response.status !== 200) return yield* new ProbeFailed();
    const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== (target.name === "API" ? "application/json" : "text/html"))
      return yield* new ProbeFailed();

    const decoder = new TextDecoder();
    const body = yield* Stream.runFoldEffect(
      response.stream,
      () => ({ bytes: 0, text: "" }),
      (accumulator, chunk) => {
        const bytes = accumulator.bytes + chunk.byteLength;
        if (bytes > 262_144) return Effect.fail(new ProbeFailed());
        return Effect.succeed({
          bytes,
          text: accumulator.text + decoder.decode(chunk, { stream: true }),
        });
      },
    );
    const text = body.text + decoder.decode();
    if (target.name === "API") {
      yield* Schema.decodeEffect(Schema.fromJsonString(ProductionRuntime))(text);
      return undefined;
    }
    if (!text.includes("<title>Osfo</title>") || !text.includes('<div id="root"></div>'))
      return yield* new ProbeFailed();
    return undefined;
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
);

const main = Effect.gen(function* () {
  const results = yield* checkAvailability();
  const accountId = yield* Config.string("CLOUDFLARE_ANALYTICS_ACCOUNT_ID").pipe(
    Config.withDefault(""),
  );
  const token = yield* Config.redacted("CLOUDFLARE_ANALYTICS_API_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  );
  const credentials =
    /^[a-f0-9]{32}$/.test(accountId) && Redacted.value(token).length > 0
      ? { accountId, token }
      : undefined;
  const metrics = yield* checkRuntimeMetrics(credentials);
  yield* Effect.forEach(metrics, (result) =>
    Console.log(`${result.name} runtime errors: ${result.status}`),
  );
  yield* Console.log(`::warning::${coverageGap}`);
  yield* Effect.forEach(results, (result) =>
    Console.log(`${result.name} HTTPS availability: ${result.available ? "PASS" : "FAIL"}`),
  );
  // Only fixed classifications reach public CI logs, never response bodies or causes.
  if (
    results.some((result) => !result.available) ||
    metrics.some((result) => result.status !== "PASS" && result.status !== "NOT_APPLICABLE")
  )
    yield* Effect.sync(() => {
      process.exitCode = 1;
    });
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This is the monitor's process entry point.
  Effect.provide(httpLayer),
);

if (import.meta.main) runMain(main);
