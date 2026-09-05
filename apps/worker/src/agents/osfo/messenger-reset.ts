import { Effect, Schema } from "effect";

import type { ChannelAddress } from "../../domain/channel-link";
import { AccountResetFence } from "./account-reset-fence";

/** Private provider threads owned by one currently authorized Channel Link. */
export const Thread = Schema.String.check(
  Schema.isPattern(/^(telegram:[0-9]+|whatsapp:[0-9]+:[0-9]+)$/),
);

export const threadForAddress = (address: typeof ChannelAddress.Type, phoneNumberId: string) =>
  Schema.decodeEffect(Thread)(
    address.channelId === "telegram"
      ? `telegram:${address.authorId}`
      : address.channelId === "whatsapp"
        ? `whatsapp:${phoneNumberId}:${address.authorId}`
        : "",
  );

/** Telegram media locks and buffers use separate shared shards in the installed SDK. */
export const shardNames = (thread: string) => {
  const history = thread.split(":").slice(0, 2).join(":");
  return thread.startsWith("telegram:")
    ? ["telegram:incoming-media-group", "default", history]
    : [history];
};

/** Telegram topics share the same private chat owner; WhatsApp threads do not. */
export const ownsThread = (ownerThread: string, candidate: string) =>
  candidate === ownerThread ||
  (ownerThread.startsWith("telegram:") && candidate.startsWith(`${ownerThread}:`));

const Fiber = Schema.Struct({
  fiber_id: Schema.String,
  status: Schema.String,
  thread_id: Schema.String,
});

/** agents@0.20.1 has no exact-ID deletion API; keep its storage adaptation here. */
export const fibers = Effect.fn("MessengerReset.fibers")(function* (
  sql: SqlStorage,
  threads: ReadonlyArray<string>,
) {
  const rows = yield* Effect.try({
    try: () =>
      sql
        .exec(
          `SELECT fiber_id, status, json_extract(metadata_json, '$.threadId') AS thread_id
           FROM cf_agents_fibers
           WHERE name = 'think:messenger-reply' AND json_valid(metadata_json)`,
        )
        .toArray(),
    catch: unavailable,
  });
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Fiber))(rows).pipe(
    Effect.mapError(unavailable),
  );
  return decoded.filter((fiber) => threads.some((thread) => ownsThread(thread, fiber.thread_id)));
});

/** A canceled SDK fiber can still execute until its cf_agents_runs row disappears. */
export const requireSettled = Effect.fn("MessengerReset.requireSettled")(function* (
  sql: SqlStorage,
  threads: ReadonlyArray<string>,
) {
  const selected = yield* fibers(sql, threads);
  yield* Effect.try({
    try: () => {
      for (const fiber of selected) {
        const running = sql
          .exec("SELECT 1 FROM cf_agents_runs WHERE id = ? LIMIT 1", fiber.fiber_id)
          .toArray();
        if (running.length > 0 || !["completed", "aborted", "error"].includes(fiber.status)) {
          throw new Error("Messenger execution has not settled; retry the suspended account reset");
        }
      }
    },
    catch: unavailable,
  });
  return selected;
});

export const eraseFibers = Effect.fn("MessengerReset.eraseFibers")(function* (
  storage: DurableObjectStorage,
  threads: ReadonlyArray<string>,
) {
  const selected = yield* requireSettled(storage.sql, threads);
  yield* Effect.try({
    try: () =>
      storage.transactionSync(() => {
        for (const fiber of selected) {
          storage.sql.exec("DELETE FROM cf_agents_fibers WHERE fiber_id = ?", fiber.fiber_id);
        }
      }),
    catch: unavailable,
  });
});

const unavailable = (cause: unknown) =>
  new AccountResetFence.AccountResetUnavailable({
    cause,
    message: "Messenger transport reset requires settled execution",
  });

export * as MessengerReset from "./messenger-reset";
