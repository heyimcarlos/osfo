/* oxlint-disable effecttsgo/async-function -- Native Think and provider fetch callbacks are Promise boundaries. */
import type { ThinkChannels } from "@cloudflare/think";
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Schema } from "effect";
import { vi } from "vitest";

import { OsfoDirectory } from "../../src/agents/osfo/directory";
import { makeTelegramChannel } from "../../src/integrations/telegram";
import { makeWhatsAppChannel } from "../../src/integrations/whatsapp";

const channels = (): ThinkChannels => ({
  telegram: makeTelegramChannel({
    apiBaseURL: "https://telegram.notice.test",
    conversation: () => Promise.resolve({ target: "self" }),
    token: "synthetic-token",
    secretToken: "synthetic-secret",
    userName: "synthetic_bot",
  }),
  whatsapp: makeWhatsAppChannel({
    apiUrl: "https://whatsapp.notice.test",
    accessToken: "synthetic-token",
    appSecret: "synthetic-secret",
    phoneNumberId: "123",
    userName: "synthetic_bot",
    verifyToken: "synthetic-secret",
    conversation: () => Promise.resolve({ target: "self" }),
  }),
});

const runtimeEnv = {
  ...env,
  TELEGRAM_BOT_TOKEN: "synthetic-token",
  TELEGRAM_BOT_USERNAME: "synthetic_bot",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "synthetic-secret",
};

const TelegramPost = Schema.Struct({ chat_id: Schema.String, text: Schema.String });

it("resolves an explicit registered target before an unrelated ambient delivery surface", async () => {
  const stub = env.OSFO_DIRECTORY.getByName("native-notice-explicit-target");
  await runInDurableObject(stub, async (_directory, state) => {
    const think = new OsfoDirectory(state, runtimeEnv);
    vi.spyOn(think, "configureChannels").mockImplementation(channels);
    const sent: Array<typeof TelegramPost.Type> = [];
    const fetcher = provider(sent);
    const ambient = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const restore = think.bindActiveDeliverySurface({ post: ambient });
    try {
      await think.onStart();
      await think.deliverNotice("Exact target notice", {
        channel: "telegram",
        thread: "telegram:456",
      });
      expect(sent).toEqual([{ chat_id: "456", text: "Exact target notice" }]);
      expect(ambient).not.toHaveBeenCalled();
      await expect(
        think.deliverNotice("Must not cross providers", {
          channel: "whatsapp",
          thread: "telegram:789",
        }),
      ).rejects.toThrow("cannot resolve");
      await expect(
        think.deliverNotice("Must not fall back", {
          channel: "unregistered",
          thread: "telegram:789",
        }),
      ).rejects.toThrow("not registered");
      expect(sent).toHaveLength(1);
      expect(ambient).not.toHaveBeenCalled();
    } finally {
      restore();
      fetcher.mockRestore();
    }
  });
});

it("lazily resolves the registered root transport after reconstruction without a messenger turn", async () => {
  const stub = env.OSFO_DIRECTORY.getByName("native-notice-cold-root");
  await runInDurableObject(stub, async (_directory, state) => {
    const sent: Array<typeof TelegramPost.Type> = [];
    const fetcher = provider(sent);
    try {
      const first = new OsfoDirectory(state, runtimeEnv);
      vi.spyOn(first, "configureChannels").mockImplementation(channels);
      await first.deliverNotice("Before reconstruction", {
        channel: "telegram",
        thread: "telegram:456",
      });
      const recovered = new OsfoDirectory(state, runtimeEnv);
      vi.spyOn(recovered, "configureChannels").mockImplementation(channels);
      await recovered.deliverNotice("After reconstruction", {
        channel: "telegram",
        thread: "telegram:789",
      });
      expect(sent).toEqual([
        { chat_id: "456", text: "Before reconstruction" },
        { chat_id: "789", text: "After reconstruction" },
      ]);
    } finally {
      fetcher.mockRestore();
    }
  });
});

const provider = (sent: Array<typeof TelegramPost.Type>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://telegram.notice.test/botsynthetic-token/getMe") {
      return Response.json({
        ok: true,
        result: { id: 777, is_bot: true, first_name: "Synthetic", username: "synthetic_bot" },
      });
    }
    if (request.url === "https://telegram.notice.test/botsynthetic-token/sendMessage") {
      const payload = Schema.decodeUnknownSync(TelegramPost)(await request.json());
      sent.push(payload);
      return Response.json({
        ok: true,
        result: {
          message_id: sent.length,
          date: 0,
          chat: { id: Number(payload.chat_id), type: "private" },
          text: payload.text,
        },
      });
    }
    throw new Error("Unexpected synthetic provider request");
  });
