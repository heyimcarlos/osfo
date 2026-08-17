import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";

import { ChannelBindingId, ChannelIdentity, RegistrationInvitationId } from "../src/domain";
import {
  handleTelegramWebhook,
  TelegramOutboundUnavailable,
} from "../src/handlers/telegram-webhook";
import type { TelegramOutbound } from "../src/handlers/telegram-webhook";
import type * as TelegramAdmission from "../src/services/telegram-message-admission";
import * as Onboarding from "../src/services/onboarding";

describe("Telegram webhook", () => {
  it.effect("verifies the webhook secret before decoding the update", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* handleTelegramWebhook(
        request(update({ text: "hello", updateId: 1 }), "wrong-secret"),
        harness.options,
      );

      expect(response.status).toBe(401);
      expect(harness.admissions).toEqual([]);
      expect(harness.posts).toEqual([]);
    }),
  );

  it.effect("rejects malformed updates and non-private Telegram chats", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const malformed = yield* handleTelegramWebhook(
        request({ update_id: "not-an-integer" }),
        harness.options,
      );
      const group = yield* handleTelegramWebhook(
        request(update({ chatType: "group", text: "hello", updateId: 2 })),
        harness.options,
      );

      expect(malformed.status).toBe(400);
      expect(group.status).toBe(400);
      expect(harness.admissions).toEqual([]);
    }),
  );

  it.effect("enforces the Telegram User ID allowlist", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ allowedUserIds: ["900100299"] });
      const response = yield* handleTelegramWebhook(
        request(update({ text: "hello", updateId: 3, userId: 900100200 })),
        harness.options,
      );

      expect(response.status).toBe(403);
      expect(harness.admissions).toEqual([]);
    }),
  );

  it.effect("uses the stable update ID for unknown-sender invitation retries", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "unbound" });
      const inbound = request(update({ languageCode: "es", text: "Hola", updateId: 41 }));
      const first = yield* handleTelegramWebhook(inbound, harness.options);
      const retry = yield* handleTelegramWebhook(
        request(update({ languageCode: "es", text: "Hola", updateId: 41 })),
        harness.options,
      );

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(harness.invitations).toEqual([
        {
          channelIdentity: ChannelIdentity.make("telegram:900100200"),
          eventId: "telegram-update-41",
          locale: "es",
          message: "Hola",
        },
      ]);
      expect(harness.posts).toEqual([
        { chatId: "900100200", text: "Regístrate en https://osfo.test/verify/token" },
      ]);
    }),
  );

  it.effect("consumes a web-first deep-link token without admitting it as conversation", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* handleTelegramWebhook(
        request(update({ text: `/start ${"a".repeat(64)}`, updateId: 42 })),
        harness.options,
      );
      const replay = yield* handleTelegramWebhook(
        request(update({ text: `/start ${"a".repeat(64)}`, updateId: 42 })),
        harness.options,
      );

      expect(response.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(harness.enrollments).toHaveLength(1);
      expect(harness.admissions).toEqual([]);
      expect(harness.posts).toEqual([
        { chatId: "900100200", text: "Telegram is connected to your Osfo Agent." },
      ]);
    }),
  );

  it.effect("routes a bound message with a stable provider event identity", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "accepted" });
      const response = yield* handleTelegramWebhook(
        request(update({ text: "Plan my day", updateId: 43 })),
        harness.options,
      );

      expect(response.status).toBe(200);
      expect(harness.admissions).toEqual([
        {
          channelIdentity: ChannelIdentity.make("telegram:900100200"),
          eventId: "telegram-update-43",
          message: "Plan my day",
        },
      ]);
      expect(harness.invitations).toEqual([]);
    }),
  );

  it.effect("acknowledges a finalized onboarding event without resubmitting it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "duplicate" });
      const response = yield* handleTelegramWebhook(
        request(update({ text: "My original setup message", updateId: 45 })),
        harness.options,
      );

      expect(response.status).toBe(200);
      expect(harness.invitations).toEqual([]);
      expect(harness.posts).toEqual([]);
    }),
  );

  it.effect("asks Telegram to retry while another delivery owns the event lease", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "in-progress" });
      const response = yield* handleTelegramWebhook(
        request(update({ text: "Plan my day", updateId: 46 })),
        harness.options,
      );

      expect(response.status).toBe(503);
      expect(harness.invitations).toEqual([]);
      expect(harness.posts).toEqual([]);
    }),
  );

  it.effect("does not resend an invitation after an ambiguous outbound failure", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "unbound", failFirstPost: true });
      const inbound = () => request(update({ text: "Help", updateId: 47 }));
      const failed = yield* Effect.exit(handleTelegramWebhook(inbound(), harness.options));
      const replay = yield* handleTelegramWebhook(inbound(), harness.options);
      harness.expireOnboardingClaims();
      const laterReplay = yield* handleTelegramWebhook(inbound(), harness.options);

      expect(Exit.isFailure(failed)).toBe(true);
      expect(replay.status).toBe(503);
      expect(laterReplay.status).toBe(503);
      expect(harness.invitations).toHaveLength(1);
      expect(harness.posts).toEqual([]);
    }),
  );

  it.effect("retries an invitation when Telegram was definitely not contacted", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "unbound", failFirstInvitation: true });
      const inbound = () => request(update({ text: "Help", updateId: 49 }));
      const failed = yield* Effect.exit(handleTelegramWebhook(inbound(), harness.options));
      harness.expireOnboardingClaims();
      const recovered = yield* handleTelegramWebhook(inbound(), harness.options);

      expect(Exit.isFailure(failed)).toBe(true);
      expect(recovered.status).toBe(200);
      expect(harness.invitations).toHaveLength(1);
      expect(harness.posts).toEqual([
        { chatId: "900100200", text: "Regístrate en https://osfo.test/verify/token" },
      ]);
    }),
  );

  it.effect("does not send when another worker takes over the prepared event lease", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ admission: "unbound", takeOverBeforeSend: true });
      const result = yield* Effect.exit(
        handleTelegramWebhook(request(update({ text: "Help", updateId: 48 })), harness.options),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(harness.invitations).toHaveLength(1);
      expect(harness.posts).toEqual([]);
    }),
  );

  it.effect("rejects the Telegram adapter in production", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ stage: "production" });
      const response = yield* handleTelegramWebhook(
        request(update({ text: "hello", updateId: 44 })),
        harness.options,
      );

      expect(response.status).toBe(404);
      expect(harness.admissions).toEqual([]);
    }),
  );
});

