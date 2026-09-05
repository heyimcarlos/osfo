import { ChatSdkStateAgent } from "agents/chat-sdk";
import { Clock, Effect, Schema } from "effect";

import { MessengerReset } from "./messenger-reset";

/**
 * Think 0.15.1 exports this empty ChatSdkStateAgent subclass. Agents 0.20.1
 * resolves facets through cls.name and ctx.exports, so the export name must stay
 * identical to preserve existing shard identities and Think's internal caller.
 */
export class ThinkMessengerStateAgent extends ChatSdkStateAgent {
  /** Internal Directory RPC; it has already authorized the suspended owner. */
  resetAccountThread(encodedThread: string): "busy" | "reset" {
    const thread = Effect.runSync(Schema.decodeEffect(MessengerReset.Thread)(encodedThread));
    const now = Effect.runSync(Clock.currentTimeMillis);
    return this.ctx.storage.transactionSync(() => {
      // Telegram 4.38.1 stores raw incoming album messages under this prefix.
      // The trailing colon prevents a private chat ID from matching another.
      const mediaPrefix = `telegram:incoming-media-group:${thread}:`;
      if (thread.startsWith("telegram:")) {
        const mediaLocks = this.ctx.storage.sql
          .exec(
            `SELECT 1 FROM chat_sdk_state_locks
             WHERE substr(thread_id, 1, ?) = ? AND expires_at > ? LIMIT 1`,
            mediaPrefix.length,
            mediaPrefix,
            now,
          )
          .toArray();
        if (mediaLocks.length > 0) return "busy";
      }
      const retained = this.ctx.storage.sql
        .exec<{ thread_id: string }>(
          `SELECT thread_id FROM chat_sdk_state_subscriptions
           UNION SELECT thread_id FROM chat_sdk_state_locks
           UNION SELECT thread_id FROM chat_sdk_state_queue
           UNION SELECT substr(key, 13) AS thread_id FROM chat_sdk_state_lists
             WHERE substr(key, 1, 12) = 'msg-history:'
           UNION SELECT substr(key, 14) AS thread_id FROM chat_sdk_state_cache
             WHERE substr(key, 1, 13) = 'thread-state:'`,
        )
        .toArray();
      const threads = new Set([
        thread,
        ...retained
          .filter((row) => MessengerReset.ownsThread(thread, row.thread_id))
          .map((row) => row.thread_id),
      ]);
      for (const selected of threads) {
        const locks = this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM chat_sdk_state_locks WHERE thread_id = ? AND expires_at > ? LIMIT 1",
            selected,
            now,
          )
          .toArray();
        if (locks.length > 0) return "busy";
      }
      // SDK 0.20.1 cacheDelete does not delete list history. Every predicate is an
      // exact key, including when several WhatsApp users share the same shard.
      for (const selected of threads) {
        this.ctx.storage.sql.exec(
          "DELETE FROM chat_sdk_state_lists WHERE key = ?",
          `msg-history:${selected}`,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM chat_sdk_state_cache WHERE key IN (?, ?)",
          `thread-state:${selected}`,
          `channel-state:${selected}`,
        );
        this.ctx.storage.sql.exec("DELETE FROM chat_sdk_state_queue WHERE thread_id = ?", selected);
        this.ctx.storage.sql.exec("DELETE FROM chat_sdk_state_locks WHERE thread_id = ?", selected);
        this.ctx.storage.sql.exec(
          "DELETE FROM chat_sdk_state_subscriptions WHERE thread_id = ?",
          selected,
        );
      }
      if (thread.startsWith("telegram:")) {
        this.ctx.storage.sql.exec(
          "DELETE FROM chat_sdk_state_cache WHERE substr(key, 1, ?) = ?",
          mediaPrefix.length,
          mediaPrefix,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM chat_sdk_state_locks WHERE substr(thread_id, 1, ?) = ?",
          mediaPrefix.length,
          mediaPrefix,
        );
      }
      return "reset";
    });
  }
}
