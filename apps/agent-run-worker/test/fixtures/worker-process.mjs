import { NodeRuntime } from "@effect/platform-node";
import {
  ModelCallExecutor,
  makeAgentRunWorkerLayer,
  makeDeterministicModelCallExecutorLayer,
} from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { Deferred, Effect, Layer, Stream } from "effect";
import { runStreamingPullWorker, StreamingPullSource } from "../../dist/streaming-pull.js";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const delivery = JSON.parse(required("OSFO_FIXTURE_DELIVERY"));
const behavior = required("OSFO_FIXTURE_BEHAVIOR");
const completed = Deferred.makeUnsafe();
const sourceLayer = Layer.succeed(
  StreamingPullSource,
  StreamingPullSource.of({
    start: (handlers) =>
      Effect.sync(() => {
        handlers.onMessage({
          data: Buffer.from(JSON.stringify(delivery)),
          id: delivery.deliveryId,
          orderingKey: delivery.threadId,
          acknowledge: () => Deferred.doneUnsafe(completed, Effect.succeed("acknowledged")),
          nack: () => Deferred.doneUnsafe(completed, Effect.succeed("nacked")),
        });
      }),
    stop: () => Effect.void,
    close: () => Effect.void,
  }),
);
const executorLayer =
  behavior === "lost"
    ? Layer.succeed(
        ModelCallExecutor,
        ModelCallExecutor.of({
          execute: () =>
            Stream.make({ fragmentIndex: 0, text: "partial before process loss" }).pipe(
              Stream.concat(Stream.fromEffect(Effect.never)),
            ),
          cancel: () => Effect.uninterruptible(Effect.never),
        }),
      )
    : makeDeterministicModelCallExecutorLayer();
const repositoryLayer = makeAgentRunRepositoryLayer({
  databaseUrl: required("OSFO_DATABASE_URL"),
  maxConnections: 2,
});
const workerLayer = makeAgentRunWorkerLayer({
  executionProfileRef: "oz.deterministic.v1",
  workerId: required("OSFO_AGENT_RUN_WORKER_ID"),
  leaseDurationMs: Number(required("OSFO_AGENT_RUN_LEASE_DURATION_MS")),
  leaseRenewalIntervalMs: Number(required("OSFO_AGENT_RUN_LEASE_RENEWAL_INTERVAL_MS")),
  cancellationPollIntervalMs: Number(required("OSFO_AGENT_RUN_CANCELLATION_POLL_INTERVAL_MS")),
}).pipe(
  Layer.provide(repositoryLayer),
  Layer.provide(
    makeDeterministicAgentRuntimeLayer({
      executionProfileRef: "oz.deterministic.v1",
      modelBinding: "oz.deterministic.echo.v1",
    }),
  ),
  Layer.provide(executorLayer),
);

const program = Effect.raceFirst(
  runStreamingPullWorker({ executionSlots: 1 }),
  Deferred.await(completed).pipe(Effect.tap((outcome) => Effect.logInfo(`FIXTURE:${outcome}`))),
).pipe(Effect.asVoid, Effect.provide(workerLayer), Effect.provide(sourceLayer));

NodeRuntime.runMain(program);
