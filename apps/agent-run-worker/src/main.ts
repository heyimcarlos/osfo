import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { makeAgentRunWorkerLayer, makeDeterministicModelCallExecutorLayer } from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { createServer } from "node:http";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { makePubSubPushRoutes } from "./push-handler.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const WorkerConfig = Config.all({
  port: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
    "OSFO_AGENT_RUN_WORKER_PORT",
  ).pipe(Config.withDefault(3_001)),
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  authorizationToken: Config.nonEmptyString("OSFO_PUBSUB_PUSH_TOKEN"),
  workerId: Config.nonEmptyString("OSFO_AGENT_RUN_WORKER_ID"),
  leaseDurationMs: Config.schema(PositiveInteger, "OSFO_AGENT_RUN_LEASE_DURATION_MS").pipe(
    Config.withDefault(30_000),
  ),
});

const announceReady = HttpServer.HttpServer.use((server) => {
  const address = server.address;
  return address._tag === "TcpAddress"
    ? Effect.sync(() => console.log(`OSFO_AGENT_RUN_WORKER_READY:${address.port}`))
    : Effect.void;
});

const ServerLive = Layer.unwrap(
  WorkerConfig.pipe(
    Effect.map((config) => {
      const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl: config.databaseUrl });
      const workerLayer = makeAgentRunWorkerLayer({
        workerId: config.workerId,
        leaseDurationMs: config.leaseDurationMs,
      }).pipe(
        Layer.provide(repositoryLayer),
        Layer.provide(makeDeterministicAgentRuntimeLayer()),
        Layer.provide(makeDeterministicModelCallExecutorLayer()),
      );
      const runningRoutes = HttpRouter.serve(
        makePubSubPushRoutes({ authorizationToken: config.authorizationToken }),
      ).pipe(Layer.provide(workerLayer));

      return Layer.effectDiscard(announceReady).pipe(
        Layer.provideMerge(runningRoutes),
        Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: config.port })),
      );
    }),
  ),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
