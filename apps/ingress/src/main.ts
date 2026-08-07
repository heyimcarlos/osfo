import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { MessageAdmission } from "@osfo/api";
import { OsfoApiLive } from "@osfo/api/server";
import { makeMessageAdmissionLayer, makeThreadResumeLayer } from "@osfo/db";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const AdmissionLimit = PositiveInteger.check(Schema.isLessThanOrEqualTo(256));
const DatabasePoolMax = PositiveInteger.check(Schema.isLessThanOrEqualTo(8));

const IngressConfig = Config.all({
  admissionCapacityReconciliationIntervalMs: Config.schema(
    PositiveInteger,
    "OSFO_ADMISSION_CAPACITY_RECONCILIATION_INTERVAL_MS",
  ).pipe(Config.withDefault(30_000)),
  admissionDatabasePoolMax: Config.schema(DatabasePoolMax, "OSFO_ADMISSION_DATABASE_POOL_MAX").pipe(
    Config.withDefault(4),
  ),
  port: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
    "OSFO_INGRESS_PORT",
  ).pipe(Config.withDefault(3_000)),
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  executionProfileRef: Config.schema(
    Schema.NonEmptyString.check(Schema.isMaxLength(255)),
    "OSFO_EXECUTION_PROFILE_REF",
  ),
  globalNonTerminalLimit: Config.schema(AdmissionLimit, "OSFO_GLOBAL_NON_TERMINAL_LIMIT"),
  principalNonTerminalLimit: Config.schema(AdmissionLimit, "OSFO_PRINCIPAL_NON_TERMINAL_LIMIT"),
  resumeDatabasePoolMax: Config.schema(DatabasePoolMax, "OSFO_RESUME_DATABASE_POOL_MAX").pipe(
    Config.withDefault(4),
  ),
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
      const AdmissionLive = makeMessageAdmissionLayer({
        databaseUrl: config.databaseUrl,
        executionProfileRef: config.executionProfileRef,
        globalNonTerminalLimit: config.globalNonTerminalLimit,
        maxConnections: config.admissionDatabasePoolMax,
        principalNonTerminalLimit: config.principalNonTerminalLimit,
      });
      const CapacityRecovery = Layer.effectDiscard(
        Effect.gen(function* () {
          const admission = yield* MessageAdmission;
          yield* admission.reconcileCapacity();
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.sleep(config.admissionCapacityReconciliationIntervalMs).pipe(
                Effect.andThen(admission.reconcileCapacity()),
                Effect.catch((error) =>
                  Effect.logWarning("Admission capacity reconciliation failed", error),
                ),
              ),
            ),
          );
        }),
      ).pipe(Layer.provide(AdmissionLive));
      const RunningApi = HttpRouter.serve(OsfoApiLive).pipe(
        Layer.provide(
          Layer.merge(
            AdmissionLive,
            makeThreadResumeLayer({
              cursorSecret: config.cursorSecret,
              databaseUrl: config.databaseUrl,
              maxConnections: config.resumeDatabasePoolMax,
              pollIntervalMs: config.streamPollIntervalMs,
              replayEventLimit: config.replayEventLimit,
              replayGuaranteedForMs: config.replayGuaranteedForMs,
              snapshotTimelineLimit: config.snapshotTimelineLimit,
            }),
          ),
        ),
      );
      const RunningWithRecovery = Layer.merge(RunningApi, CapacityRecovery);

      return Layer.effectDiscard(announceReady).pipe(
        Layer.provideMerge(RunningWithRecovery),
        Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: config.port })),
      );
    }),
  ),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
