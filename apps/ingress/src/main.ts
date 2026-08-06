import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { OsfoApiLive } from "@osfo/api/server";
import { makeMessageAdmissionLayer, makeThreadTraversalLayer } from "@osfo/db";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const IngressConfig = Config.all({
  port: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
    "OSFO_INGRESS_PORT",
  ).pipe(Config.withDefault(3_000)),
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  executionProfileRef: Config.schema(
    Schema.NonEmptyString.check(Schema.isMaxLength(255)),
    "OSFO_EXECUTION_PROFILE_REF",
  ),
  globalNonTerminalLimit: Config.schema(PositiveInteger, "OSFO_GLOBAL_NON_TERMINAL_LIMIT"),
  principalNonTerminalLimit: Config.schema(PositiveInteger, "OSFO_PRINCIPAL_NON_TERMINAL_LIMIT"),
  cursorSecret: Config.nonEmptyString("OSFO_CURSOR_SECRET").pipe(
    Config.withDefault("local-reference-cursor-secret-change-in-production"),
  ),
  replayEventLimit: Config.schema(PositiveInteger, "OSFO_REPLAY_EVENT_LIMIT").pipe(
    Config.withDefault(1_000),
  ),
  replayGuaranteedForMs: Config.schema(PositiveInteger, "OSFO_REPLAY_GUARANTEED_FOR_MS").pipe(
    Config.withDefault(30_000),
  ),
  snapshotTimelineLimit: Config.schema(PositiveInteger, "OSFO_SNAPSHOT_TIMELINE_LIMIT").pipe(
    Config.withDefault(100),
  ),
  streamPollIntervalMs: Config.schema(PositiveInteger, "OSFO_STREAM_POLL_INTERVAL_MS").pipe(
    Config.withDefault(100),
  ),
});

const announceReady = HttpServer.HttpServer.use((server) => {
  const address = server.address;
  return address._tag === "TcpAddress"
    ? Effect.sync(() => console.log(`OSFO_INGRESS_READY:${address.port}`))
    : Effect.void;
});

const ServerLive = Layer.unwrap(
  IngressConfig.pipe(
    Effect.map((config) => {
      const RunningApi = HttpRouter.serve(OsfoApiLive).pipe(
        Layer.provide(
          Layer.merge(
            makeMessageAdmissionLayer({
              databaseUrl: config.databaseUrl,
              executionProfileRef: config.executionProfileRef,
              globalNonTerminalLimit: config.globalNonTerminalLimit,
              principalNonTerminalLimit: config.principalNonTerminalLimit,
            }),
            makeThreadTraversalLayer({
              cursorSecret: config.cursorSecret,
              databaseUrl: config.databaseUrl,
              pollIntervalMs: config.streamPollIntervalMs,
              replayEventLimit: config.replayEventLimit,
              replayGuaranteedForMs: config.replayGuaranteedForMs,
              snapshotTimelineLimit: config.snapshotTimelineLimit,
            }),
          ),
        ),
      );

      return Layer.effectDiscard(announceReady).pipe(
        Layer.provideMerge(RunningApi),
        Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: config.port })),
      );
    }),
  ),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
