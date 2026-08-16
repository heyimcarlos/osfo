import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { users } from "@osfo/db/schema/auth";
import { Effect, Exit, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import * as Db from "../src/db";
import { ChannelIdentity, UserId } from "../src/domain";
import * as OnboardingPostgres from "../src/integrations/postgres/onboarding";
import * as Onboarding from "../src/services/onboarding";
import * as Registration from "../src/services/registration";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/strict-effect-provide -- These tests are Effect application entry points and assert tagged public results. */

describe("Onboarding application service", () => {
  it.effect("gives an unknown WhatsApp sender one resumable Registration Invitation", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const message = {
              channelIdentity: ChannelIdentity.make("whatsapp:+14165550171"),
              eventId: "wamid-first-contact",
              invitedPhoneNumber: "+14165550171",
              locale: "en" as const,
              message: "Can Osfo help me plan my week?",
            };

            const first = yield* onboarding.issueWhatsAppInvitation(message);
            const repeated = yield* onboarding.issueWhatsAppInvitation({
              ...message,
              eventId: "wamid-later-contact",
              message: "Are you still there?",
            });
            const inspected = yield* onboarding.inspectInvitation(tokenFromUrl(first.verifyUrl));

            expect(first.invitationId).toBe(repeated.invitationId);
            expect(first.response).toContain("I can help you get started");
            expect(repeated.response).toContain("registration link");
            expect(first.verifyUrl.origin).toBe("https://osfo.ai");
            expect(inspected).toEqual({
              locale: "en",
              maskedPhoneNumber: "••••••••0171",
              state: "live",
            });
          });

          yield* program.pipe(Effect.provide(makeLayer(fixture.database)));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("expires temporary registration data and replaces the invitation after 24 hours", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const message = {
              channelIdentity: ChannelIdentity.make("whatsapp:+14165550172"),
              eventId: "wamid-expiring-contact",
              invitedPhoneNumber: "+14165550172",
              locale: "es" as const,
              message: "Necesito ayuda para organizar mi semana.",
            };
            const first = yield* onboarding.issueWhatsAppInvitation(message);
            const firstToken = tokenFromUrl(first.verifyUrl);

            yield* TestClock.adjust(24 * 60 * 60 * 1_000 + 1);

            const expired = yield* onboarding.inspectInvitation(firstToken);
            const replacement = yield* onboarding.issueWhatsAppInvitation({
              ...message,
              eventId: "wamid-replacement-contact",
            });

            expect(expired).toEqual({
              locale: "es",
              maskedPhoneNumber: null,
              state: "expired",
            });
            expect(replacement.invitationId).not.toBe(first.invitationId);
          });

          yield* program.pipe(Effect.provide(makeLayer(fixture.database)));
        }),
      closeTestDatabase,
    ),
  );

  it.effect(
    "retries web registration without duplicating the User resources or enrollment link",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            yield* Effect.promise(() =>
              fixture.database.insert(users).values({
                email: "14165550173@phone-user.osfo.invalid",
                id: "user-web-onboarding",
                name: "Osfo User",
                phoneNumber: "+14165550173",
                phoneNumberVerified: true,
              }),
            );
            const program = Effect.gen(function* () {
              const onboarding = yield* Onboarding.Service;
              const input: Onboarding.CompleteInput = {
                existingProfileChoice: null,
                bindingConsent: "web-enrollment",
                invitationToken: null,
                profile: {
                  helpAreas: ["scheduling-reminders"],
                  locale: "en",
                  preferredName: "Ren",
                },
                userId: UserId.make("user-web-onboarding"),
                webEnrollmentToken: token("a"),
              };

              const first = yield* onboarding.complete(input);
              const retried = yield* onboarding.complete(input);
              const erasedInput: Onboarding.CompleteInput = {
                ...input,
                existingProfileChoice: "apply",
                profile: { helpAreas: [], locale: "en", preferredName: null },
              };
              const erased = yield* onboarding.complete(erasedInput);
              const oldProfileNeedsConsent = yield* onboarding.complete({
                ...input,
                existingProfileChoice: null,
              });
              const erasedProfileIsCurrent = yield* onboarding.complete({
                ...erasedInput,
                existingProfileChoice: null,
              });

              expect(first.userId).toBe("user-web-onboarding");
              expect(first.profileConfirmationRequired).toBe(false);
              expect(first.channel._tag).toBe("EnrollmentPending");
              expect(
                first.channel._tag === "EnrollmentPending" && first.channel.enrollmentUrl.pathname,
              ).toBe("/14165550100");
              expect(retried).toEqual(first);
              expect(erased.profileConfirmationRequired).toBe(false);
              expect(oldProfileNeedsConsent.profileConfirmationRequired).toBe(true);
              expect(erasedProfileIsCurrent.profileConfirmationRequired).toBe(false);
            });

            yield* program.pipe(Effect.provide(makeLayer(fixture.database)));
          }),
        closeTestDatabase,
      ),
  );

  it.effect("replaces an older web enrollment token and keeps invalid tokens safe", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-replaced-token", "+14165550181");
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const base: Omit<Onboarding.CompleteInput, "webEnrollmentToken"> = {
              existingProfileChoice: null,
              bindingConsent: "web-enrollment",
              invitationToken: null,
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-replaced-token"),
            };
            const firstToken = token("1");
            const replacementToken = token("2");
            yield* onboarding.complete({ ...base, webEnrollmentToken: firstToken });
            yield* onboarding.complete({ ...base, webEnrollmentToken: replacementToken });
            const replaced = yield* onboarding.inspectInvitation(firstToken);
            const invalid = yield* onboarding.inspectInvitation(token("9"));
            const oldEnrollmentError = yield* Effect.flip(
              onboarding.enrollWhatsApp({
                channelIdentity: ChannelIdentity.make("whatsapp:replaced-token"),
                eventId: "wamid-replaced-token",
                token: firstToken,
              }),
            );

            expect(replaced.state).toBe("expired");
            expect(invalid.state).toBe("invalid");
            expect(oldEnrollmentError._tag).toBe("RegistrationInvitationUnavailable");
            if (oldEnrollmentError._tag === "RegistrationInvitationUnavailable") {
              expect(oldEnrollmentError.reason).toBe("replaced");
            }
          });

          yield* program.pipe(Effect.provide(makeLayer(fixture.database)));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("binds an invited identity only after consent and rejects reuse by another User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-invited", "+14165550174");
          yield* seedUser(fixture.database, "user-other", "+14165550175");
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const issued = yield* onboarding.issueWhatsAppInvitation({
              channelIdentity: ChannelIdentity.make("whatsapp:sender-174"),
              eventId: "wamid-consent",
              invitedPhoneNumber: "+14165550174",
              locale: "en",
              message: "Help me write emails.",
            });
            const invitationToken = tokenFromUrl(issued.verifyUrl);
            const input: Onboarding.CompleteInput = {
              existingProfileChoice: null,
              bindingConsent: "accepted",
              invitationToken,
              profile: {
                helpAreas: ["writing-email"],
                locale: "en",
                preferredName: null,
              },
              userId: UserId.make("user-invited"),
              webEnrollmentToken: null,
            };

            const completed = yield* onboarding.complete(input);
            const exactRetry = yield* onboarding.complete(input);
            const changedRetry = yield* Effect.exit(
              onboarding.complete({
                ...input,
                profile: { ...input.profile, preferredName: "Changed after consumption" },
              }),
            );
            const reusedByAnotherUser = yield* Effect.exit(
              onboarding.complete({ ...input, userId: UserId.make("user-other") }),
            );

            expect(completed.channel._tag).toBe("BindingCreated");
            expect(exactRetry).toEqual(completed);
            expect(Exit.isFailure(changedRetry)).toBe(true);
            expect(Exit.isFailure(reusedByAnotherUser)).toBe(true);
          });

          yield* program.pipe(Effect.provide(makeLayer(fixture.database)));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("asks an existing User before applying new setup facts or binding WhatsApp", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-existing-profile", "+14165550182");
          const harness = makeHarness(fixture.database);
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const registration = yield* Registration.Service;
            yield* registration.complete(UserId.make("user-existing-profile"));
            const issued = yield* onboarding.issueWhatsAppInvitation({
              channelIdentity: ChannelIdentity.make("whatsapp:existing-profile"),
              eventId: "wamid-existing-profile",
              invitedPhoneNumber: "+14165550182",
              locale: "en",
              message: "Help me research a trip.",
            });
            const input: Onboarding.CompleteInput = {
              bindingConsent: "accepted",
              existingProfileChoice: null,
              invitationToken: tokenFromUrl(issued.verifyUrl),
              profile: { helpAreas: ["research"], locale: "en", preferredName: "New name" },
              userId: UserId.make("user-existing-profile"),
              webEnrollmentToken: null,
            };

            const pending = yield* onboarding.complete(input);
            expect(pending.profileConfirmationRequired).toBe(true);
            expect(pending.channel._tag).toBe("ProfileConfirmationPending");
            expect(harness.welcomes).toEqual([]);

            const completed = yield* onboarding.complete({
              ...input,
              existingProfileChoice: "apply",
            });
            expect(completed.profileConfirmationRequired).toBe(false);
            expect(completed.channel._tag).toBe("BindingCreated");
            expect(harness.welcomes).toEqual([input.profile]);
          });

          yield* program.pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("keeps refusal unbound and later accepts provider-authenticated enrollment", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-refused", "+14165550176");
          const harness = makeHarness(fixture.database);
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const issued = yield* onboarding.issueWhatsAppInvitation({
              channelIdentity: ChannelIdentity.make("whatsapp:sender-176"),
              eventId: "wamid-refusal",
              invitedPhoneNumber: "+14165550176",
              locale: "es",
              message: "Quiero organizar mis archivos.",
            });
            const refused = yield* onboarding.complete({
              existingProfileChoice: null,
              bindingConsent: "refused",
              invitationToken: tokenFromUrl(issued.verifyUrl),
              profile: { helpAreas: [], locale: "es", preferredName: null },
              userId: UserId.make("user-refused"),
              webEnrollmentToken: null,
            });
            const webToken = token("b");
            const pending = yield* onboarding.complete({
              existingProfileChoice: "apply",
              bindingConsent: "web-enrollment",
              invitationToken: null,
              profile: {
                helpAreas: ["files-documents"],
                locale: "es",
                preferredName: "Sol",
              },
              userId: UserId.make("user-refused"),
              webEnrollmentToken: webToken,
            });
            const enrolled = yield* onboarding.enrollWhatsApp({
              channelIdentity: ChannelIdentity.make("whatsapp:sender-176"),
              eventId: "wamid-enrollment",
              token: webToken,
            });

            expect(refused.channel).toEqual({ _tag: "ConsentRefused" });
            expect(pending.channel._tag).toBe("EnrollmentPending");
            expect(enrolled._tag).toBe("BindingCreated");
            expect(harness.welcomes).toEqual([
              {
                helpAreas: ["files-documents"],
                locale: "es",
                preferredName: "Sol",
              },
            ]);
          });

          yield* program.pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("fails closed when a provider identity belongs to another User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-binding-owner", "+14165550177");
          yield* seedUser(fixture.database, "user-binding-other", "+14165550178");
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const identity = ChannelIdentity.make("whatsapp:shared-identity");
            const firstToken = token("c");
            yield* onboarding.complete({
              existingProfileChoice: null,
              bindingConsent: "web-enrollment",
              invitationToken: null,
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-binding-owner"),
              webEnrollmentToken: firstToken,
            });
            const firstBinding = yield* onboarding.enrollWhatsApp({
              channelIdentity: identity,
              eventId: "wamid-owner",
              token: firstToken,
            });
            const matchingToken = token("f");
            yield* onboarding.complete({
              existingProfileChoice: null,
              bindingConsent: "web-enrollment",
              invitationToken: null,
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-binding-owner"),
              webEnrollmentToken: matchingToken,
            });
            const matching = yield* onboarding.enrollWhatsApp({
              channelIdentity: identity,
              eventId: "wamid-owner-retry",
              token: matchingToken,
            });
            const secondToken = token("d");
            yield* onboarding.complete({
              existingProfileChoice: null,
              bindingConsent: "web-enrollment",
              invitationToken: null,
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-binding-other"),
              webEnrollmentToken: secondToken,
            });
            const conflict = yield* Effect.exit(
              onboarding.enrollWhatsApp({
                channelIdentity: identity,
                eventId: "wamid-conflict",
                token: secondToken,
              }),
            );

            expect(Exit.isFailure(conflict)).toBe(true);
            expect(matching._tag).toBe("BindingExisting");
            expect(
              "channelBindingId" in matching &&
                "channelBindingId" in firstBinding &&
                matching.channelBindingId === firstBinding.channelBindingId,
            ).toBe(true);
          });

          yield* program.pipe(Effect.provide(makeLayer(fixture.database)));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("recovers after a welcome failure without duplicating registration or binding", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-recovery", "+14165550179");
          const harness = makeHarness(fixture.database, { failWelcomeOnce: true });
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const issued = yield* onboarding.issueWhatsAppInvitation({
              channelIdentity: ChannelIdentity.make("whatsapp:sender-179"),
              eventId: "wamid-recovery",
              invitedPhoneNumber: "+14165550179",
              locale: "en",
              message: "I need help with research.",
            });
            const input: Onboarding.CompleteInput = {
              existingProfileChoice: null,
              bindingConsent: "accepted",
              invitationToken: tokenFromUrl(issued.verifyUrl),
              profile: {
                helpAreas: ["research"],
                locale: "en",
                preferredName: "Ari",
              },
              userId: UserId.make("user-recovery"),
              webEnrollmentToken: null,
            };

            const interrupted = yield* Effect.exit(onboarding.complete(input));
            const recovered = yield* onboarding.complete(input);
            const retriedAgain = yield* onboarding.complete(input);

            expect(Exit.isFailure(interrupted)).toBe(true);
            expect(recovered).toEqual(retriedAgain);
            expect(recovered.channel._tag).toBe("BindingCreated");
            expect(harness.welcomes).toEqual([input.profile, input.profile]);
          });

          yield* program.pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );
});

