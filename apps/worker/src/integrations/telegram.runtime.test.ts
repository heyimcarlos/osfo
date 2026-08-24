/* oxlint-disable effecttsgo/async-function -- Vitest and Chat SDK callbacks use Promise-based protocols. */
/* oxlint-disable effecttsgo/global-date -- Chat SDK message metadata requires a native Date. */
import type { FiberContext } from "agents";
import { ThinkMessengerRuntime, type MessengerThinkHost } from "@cloudflare/think/messengers";
import { Predicate } from "effect";
import { Message, parseMarkdown, stringifyMarkdown, type Adapter, type ChatInstance } from "chat";
import { describe, expect, it } from "vitest";

import { makeTelegramChannel } from "./telegram";

describe("Telegram integration", () => {
  it.each([
    { name: "normal delivery", recover: false },
    { name: "fiber recovery", recover: true },
  ])(
    "preserves every message in one rapid direct-message burst during $name",
    async ({ recover }) => {
      const received: Array<string> = [];
      const events: Array<string> = [];
      const adapter = makeFakeAdapter();
      const channel = makeTelegramChannel({
        conversation: () => Promise.resolve({ target: "self" }),
        secretToken: "secret",
        token: "token",
        userName: "osfo_test_bot",
      });
      if (channel.ingress.transport !== "webhook") throw new Error("Expected webhook ingress");
      const { transport: _transport, ...telegram } = channel.ingress;
      const stateAgent = makeStateAgent();
      const chatWithMessengerContext: NonNullable<
        MessengerThinkHost["chatWithMessengerContext"]
      > = async (message, callback) => {
        events.push("chat");
        received.push(
          Predicate.isString(message)
            ? message
            : message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        );
        await callback.onEvent(JSON.stringify({ type: "text-delta", delta: "ok" }));
      };
      const startFiber: MessengerThinkHost["startFiber"] = async (_name, run) => {
        events.push("fiber");
        if (recover) {
          let snapshot: unknown;
          try {
            const context: FiberContext = {
              id: "fiber-recovery",
              signal: new AbortController().signal,
              snapshot: null,
              // oxlint-disable-next-line osfo/no-unknown-parameters -- FiberContext defines stash as the unknown snapshot boundary.
              stash: (value: unknown) => {
                snapshot = value;
                throw new Error("Simulated interruption after accepting the burst");
              },
            };
            await run(context);
          } catch {
            if (snapshot === undefined) throw new Error("Expected an accepted fiber snapshot");
          }
          return {
            accepted: false,
            fiberId: "fiber-recovery",
            snapshot,
            status: "interrupted",
          };
        }
        await run({
          id: "fiber-normal",
          signal: new AbortController().signal,
          snapshot: null,
          stash: () => undefined,
        });
        return { accepted: true, fiberId: "fiber-normal", status: "completed" };
      };
      const host = {
        cancelChat: () => Promise.resolve(true),
        chat: () => Promise.resolve(),
        chatWithMessengerContext,
        constructor: { name: "FakeHost" },
        name: "fake-host",
        parentPath: [],
        resolveFiber: () => Promise.resolve(true),
        startFiber,
        subAgent: () => Promise.resolve(stateAgent),
      };
      // SAFETY: The fake implements every host operation exercised by Think's
      // messenger runtime and returns the complete in-memory Chat SDK state stub.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The runtime proof is exercised by both delivery paths below.
      const messengerHost = host as MessengerThinkHost;
      const runtime = new ThinkMessengerRuntime(
        { telegram: { ...telegram, adapter } },
        messengerHost,
      );
      runtime.initialize();

      await Promise.all([
        runtime.handleRequest(messageRequest("message-1", "Remember Harbor Glass")),
        runtime.handleRequest(messageRequest("message-2", "Correction: use Copper Vale")),
      ]);

      expect({ events, received }).toEqual({
        events: ["fiber", "chat"],
        received: ["Remember Harbor Glass\n\nCorrection: use Copper Vale"],
      });
    },
  );
});

