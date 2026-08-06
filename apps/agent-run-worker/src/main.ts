import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { makeAgentRunWorkerLayer, makeDeterministicModelCallExecutorLayer } from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { createServer } from "node:http";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { makeGooglePubSubPushAuthenticatorLayer } from "./push-authentication.js";
import { PubSubPushRoutes } from "./push-handler.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const WorkerConfig = Config.all({
  port: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
    "OSFO_AGENT_RUN_WORKER_PORT",
  ).pipe(Config.withDefault(3_001)),
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  executionProfileRef: Config.nonEmptyString("OSFO_EXECUTION_PROFILE_REF"),
  modelBinding: Config.nonEmptyString("OSFO_MODEL_BINDING"),
  pushAudience: Config.nonEmptyString("OSFO_PUBSUB_PUSH_AUDIENCE"),
  pushServiceAccountEmail: Config.nonEmptyString("OSFO_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL"),
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
        executionProfileRef: config.executionProfileRef,
        workerId: config.workerId,
        leaseDurationMs: config.leaseDurationMs,
      }).pipe(
        Layer.provide(repositoryLayer),
        Layer.provide(
          makeDeterministicAgentRuntimeLayer({
            executionProfileRef: config.executionProfileRef,
            modelBinding: config.modelBinding,
          }),
        ),
        Layer.provide(makeDeterministicModelCallExecutorLayer()),
      );
      const authenticationLayer = makeGooglePubSubPushAuthenticatorLayer({
        audience: config.pushAudience,
        jwksUrl: new URL("https://www.googleapis.com/oauth2/v3/certs"),
        serviceAccountEmail: config.pushServiceAccountEmail,
      }).pipe(Layer.provide(NodeHttpClient.layerUndici));
      const runningRoutes = HttpRouter.serve(PubSubPushRoutes).pipe(
        Layer.provide(workerLayer),
        Layer.provide(authenticationLayer),
      );

      return Layer.effectDiscard(announceReady).pipe(
        Layer.provideMerge(runningRoutes),
        Layer.provide(NodeHttpServer.layer(createServer, { host: "0.0.0.0", port: config.port })),
      );
    }),
  ),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
