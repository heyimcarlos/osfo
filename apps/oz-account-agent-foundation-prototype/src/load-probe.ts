import { Config, Data, Effect, Redacted, Schema } from "effect";
import * as Exit from "effect/Exit";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

const Identity = Schema.NonEmptyString.check(Schema.isMaxLength(512));
const BindingResponse = Schema.Struct({
  agentId: Identity,
  bound: Schema.Boolean,
  channelIdentity: Identity,
});
const MessageResponse = Schema.Struct({
  agentId: Identity,
  receipt: Schema.Struct({
    accepted: Schema.Boolean,
    status: Identity,
    submissionId: Identity,
  }),
});
const StateResponse = Schema.Struct({
  submissions: Schema.Array(
    Schema.Struct({
      completedAt: Schema.optionalKey(Schema.Number),
      createdAt: Schema.Number,
      idempotencyKey: Identity,
      startedAt: Schema.optionalKey(Schema.Number),
      status: Identity,
      submissionId: Identity,
    }),
  ),
});
const OpenRouterKeyResponse = Schema.Struct({
  data: Schema.Struct({
    is_free_tier: Schema.Boolean,
    usage: Schema.Number,
  }),
});

class LoadProbeHttpError extends Data.TaggedError("LoadProbeHttpError")<{
  readonly operation: string;
  readonly status: number;
}> {}

