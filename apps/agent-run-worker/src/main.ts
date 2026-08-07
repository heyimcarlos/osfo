import { NodeRuntime } from "@effect/platform-node";
import { makeAgentRunWorkerLayer } from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { Config, Effect, Layer, Schema } from "effect";
import { makeGoogleStreamingPullSourceLayer, runStreamingPullWorker } from "./streaming-pull.js";
import {
  deterministicModelCallWorkerSource,
  makeWorkerThreadModelCallExecutorLayer,
} from "./worker-thread-model-call-executor.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const DatabasePoolMax = PositiveInteger.check(Schema.isLessThanOrEqualTo(8));

const WorkerConfig = Config.all({
  databasePoolMax: Config.schema(DatabasePoolMax, "OSFO_DATABASE_POOL_MAX").pipe(
    Config.withDefault(8),
  ),
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  executionProfileRef: Config.nonEmptyString("OSFO_EXECUTION_PROFILE_REF"),
  executionSlots: Config.schema(PositiveInteger, "OSFO_AGENT_RUN_EXECUTION_SLOTS").pipe(
    Config.withDefault(32),
  ),
  leaseDurationMs: Config.schema(PositiveInteger, "OSFO_AGENT_RUN_LEASE_DURATION_MS").pipe(
    Config.withDefault(30_000),
  ),
  leaseRenewalIntervalMs: Config.schema(
    PositiveInteger,
    "OSFO_AGENT_RUN_LEASE_RENEWAL_INTERVAL_MS",
  ).pipe(Config.withDefault(10_000)),
  cancellationPollIntervalMs: Config.schema(
    PositiveInteger,
    "OSFO_AGENT_RUN_CANCELLATION_POLL_INTERVAL_MS",
  ).pipe(Config.withDefault(100)),
  cancellationGraceMs: Config.schema(PositiveInteger, "OSFO_AGENT_RUN_CANCELLATION_GRACE_MS").pipe(
    Config.withDefault(100),
  ),
  modelBinding: Config.nonEmptyString("OSFO_MODEL_BINDING"),
  projectId: Config.nonEmptyString("OSFO_PUBSUB_PROJECT_ID"),
  streamCount: Config.schema(PositiveInteger, "OSFO_PUBSUB_STREAM_COUNT").pipe(
    Config.withDefault(4),
  ),
  subscriptionId: Config.nonEmptyString("OSFO_PUBSUB_SUBSCRIPTION_ID"),
  terminationDeadlineMs: Config.schema(
    PositiveInteger,
    "OSFO_AGENT_RUN_TERMINATION_DEADLINE_MS",
  ).pipe(Config.withDefault(1_000)),
  workerId: Config.nonEmptyString("OSFO_AGENT_RUN_WORKER_ID"),
});

const program = WorkerConfig.pipe(
  Effect.flatMap((config) => {
    const repositoryLayer = makeAgentRunRepositoryLayer({
      databaseUrl: config.databaseUrl,
      maxConnections: config.databasePoolMax,
    });
    const workerLayer = makeAgentRunWorkerLayer({
      executionProfileRef: config.executionProfileRef,
      workerId: config.workerId,
      leaseDurationMs: config.leaseDurationMs,
      leaseRenewalIntervalMs: config.leaseRenewalIntervalMs,
      cancellationPollIntervalMs: config.cancellationPollIntervalMs,
    }).pipe(
      Layer.provide(repositoryLayer),
      Layer.provide(
        makeDeterministicAgentRuntimeLayer({
          executionProfileRef: config.executionProfileRef,
          modelBinding: config.modelBinding,
        }),
      ),
      Layer.provide(
        makeWorkerThreadModelCallExecutorLayer({
          cancellationGraceMs: config.cancellationGraceMs,
          source: deterministicModelCallWorkerSource,
          terminationDeadlineMs: config.terminationDeadlineMs,
        }),
      ),
    );
    const sourceLayer = makeGoogleStreamingPullSourceLayer({
      projectId: config.projectId,
      subscriptionId: config.subscriptionId,
      streamCount: config.streamCount,
      maxOutstandingMessages: config.executionSlots,
    });

    return Effect.logInfo(
      `OSFO_AGENT_RUN_WORKER_TOPOLOGY:streams=${config.streamCount}:executionSlots=${config.executionSlots}:databasePoolMax=${config.databasePoolMax}`,
    ).pipe(
      Effect.andThen(
        runStreamingPullWorker({
          drainTimeoutMs: config.terminationDeadlineMs,
          executionSlots: config.executionSlots,
        }),
      ),
      Effect.provide(workerLayer),
      Effect.provide(sourceLayer),
    );
  }),
);

NodeRuntime.runMain(program);