const makeLayer = (database: Parameters<typeof Db.layerFromDatabase>[0]) =>
  makeHarness(database).layer;

const makeHarness = (
  database: Parameters<typeof Db.layerFromDatabase>[0],
  options?: { readonly failWelcomeOnce?: boolean },
) => {
  const welcomes: Array<Onboarding.SetupProfile> = [];
  let shouldFailWelcome = options?.failWelcomeOnce ?? false;
  const layer = Onboarding.layerWithoutDependencies.pipe(
    Layer.provideMerge(OnboardingPostgres.layerWithoutDependencies),
    Layer.provideMerge(Registration.layerWithoutDependencies),
    Layer.provideMerge(Db.layerFromDatabase(database)),
    Layer.provideMerge(BrowserCrypto.layer),
    Layer.provideMerge(
      Layer.succeed(Onboarding.OnboardingConfig, {
        officialWhatsAppNumber: "14165550100",
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        Onboarding.AgentOnboarding,
        Onboarding.AgentOnboarding.of({
          commitWelcome: ({ profile }) => {
            if (shouldFailWelcome) {
              shouldFailWelcome = false;
              return new Onboarding.OnboardingExecutionUnavailable({
                cause: "injected failure",
                message: "The welcome could not be committed",
              });
            }
            welcomes.push(profile);
            return Effect.void;
          },
          initialize: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        Onboarding.RegistrationTurn,
        Onboarding.RegistrationTurn.of({
          begin: ({ verifyUrl }) =>
            Effect.succeed(
              verifyUrl.endsWith("/get-started")
                ? "Use the registration link I sent earlier."
                : `I can help you get started. Verify at ${verifyUrl}`,
            ),
          delete: () => Effect.void,
        }),
      ),
    ),
  );
  return { layer, welcomes };
};

const seedUser = (
  database: Parameters<typeof Db.layerFromDatabase>[0],
  id: string,
  phoneNumber: string,
) =>
  Effect.promise(() =>
    database.insert(users).values({
      email: `${id}@phone-user.osfo.invalid`,
      id,
      name: "Osfo User",
      phoneNumber,
      phoneNumberVerified: true,
    }),
  );

const token = (character: string) =>
  Redacted.make(Onboarding.RegistrationToken.make(character.repeat(64)));

const tokenFromUrl = (url: URL) =>
  Redacted.make(Onboarding.RegistrationToken.make(url.pathname.replace("/verify/", "")));
