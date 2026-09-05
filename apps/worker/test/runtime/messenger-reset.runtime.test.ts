/* oxlint-disable effecttsgo/async-function -- Cloudflare test callbacks and SDK methods are Promise boundaries. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute in the Effect returned to it.effect. */
/* oxlint-disable eslint/no-await-in-loop, eslint/no-underscore-dangle -- SDK seeding is sequential; Effect outcomes use the standard _tag discriminator. */
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createChatSdkState } from "agents/chat-sdk";
import { Clock, Effect, Schema } from "effect";

import { MessengerReset } from "../../src/agents/osfo/messenger-reset";
import { ThinkMessengerStateAgent } from "../../src/agents/osfo/messenger-state";

it.effect("opens Think's existing facet by name and erases only the selected WhatsApp thread", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("messenger-reset-isolation");
    await runInDurableObject(stub, async (directory) => {
      const upstream = await import("@cloudflare/think/messengers");
      const adapter = createChatSdkState({
        agent: upstream.ThinkMessengerStateAgent,
        parent: directory,
      });
      await adapter.connect();
      const target = "whatsapp:123:456";
      const other = "whatsapp:123:4567";
      for (const thread of [target, other]) {
        await adapter.appendToList?.(`msg-history:${thread}`, { text: thread });
        await adapter.set(`thread-state:${thread}`, { text: thread });
        await adapter.set(`channel-state:${thread}`, { text: thread });
        await adapter.subscribe(thread);
      }
      await adapter.set("channel-state:whatsapp:123", { shared: true });
      const state = await directory.subAgent(ThinkMessengerStateAgent, "whatsapp:123");
      const now = Effect.runSync(Clock.currentTimeMillis);
      const queueEntry = JSON.stringify({ enqueuedAt: now, expiresAt: now + 60_000 });
      await state.enqueue(target, queueEntry, 10);
      await state.enqueue(other, queueEntry, 10);
      const targetLock = await state.acquireLock(target, 60_000);
      const otherLock = await state.acquireLock(other, 60_000);
      if (targetLock === null || otherLock === null) throw new Error("Missing test lock");
      expect(await state.resetAccountThread(target)).toBe("busy");
      expect(await adapter.getList?.(`msg-history:${target}`)).toEqual([{ text: target }]);
      await state.releaseLock(target, targetLock.token);
      expect(await state.resetAccountThread(target)).toBe("reset");
      expect(await state.resetAccountThread(target)).toBe("reset");
      expect(await adapter.getList?.(`msg-history:${target}`)).toEqual([]);
      expect(await adapter.get(`thread-state:${target}`)).toBeNull();
      expect(await adapter.get(`channel-state:${target}`)).toBeNull();
      expect(await adapter.isSubscribed(target)).toBe(false);
      expect(await state.queueDepth(target)).toBe(0);
      expect(await adapter.getList?.(`msg-history:${other}`)).toEqual([{ text: other }]);
      expect(await adapter.get(`thread-state:${other}`)).toEqual({ text: other });
      expect(await adapter.get(`channel-state:${other}`)).toEqual({ text: other });
      expect(await adapter.get("channel-state:whatsapp:123")).toEqual({ shared: true });
      expect(await adapter.isSubscribed(other)).toBe(true);
      expect(await state.queueDepth(other)).toBe(1);
      expect(await state.acquireLock(other, 60_000)).toBeNull();
      await state.releaseLock(other, otherLock.token);
    });
  }),
);

it.effect("erases Telegram private topics without matching another chat's prefix", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("messenger-reset-topics");
    await runInDurableObject(stub, async (directory) => {
      const state = await directory.subAgent(ThinkMessengerStateAgent, "telegram:123");
      for (const thread of ["telegram:123", "telegram:123:99", "telegram:1234"]) {
        await state.listAppend(`msg-history:${thread}`, thread);
      }
      await state.resetAccountThread("telegram:123");
      expect(await state.listGet("msg-history:telegram:123")).toEqual([]);
      expect(await state.listGet("msg-history:telegram:123:99")).toEqual([]);
      expect(await state.listGet("msg-history:telegram:1234")).toEqual(["telegram:1234"]);
      expect(Schema.decodeResult(MessengerReset.Thread)("telegram:")._tag).toBe("Failure");
    });
  }),
);

