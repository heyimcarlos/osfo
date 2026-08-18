import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { SELF } from "cloudflare:test";
import { Effect } from "effect";

describe("Think Telegram channel", () => {
  afterEach(() => vi.restoreAllMocks());

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