const makeHarness = (overrides?: {
  readonly admission?: "accepted" | "duplicate" | "in-progress" | "unbound";
  readonly allowedUserIds?: ReadonlyArray<string>;
  readonly failFirstPost?: boolean;
  readonly failFirstInvitation?: boolean;
  readonly stage?: "development" | "preview" | "production" | "test";
  readonly takeOverBeforeSend?: boolean;
}) => {
  const admissions: Array<TelegramAdmission.TelegramMessageAdmissionInput> = [];
  const enrollments: Array<Onboarding.TelegramEnrollment> = [];
  const invitations: Array<Onboarding.UnknownTelegramMessage> = [];
  const completedOnboardingEvents = new Set<string>();
  const ambiguousOnboardingEvents = new Map<string, string>();
  const pendingOnboardingEvents = new Map<string, string>();
  let claimSequence = 0;
  const posts: Array<{ readonly chatId: string; readonly text: string }> = [];
  let postAttempt = 0;
  let invitationAttempt = 0;
  const outbound: TelegramOutbound = {
    post: (chatId, text) => {
      postAttempt += 1;
      if (overrides?.failFirstPost === true && postAttempt === 1) {
        return Effect.fail(
          new TelegramOutboundUnavailable({ cause: "test failure", message: "Telegram failed" }),
        );
      }
      posts.push({ chatId, text });
      return Effect.void;
    },
  };
  const options: Parameters<typeof handleTelegramWebhook>[1] = {
    admission: {
      accept: (input) => {
        admissions.push(input);
        const outcome: TelegramAdmission.AdmissionResult["_tag"] =
          overrides?.admission === "unbound"
            ? "Unbound"
            : overrides?.admission === "duplicate"
              ? "Accepted"
              : overrides?.admission === "in-progress"
                ? "Denied"
                : "Accepted";
        return Effect.succeed({
          _tag: outcome,
        });
      },
    },
    allowedUserIds: new Set(overrides?.allowedUserIds ?? ["900100200"]),
    delivery: {
      beginEvent: (eventId) => {
        if (completedOnboardingEvents.has(eventId)) {
          return Effect.succeed({ _tag: "Completed" } as const);
        }
        if (ambiguousOnboardingEvents.has(eventId)) {
          return Effect.succeed({ _tag: "Ambiguous" } as const);
        }
        if (pendingOnboardingEvents.has(eventId)) {
          return Effect.succeed({ _tag: "InProgress" } as const);
        }
        claimSequence += 1;
        const claimToken = `claim-${claimSequence}`;
        pendingOnboardingEvents.set(eventId, claimToken);
        return Effect.succeed({ _tag: "Claimed", claimToken } as const);
      },
      completeEvent: (eventId, claimToken) =>
        Effect.sync(() => {
          if (ambiguousOnboardingEvents.get(eventId) !== claimToken) return;
          ambiguousOnboardingEvents.delete(eventId);
          pendingOnboardingEvents.delete(eventId);
          completedOnboardingEvents.add(eventId);
        }),
      issueInvitation: (input) => {
        invitationAttempt += 1;
        if (overrides?.failFirstInvitation === true && invitationAttempt === 1) {
          return Effect.fail(
            new Onboarding.OnboardingExecutionUnavailable({
              cause: "test failure before provider contact",
              message: "The invitation could not be prepared",
            }),
          );
        }
        invitations.push(input);
        if (overrides?.takeOverBeforeSend === true) {
          pendingOnboardingEvents.set(input.eventId, "takeover-claim");
        }
        return Effect.succeed({
          invitationId: RegistrationInvitationId.make("invitation-telegram"),
          response: "Regístrate en https://osfo.test/verify/token",
          verifyUrl: new URL("https://osfo.test/verify/token"),
        });
      },
      markEventAmbiguous: (eventId, claimToken) =>
        pendingOnboardingEvents.get(eventId) !== claimToken
          ? Effect.fail(
              new Onboarding.OnboardingPersistenceUnavailable({
                cause: "claim lost",
                operation: "markTelegramDeliveryAmbiguous",
              }),
            )
          : Effect.sync(() => {
              pendingOnboardingEvents.delete(eventId);
              ambiguousOnboardingEvents.set(eventId, claimToken);
            }),
    },
    onboarding: {
      enrollTelegram: (input) => {
        enrollments.push(input);
        return Effect.succeed({
          _tag: "BindingCreated",
          channelBindingId: ChannelBindingId.make("binding-telegram"),
        });
      },
    },
    outbound,
    secretToken: Redacted.make("telegram-webhook-secret"),
    stage: overrides?.stage ?? "test",
  };
  return {
    admissions,
    enrollments,
    expireOnboardingClaims: () => pendingOnboardingEvents.clear(),
    invitations,
    options,
    posts,
  };
};

type TelegramRequestBody = ReturnType<typeof update> | { readonly update_id: string };

const request = (body: TelegramRequestBody, secret = "telegram-webhook-secret") =>
  new Request("https://osfo.test/messengers/telegram/webhook", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    method: "POST",
  });

const update = ({
  chatType = "private",
  languageCode = "en",
  text,
  updateId,
  userId = 900100200,
}: {
  readonly chatType?: "group" | "private";
  readonly languageCode?: string;
  readonly text: string;
  readonly updateId: number;
  readonly userId?: number;
}) => ({
  message: {
    chat: { id: userId, type: chatType },
    date: 1_786_930_000,
    from: {
      first_name: "Dogfood",
      id: userId,
      is_bot: false,
      language_code: languageCode,
    },
    message_id: updateId + 100,
    text,
  },
  update_id: updateId,
});