const messageRequest = (id: string, text: string) =>
  new Request("https://osfo.test/webhooks/telegram", {
    body: JSON.stringify({ id, text }),
    headers: { "x-telegram-bot-api-secret-token": "secret" },
    method: "POST",
  });

const makeFakeAdapter = (): Adapter => {
  let chat: ChatInstance | undefined;
  const adapter = {
    addReaction: () => Promise.resolve(),
    channelIdFromThreadId: (threadId: string) => threadId,
    decodeThreadId: (threadId: string) => threadId,
    deleteMessage: () => Promise.resolve(),
    editMessage: (threadId: string) => Promise.resolve({ id: "edited-message", raw: {}, threadId }),
    encodeThreadId: (threadId: string) => threadId,
    fetchMessages: () => Promise.resolve({ messages: [] }),
    fetchThread: (threadId: string) =>
      Promise.resolve({ channelId: threadId, id: threadId, isDM: true, metadata: {} }),
    handleWebhook: async (request: Request) => {
      if (chat === undefined) throw new Error("Fake Telegram adapter is not initialized");
      const input = await request.json<{ readonly id: string; readonly text: string }>();
      await chat.handleIncomingMessage(
        adapter,
        "telegram:direct-user",
        new Message({
          attachments: [],
          author: {
            fullName: "Test User",
            isBot: false,
            isMe: false,
            userId: "telegram-user",
            userName: "test-user",
          },
          formatted: parseMarkdown(input.text),
          id: input.id,
          links: [],
          metadata: { dateSent: new Date(0), edited: false },
          raw: {},
          text: input.text,
          threadId: "telegram:direct-user",
        }),
      );
      return new Response("ok");
    },
    initialize: (instance: ChatInstance) => {
      chat = instance;
      return Promise.resolve();
    },
    isDM: () => true,
    lockScope: "channel" as const,
    name: "telegram",
    parseMessage: () => {
      throw new Error("parseMessage is not used by this test");
    },
    postMessage: (threadId: string) => Promise.resolve({ id: "posted-message", raw: {}, threadId }),
    removeReaction: () => Promise.resolve(),
    renderFormatted: stringifyMarkdown,
    startTyping: () => Promise.resolve(),
    userName: "osfo_test_bot",
  } satisfies Adapter;
  return adapter;
};

const makeStateAgent = () => {
  const cache = new Map<string, string>();
  const locks = new Map<string, string>();
  const queues = new Map<string, Array<string>>();
  return {
    acquireLock: (key: string) => {
      if (locks.has(key)) return Promise.resolve(null);
      const token = `lock:${key}`;
      locks.set(key, token);
      return Promise.resolve({ expiresAt: 30_000, threadId: key, token });
    },
    cacheDelete: (key: string) => {
      cache.delete(key);
      return Promise.resolve();
    },
    cacheGet: (key: string) => Promise.resolve(cache.get(key) ?? null),
    cacheSet: (key: string, value: string) => {
      cache.set(key, value);
      return Promise.resolve();
    },
    cacheSetIfNotExists: (key: string, value: string) => {
      if (cache.has(key)) return Promise.resolve(false);
      cache.set(key, value);
      return Promise.resolve(true);
    },
    enqueue: (key: string, value: string, maxSize: number) => {
      const queue = queues.get(key) ?? [];
      queue.push(value);
      while (queue.length > maxSize) queue.shift();
      queues.set(key, queue);
      return Promise.resolve(queue.length);
    },
    extendLock: (key: string, token: string) => Promise.resolve(locks.get(key) === token),
    forceReleaseLock: (key: string) => {
      locks.delete(key);
      return Promise.resolve();
    },
    isSubscribed: () => Promise.resolve(false),
    listAppend: () => Promise.resolve(),
    listGet: () => Promise.resolve([]),
    popQueue: (key: string) => Promise.resolve(queues.get(key)?.shift() ?? null),
    queueDepth: (key: string) => Promise.resolve(queues.get(key)?.length ?? 0),
    releaseLock: (key: string, token: string) => {
      if (locks.get(key) === token) locks.delete(key);
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
  };
};
