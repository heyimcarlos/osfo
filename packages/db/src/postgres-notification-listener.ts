import { ThreadResumeUnavailable } from "@osfo/api";
import { Cause, Effect, Option, Queue, Stream } from "effect";
import { Client, type Notification } from "pg";

const gracefulCloseTimeoutMs = 250;

export interface PostgresNotificationListenerOptions {
  readonly applicationName: string;
  readonly beforeGracefulClose?: Effect.Effect<void>;
  readonly channels: ReadonlyArray<string>;
  readonly databaseUrl: string;
}

export interface PostgresNotification {
  readonly channel: string;
  readonly payload: string;
}

const closeClient = (
  client: Client,
  channels: ReadonlyArray<string>,
  beforeGracefulClose: Effect.Effect<void>,
) => {
  const graceful = beforeGracefulClose.pipe(
    Effect.andThen(
      Effect.tryPromise(() =>
        client.query(
          channels.map((channel) => `UNLISTEN ${client.escapeIdentifier(channel)}`).join(";"),
        ),
      ),
    ),
    Effect.andThen(Effect.tryPromise(() => client.end())),
    Effect.timeoutOption(gracefulCloseTimeoutMs),
    Effect.map(Option.isSome),
    Effect.catchCause(() => Effect.succeed(false)),
  );
  return Effect.gen(function* () {
    if (yield* graceful) return;
    yield* Effect.sync(() => client.connection.stream.destroy());
    yield* Effect.tryPromise(() => client.end()).pipe(
      Effect.timeoutOption(gracefulCloseTimeoutMs),
      Effect.ignore,
    );
  }).pipe(Effect.ignore);
};

export const listenForPostgresNotifications = (options: PostgresNotificationListenerOptions) =>
  Stream.callback<PostgresNotification, ThreadResumeUnavailable>((queue) =>
    Effect.gen(function* () {
      const client = new Client({
        application_name: options.applicationName,
        connectionString: options.databaseUrl,
      });
      const fail = () => Queue.failCauseUnsafe(queue, Cause.fail(new ThreadResumeUnavailable()));
      const onEnd = () => fail();
      const onError = () => fail();
      const onNotification = (notification: Notification) => {
        if (options.channels.includes(notification.channel)) {
          Queue.offerUnsafe(queue, {
            channel: notification.channel,
            payload: notification.payload ?? "",
          });
        }
      };
      client.on("end", onEnd);
      client.on("error", onError);
      client.on("notification", onNotification);
      yield* Effect.addFinalizer(() =>
        closeClient(client, options.channels, options.beforeGracefulClose ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              client.off("end", onEnd);
              client.off("error", onError);
              client.off("notification", onNotification);
            }),
          ),
        ),
      );
      yield* Effect.tryPromise({
        try: async () => {
          await client.connect();
          for (const channel of options.channels) {
            await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
          }
        },
        catch: () => new ThreadResumeUnavailable(),
      });
    }),
  );