class LoadProbeEvidenceError extends Data.TaggedError("LoadProbeEvidenceError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

type Distribution = {
  readonly count: number;
  readonly maximum: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
};

type Lane = {
  readonly durationSeconds: number;
  readonly name: string;
  readonly ratePerSecond: number;
};

type RequestObservation = {
  readonly accepted: boolean;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly offeredAt: string;
  readonly ordinal: number;
  readonly scheduledAt: string;
  readonly schedulerLagMs: number;
  readonly status: string;
};

const fullLanes: readonly Lane[] = [
  { durationSeconds: 10, name: "warm-up-23", ratePerSecond: 23 },
  { durationSeconds: 60, name: "target-232", ratePerSecond: 232 },
  { durationSeconds: 15, name: "stress-464", ratePerSecond: 464 },
  { durationSeconds: 10, name: "post-stress-23", ratePerSecond: 23 },
];
const smokeLanes: readonly Lane[] = [
  { durationSeconds: 3, name: "model-smoke-1", ratePerSecond: 1 },
];

const percentile = (sorted: readonly number[], quantile: number): number => {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
};

const distribution = (samples: readonly number[]): Distribution => {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    maximum: sorted.at(-1) ?? 0,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const bodyJson = <A, I>(
  schema: Schema.Codec<A, I, never>,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.status === 200
    ? HttpClientResponse.schemaBodyJson(schema)(response)
    : Effect.fail(
        new LoadProbeHttpError({
          operation: "receive successful response",
          status: response.status,
        }),
      );

const makeBindAccount = (client: HttpClient.HttpClient, origin: string, authorization: string) =>
  Effect.fn("loadProbe.bindAccount")(function* (input: {
    readonly agentId: string;
    readonly channelIdentity: string;
  }) {
    const response = yield* client.execute(
      HttpClientRequest.post(`${origin}/bindings`).pipe(
        HttpClientRequest.setHeader("authorization", authorization),
        HttpClientRequest.bodyJsonUnsafe(input),
      ),
    );
    return yield* bodyJson(BindingResponse, response);
  });

const makeSendMessage = (client: HttpClient.HttpClient, origin: string, authorization: string) =>
  Effect.fn("loadProbe.sendMessage")(function* (input: {
    readonly channelIdentity: string;
    readonly messageId: string;
    readonly text: string;
  }) {
    const response = yield* client.execute(
      HttpClientRequest.post(`${origin}/messages`).pipe(
        HttpClientRequest.setHeader("authorization", authorization),
        HttpClientRequest.bodyJsonUnsafe(input),
      ),
    );
    return yield* bodyJson(MessageResponse, response);
  });

const makeReadState = (client: HttpClient.HttpClient, origin: string, authorization: string) =>
  Effect.fn("loadProbe.readState")(function* (agentId: string) {
    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/agents/${encodeURIComponent(agentId)}/state`).pipe(
        HttpClientRequest.setHeader("authorization", authorization),
      ),
    );
    return yield* bodyJson(StateResponse, response);
  });

const makeReadOpenRouterUsage = (client: HttpClient.HttpClient, authorization: string) =>
  Effect.fn("loadProbe.readOpenRouterUsage")(function* () {
    const response = yield* client.execute(
      HttpClientRequest.get("https://openrouter.ai/api/v1/key").pipe(
        HttpClientRequest.setHeader("authorization", authorization),
      ),
    );
    return yield* bodyJson(OpenRouterKeyResponse, response);
  });

const runLane = async (input: {
  readonly accounts: readonly { readonly channelIdentity: string }[];
  readonly lane: Lane;
  readonly runId: string;
  readonly sendMessage: ReturnType<typeof makeSendMessage>;
}) => {
  const offered = input.lane.ratePerSecond * input.lane.durationSeconds;
  const startsAt = performance.now() + 1_000;
  const startsAtWallClock = Date.now() + 1_000;
  let inFlight = 0;
  let maximumInFlight = 0;
  const tasks = Array.from({ length: offered }, (_, index) => {
    const scheduledAt = startsAt + (index * 1_000) / input.lane.ratePerSecond;
    return (async (): Promise<RequestObservation> => {
      await sleep(Math.max(0, scheduledAt - performance.now()));
      const startedAt = performance.now();
      const offeredAt = new Date().toISOString();
      const account = input.accounts[index % input.accounts.length];
      if (account === undefined) {
        return {
          accepted: false,
          completedAt: new Date().toISOString(),
          latencyMs: 0,
          offeredAt,
          ordinal: index,
          scheduledAt: new Date(
            startsAtWallClock + (index * 1_000) / input.lane.ratePerSecond,
          ).toISOString(),
          schedulerLagMs: startedAt - scheduledAt,
          status: "missing_account",
        };
      }
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      const exit = await Effect.runPromiseExit(
        input.sendMessage({
          channelIdentity: account.channelIdentity,
          messageId: `${input.runId}:${input.lane.name}:${index}`,
          text: "Load characterization message.",
        }),
      );
      inFlight -= 1;
      const latencyMs = performance.now() - startedAt;
      if (Exit.isFailure(exit)) {
        return {
          accepted: false,
          completedAt: new Date().toISOString(),
          latencyMs,
          offeredAt,
          ordinal: index,
          scheduledAt: new Date(
            startsAtWallClock + (index * 1_000) / input.lane.ratePerSecond,
          ).toISOString(),
          schedulerLagMs: startedAt - scheduledAt,
          status: "effect_failure",
        };
      }
      return {
        accepted: exit.value.receipt.accepted,
        completedAt: new Date().toISOString(),
        latencyMs,
        offeredAt,
        ordinal: index,
        scheduledAt: new Date(
          startsAtWallClock + (index * 1_000) / input.lane.ratePerSecond,
        ).toISOString(),
        schedulerLagMs: startedAt - scheduledAt,
        status: exit.value.receipt.status,
      };
    })();
  });
  const observations = await Promise.all(tasks);
  const accepted = observations.filter((observation) => observation.accepted).length;
  const withinThreshold = observations.filter(
    (observation) => observation.accepted && observation.latencyMs <= 1_000,
  ).length;
  const statusCounts = Object.fromEntries(
    [...new Set(observations.map((observation) => observation.status))]
      .sort()
      .map((status) => [
        status,
        observations.filter((observation) => observation.status === status).length,
      ]),
  );
  const withinThresholdRatio = withinThreshold / offered;
  return {
    observations,
    summary: {
      accepted,
      callerToReceiptMs: distribution(observations.map((observation) => observation.latencyMs)),
      completeAcceptance: accepted === offered,
      durationSeconds: input.lane.durationSeconds,
      maximumInFlight,
      name: input.lane.name,
      offered,
      ratePerSecond: input.lane.ratePerSecond,
      receiptSlo: {
        thresholdMs: 1_000,
        verdict: withinThresholdRatio >= 0.999 ? "PASS" : "FAIL",
        withinThreshold,
        withinThresholdRatio,
      },
      schedulerLagMs: distribution(observations.map((observation) => observation.schedulerLagMs)),
      statusCounts,
      verdict: accepted === offered && withinThresholdRatio >= 0.999 ? "PASS" : "FAIL",
    } as const,
  };
};

const collectTerminalAudit = (input: {
  readonly accounts: readonly { readonly agentId: string }[];
  readonly expected: number;
  readonly readState: ReturnType<typeof makeReadState>;
  readonly runId: string;
}) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 15 * 60_000;
    let matching: ReadonlyArray<(typeof StateResponse.Type.submissions)[number]> = [];
    while (true) {
      const states = yield* Effect.forEach(
        input.accounts,
        (account) => input.readState(account.agentId),
        { concurrency: 64 },
      );
      matching = states
        .flatMap((state) => state.submissions)
        .filter((submission) => submission.idempotencyKey.startsWith(`whatsapp:${input.runId}:`));
      const terminal = matching.filter((submission) =>
        ["aborted", "completed", "error", "failed"].includes(submission.status),
      ).length;
      yield* Effect.sync(() =>
        console.log(`terminal drain: ${terminal}/${input.expected}, observed ${matching.length}`),
      );
      if (matching.length === input.expected && terminal === input.expected) break;
      if (Date.now() >= deadline) break;
      yield* Effect.promise(() => sleep(10_000));
    }

    const unique = new Map(matching.map((submission) => [submission.submissionId, submission]));
    const submissions = [...unique.values()];
    const statusCounts = Object.fromEntries(
      [...new Set(submissions.map((submission) => submission.status))]
        .sort()
        .map((status) => [
          status,
          submissions.filter((submission) => submission.status === status).length,
        ]),
    );
    const completed = submissions.filter(
      (submission) => submission.status === "completed" && submission.completedAt !== undefined,
    );
    const terminalDurationMs = completed.map(
      (submission) => (submission.completedAt ?? submission.createdAt) - submission.createdAt,
    );
    const queueDurationMs = completed
      .filter((submission) => submission.startedAt !== undefined)
      .map((submission) => (submission.startedAt ?? submission.createdAt) - submission.createdAt);
    const modelDurationMs = completed
      .filter(
        (submission) => submission.startedAt !== undefined && submission.completedAt !== undefined,
      )
      .map(
        (submission) =>
          (submission.completedAt ?? submission.createdAt) -
          (submission.startedAt ?? submission.createdAt),
      );
    const missing = Math.max(0, input.expected - submissions.length);
    const failed = submissions.filter((submission) =>
      ["error", "failed"].includes(submission.status),
    ).length;
    const nonterminal = submissions.filter(
      (submission) => !["aborted", "completed", "error", "failed"].includes(submission.status),
    ).length;
    return {
      completed: completed.length,
      duplicateSubmissionIds: matching.length - submissions.length,
      expected: input.expected,
      failed,
      missing,
      modelDurationMs: distribution(modelDurationMs),
      nonterminal,
      observed: submissions.length,
      queueDurationMs: distribution(queueDurationMs),
      statusCounts,
      terminalDurationMs: distribution(terminalDurationMs),
      verdict:
        completed.length === input.expected && failed === 0 && missing === 0 && nonterminal === 0
          ? "PASS"
          : "FAIL",
    } as const;
  });

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const writeEvidenceBundle = (input: {
  readonly accountCount: number;
  readonly completedAt: string;
  readonly comparison: Record<string, unknown>;
  readonly laneRuns: ReadonlyArray<Awaited<ReturnType<typeof runLane>>>;
  readonly modelUsage: Record<string, unknown>;
  readonly outputDirectory: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly startedAt: string;
  readonly terminalAudit: Record<string, unknown> & {
    readonly completed: number;
  };
  readonly verdict: string;
}) =>
  Effect.tryPromise({
    catch: (cause) => new LoadProbeEvidenceError({ cause, operation: "write load evidence" }),
    try: async () => {
      const files = new Map<string, Buffer>();
      const summaries = input.laneRuns.map((laneRun) => laneRun.summary);
      for (const laneRun of input.laneRuns) {
        const lane = laneRun.summary;
        files.set(
          `runs/${lane.name}/scenario.json`,
          json({
            account_count: input.accountCount,
            arrival_pattern: "uniform-open-loop",
            benchmark_id: input.runId,
            candidate: "cloudflare-think-account-agent",
            count: lane.offered,
            duration_seconds: lane.durationSeconds,
            lane: lane.name,
            manifest: "oz-cloudflare-account-agent-load-v1",
            model: "openai/gpt-5-nano",
            rate_per_second: lane.ratePerSecond,
          }),
        );
        files.set(
          `runs/${lane.name}/caller-summary.json`,
          json({
            count: lane.offered,
            latency_ms: {
              count: lane.callerToReceiptMs.count,
              max: lane.callerToReceiptMs.maximum,
              p50: lane.callerToReceiptMs.p50,
              p90: lane.callerToReceiptMs.p90,
              p95: lane.callerToReceiptMs.p95,
              p99: lane.callerToReceiptMs.p99,
            },
            maximum_in_flight: lane.maximumInFlight,
            outcomes: [
              { count: lane.accepted, outcome: "accepted" },
              { count: lane.offered - lane.accepted, outcome: "unknown" },
            ],
            scheduler_lag_ms: {
              count: lane.schedulerLagMs.count,
              max: lane.schedulerLagMs.maximum,
              p50: lane.schedulerLagMs.p50,
              p90: lane.schedulerLagMs.p90,
              p95: lane.schedulerLagMs.p95,
              p99: lane.schedulerLagMs.p99,
            },
          }),
        );
        const samples = laneRun.observations
          .map((observation) =>
            JSON.stringify({
              caller_outcome: observation.accepted ? "accepted" : "unknown",
              completed_at: observation.completedAt,
              error_class: observation.accepted ? undefined : observation.status,
              http_attempts: 1,
              latency_ms: observation.latencyMs,
              offered_at: observation.offeredAt,
              ordinal: observation.ordinal,
              scheduled_at: observation.scheduledAt,
              scheduler_lag_ms: observation.schedulerLagMs,
              status: observation.accepted ? 200 : 0,
            }),
          )
          .join("\n");
        files.set(`runs/${lane.name}/caller-samples.jsonl.gz`, gzipSync(`${samples}\n`));
      }

      files.set(
        "receipt-slo.json",
        json({
          derivation:
            "Count accepted caller samples at or below the 1000 ms durable receipt threshold.",
          runs: input.laneRuns.map(({ observations, summary }) => ({
            caller_samples_sha256: sha256(
              files.get(`runs/${summary.name}/caller-samples.jsonl.gz`) ?? Buffer.alloc(0),
            ),
            over_threshold: observations.filter(
              (observation) => !observation.accepted || observation.latencyMs > 1_000,
            ).length,
            run: summary.name,
            total: summary.offered,
            within_threshold_ratio: summary.receiptSlo.withinThresholdRatio,
          })),
          schema_version: 1,
          threshold_ms: 1_000,
        }),
      );
      files.set("terminal-audit.json", json(input.terminalAudit));
      files.set("comparison.json", json(input.comparison));
      files.set("model-usage.json", json(input.modelUsage));
      files.set(
        "manifest.json",
        json({
          benchmark_id: input.runId,
          candidate: "cloudflare-think-account-agent",
          completed_at: input.completedAt,
          environment: "live-cloudflare-non-production",
          model: "openai/gpt-5-nano",
          output_token_cap: 8,
          schema_version: 1,
          source_revision: input.sourceRevision,
          started_at: input.startedAt,
          verdict: input.verdict,
        }),
      );
      files.set(
        "results.json",
        json(
          (() => {
            const target = summaries.find((lane) => lane.name === "target-232");
            return {
              accepted: target?.accepted,
              admission_latency: target
                ? {
                    p95_ms: target.callerToReceiptMs.p95,
                    p99_ms: target.callerToReceiptMs.p99,
                  }
                : undefined,
              comparison: input.comparison,
              completed: input.terminalAudit.completed,
              duration_seconds: target?.durationSeconds,
              lanes: summaries,
              modelUsage: input.modelUsage,
              offered: target?.offered,
              rate_per_second: target?.ratePerSecond,
              rejected_or_failed:
                target === undefined ? undefined : target.offered - target.accepted,
              runId: input.runId,
              terminalAudit: input.terminalAudit,
              verdict: input.verdict,
            };
          })(),
        ),
      );
      const targetLane = summaries.find((lane) => lane.name === "target-232");
      const evidenceMarkdown = `# Cloudflare account-agent live load evidence

- Source revision: \`${input.sourceRevision}\`
- Environment: live Cloudflare, non-production
- Model: \`openai/gpt-5-nano\` through OpenRouter, eight output tokens maximum
- Overall verdict: **${input.verdict}**

| Lane | Offered | Accepted | Receipt p95 ms | Receipt p99 ms | Within 1s | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${summaries
  .map(
    (lane) =>
      `| ${lane.name} | ${lane.offered} | ${lane.accepted} | ${lane.callerToReceiptMs.p95.toFixed(3)} | ${lane.callerToReceiptMs.p99.toFixed(3)} | ${(lane.receiptSlo.withinThresholdRatio * 100).toFixed(5)}% | ${lane.verdict} |`,
  )
  .join("\n")}

The frozen GCP short target accepted 13,920 messages at 232/s with caller-to-receipt p95 20.435 ms and p99 91.173 ms. The matched Cloudflare target recorded p95 ${targetLane?.callerToReceiptMs.p95.toFixed(3) ?? "MISSING"} ms and p99 ${targetLane?.callerToReceiptMs.p99.toFixed(3) ?? "MISSING"} ms.

The terminal audit records acceptance-to-completion, queue, and model duration separately. The Cloudflare workload maps one message to one account-agent turn. The GCP workload derived 1.5 AgentRuns per incoming message. This run is a topology characterization from a Toronto client, not production qualification.
`;
      files.set("EVIDENCE.md", Buffer.from(evidenceMarkdown));

      const outputDirectory = resolve(input.outputDirectory);
      await mkdir(outputDirectory, { recursive: true });
      for (const [path, contents] of [...files.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const target = resolve(outputDirectory, path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, contents);
      }
      const checksums = [...files.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, contents]) => `${sha256(contents)}  ./${path}`)
        .join("\n");
      await writeFile(resolve(outputDirectory, "SHA256SUMS"), `${checksums}\n`, "utf8");
    },
  });

const program = Effect.gen(function* () {
  const origin = (yield* Config.string("OZ_LOAD_ORIGIN")).replace(/\/$/, "");
  const token = yield* Config.redacted("OZ_LOAD_TOKEN");
  const openRouterApiKey = yield* Config.redacted("OPENROUTER_API_KEY");
  const outputDirectory = yield* Config.string("OZ_LOAD_OUTPUT_DIR").pipe(
    Config.withDefault("evidence/cloudflare-live-load"),
  );
  const sourceRevision = yield* Config.string("OZ_LOAD_SOURCE_REVISION").pipe(
    Config.withDefault("working-tree"),
  );
  const profile = yield* Config.string("OZ_LOAD_PROFILE").pipe(Config.withDefault("full"));
  const selectedLanes = profile === "smoke" ? smokeLanes : fullLanes;
  const accountCount = profile === "smoke" ? 8 : 1_024;
  const client = yield* HttpClient.HttpClient;
  const authorization = `Bearer ${Redacted.value(token)}`;
  const bindAccount = makeBindAccount(client, origin, authorization);
  const readOpenRouterUsage = makeReadOpenRouterUsage(
    client,
    `Bearer ${Redacted.value(openRouterApiKey)}`,
  );
  const readState = makeReadState(client, origin, authorization);
  const sendMessage = makeSendMessage(client, origin, authorization);
  const runId = crypto.randomUUID();
  const accounts = Array.from({ length: accountCount }, (_, index) => ({
    agentId: `load:${runId}:account:${index}`,
    channelIdentity: `load:${runId}:channel:${index}`,
  }));

  yield* Effect.forEach(accounts, bindAccount, { concurrency: 32, discard: true });
  const usageBefore = yield* readOpenRouterUsage();
  const startedAt = new Date().toISOString();
  const laneRuns = [];
  for (const lane of selectedLanes) {
    const laneRun = yield* Effect.promise(() => runLane({ accounts, lane, runId, sendMessage }));
    laneRuns.push(laneRun);
    const result = laneRun.summary;
    yield* Effect.sync(() => {
      console.log(
        `${result.name}: ${result.verdict}, accepted ${result.accepted}/${result.offered}, p95 ${result.callerToReceiptMs.p95.toFixed(3)} ms, p99 ${result.callerToReceiptMs.p99.toFixed(3)} ms`,
      );
    });
  }

  const expected = laneRuns.reduce((total, laneRun) => total + laneRun.summary.offered, 0);
  const terminalAudit = yield* collectTerminalAudit({ accounts, expected, readState, runId });
  yield* Effect.promise(() => sleep(30_000));
  const usageAfter = yield* readOpenRouterUsage();
  const comparison = {
    gcp: {
      artifact:
        "prototypes/pubsub-worker-seam/evidence/b3-flow-control-8/load/warm-target-qualified-232-1/audit.json",
      callerToReceiptMs: { maximum: 385.255, p50: 11.6865, p95: 20.435, p99: 91.17282 },
      offered: 13_920,
      ratePerSecond: 232,
      verdict: "PASS",
    },
    limitations: [
      "Both target lanes measure caller-to-durable-receipt latency under open-loop arrivals.",
      "The Cloudflare lane maps one message to one account-agent turn; the GCP lane derived 1.5 AgentRuns per incoming message.",
      "The Cloudflare deployment uses OpenRouter with openai/gpt-5-nano and an eight-token output cap.",
      "The client ran from the local Toronto development host; this is a characterization, not production qualification.",
    ],
  };
  const modelUsage = {
    isFreeTier: usageAfter.data.is_free_tier,
    measuredCostUsd: Math.max(0, usageAfter.data.usage - usageBefore.data.usage),
    usageAfterUsd: usageAfter.data.usage,
    usageBeforeUsd: usageBefore.data.usage,
  };
  const receiptVerdict = laneRuns.every((laneRun) => laneRun.summary.verdict === "PASS");
  const verdict = receiptVerdict && terminalAudit.verdict === "PASS" ? "PASS" : "FAIL";
  const completedAt = new Date().toISOString();
  yield* writeEvidenceBundle({
    accountCount,
    completedAt,
    comparison,
    laneRuns,
    modelUsage,
    outputDirectory,
    runId,
    sourceRevision,
    startedAt,
    terminalAudit,
    verdict,
  });
  yield* Effect.sync(() => {
    console.log(
      `terminal: ${terminalAudit.verdict}, completed ${terminalAudit.completed}/${terminalAudit.expected}, p95 ${terminalAudit.terminalDurationMs.p95.toFixed(3)} ms, p99 ${terminalAudit.terminalDurationMs.p99.toFixed(3)} ms`,
    );
    console.log(`OpenRouter measured cost: $${modelUsage.measuredCostUsd.toFixed(6)}`);
    console.log(`Evidence: ${resolve(outputDirectory)}`);
  });
}).pipe(Effect.provide(FetchHttpClient.layer));

await Effect.runPromise(program);
