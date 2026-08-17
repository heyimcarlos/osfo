import { Effect, Redacted, Schema } from "effect";
import { timingSafeEqual } from "node:crypto";

import { ChannelIdentity } from "../domain";
import type { OsfoStage } from "../env";
import type * as TelegramAdmission from "../services/telegram-message-admission";
import * as Onboarding from "../services/onboarding";
import type * as TelegramDelivery from "../services/telegram-onboarding-delivery";

/* oxlint-disable eslint/no-underscore-dangle -- Effect result unions use the standard _tag discriminator. */

const TelegramUser = Schema.Struct({
  first_name: Schema.String,
  id: Schema.Int,
  is_bot: Schema.Boolean,
  language_code: Schema.optional(Schema.String),
});

const TelegramPrivateMessage = Schema.Struct({
  chat: Schema.Struct({ id: Schema.Int, type: Schema.Literal("private") }),
  date: Schema.Int,
  from: TelegramUser,
  message_id: Schema.Int,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});

const TelegramUpdate = Schema.Struct({
  message: TelegramPrivateMessage,
  update_id: Schema.Int,
});

type TelegramUpdate = typeof TelegramUpdate.Type;

/** Expected failure while resolving or submitting one Telegram message. */
export class TelegramAdmissionUnavailable extends Schema.TaggedError<TelegramAdmissionUnavailable>()(
  "TelegramAdmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected failure while posting one deterministic Telegram response. */
export class TelegramOutboundUnavailable extends Schema.TaggedError<TelegramOutboundUnavailable>()(
  "TelegramOutboundUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Narrow outbound interface implemented by the official Telegram adapter. */
export interface TelegramOutbound {
  readonly post: (chatId: string, text: string) => Effect.Effect<void, TelegramOutboundUnavailable>;
}

/** Dependencies and stage policy for one Telegram webhook invocation. */
export interface TelegramWebhookOptions {
  readonly admission: Pick<TelegramAdmission.Interface, "accept">;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly delivery: TelegramDelivery.Interface;
  readonly onboarding: Pick<Onboarding.Interface, "enrollTelegram">;
  readonly outbound: TelegramOutbound;
  readonly secretToken: Redacted.Redacted;
  readonly stage: OsfoStage;
}

/** Verify and route one closed Telegram update without creating Chat SDK authority. */
export const handleTelegramWebhook = Effect.fn("TelegramWebhook.handle")(function* (
  request: Request,
  options: TelegramWebhookOptions,
) {
  if (options.stage === "production") return response(404, "Not found");
  if (request.method !== "POST") return response(405, "Method not allowed");
  if (!secretMatches(request, options.secretToken)) return response(401, "Unauthorized");

  const decoded = yield* decodeUpdate(request).pipe(Effect.option);
  if (decoded._tag === "None" || decoded.value.message.from.is_bot) {
    return response(400, "Invalid Telegram update");
  }
  const update = decoded.value;
  const userId = String(update.message.from.id);
  if (!options.allowedUserIds.has(userId)) return response(403, "Forbidden");

  const eventId = `telegram-update-${update.update_id}`;
  const channelIdentity = ChannelIdentity.make(`telegram:${userId}`);
  const enrollmentToken = readEnrollmentToken(update.message.text);
  if (enrollmentToken !== null) {
    const claim = yield* claimOnboardingEvent(options.delivery, eventId);
    if (claim instanceof Response) return claim;
    yield* options.onboarding.enrollTelegram({
      channelIdentity,
      eventId,
      token: Redacted.make(enrollmentToken),
    });
    yield* options.delivery.markEventAmbiguous(eventId, claim);
    yield* options.outbound.post(userId, "Telegram is connected to your Osfo Agent.");
    yield* options.delivery.completeEvent(eventId, claim);
    return response(200, "OK");
  }

  const admission = yield* options.admission.accept({
    channelIdentity,
    eventId,
    message: update.message.text,
  });
  if (admission._tag === "Accepted") return response(200, "OK");
  if (admission._tag === "Denied") return response(503, "Retry later");

  const claim = yield* claimOnboardingEvent(options.delivery, eventId);
  if (claim instanceof Response) return claim;

  const invitation = yield* options.delivery.issueInvitation(
    {
      channelIdentity,
      eventId,
      locale: telegramLocale(update),
      message: update.message.text,
    },
    claim,
  );
  yield* options.delivery.markEventAmbiguous(eventId, claim);
  yield* options.outbound.post(userId, invitation.response);
  yield* options.delivery.completeEvent(eventId, claim);
  return response(200, "OK");
});

const decodeUpdate = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: (cause) =>
      new TelegramAdmissionUnavailable({
        cause,
        message: "The Telegram update body is invalid",
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TelegramUpdate)),
    Effect.mapError(
      (cause) =>
        new TelegramAdmissionUnavailable({
          cause,
          message: "The Telegram update body is invalid",
        }),
    ),
  );

const secretMatches = (request: Request, expected: Redacted.Redacted): boolean => {
  const supplied = request.headers.get("x-telegram-bot-api-secret-token");
  if (supplied === null) return false;
  const encoder = new TextEncoder();
  const suppliedBytes = encoder.encode(supplied);
  const expectedBytes = encoder.encode(Redacted.value(expected));
  return (
    suppliedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
};

const readEnrollmentToken = (text: string): Onboarding.RegistrationToken | null => {
  const match = /^\/start(?:@[A-Za-z0-9_]+)? ([0-9a-f]{64})$/u.exec(text.trim());
  return match?.[1] === undefined ? null : Onboarding.RegistrationToken.make(match[1]);
};

const telegramLocale = (update: TelegramUpdate): Onboarding.OnboardingLocale =>
  update.message.from.language_code?.toLowerCase().startsWith("es") === true ? "es" : "en";

const response = (status: number, body: string) =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" }, status });

const claimOnboardingEvent = Effect.fn("TelegramWebhook.claimOnboardingEvent")(function* (
  delivery: Pick<TelegramDelivery.Interface, "beginEvent">,
  eventId: string,
) {
  const claim = yield* delivery.beginEvent(eventId);
  if (claim._tag === "Completed") return response(200, "OK");
  if (claim._tag === "Ambiguous") return response(503, "Provider outcome is ambiguous");
  if (claim._tag === "InProgress") return response(503, "Retry later");
  return claim.claimToken;
});
