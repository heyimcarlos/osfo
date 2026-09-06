/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect-owned native Durable Object callback. */
/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Native Think submission execution is the protocol under test. */
import type { Think } from "@cloudflare/think";
import { it, expect } from "@effect/vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { vi } from "vitest";

it.effect("follows an existing native submission without starting another chat", () =>
  Effect.promise(async () => {
    const stub = env.OSFO_DIRECTORY.getByName("whatsapp-existing-submission");
    await runInDurableObject(stub, async (directory) => {
      const think: Think = directory;
      const model = new MockLanguageModelV3({
        doStream: {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Your retained reminder." },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ]),
        },
      });
      const selected = vi.spyOn(think, "getModel").mockReturnValue(model);
      const chat = vi.spyOn(think, "chat");
      try {
        await think.onStart();
        const input = [
          {
            id: "user-message",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "What was my reminder?" }],
          },
        ];
        const options = {
          submissionId: "existing-submission",
          idempotencyKey: "whatsapp:exact-message",
        };
        const accepted = await think.submitMessages(input, options);
        const waiting = think.waitForSubmission(accepted.submissionId);
        await think._drainThinkSubmissions();
        const completed = await waiting;
        const replay = await think.submitMessages(input, options);
        expect(completed).toMatchObject({
          submissionId: accepted.submissionId,
          status: "completed",
        });
        expect(await think.waitForSubmission(accepted.submissionId)).toEqual(completed);
        expect(replay).toMatchObject({ accepted: false, submissionId: accepted.submissionId });
        expect(model.doStreamCalls).toHaveLength(1);
        expect(chat).not.toHaveBeenCalled();
        expect(
          (await think.getMessages()).filter((message) => message.role === "assistant"),
        ).toHaveLength(1);
      } finally {
        selected.mockRestore();
        chat.mockRestore();
      }
    });
  }),
);
