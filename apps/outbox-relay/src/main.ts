import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { makeOutboxRelayLayer } from "@osfo/agent-run";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { Config, Effect, Layer, Schema } from "effect";
import { makeGooglePubSubPublisherLayer } from "./pubsub-publisher.js";
import { runOutboxRelay } from "./relay.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const DatabasePoolMax = PositiveInteger.check(Schema.isLessThanOrEqualTo(8));

const RelayConfig = Config.all({
  databasePoolMax: Config.schema(DatabasePoolMax, "OSFO_RELAY_DATABASE_POOL_MAX").pipe(
    Config.withDefault(4),
  ),
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  leaseDurationMs: Config.schema(PositiveInteger, "OSFO_RELAY_LEASE_DURATION_MS").pipe(
    Config.withDefault(30_000),
  ),
  projectId: Config.nonEmptyString("OSFO_PUBSUB_PROJECT_ID"),
  publicationWindowSize: Config.schema(
    Schema.Literal(128),
    "OSFO_RELAY_PUBLICATION_WINDOW_SIZE",
  ).pipe(Config.withDefault(128)),
  publisherConcurrency: Config.schema(Schema.Literal(4), "OSFO_RELAY_PUBLISHER_CONCURRENCY").pipe(
    Config.withDefault(4),
  ),
  relayId: Config.nonEmptyString("OSFO_RELAY_ID"),
  safetyDrainIntervalMs: Config.schema(
    Schema.Literal(1_000),
    "OSFO_RELAY_SAFETY_DRAIN_INTERVAL_MS",
  ).pipe(Config.withDefault(1_000)),
  topicId: Config.nonEmptyString("OSFO_PUBSUB_TOPIC_ID"),
});

const RelayLive = Layer.unwrap(
  RelayConfig.pipe(
    Effect.map((config) => {
      const repository = makeAgentRunRepositoryLayer({
        databaseUrl: config.databaseUrl,
        maxConnections: config.databasePoolMax,
      });
      const publisher = makeGooglePubSubPublisherLayer({
        projectId: config.projectId,
        requestTimeoutMs: Math.max(1, Math.floor(config.leaseDurationMs / 2)),
        topicId: config.topicId,
      }).pipe(Layer.provide(NodeHttpClient.layerUndici));
      return makeOutboxRelayLayer({
        relayId: config.relayId,
        leaseDurationMs: config.leaseDurationMs,
        publicationWindowSize: config.publicationWindowSize,
      }).pipe(Layer.provide(repository), Layer.provide(publisher));
    }),
  ),
);

const program = RelayConfig.pipe(
  Effect.flatMap((config) =>
    runOutboxRelay({
      publisherConcurrency: config.publisherConcurrency,
      safetyDrainIntervalMs: config.safetyDrainIntervalMs,
    }),
  ),
  Effect.provide(RelayLive),
);

NodeRuntime.runMain(program);
