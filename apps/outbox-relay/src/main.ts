import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { OutboxRelay, makeOutboxRelayLayer } from "@osfo/agent-run";
import { makeAgentRunRepositoryLayer } from "@osfo/db";
import { Config, Effect, Layer, Schema } from "effect";
import { makeGooglePubSubPublisherLayer } from "./pubsub-publisher.js";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const RelayConfig = Config.all({
  databaseUrl: Config.nonEmptyString("OSFO_DATABASE_URL"),
  idlePollIntervalMs: Config.schema(PositiveInteger, "OSFO_RELAY_IDLE_POLL_INTERVAL_MS").pipe(
    Config.withDefault(100),
  ),
  leaseDurationMs: Config.schema(PositiveInteger, "OSFO_RELAY_LEASE_DURATION_MS").pipe(
    Config.withDefault(30_000),
  ),
  projectId: Config.nonEmptyString("OSFO_PUBSUB_PROJECT_ID"),
  publicationWindowSize: Config.schema(PositiveInteger, "OSFO_RELAY_PUBLICATION_WINDOW_SIZE").pipe(
    Config.withDefault(32),
  ),
  relayId: Config.nonEmptyString("OSFO_RELAY_ID"),
  topicId: Config.nonEmptyString("OSFO_PUBSUB_TOPIC_ID"),
});

const RelayLive = Layer.unwrap(
  RelayConfig.pipe(
    Effect.map((config) => {
      const repository = makeAgentRunRepositoryLayer({ databaseUrl: config.databaseUrl });
      const publisher = makeGooglePubSubPublisherLayer({
        projectId: config.projectId,
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
    Effect.gen(function* () {
      yield* Effect.logInfo("OSFO_OUTBOX_RELAY_READY");
      const relay = yield* OutboxRelay;
      yield* Effect.forever(
        relay.relayOnce().pipe(
          Effect.flatMap((result) =>
            result.type === "idle" ? Effect.sleep(config.idlePollIntervalMs) : Effect.yieldNow,
          ),
          Effect.catch((cause) =>
            Effect.logError("Outbox relay iteration failed", cause).pipe(
              Effect.andThen(Effect.sleep(config.idlePollIntervalMs)),
            ),
          ),
        ),
      );
    }),
  ),
  Effect.provide(RelayLive),
);

NodeRuntime.runMain(program);
