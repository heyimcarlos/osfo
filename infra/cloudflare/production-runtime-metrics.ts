import { Clock, Data, DateTime, Effect, type Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

class MetricsUnavailable extends Data.TaggedError("MetricsUnavailable") {}

export const scripts = [
  { name: "API", scriptName: "osfo-api-production-z523cwnu5fuebaer" },
  { name: "Web", scriptName: "osfo-web-production-hxz26hpoghafseuv" },
] as const;

export interface Credentials {
  readonly accountId: string;
  readonly token: Redacted.Redacted;
}

const Row = Schema.Struct({
  dimensions: Schema.Struct({ scriptName: Schema.String }),
  sum: Schema.Struct({
    requests: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    errors: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});
const Response = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  data: Schema.Struct({
    viewer: Schema.Struct({
      accounts: Schema.Array(Schema.Struct({ workersInvocationsAdaptive: Schema.Array(Row) })),
    }),
  }),
});

// Group only by script: no timestamp/status dimensions that could truncate a busy window.
export const query = `query RuntimeErrors($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    workersInvocationsAdaptive(limit: 2, filter: {
      scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd
    }) { dimensions { scriptName } sum { requests errors } }
  } }
}`;

/** Adaptive metrics are delayed observations, not a five-minute availability guarantee. */
export const checkRuntimeMetrics = Effect.fn("ProductionMonitor.checkRuntimeMetrics")(function* (
  credentials: Credentials | undefined,
) {
  const now = yield* Clock.currentTimeMillis;
  const datetimeEnd = DateTime.formatIso(DateTime.makeUnsafe(now - 5 * 60_000));
  const datetimeStart = DateTime.formatIso(DateTime.makeUnsafe(now - 20 * 60_000));
  return yield* Effect.forEach(
    scripts,
    (script) =>
      Effect.gen(function* () {
        // Verified production Web deployment serves assets only, without Worker code.
        if (script.name === "Web") return { name: script.name, status: "NOT_APPLICABLE" as const };
        if (credentials === undefined) return { name: script.name, status: "MISSING" as const };
        const status = yield* readMetrics(
          credentials,
          script.scriptName,
          datetimeStart,
          datetimeEnd,
        );
        return { name: script.name, status };
      }),
    { concurrency: 2 },
  );
});

const readMetrics = Effect.fn("ProductionMonitor.readMetrics")(
  function* (
    credentials: Credentials,
    scriptName: string,
    datetimeStart: string,
    datetimeEnd: string,
  ) {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(
      "https://api.cloudflare.com/client/v4/graphql",
    ).pipe(
      HttpClientRequest.bearerToken(credentials.token),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyJson({
        query,
        variables: { accountTag: credentials.accountId, scriptName, datetimeStart, datetimeEnd },
      }),
    );
    const response = yield* client.execute(request);
    if (response.status !== 200) return yield* new MetricsUnavailable();
    const bytes = yield* Stream.runFoldEffect(
      response.stream,
      () => new Uint8Array(0),
      (body, chunk) => {
        if (body.byteLength + chunk.byteLength > 65_536)
          return Effect.fail(new MetricsUnavailable());
        const joined = new Uint8Array(body.byteLength + chunk.byteLength);
        joined.set(body);
        joined.set(chunk, body.byteLength);
        return Effect.succeed(joined);
      },
    );
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Response))(
      new TextDecoder().decode(bytes),
    );
    if (decoded.errors !== undefined && decoded.errors !== null && decoded.errors.length > 0)
      return yield* new MetricsUnavailable();
    if (decoded.data.viewer.accounts.length !== 1) return yield* new MetricsUnavailable();
    const rows = decoded.data.viewer.accounts[0]?.workersInvocationsAdaptive;
    if (rows === undefined || rows.length > 1) return yield* new MetricsUnavailable();
    const row = rows[0];
    if (row === undefined) return "NO_DATA" as const;
    if (row.dimensions.scriptName !== scriptName || row.sum.errors > row.sum.requests)
      return yield* new MetricsUnavailable();
    if (row.sum.errors > 0) return "FAIL" as const;
    return row.sum.requests > 0 ? ("PASS" as const) : ("NO_DATA" as const);
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => "UNAVAILABLE" as const),
);
