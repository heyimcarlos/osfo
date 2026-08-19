import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { deliverMessengerReply, TextStreamCallback } from "@cloudflare/think/messengers";
import { SELF } from "cloudflare:test";
import { Effect, Schema } from "effect";

import { ThinkSubmissionId } from "../src/domain";
import { messengerSubmissionId } from "../src/agents/osfo/agent";
import {
  completeDeterministicTelegramReply,
  makeTelegramChannel,
} from "../src/integrations/telegram";

/* oxlint-disable effecttsgo/async-function -- Think delivery surfaces and callbacks are Promise-based. */

describe("Think Telegram channel", () => {
  afterEach(() => vi.restoreAllMocks());

  it.effect(
    "derives a stable schema-valid submission identity from Telegram message identity",
    () =>
      Effect.gen(function* () {
        const first = yield* Effect.promise(() =>
          messengerSubmissionId("telegram", "telegram:900100200", "message:102"),
        );
        const retry = yield* Effect.promise(() =>
          messengerSubmissionId("telegram", "telegram:900100200", "message:102"),
        );
        const otherProvider = yield* Effect.promise(() =>
          messengerSubmissionId("whatsapp", "telegram:900100200", "message:102"),
        );
        const decoded = yield* Schema.decodeEffect(ThinkSubmissionId)(first);

        expect(decoded).toBe(first);
        expect(first).toBe(retry);
        expect(first).not.toBe(otherProvider);
        expect(first).not.toContain(":");
      }),
  );

  it.effect("rejects an invalid webhook secret before it decodes the update", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        SELF.fetch(request(update(1), "invalid-secret")),
      );

      expect(response.status).toBe(401);
    }),
  );

  it.effect("accepts a valid direct update through the Think messenger", () =>
    Effect.gen(function* () {
      const telegramCalls: Array<string> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        telegramCalls.push(url);
        if (url.endsWith("/getMe")) {
          return Promise.resolve(
            Response.json({
              ok: true,
              result: {
                first_name: "Osfo",
                id: 100200300,
                is_bot: true,
                username: "osfo_test_bot",
              },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            ok: true,
            result: {
              chat: { id: 12345, type: "private" },
              date: 1_786_930_001,
              from: { first_name: "Osfo", id: 100200300, is_bot: true },
              message_id: 7001,
              text: "Open https://osfo.test/get-started to connect Telegram to your Osfo Agent.",
            },
          }),
        );
      });
      const directUpdate = update(2);

      const first = yield* Effect.promise(() => SELF.fetch(request(directUpdate)));
      expect(first.status).toBe(200);
      expect(telegramCalls.filter((url) => url.endsWith("/getMe"))).toHaveLength(1);
    }),
  );

  it.effect("does not append an empty fallback after a deterministic notice", () =>
    Effect.gen(function* () {
      const visibleMessages: Array<string> = [];
      const channel = makeTelegramChannel({
        conversation: () => ({ target: "self" }),
        secretToken: "telegram-test-webhook-secret",
        token: "telegram-test-bot-token",
        userName: "osfo_test_bot",
      });
      const policy = channel.delivery ?? {};
      const surface = {
        post: async (message: string | { markdown: string } | AsyncIterable<string>) => {
          if (Schema.is(Schema.String)(message)) {
            visibleMessages.push(message);
          } else if (Schema.is(PostedMarkdown)(message)) {
            visibleMessages.push(message.markdown);
          } else {
            for await (const chunk of message) visibleMessages.push(chunk);
          }
        },
      };

      yield* Effect.promise(() =>
        deliverMessengerReply({
          event: telegramEvent,
          policy,
          surface,
          target: {
            cancelChat: () => undefined,
            chat: async (_message, callback) => {
              await surface.post("Connect Telegram from Osfo.");
              await completeDeterministicTelegramReply(callback);
            },
          },
        }),
      );

      expect(visibleMessages).toEqual(["Connect Telegram from Osfo."]);
    }),
  );

  it("accepts Telegram's final edit no-op after reaching the visible stream limit", () => {
    const channel = makeTelegramChannel({
      conversation: () => ({ target: "self" }),
      secretToken: "telegram-test-webhook-secret",
      token: "telegram-test-bot-token",
      userName: "osfo_test_bot",
    });
    const callback = new TextStreamCallback({ visibleSoftLimit: 1 });
    callback.onEvent(JSON.stringify({ delta: "Hello", type: "text-delta" }));

    expect(
      channel.delivery?.isExpectedDeliveryCompletion?.(
        { code: "VALIDATION_ERROR", message: "message is not modified" },
        callback,
      ),
    ).toBe(true);
  });
});

const request = (body: ReturnType<typeof update>, secret = "telegram-test-webhook-secret") =>
  new Request("https://osfo.test/webhooks/telegram", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    method: "POST",
  });

const update = (updateId: number, userId = 900100200) => ({
  message: {
    chat: { id: userId, type: "private" },
    date: 1_786_930_000,
    from: {
      first_name: "Test",
      id: userId,
      is_bot: false,
      language_code: "en",
    },
    message_id: updateId + 100,
    text: "Hello",
  },
  update_id: updateId,
});

const telegramEvent = {
  capabilities: {},
  kind: "direct-message" as const,
  message: {
    attachments: [],
    author: { userId: "telegram-user-1" },
    id: "telegram-message-1",
    providerMessageId: "telegram-message-1",
    text: "Hello",
  },
  messengerId: "telegram",
  provider: "telegram",
  thread: {
    id: "telegram-thread-1",
    isDirectMessage: true,
    providerThreadId: "telegram-thread-1",
  },
};

const PostedMarkdown = Schema.Struct({ markdown: Schema.String });
