/* oxlint-disable effecttsgo/async-function -- Native Think lifecycle and model callbacks are Promise boundaries. */
import type { Think } from "@cloudflare/think";
import { TextStreamCallback, toMessengerUserMessage } from "@cloudflare/think/messengers";
import { expect, it } from "@effect/vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { vi } from "vitest";

import { harness, messenger, metadata, source } from "../../../test/support/messenger-file-turn";
import { ChannelAddress, ChannelId } from "../../domain/channel-link";
import { MessengerFileTurn } from "./messenger-file-turn";

it.each(["whatsapp", "telegram"] as const)(
  "prepares %s native input before inference and upserts the same retained message",
  async (provider) => {
    const stub = env.OSFO_DIRECTORY.getByName(`attachment-native-turn-${provider}`);
    await runInDurableObject(stub, async (directory) => {
      const think: Think = directory;
      await think.onStart();
      const test = harness();
      const context = {
        ...messenger,
        kind: "direct-message" as const,
        provider,
        messengerId: provider,
        message: {
          ...messenger.message,
          attachments: messenger.message.attachments.map((attachment) => ({
            ...attachment,
            url: "https://media.invalid/private",
          })),
        },
      };
      const turnMetadata = {
        ...metadata,
        authorityIdentity: {
          ...metadata.authorityIdentity,
          address: ChannelAddress.make({
            ...metadata.authorityIdentity.address,
            channelId: ChannelId.make(provider),
          }),
        },
      };
      const sdkMessage = toMessengerUserMessage(context);
      expect(sdkMessage.id).not.toBe(metadata.submissionId);
      expect(JSON.stringify(sdkMessage.parts)).toContain("https://media.invalid/private");
      const nativeMessage = MessengerFileTurn.messageForSubmission(
        sdkMessage,
        context,
        metadata.submissionId,
      );
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          expect(prompt).toContain("owned File messenger-file-");
          expect(prompt).toContain("retain unknown fields");
          expect(prompt).not.toContain("https://media.invalid");
          const retained = await think.session.getMessage(source.id);
          expect(JSON.stringify(retained)).toContain("owned File messenger-file-");
          return {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "reply" },
              {
                type: "text-delta",
                id: "reply",
                delta: "I will read the owned File and retain unknown fields.",
              },
              { type: "text-end", id: "reply" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ]),
          };
        },
      });
      const selected = vi.spyOn(think, "getModel").mockReturnValue(model);
      const prepared = vi.spyOn(think, "beforeTurn").mockImplementation(async (context) => ({
        maxSteps: 1,
        messages: await Effect.runPromise(
          MessengerFileTurn.prepare(
            { metadata: turnMetadata, messages: think.messages, modelMessages: context.messages },
            {
              ...test.dependencies,
              persist: (message) =>
                Effect.promise(() => think.addMessages([message], { mode: "upsert" })),
            },
          ),
        ),
      }));
      try {
        if (provider === "telegram") {
          await think.chatWithMessengerContext(nativeMessage, new TextStreamCallback(), context, {
            metadata: turnMetadata,
          });
        } else {
          const accepted = await think.runTurn({
            mode: "submit",
            input: nativeMessage,
            submissionId: metadata.submissionId,
            idempotencyKey: "attachment-native-turn",
            metadata: turnMetadata,
          });
          expect(accepted.accepted).toBe(true);
          const completed = await think.waitForSubmission(metadata.submissionId);
          expect(completed?.status).toBe("completed");
        }
        expect(model.doStreamCalls).toHaveLength(1);
        expect(think.messages.filter((message) => message.id === source.id)).toHaveLength(1);
        if (provider === "whatsapp") {
          const replay = await think.runTurn({
            mode: "submit",
            input: nativeMessage,
            submissionId: metadata.submissionId,
            idempotencyKey: "attachment-native-turn",
            metadata: turnMetadata,
          });
          expect(replay.accepted).toBe(false);
        }
        expect(test.events.filter((event) => event === "download")).toHaveLength(1);
        expect(test.files.size).toBe(1);
      } finally {
        prepared.mockRestore();
        selected.mockRestore();
      }
    });
  },
);
