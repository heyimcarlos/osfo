/* oxlint-disable effecttsgo/global-fetch, effecttsgo/global-fetch-in-effect, vitest/no-standalone-expect -- These Effect tests drive the owned loopback Meta protocol boundary. */
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { it } from "@effect/vitest";
import { Chat, type StateAdapter } from "chat";
import { Effect, Result, Schema } from "effect";
import { expect, vi } from "vitest";

import { startProviderEmulator } from "../../../test/emulators/provider-emulator";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const typingRequest = {
  messaging_product: "whatsapp",
  status: "read",
  message_id: "wamid.inbound-verification",
  typing_indicator: { type: "text" },
};

it.effect(
  "accepts the installed WhatsApp adapter typing request and preserves injected failures",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(startProviderEmulator),
      (emulator) =>
        Effect.gen(function* () {
          const adapter = createWhatsAppAdapter({
            accessToken: "local-verification",
            appSecret: "local-secret",
            verifyToken: "local-verify",
            apiUrl: emulator.origin,
            phoneNumberId: "123456789",
          });
          const threadId = "whatsapp:123456789:16135550113";
          const state: StateAdapter = {
            acquireLock: vi.fn<StateAdapter["acquireLock"]>(),
            appendToList: vi.fn<StateAdapter["appendToList"]>(),
            connect: vi.fn<StateAdapter["connect"]>(),
            delete: vi.fn<StateAdapter["delete"]>(),
            dequeue: vi.fn<StateAdapter["dequeue"]>(),
            disconnect: vi.fn<StateAdapter["disconnect"]>(),
            enqueue: vi.fn<StateAdapter["enqueue"]>(),
            extendLock: vi.fn<StateAdapter["extendLock"]>(),
            forceReleaseLock: vi.fn<StateAdapter["forceReleaseLock"]>(),
            get: () => Promise.resolve(null),
            getList: <T>() =>
              Promise.resolve(
                // SAFETY: Only the installed MessageHistoryCache reads this list,
                // as serialized messages. startTyping decodes the complete fixture.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The SDK owns the generic stored-message contract.
                [
                  {
                    _type: "chat:Message",
                    id: typingRequest.message_id,
                    threadId,
                    text: "Hello",
                    author: {
                      userId: "16135550113",
                      userName: "Verification",
                      fullName: "Verification",
                      isMe: false,
                      isBot: false,
                    },
                    formatted: { type: "root", children: [] },
                    attachments: [],
                    metadata: { dateSent: "2026-09-05T12:00:00.000Z", edited: false },
                  },
                ] as Array<T>,
              ),
            isSubscribed: vi.fn<StateAdapter["isSubscribed"]>(),
            queueDepth: vi.fn<StateAdapter["queueDepth"]>(),
            releaseLock: vi.fn<StateAdapter["releaseLock"]>(),
            set: vi.fn<StateAdapter["set"]>(),
            setIfNotExists: vi.fn<StateAdapter["setIfNotExists"]>(),
            subscribe: vi.fn<StateAdapter["subscribe"]>(),
            unsubscribe: vi.fn<StateAdapter["unsubscribe"]>(),
          };
          const chat = new Chat({
            adapters: {},
            state,
            userName: "verification",
          });
          yield* Effect.promise(() => adapter.initialize(chat));
          yield* Effect.promise(() => adapter.startTyping(threadId));
          const ledger = yield* Effect.promise(() =>
            fetch(`${emulator.origin}/_test/whatsapp/ledger`).then((response) => response.json()),
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ body: Schema.String }))),
            ),
          );
          expect(ledger.map((entry) => entry.body)).toEqual([encodeJson(typingRequest)]);

          yield* post(emulator.origin, "/_test/whatsapp/next-response?status=503", {});
          const failed = yield* Effect.tryPromise(() => adapter.startTyping(threadId)).pipe(
            Effect.result,
          );
          expect(Result.isFailure(failed)).toBe(true);
          yield* Effect.promise(() => adapter.startTyping(threadId));
        }),
      (emulator) => Effect.promise(emulator.close),
    ),
);

it.effect("rejects malformed typing requests and keeps template-only mode fail closed", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const path = "/v25.0/123456789/messages";
        const malformed = [
          { ...typingRequest, message_id: "" },
          { ...typingRequest, message_id: 12 },
          { ...typingRequest, status: "sent" },
          { ...typingRequest, messaging_product: "other" },
          { ...typingRequest, typing_indicator: { type: "image" } },
          { ...typingRequest, typing_indicator: { type: "text", extra: true } },
          { ...typingRequest, text: { body: "private" } },
        ];
        const statuses = yield* Effect.forEach(malformed, (body) =>
          post(emulator.origin, path, body).pipe(Effect.map((response) => response.status)),
        );
        expect(statuses).toEqual(malformed.map(() => 422));
        yield* post(emulator.origin, "/_test/whatsapp/template-only", {});
        yield* post(emulator.origin, "/_test/whatsapp/next-response?status=503", {});
        expect((yield* post(emulator.origin, path, typingRequest)).status).toBe(422);
        yield* post(emulator.origin, "/_test/whatsapp/allow-messages", {});
        expect((yield* post(emulator.origin, path, typingRequest)).status).toBe(503);
        const accepted = yield* post(emulator.origin, path, typingRequest);
        expect(accepted.status).toBe(200);
        expect(yield* Effect.promise(() => accepted.json())).toEqual({ success: true });
        const ordinary = yield* post(emulator.origin, path, {
          messaging_product: "whatsapp",
          to: "16135550113",
          type: "text",
          text: { body: "Ordinary reply" },
        });
        expect(yield* Effect.promise(() => ordinary.json())).toMatchObject({
          messaging_product: "whatsapp",
          messages: [{ id: expect.any(String) }],
        });
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

const post = (origin: string, path: string, body: Schema.JsonObject) =>
  Effect.promise(() =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJson(body),
    }),
  );
