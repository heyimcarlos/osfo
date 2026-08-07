import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  DevelopmentBootstrapRejected,
  DevelopmentDemoBootstrap,
  MessageAdmission,
  ThreadStreamLifecycle,
  makeThreadStreamLifecycleLayer,
  type ThreadStreamLifecycleService,
} from "@osfo/api";
import { DevelopmentBootstrapApiLive, OsfoApiLive } from "@osfo/api/server";
import {
  makeDevelopmentDemoBootstrapLayer,
  makeAgentRunCancellationLayer,
  makeMessageAdmissionLayer,
  makeThreadResumeLayer,
} from "@osfo/db";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import {
  drainedTelemetry,
  emitIngressLifecycleTelemetry,
  slowConsumerTelemetry,
} from "./lifecycle-telemetry.js";
import { resolveDevelopmentBootstrapConfig } from "./development-bootstrap-config.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const AdmissionLimit = PositiveInteger.check(Schema.isLessThanOrEqualTo(256));
const DatabasePoolMax = PositiveInteger.check(Schema.isLessThanOrEqualTo(8));

class IngressLifecycleTelemetry extends Context.Service<
  IngressLifecycleTelemetry,
  {
    readonly observe: (lifecycle: ThreadStreamLifecycleService) => Effect.Effect<void>;
    readonly reportDrained: (lifecycle: ThreadStreamLifecycleService) => Effect.Effect<void>;
  }
>()("@osfo/ingress/IngressLifecycleTelemetry") {}

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
  lifecycleTelemetryEnabled: Config.boolean("OSFO_TEST_LIFECYCLE_TELEMETRY").pipe(
    Config.withDefault(false),
  ),
  host: Config.nonEmptyString("OSFO_INGRESS_HOST").pipe(Config.withDefault("127.0.0.1")),
  maxStreamBufferedAgeMs: Config.schema(PositiveInteger, "OSFO_MAX_STREAM_BUFFERED_AGE_MS").pipe(
    Config.withDefault(5_000),
  ),
  maxStreamBufferedBytes: Config.schema(PositiveInteger, "OSFO_MAX_STREAM_BUFFERED_BYTES").pipe(
    Config.withDefault(1_048_576),
  ),
  maxStreamBufferedEvents: Config.schema(PositiveInteger, "OSFO_MAX_STREAM_BUFFERED_EVENTS").pipe(
    Config.withDefault(64),
  ),
  maxStreamConnectionLifetimeMs: Config.schema(
    PositiveInteger,
    "OSFO_MAX_STREAM_CONNECTION_LIFETIME_MS",
  ).pipe(Config.withDefault(1_800_000)),
  maxStreamConnections: Config.schema(PositiveInteger, "OSFO_MAX_STREAM_CONNECTIONS").pipe(
    Config.withDefault(64),
  ),
  principalNonTerminalLimit: Config.schema(AdmissionLimit, "OSFO_PRINCIPAL_NON_TERMINAL_LIMIT"),
  agentRunCleanupTimeoutMs: Config.schema(
    PositiveInteger,
    "OSFO_AGENT_RUN_CLEANUP_TIMEOUT_MS",
  ).pipe(Config.withDefault(30_000)),
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
  webRoot: Config.nonEmptyString("OSFO_WEB_ROOT").pipe(Config.withDefault("/srv/osfo/web")),
  runtimeEnvironment: Config.literals(
    ["development", "production"],
    "OSFO_RUNTIME_ENVIRONMENT",
  ).pipe(Config.withDefault("production")),
  developmentBootstrapAccessCodeSha256: Config.option(
    Config.redacted("OSFO_DEMO_BOOTSTRAP_CODE_SHA256"),
  ),
});

const announceReady = HttpServer.HttpServer.use((server) => {
  const address = server.address;
  return address._tag === "TcpAddress"
    ? Effect.sync(() => console.log(`OSFO_INGRESS_READY:${address.port}`))
    : Effect.void;
});

const contentType = (path: string) => {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
};

