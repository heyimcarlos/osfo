import {
  AgentRunRepositoryUnavailable,
  OutboxRelayWake,
  type OutboxRelayWakeEvent,
} from "@osfo/agent-run";
import { Cause, Effect, Layer, Queue, Ref, Stream } from "effect";
import { Client, type Notification } from "pg";

export const OUTBOX_RELAY_WAKE_CHANNEL = "osfo_outbox_relay_wake";
export const OUTBOX_RELAY_WAKE_PAYLOAD = "wake";
export const OUTBOX_RELAY_SELECTOR_LOCK_ID = 2_026_080_601;

export const makeOutboxRelayWakeLayer = (databaseUrl: string) =>
  Layer.effect(
    OutboxRelayWake,
    Effect.gen(function* () {
      const connectedOnce = yield* Ref.make(false);
      return OutboxRelayWake.of({
        events: Stream.callback<OutboxRelayWakeEvent, AgentRunRepositoryUnavailable>((queue) =>
          Effect.gen(function* () {
            const client = new Client({
              application_name: "osfo-outbox-relay-wake",
              connectionString: databaseUrl,
            });
            const fail = (cause: unknown) =>
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(new AgentRunRepositoryUnavailable({ cause })),
              );
            const onError = (cause: Error) => fail(cause);
            const onEnd = () => fail("PostgreSQL relay wake connection ended");
            const onNotification = (notification: Notification) => {
              if (notification.channel === OUTBOX_RELAY_WAKE_CHANNEL) {
                Queue.offerUnsafe(queue, { type: "notification" });
              }
            };
            client.on("error", onError);
            client.on("end", onEnd);
            client.on("notification", onNotification);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                client.off("error", onError);
                client.off("end", onEnd);
                client.off("notification", onNotification);
              }).pipe(Effect.andThen(Effect.promise(() => client.end())), Effect.ignore),
            );
            yield* Effect.tryPromise({
              try: async () => {
                await client.connect();
                await client.query(`LISTEN "${OUTBOX_RELAY_WAKE_CHANNEL}"`);
              },
              catch: (cause) => new AgentRunRepositoryUnavailable({ cause }),
            });
            const reconnect = yield* Ref.getAndSet(connectedOnce, true);
            Queue.offerUnsafe(queue, { type: "connected", reconnect });
          }),
        ),
      });
    }),
  );