it.effect("erases only the owner's Telegram album buffers across shared shards", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("messenger-reset-media-groups");
    await runInDurableObject(stub, async (directory) => {
      const upstream = await import("@cloudflare/think/messengers");
      const adapter = createChatSdkState({
        agent: upstream.ThinkMessengerStateAgent,
        parent: directory,
      });
      await adapter.connect();
      const target = "telegram:123";
      const key = "telegram:incoming-media-group:telegram:123:album";
      const topicKey = "telegram:incoming-media-group:telegram:123:99:album";
      const foreignKey = "telegram:incoming-media-group:telegram:1234:album";
      for (const retained of [key, topicKey, foreignKey]) {
        await adapter.set(retained, [{ message: { caption: retained }, receivedAt: 1 }], 30_000);
      }
      const targetLock = await adapter.acquireLock(`${key}:lock`, 5_000);
      const foreignLock = await adapter.acquireLock(`${foreignKey}:lock`, 5_000);
      if (targetLock === null || foreignLock === null) throw new Error("Missing album test lock");
      expect(MessengerReset.shardNames(target)).toEqual([
        "telegram:incoming-media-group",
        "default",
        target,
      ]);
      const locks = await directory.subAgent(
        ThinkMessengerStateAgent,
        "telegram:incoming-media-group",
      );
      const buffers = await directory.subAgent(ThinkMessengerStateAgent, "default");
      expect(await locks.resetAccountThread(target)).toBe("busy");
      expect(await adapter.get(key)).toEqual([{ message: { caption: key }, receivedAt: 1 }]);
      await adapter.releaseLock(targetLock);
      expect(await locks.resetAccountThread(target)).toBe("reset");
      expect(await buffers.resetAccountThread(target)).toBe("reset");
      expect(await buffers.resetAccountThread(target)).toBe("reset");
      expect(await adapter.get(key)).toBeNull();
      expect(await adapter.get(topicKey)).toBeNull();
      expect(await adapter.get(foreignKey)).toEqual([
        { message: { caption: foreignKey }, receivedAt: 1 },
      ]);
      expect(await adapter.acquireLock(`${foreignKey}:lock`, 5_000)).toBeNull();
      await adapter.releaseLock(foreignLock);
    });
  }),
);

it.effect("retains canceled fibers until execution settles and deletes only target snapshots", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("messenger-reset-fibers");
    await runInDurableObject(stub, async (directory, state) => {
      const target = "telegram:123";
      for (const thread of [target, "telegram:123:99", "telegram:1234"]) {
        state.storage.sql.exec(
          `INSERT INTO cf_agents_fibers
            (fiber_id, name, status, snapshot, metadata_json, created_at)
           VALUES (?, 'think:messenger-reply', 'completed', ?, ?, ?)`,
          thread,
          JSON.stringify({ event: { content: thread } }),
          JSON.stringify({ messengerId: "telegram", threadId: thread }),
          Effect.runSync(Clock.currentTimeMillis),
        );
      }
      state.storage.sql.exec(
        "UPDATE cf_agents_fibers SET status = 'running' WHERE fiber_id = ?",
        target,
      );
      state.storage.sql.exec(
        "INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, 'think:messenger-reply', ?, ?)",
        target,
        JSON.stringify({ content: "still active" }),
        Effect.runSync(Clock.currentTimeMillis),
      );
      await directory.cancelFiber(target, "test cancellation");
      const blocked = await Effect.runPromise(
        MessengerReset.eraseFibers(state.storage, [target]).pipe(Effect.result),
      );
      expect(blocked._tag).toBe("Failure");
      expect(
        state.storage.sql.exec("SELECT fiber_id FROM cf_agents_fibers").toArray(),
      ).toHaveLength(3);
      state.storage.sql.exec("DELETE FROM cf_agents_runs WHERE id = ?", target);
      await Effect.runPromise(MessengerReset.eraseFibers(state.storage, [target]));
      await Effect.runPromise(MessengerReset.eraseFibers(state.storage, [target]));
      expect(state.storage.sql.exec("SELECT fiber_id FROM cf_agents_fibers").toArray()).toEqual([
        { fiber_id: "telegram:1234" },
      ]);
    });
  }),
);
