import { Context, Crypto, DateTime, Effect, Layer, Redacted } from "effect";

import { RegistrationInvitationId } from "../domain";
import type { ChannelIdentity } from "../domain";
import * as Onboarding from "./onboarding";

/** Values committed atomically before Telegram can receive one invitation. */
export interface PrepareInvitationInput {
  readonly channelIdentity: ChannelIdentity;
  readonly claimToken: string;
  readonly createdAt: Date;
  readonly eventId: string;
  readonly expiresAt: Date;
  readonly invitationId: RegistrationInvitationId;
  readonly locale: Onboarding.OnboardingLocale;
  readonly tokenDigest: string;
}

/** Telegram delivery lifecycle persistence owned by the Telegram onboarding adapter. */
export interface PersistencePort {
  readonly begin: (
    eventId: string,
    claimToken: string,
    now: Date,
  ) => Effect.Effect<
    | { readonly _tag: "Ambiguous" }
    | { readonly _tag: "Completed" }
    | { readonly _tag: "InProgress" }
    | { readonly _tag: "Claimed"; readonly claimToken: string },
    Onboarding.OnboardingPersistenceUnavailable
  >;
  readonly complete: (
    eventId: string,
    claimToken: string,
    now: Date,
  ) => Effect.Effect<void, Onboarding.OnboardingPersistenceUnavailable>;
  readonly markAmbiguous: (
    eventId: string,
    claimToken: string,
  ) => Effect.Effect<void, Onboarding.OnboardingPersistenceUnavailable>;
  readonly prepareInvitation: (
    input: PrepareInvitationInput,
  ) => Effect.Effect<void, Onboarding.OnboardingPersistenceRejected>;
}

/** PostgreSQL persistence required by Telegram onboarding delivery. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/TelegramOnboardingDelivery/Persistence",
) {}

/** Telegram-owned onboarding delivery operations used by the webhook adapter. */
export interface Interface {
  readonly beginEvent: (
    eventId: string,
  ) => Effect.Effect<
    | { readonly _tag: "Ambiguous" }
    | { readonly _tag: "Completed" }
    | { readonly _tag: "InProgress" }
    | { readonly _tag: "Claimed"; readonly claimToken: string },
    Onboarding.OnboardingIdentityUnavailable | Onboarding.OnboardingPersistenceUnavailable
  >;
  readonly completeEvent: (
    eventId: string,
    claimToken: string,
  ) => Effect.Effect<void, Onboarding.OnboardingPersistenceUnavailable>;
  readonly issueInvitation: (
    input: Onboarding.UnknownTelegramMessage,
    claimToken: string,
  ) => Effect.Effect<
    Onboarding.RegistrationTurnIssued,
    | Onboarding.OnboardingExecutionUnavailable
    | Onboarding.OnboardingIdentityUnavailable
    | Onboarding.OnboardingPersistenceRejected
    | Onboarding.OnboardingPersistenceUnavailable
  >;
  readonly markEventAmbiguous: (
    eventId: string,
    claimToken: string,
  ) => Effect.Effect<void, Onboarding.OnboardingPersistenceUnavailable>;
}

/** Telegram onboarding delivery application service. */
export class Service extends Context.Service<Service, Interface>()(
  "@osfo/TelegramOnboardingDelivery",
) {}

/** Construct Telegram delivery from shared invitation capabilities and Telegram persistence. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const links = yield* Onboarding.OnboardingLinks;
  const onboardingPersistence = yield* Onboarding.Persistence;
  const persistence = yield* Persistence;
  const registrationTurn = yield* Onboarding.RegistrationTurn;

  const issueInvitation: Interface["issueInvitation"] = (input, claimToken) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowDate = DateTime.toDateUtc(now);
      yield* onboardingPersistence.expireLive(nowDate);
      const liveInvitationId = yield* onboardingPersistence.findLiveChannel(
        "telegram",
        input.channelIdentity,
      );
      const generated =
        liveInvitationId === null
          ? yield* Onboarding.generateRegistrationInvitationIdentity(crypto)
          : null;
      const invitationId =
        liveInvitationId ??
        RegistrationInvitationId.make(`registration-invitation-${input.eventId}`);
      const candidateUrl =
        generated === null ? links.registrationHome() : links.verification(generated.token);
      const turn = yield* registrationTurn.begin({
        eventId: input.eventId,
        invitationId,
        locale: input.locale,
        message: input.message,
        verifyUrl: candidateUrl.href,
      });
      const verifyUrl = yield* parseRecoveredVerificationUrl(turn.verifyUrl);
      const recoveredToken = Onboarding.RegistrationToken.make(
        verifyUrl.pathname.slice("/verify/".length),
      );
      yield* persistence.prepareInvitation({
        channelIdentity: input.channelIdentity,
        claimToken,
        createdAt: nowDate,
        eventId: input.eventId,
        expiresAt: DateTime.toDateUtc(DateTime.add(now, { hours: 24 })),
        invitationId,
        locale: input.locale,
        tokenDigest: yield* Onboarding.digestRegistrationToken(
          crypto,
          Redacted.make(recoveredToken),
        ),
      });
      return { invitationId, response: turn.response, verifyUrl };
    });

  return Service.of({
    beginEvent: (eventId) =>
      Effect.all([secureUuid(crypto), DateTime.now.pipe(Effect.map(DateTime.toDateUtc))]).pipe(
        Effect.flatMap(([claimToken, now]) => persistence.begin(eventId, claimToken, now)),
      ),
    completeEvent: (eventId, claimToken) =>
      DateTime.now.pipe(
        Effect.map(DateTime.toDateUtc),
        Effect.flatMap((now) => persistence.complete(eventId, claimToken, now)),
      ),
    issueInvitation,
    markEventAmbiguous: (eventId, claimToken) => persistence.markAmbiguous(eventId, claimToken),
  });
});

/** Telegram onboarding delivery Layer with request-scoped dependencies. */
export const layerWithoutDependencies = Layer.effect(Service, make);

const parseRecoveredVerificationUrl = (value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: (cause) =>
      new Onboarding.OnboardingExecutionUnavailable({
        cause,
        message: "The Registration Turn returned an invalid verification link",
      }),
  }).pipe(
    Effect.filterOrFail(
      (url) => /^\/verify\/[0-9a-f]{64}$/u.test(url.pathname),
      (url) =>
        new Onboarding.OnboardingExecutionUnavailable({
          cause: { path: url.pathname },
          message: "The Registration Turn returned an invalid verification link",
        }),
    ),
  );

const secureUuid = (crypto: Crypto.Crypto) =>
  crypto.randomUUIDv7.pipe(
    Effect.mapError(
      (cause) =>
        new Onboarding.OnboardingIdentityUnavailable({
          cause,
          message: "A secure onboarding identity could not be generated",
        }),
    ),
  );
