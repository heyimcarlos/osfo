import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { ModelCallExecutor, makeAgentRunWorkerLayer } from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { Config, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { resolveExecutionProfile, type OzExecutionProfile } from "./execution-profile.js";
import { makeOpenAIResponsesModelCallExecutorLayer } from "./openai-responses-model-call-executor.js";
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
  openAIApiKey: Config.option(Config.redacted("OPENAI_API_KEY")),
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

class InvalidWorkerExecutionProfile extends Data.TaggedError("InvalidWorkerExecutionProfile")<{
  readonly executionProfileRef: string;
  readonly cause: "unsupported" | "missingCredential";
}> {}

const modelCallExecutorLayer = (
  profile: OzExecutionProfile,
  openAIApiKey: Option.Option<Redacted.Redacted<string>>,
  cancellationGraceMs: number,
  terminationDeadlineMs: number,
): Effect.Effect<Layer.Layer<ModelCallExecutor>, InvalidWorkerExecutionProfile> => {
  switch (profile.type) {
    case "deterministic":
      return Effect.succeed(
        makeWorkerThreadModelCallExecutorLayer({
          cancellationGraceMs,
          source: deterministicModelCallWorkerSource,
          terminationDeadlineMs,
        }),
      );
    case "openaiResponses":
      if (Option.isNone(openAIApiKey)) {
        return Effect.fail(
          new InvalidWorkerExecutionProfile({
            executionProfileRef: profile.ref,
            cause: "missingCredential",
          }),
        );
      }
      return Effect.succeed(
        makeOpenAIResponsesModelCallExecutorLayer({
          apiKey: Redacted.value(openAIApiKey.value),
          profile,
        }).pipe(Layer.provide(NodeHttpClient.layerUndici)),
      );
  }
};

const program = WorkerConfig.pipe(
  Effect.flatMap((config) => {
    const profile = resolveExecutionProfile(config.executionProfileRef);
    if (profile === undefined) {
      return Effect.fail(
        new InvalidWorkerExecutionProfile({
          executionProfileRef: config.executionProfileRef,
          cause: "unsupported",
        }),
      );
    }
    return modelCallExecutorLayer(
      profile,
      config.openAIApiKey,
      config.cancellationGraceMs,
      config.terminationDeadlineMs,
    ).pipe(
      Effect.flatMap((executorLayer) => {
        const repositoryLayer = makeAgentRunRepositoryLayer({
          databaseUrl: config.databaseUrl,
          maxConnections: config.databasePoolMax,
        });
        const workerLayer = makeAgentRunWorkerLayer({
          executionProfileRef: config.executionProfileRef,
          modelCallAttemptLimit: profile.retry.modelCallAttempts,
          workerId: config.workerId,
          leaseDurationMs: config.leaseDurationMs,
          leaseRenewalIntervalMs: config.leaseRenewalIntervalMs,
          cancellationPollIntervalMs: config.cancellationPollIntervalMs,
        }).pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(
            makeDeterministicAgentRuntimeLayer({
              executionProfileRef: config.executionProfileRef,
              modelBinding: profile.modelBinding,
            }),
          ),
          Layer.provide(executorLayer),
        );
        const sourceLayer = makeGoogleStreamingPullSourceLayer({
          closeTimeoutMs: config.terminationDeadlineMs,
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
  }),
);

NodeRuntime.runMain(program);