const ServerLive = Layer.unwrap(
  IngressConfig.pipe(
    Effect.flatMap((config) =>
      resolveDevelopmentBootstrapConfig(
        config.runtimeEnvironment,
        Option.match(config.developmentBootstrapAccessCodeSha256, {
          onNone: () => undefined,
          onSome: Redacted.value,
        }),
      ).pipe(Effect.map((developmentBootstrap) => ({ config, developmentBootstrap }))),
    ),
    Effect.map(({ config, developmentBootstrap }) => {
      const server = createServer();
      if (config.lifecycleTelemetryEnabled) {
        server.once("close", () =>
          Effect.runFork(
            emitIngressLifecycleTelemetry(true, {
              type: "http_closed",
            }),
          ),
        );
      }
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
      const ThreadStreamLifecycleLive = makeThreadStreamLifecycleLayer({
        maxBufferedAgeMs: config.maxStreamBufferedAgeMs,
        maxBufferedBytes: config.maxStreamBufferedBytes,
        maxBufferedEvents: config.maxStreamBufferedEvents,
        maxConnectionLifetimeMs: config.maxStreamConnectionLifetimeMs,
        maxConnections: config.maxStreamConnections,
      });
      const WebRoutes = Layer.merge(
        HttpRouter.add(
          "GET",
          "/healthz",
          HttpServerResponse.jsonUnsafe({
            profile: config.executionProfileRef,
            status: "ready",
          }),
        ),
        HttpRouter.add("GET", "/*", (request) => {
          const pathname = new URL(request.url, "http://osfo.invalid").pathname;
          const requestedPath = resolve(config.webRoot, `.${pathname}`);
          const webRootPrefix = resolve(config.webRoot) + sep;
          const assetPath =
            requestedPath.startsWith(webRootPrefix) && existsSync(requestedPath)
              ? requestedPath
              : resolve(config.webRoot, "index.html");
          return Effect.succeed(
            HttpServerResponse.uint8Array(readFileSync(assetPath), {
              contentType: contentType(assetPath),
            }),
          );
        }),
      );
      const DevelopmentBootstrapRoutes = developmentBootstrap.enabled
        ? DevelopmentBootstrapApiLive
        : Layer.empty;
      const DevelopmentBootstrapService = developmentBootstrap.enabled
        ? makeDevelopmentDemoBootstrapLayer({
            accessCodeSha256: developmentBootstrap.accessCodeSha256,
            databaseUrl: config.databaseUrl,
          })
        : Layer.succeed(DevelopmentDemoBootstrap)(
            DevelopmentDemoBootstrap.of({
              create: () => Effect.fail(new DevelopmentBootstrapRejected()),
            }),
          );
      const RunningApi = HttpRouter.serve(
        Layer.mergeAll(OsfoApiLive, DevelopmentBootstrapRoutes, WebRoutes),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            AdmissionLive,
            makeAgentRunCancellationLayer({
              databaseUrl: config.databaseUrl,
              cleanupTimeoutMs: config.agentRunCleanupTimeoutMs,
            }),
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
        Layer.provideMerge(ThreadStreamLifecycleLive),
        Layer.provide(DevelopmentBootstrapService),
      );
      const RunningWithRecovery = Layer.merge(RunningApi, CapacityRecovery);
      const LifecycleTelemetryLive = Layer.succeed(IngressLifecycleTelemetry)({
        observe: (lifecycle) =>
          config.lifecycleTelemetryEnabled
            ? Effect.gen(function* () {
                let observedSlowConsumerCloses = 0;
                while (true) {
                  const status = yield* lifecycle.status;
                  if (status.slowConsumerCloses > observedSlowConsumerCloses) {
                    observedSlowConsumerCloses = status.slowConsumerCloses;
                    yield* emitIngressLifecycleTelemetry(true, slowConsumerTelemetry(status));
                  }
                  yield* Effect.sleep(1);
                }
              })
            : Effect.void,
        reportDrained: (lifecycle) =>
          lifecycle.status.pipe(
            Effect.flatMap((status) =>
              emitIngressLifecycleTelemetry(
                config.lifecycleTelemetryEnabled,
                drainedTelemetry(status, server.listening),
              ),
            ),
          ),
      });

      const RunningServer = Layer.effectDiscard(announceReady).pipe(
        Layer.provideMerge(RunningWithRecovery),
        Layer.provide(NodeHttpServer.layer(() => server, { host: config.host, port: config.port })),
      );
      return Layer.merge(RunningServer, LifecycleTelemetryLive);
    }),
  ),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const services = yield* Layer.build(ServerLive);
    const lifecycle = Context.get(services, ThreadStreamLifecycle);
    const telemetry = Context.get(services, IngressLifecycleTelemetry);
    yield* Effect.forkScoped(telemetry.observe(lifecycle));
    yield* Effect.addFinalizer(() =>
      lifecycle.drain.pipe(Effect.andThen(telemetry.reportDrained(lifecycle))),
    );
    return yield* Effect.never;
  }),
);

NodeRuntime.runMain(program);
