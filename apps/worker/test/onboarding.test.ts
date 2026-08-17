import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { users } from "@osfo/db/schema/auth";
import {
  channelBindings,
  registrationInvitations,
  telegramOnboardingDeliveries,
} from "@osfo/db/schema/onboarding";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Exit, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";

import * as Db from "../src/db";
import { ChannelIdentity, UserId } from "../src/domain";
import * as OnboardingPostgres from "../src/integrations/postgres/onboarding";
import * as MessagingAdmissionPostgres from "../src/integrations/postgres/messaging-admission";
import * as OnboardingLinks from "../src/integrations/public/onboarding-links";
import { handleWhatsAppOnboardingCommand } from "../src/handlers/whatsapp-onboarding";
import * as Onboarding from "../src/services/onboarding";
import * as MessagingAdmission from "../src/services/messaging-admission";
import * as Registration from "../src/services/registration";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/strict-effect-provide -- These tests are Effect application entry points and assert tagged public results. */

const transportMatrix = [
  {
    channelIdentity: (suffix: string) => ChannelIdentity.make(`whatsapp:${suffix}`),
    issue: (onboarding: Onboarding.Interface, suffix: string, locale: "en" | "es") =>
      onboarding.issueWhatsAppInvitation({
        channelIdentity: ChannelIdentity.make(`whatsapp:${suffix}`),
        eventId: `wamid-${suffix}`,
        invitedPhoneNumber: "+14165550199",
        locale,
        message: "Help me get started.",
      }),
    provider: "whatsapp",
  },
  {
    channelIdentity: (suffix: string) => ChannelIdentity.make(`telegram:${suffix}`),
    issue: (onboarding: Onboarding.Interface, suffix: string, locale: "en" | "es") =>
      issueTelegramInvitation(onboarding, {
        channelIdentity: ChannelIdentity.make(`telegram:${suffix}`),
        eventId: `telegram-update-${suffix}`,
        locale,
        message: "Help me get started.",
      }),
    provider: "telegram",
  },
] as const;

describe("Onboarding application service", () => {
  it.effect(
    "binds an unknown Telegram User ID only after SMS verification and explicit consent",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            yield* seedUser(fixture.database, "user-telegram-first", "+14165550190");
            const harness = makeHarness(fixture.database, { enrollmentProvider: "telegram" });
            const program = Effect.gen(function* () {
              const onboarding = yield* Onboarding.Service;
              const issued = yield* issueTelegramInvitation(onboarding, {
                channelIdentity: ChannelIdentity.make("telegram:900100200"),
                eventId: "telegram-update-301",
                locale: "es",
                message: "Necesito ayuda para planificar mi semana.",
              });
              const invitationToken = tokenFromUrl(issued.verifyUrl);
              const inspected = yield* onboarding.inspectInvitation(invitationToken);
              const completed = yield* onboarding.complete({
                bindingConsent: "accepted",
                existingProfileChoice: null,
                invitationToken,
                profile: {
                  helpAreas: ["scheduling-reminders"],
                  locale: "es",
                  preferredName: "Luz",
                },
                userId: UserId.make("user-telegram-first"),
              });

              expect(inspected).toEqual({
                locale: "es",
                maskedPhoneNumber: null,
                provider: "telegram",
                state: "live",
              });
              expect(completed.channel._tag).toBe("BindingCreated");
              expect(harness.welcomes).toEqual([
                {
                  helpAreas: ["scheduling-reminders"],
                  locale: "es",
                  preferredName: "Luz",
                },
              ]);
            });

            yield* program.pipe(Effect.provide(harness.layer));
          }),
        closeTestDatabase,
      ),
  );

  it.effect("does not admit a Telegram onboarding update replayed after binding", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-telegram-transition", "+14165550196");
          const onboardingHarness = makeHarness(fixture.database, {
            enrollmentProvider: "telegram",
          });
          const submissions: Array<string> = [];
          const eventId = "telegram-update-318";
          const identity = ChannelIdentity.make("telegram:900100214");
          const admissionLayer = MessagingAdmission.layerWithoutDependencies.pipe(
            Layer.provideMerge(MessagingAdmissionPostgres.layerWithoutDependencies),
            Layer.provideMerge(Db.layerFromDatabase(fixture.database)),
            Layer.provideMerge(
              Layer.succeed(
                MessagingAdmission.AgentSubmission,
                MessagingAdmission.AgentSubmission.of({
                  accept: (_agentId, input) =>
                    Effect.sync(() => {
                      submissions.push(input.submissionId);
                      throw new Error("unbound onboarding replay reached Agent acceptance");
                    }),
                  recover: (_agentId, input) =>
                    Effect.sync(() => {
                      submissions.push(input.submissionId);
                      return null;
                    }),
                }),
              ),
            ),
            Layer.provideMerge(
              Layer.succeed(
                MessagingAdmission.StableIdentity,
                MessagingAdmission.StableIdentity.of({
                  deriveAdmission: () => Effect.succeed("a".repeat(40)),
                  deriveContent: () => Effect.succeed("b".repeat(40)),
                }),
              ),
            ),
          );
          const admit = (message: string) =>
            MessagingAdmission.Service.pipe(
              Effect.flatMap((admission) =>
                admission.accept({ channelIdentity: identity, eventId, message }),
              ),
              Effect.provide(admissionLayer),
            );
          expect(yield* admit("Help me get started.")).toEqual({ _tag: "Unbound" });
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const claim = yield* onboarding.beginTelegramEvent(eventId);
            expect(claim._tag).toBe("Claimed");
            if (claim._tag !== "Claimed") return;
            const issued = yield* onboarding.issueTelegramInvitation(
              {
                channelIdentity: identity,
                eventId,
                locale: "en",
                message: "Help me get started.",
              },
              claim.claimToken,
            );
            yield* onboarding.complete({
              bindingConsent: "accepted",
              existingProfileChoice: null,
              invitationToken: tokenFromUrl(issued.verifyUrl),
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-telegram-transition"),
            });
            yield* onboarding.markTelegramEventAmbiguous(eventId, claim.claimToken);
          });
          yield* program.pipe(Effect.provide(onboardingHarness.layer));
          const invitationRows = yield* Effect.promise(() =>
            fixture.database
              .select({
                channelIdentity: registrationInvitations.channelIdentity,
                provider: registrationInvitations.provider,
                providerEventId: registrationInvitations.providerEventId,
                state: registrationInvitations.state,
              })
              .from(registrationInvitations),
          );
          expect(invitationRows).toContainEqual({
            channelIdentity: null,
            provider: "telegram",
            providerEventId: eventId,
            state: "consumed",
          });
          yield* Effect.promise(() =>
            fixture.database.update(channelBindings).set({
              revokedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T20:01:00.000Z")),
            }),
          );

          const result = yield* admit("Help me get started.");

          expect(result).toEqual({ _tag: "Unbound" });
          expect(submissions).toEqual([]);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("fences a stale Telegram worker after deterministic lease takeover", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const harness = makeHarness(fixture.database, { enrollmentProvider: "telegram" });
          yield* Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const first = yield* onboarding.beginTelegramEvent("telegram-update-takeover");
            expect(first._tag).toBe("Claimed");
            if (first._tag !== "Claimed") return;

            yield* TestClock.adjust("61 seconds");
            const second = yield* onboarding.beginTelegramEvent("telegram-update-takeover");
            expect(second._tag).toBe("Claimed");
            if (second._tag !== "Claimed") return;
            expect(second.claimToken).not.toBe(first.claimToken);

            const stalePreparation = yield* Effect.exit(
              onboarding.issueTelegramInvitation(
                {
                  channelIdentity: ChannelIdentity.make("telegram:900100298"),
                  eventId: "telegram-update-takeover",
                  locale: "en",
                  message: "Help me.",
                },
                first.claimToken,
              ),
            );
            const staleInvitationRows = yield* Effect.promise(() =>
              fixture.database
                .select({ invitationId: registrationInvitations.invitationId })
                .from(registrationInvitations),
            );
            expect(Exit.isFailure(stalePreparation)).toBe(true);
            expect(staleInvitationRows).toEqual([]);

            const staleTransition = yield* Effect.exit(
              onboarding.markTelegramEventAmbiguous("telegram-update-takeover", first.claimToken),
            );
            expect(Exit.isFailure(staleTransition)).toBe(true);

            yield* onboarding.markTelegramEventAmbiguous(
              "telegram-update-takeover",
              second.claimToken,
            );
            const staleTerminal = yield* Effect.exit(
              onboarding.completeTelegramEvent("telegram-update-takeover", first.claimToken),
            );
            expect(Exit.isFailure(staleTerminal)).toBe(true);
            yield* onboarding.completeTelegramEvent("telegram-update-takeover", second.claimToken);
          }).pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("recovers the exact digest-only Telegram invitation after lease takeover", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const harness = makeHarness(fixture.database, { enrollmentProvider: "telegram" });
          yield* Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const eventId = "telegram-update-prepared-takeover";
            const input: Onboarding.UnknownTelegramMessage = {
              channelIdentity: ChannelIdentity.make("telegram:900100299"),
              eventId,
              locale: "en",
              message: "Help me plan.",
            };
            const firstClaim = yield* onboarding.beginTelegramEvent(eventId);
            expect(firstClaim._tag).toBe("Claimed");
            if (firstClaim._tag !== "Claimed") return;
            const first = yield* onboarding.issueTelegramInvitation(input, firstClaim.claimToken);

            yield* TestClock.adjust("61 seconds");
            const secondClaim = yield* onboarding.beginTelegramEvent(eventId);
            expect(secondClaim._tag).toBe("Claimed");
            if (secondClaim._tag !== "Claimed") return;
            const recovered = yield* onboarding.issueTelegramInvitation(
              input,
              secondClaim.claimToken,
            );
            const rows = yield* Effect.promise(() =>
              fixture.database
                .select({
                  receiptState: telegramOnboardingDeliveries.state,
                  tokenDigest: registrationInvitations.tokenDigest,
                })
                .from(registrationInvitations)
                .innerJoin(
                  telegramOnboardingDeliveries,
                  eq(telegramOnboardingDeliveries.eventId, registrationInvitations.providerEventId),
                ),
            );
            const plaintextToken = first.verifyUrl.pathname.slice("/verify/".length);

            expect(recovered.verifyUrl.href).toBe(first.verifyUrl.href);
            expect(recovered.response).toBe(first.response);
            expect(rows).toEqual([
              { receiptState: "prepared", tokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            ]);
            expect(rows[0]?.tokenDigest).not.toBe(plaintextToken);
          }).pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("uses one digest-only Telegram enrollment token once for web-first setup", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-telegram-web", "+14165550191");
          const harness = makeHarness(fixture.database, { enrollmentProvider: "telegram" });
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const pending = yield* onboarding.complete({
              bindingConsent: "web-enrollment",
              existingProfileChoice: null,
              invitationToken: null,
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-telegram-web"),
            });
            const enrollmentToken = tokenFromEnrollment(pending);
            const first = yield* onboarding.enrollTelegram({
              channelIdentity: ChannelIdentity.make("telegram:900100201"),
              eventId: "telegram-update-302",
              token: enrollmentToken,
            });
            const retry = yield* onboarding.enrollTelegram({
              channelIdentity: ChannelIdentity.make("telegram:900100201"),
              eventId: "telegram-update-302",
              token: enrollmentToken,
            });
            const reuse = yield* Effect.exit(
              onboarding.enrollTelegram({
                channelIdentity: ChannelIdentity.make("telegram:900100202"),
                eventId: "telegram-update-303",
                token: enrollmentToken,
              }),
            );

            expect(pending.channel).toMatchObject({
              _tag: "EnrollmentPending",
              enrollmentUrl: expect.objectContaining({ hostname: "t.me" }),
            });
            expect(first).toEqual(retry);
            expect(Exit.isFailure(reuse)).toBe(true);
          });

          yield* program.pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

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

            const first = yield* handleWhatsAppOnboardingCommand(onboarding, {
              _tag: "UnknownSenderMessage",
              ...message,
            });
            const repeated = yield* handleWhatsAppOnboardingCommand(onboarding, {
              _tag: "UnknownSenderMessage",
              ...message,
              eventId: "wamid-later-contact",
              message: "Are you still there?",
            });
            expect(first._tag).toBe("InvitationIssued");
            expect(repeated._tag).toBe("InvitationIssued");
            if (first._tag !== "InvitationIssued" || repeated._tag !== "InvitationIssued") return;
            const inspected = yield* onboarding.inspectInvitation(
              tokenFromUrl(first.invitation.verifyUrl),
            );

            expect(first.invitation.invitationId).toBe(repeated.invitation.invitationId);
            expect(first.invitation.response).toContain("I can help you get started");
            expect(repeated.invitation.response).toBe(first.invitation.response);
            expect(repeated.invitation.verifyUrl.href).toBe(first.invitation.verifyUrl.href);
            expect(first.invitation.verifyUrl.origin).toBe("https://osfo.ai");
            expect(inspected).toEqual({
              locale: "en",
              maskedPhoneNumber: "••••••••0171",
              provider: "whatsapp",
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
              provider: "whatsapp",
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
    "retries web registration without duplicating User resources and rotates the enrollment link",
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
              expect(Redacted.value(tokenFromEnrollment(retried))).not.toBe(
                Redacted.value(tokenFromEnrollment(first)),
              );
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
            const base: Onboarding.CompleteInput = {
              existingProfileChoice: null,
              bindingConsent: "web-enrollment",
              invitationToken: null,
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-replaced-token"),
            };
            const firstToken = tokenFromEnrollment(yield* onboarding.complete(base));
            const replacementToken = tokenFromEnrollment(yield* onboarding.complete(base));
            const replaced = yield* onboarding.inspectInvitation(firstToken);
            const replacement = yield* onboarding.inspectInvitation(replacementToken);
            const invalid = yield* onboarding.inspectInvitation(token("9"));
            const oldEnrollmentError = yield* Effect.flip(
              onboarding.enrollWhatsApp({
                channelIdentity: ChannelIdentity.make("whatsapp:replaced-token"),
                eventId: "wamid-replaced-token",
                token: firstToken,
              }),
            );

            expect(replaced.state).toBe("expired");
            expect(replacement.state).toBe("live");
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
            });
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
            });
            const webToken = tokenFromEnrollment(pending);
            const turnsBeforeEnrollment = harness.turns.length;
            const enrolled = yield* handleWhatsAppOnboardingCommand(onboarding, {
              _tag: "EnrollmentControlMessage",
              channelIdentity: ChannelIdentity.make("whatsapp:sender-176"),
              eventId: "wamid-enrollment",
              token: webToken,
            });

            expect(refused.channel).toEqual({ _tag: "ConsentRefused" });
            expect(pending.channel._tag).toBe("EnrollmentPending");
            expect(enrolled).toMatchObject({
              _tag: "EnrollmentCompleted",
              channel: { _tag: "BindingCreated" },
            });
            expect(harness.turns).toHaveLength(turnsBeforeEnrollment);
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
            const firstToken = tokenFromEnrollment(
              yield* onboarding.complete({
                existingProfileChoice: null,
                bindingConsent: "web-enrollment",
                invitationToken: null,
                profile: { helpAreas: [], locale: "en", preferredName: null },
                userId: UserId.make("user-binding-owner"),
              }),
            );
            const firstBinding = yield* onboarding.enrollWhatsApp({
              channelIdentity: identity,
              eventId: "wamid-owner",
              token: firstToken,
            });
            const matchingToken = tokenFromEnrollment(
              yield* onboarding.complete({
                existingProfileChoice: null,
                bindingConsent: "web-enrollment",
                invitationToken: null,
                profile: { helpAreas: [], locale: "en", preferredName: null },
                userId: UserId.make("user-binding-owner"),
              }),
            );
            const matching = yield* onboarding.enrollWhatsApp({
              channelIdentity: identity,
              eventId: "wamid-owner-retry",
              token: matchingToken,
            });
            const secondToken = tokenFromEnrollment(
              yield* onboarding.complete({
                existingProfileChoice: null,
                bindingConsent: "web-enrollment",
                invitationToken: null,
                profile: { helpAreas: [], locale: "en", preferredName: null },
                userId: UserId.make("user-binding-other"),
              }),
            );
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

  it.effect("preserves expiry, refusal, matching, and conflict recovery through Telegram", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-telegram-refused", "+14165550192");
          yield* seedUser(fixture.database, "user-telegram-owner", "+14165550193");
          yield* seedUser(fixture.database, "user-telegram-other", "+14165550194");
          const harness = makeHarness(fixture.database, { enrollmentProvider: "telegram" });
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const expiring = yield* issueTelegramInvitation(onboarding, {
              channelIdentity: ChannelIdentity.make("telegram:900100210"),
              eventId: "telegram-update-310",
              locale: "es",
              message: "Necesito ayuda.",
            });
            yield* TestClock.adjust(24 * 60 * 60 * 1_000 + 1);
            const expired = yield* onboarding.inspectInvitation(tokenFromUrl(expiring.verifyUrl));
            const replacement = yield* issueTelegramInvitation(onboarding, {
              channelIdentity: ChannelIdentity.make("telegram:900100210"),
              eventId: "telegram-update-311",
              locale: "es",
              message: "Necesito ayuda.",
            });

            const refusedInvitation = yield* issueTelegramInvitation(onboarding, {
              channelIdentity: ChannelIdentity.make("telegram:900100211"),
              eventId: "telegram-update-312",
              locale: "en",
              message: "Help me.",
            });
            const refused = yield* onboarding.complete({
              bindingConsent: "refused",
              existingProfileChoice: null,
              invitationToken: tokenFromUrl(refusedInvitation.verifyUrl),
              profile: { helpAreas: [], locale: "en", preferredName: null },
              userId: UserId.make("user-telegram-refused"),
            });
            const refusedEnrollmentToken = tokenFromEnrollment(
              yield* onboarding.complete({
                bindingConsent: "web-enrollment",
                existingProfileChoice: "apply",
                invitationToken: null,
                profile: { helpAreas: ["research"], locale: "en", preferredName: null },
                userId: UserId.make("user-telegram-refused"),
              }),
            );
            const laterBinding = yield* onboarding.enrollTelegram({
              channelIdentity: ChannelIdentity.make("telegram:900100211"),
              eventId: "telegram-update-313",
              token: refusedEnrollmentToken,
            });

            const sharedIdentity = ChannelIdentity.make("telegram:900100212");
            const ownerToken = tokenFromEnrollment(
              yield* onboarding.complete({
                bindingConsent: "web-enrollment",
                existingProfileChoice: null,
                invitationToken: null,
                profile: { helpAreas: [], locale: "en", preferredName: null },
                userId: UserId.make("user-telegram-owner"),
              }),
            );
            const ownerBinding = yield* onboarding.enrollTelegram({
              channelIdentity: sharedIdentity,
              eventId: "telegram-update-314",
              token: ownerToken,
            });
            const matchingToken = tokenFromEnrollment(
              yield* onboarding.complete({
                bindingConsent: "web-enrollment",
                existingProfileChoice: null,
                invitationToken: null,
                profile: { helpAreas: [], locale: "en", preferredName: null },
                userId: UserId.make("user-telegram-owner"),
              }),
            );
            const matching = yield* onboarding.enrollTelegram({
              channelIdentity: sharedIdentity,
              eventId: "telegram-update-315",
              token: matchingToken,
            });
            const conflictToken = tokenFromEnrollment(
              yield* onboarding.complete({
                bindingConsent: "web-enrollment",
                existingProfileChoice: null,
                invitationToken: null,
                profile: { helpAreas: [], locale: "en", preferredName: null },
                userId: UserId.make("user-telegram-other"),
              }),
            );
            const conflict = yield* Effect.exit(
              onboarding.enrollTelegram({
                channelIdentity: sharedIdentity,
                eventId: "telegram-update-316",
                token: conflictToken,
              }),
            );

            expect(expired).toMatchObject({ provider: "telegram", state: "expired" });
            expect(replacement.invitationId).not.toBe(expiring.invitationId);
            expect(refused.channel).toEqual({ _tag: "ConsentRefused" });
            expect(laterBinding._tag).toBe("BindingCreated");
            expect(matching._tag).toBe("BindingExisting");
            expect(
              "channelBindingId" in matching &&
                "channelBindingId" in ownerBinding &&
                matching.channelBindingId === ownerBinding.channelBindingId,
            ).toBe(true);
            expect(Exit.isFailure(conflict)).toBe(true);
          });

          yield* program.pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

  it.effect("recovers a Telegram-first welcome without duplicating stable resources", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* seedUser(fixture.database, "user-telegram-recovery", "+14165550195");
          const harness = makeHarness(fixture.database, {
            enrollmentProvider: "telegram",
            failWelcomeOnce: true,
          });
          const program = Effect.gen(function* () {
            const onboarding = yield* Onboarding.Service;
            const issued = yield* issueTelegramInvitation(onboarding, {
              channelIdentity: ChannelIdentity.make("telegram:900100213"),
              eventId: "telegram-update-317",
              locale: "en",
              message: "Help me research.",
            });
            const input: Onboarding.CompleteInput = {
              bindingConsent: "accepted",
              existingProfileChoice: null,
              invitationToken: tokenFromUrl(issued.verifyUrl),
              profile: { helpAreas: ["research"], locale: "en", preferredName: "Ari" },
              userId: UserId.make("user-telegram-recovery"),
            };

            const interrupted = yield* Effect.exit(onboarding.complete(input));
            const recovered = yield* onboarding.complete(input);
            const retried = yield* onboarding.complete(input);

            expect(Exit.isFailure(interrupted)).toBe(true);
            expect(recovered).toEqual(retried);
            expect(recovered.channel._tag).toBe("BindingCreated");
            expect(harness.welcomes).toEqual([input.profile, input.profile]);
          });

          yield* program.pipe(Effect.provide(harness.layer));
        }),
      closeTestDatabase,
    ),
  );

  describe.each(transportMatrix)("$provider transport-neutral journeys", (transport) => {
    it.effect("resumes, expires, and replaces one invitation", () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const userId = UserId.make(`user-${transport.provider}-expiry`);
            yield* seedUser(fixture.database, userId, "+14165550199");
            const harness = makeHarness(fixture.database, {
              enrollmentProvider: transport.provider,
            });
            const program = Effect.gen(function* () {
              const onboarding = yield* Onboarding.Service;
              const first = yield* transport.issue(
                onboarding,
                `${transport.provider}-resume`,
                "es",
              );
              const resumed = yield* onboarding.inspectInvitation(tokenFromUrl(first.verifyUrl));

              yield* TestClock.adjust(24 * 60 * 60 * 1_000 + 1);

              const expired = yield* onboarding.inspectInvitation(tokenFromUrl(first.verifyUrl));
              const expiredReuse = yield* Effect.exit(
                onboarding.complete({
                  bindingConsent: "accepted",
                  existingProfileChoice: null,
                  invitationToken: tokenFromUrl(first.verifyUrl),
                  profile: { helpAreas: [], locale: "es", preferredName: null },
                  userId,
                }),
              );
              const replacement = yield* transport.issue(
                onboarding,
                `${transport.provider}-replacement`,
                "es",
              );

              expect(resumed).toMatchObject({ provider: transport.provider, state: "live" });
              expect(expired).toMatchObject({ provider: transport.provider, state: "expired" });
              expect(Exit.isFailure(expiredReuse)).toBe(true);
              expect(replacement.invitationId).not.toBe(first.invitationId);
            });

            yield* program.pipe(Effect.provide(harness.layer));
          }),
        closeTestDatabase,
      ),
    );

    it.effect("recovers after Phone Account verification and deletes the temporary dialogue", () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const userId = UserId.make(`user-${transport.provider}-sms-recovery`);
            yield* seedUser(fixture.database, userId, "+14165550199");
            yield* Effect.promise(() =>
              fixture.database
                .update(users)
                .set({ phoneNumberVerified: false })
                .where(eq(users.id, userId)),
            );
            const harness = makeHarness(fixture.database, {
              enrollmentProvider: transport.provider,
            });
            const program = Effect.gen(function* () {
              const onboarding = yield* Onboarding.Service;
              const issued = yield* transport.issue(
                onboarding,
                `${transport.provider}-sms-recovery`,
                "en",
              );
              const input: Onboarding.CompleteInput = {
                bindingConsent: "accepted",
                existingProfileChoice: null,
                invitationToken: tokenFromUrl(issued.verifyUrl),
                profile: { helpAreas: ["research"], locale: "en", preferredName: null },
                userId,
              };
              const beforeVerification = yield* Effect.exit(onboarding.complete(input));
              yield* Effect.promise(() =>
                fixture.database
                  .update(users)
                  .set({ phoneNumberVerified: true })
                  .where(eq(users.id, userId)),
              );
              const completed = yield* onboarding.complete(input);

              expect(Exit.isFailure(beforeVerification)).toBe(true);
              expect(completed.channel._tag).toBe("BindingCreated");
              expect(harness.deletedInvitations).toEqual([issued.invitationId]);
            });

            yield* program.pipe(Effect.provide(harness.layer));
          }),
        closeTestDatabase,
      ),
    );

    it.effect("asks an existing User before applying profile facts", () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const userId = UserId.make(`user-${transport.provider}-existing-profile`);
            yield* seedUser(fixture.database, userId, "+14165550199");
            const harness = makeHarness(fixture.database, {
              enrollmentProvider: transport.provider,
            });
            const program = Effect.gen(function* () {
              const onboarding = yield* Onboarding.Service;
              const registration = yield* Registration.Service;
              yield* registration.complete(userId);
              const issued = yield* transport.issue(
                onboarding,
                `${transport.provider}-existing-profile`,
                "en",
              );
              const input: Onboarding.CompleteInput = {
                bindingConsent: "accepted",
                existingProfileChoice: null,
                invitationToken: tokenFromUrl(issued.verifyUrl),
                profile: { helpAreas: ["research"], locale: "en", preferredName: "New name" },
                userId,
              };
              const pending = yield* onboarding.complete(input);
              const completed = yield* onboarding.complete({
                ...input,
                existingProfileChoice: "apply",
              });

              expect(pending).toMatchObject({
                channel: { _tag: "ProfileConfirmationPending" },
                profileConfirmationRequired: true,
              });
              expect(completed.channel._tag).toBe("BindingCreated");
              expect(harness.welcomes).toEqual([input.profile]);
            });

            yield* program.pipe(Effect.provide(harness.layer));
          }),
        closeTestDatabase,
      ),
    );
  });
});

const makeLayer = (database: Parameters<typeof Db.layerFromDatabase>[0]) =>
  makeHarness(database).layer;

const issueTelegramInvitation = (
  onboarding: Onboarding.Interface,
  input: Onboarding.UnknownTelegramMessage,
) =>
  Effect.gen(function* () {
    const claim = yield* onboarding.beginTelegramEvent(input.eventId);
    if (claim._tag !== "Claimed") {
      return yield* new Onboarding.OnboardingPersistenceUnavailable({
        cause: claim,
        operation: "claimTelegramTestEvent",
      });
    }
    return yield* onboarding.issueTelegramInvitation(input, claim.claimToken);
  });

const makeHarness = (
  database: Parameters<typeof Db.layerFromDatabase>[0],
  options?: {
    readonly enrollmentProvider?: "telegram" | "whatsapp";
    readonly failWelcomeOnce?: boolean;
  },
) => {
  const welcomes: Array<Onboarding.SetupProfile> = [];
  const deletedInvitations: Array<string> = [];
  const turns: Array<{ readonly eventId: string; readonly verifyUrl: string }> = [];
  const durableTurnUrls = new Map<string, string>();
  let shouldFailWelcome = options?.failWelcomeOnce ?? false;
  const layer = Onboarding.layerWithoutDependencies.pipe(
    Layer.provideMerge(OnboardingPostgres.layerWithoutDependencies),
    Layer.provideMerge(Registration.layerWithoutDependencies),
    Layer.provideMerge(Db.layerFromDatabase(database)),
    Layer.provideMerge(BrowserCrypto.layer),
    Layer.provideMerge(
      OnboardingLinks.layer({
        enrollmentProvider: options?.enrollmentProvider ?? "whatsapp",
        officialWhatsAppNumber: "14165550100",
        publicBaseUrl: new URL("https://osfo.ai"),
        telegramBotUsername: "osfo_test_bot",
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
          begin: ({ eventId, invitationId, verifyUrl }) => {
            const durableVerifyUrl = durableTurnUrls.get(invitationId) ?? verifyUrl;
            durableTurnUrls.set(invitationId, durableVerifyUrl);
            turns.push({ eventId, verifyUrl: durableVerifyUrl });
            return Effect.succeed({
              response: durableVerifyUrl.endsWith("/get-started")
                ? "Use the registration link I sent earlier."
                : `I can help you get started. Verify at ${durableVerifyUrl}`,
              verifyUrl: durableVerifyUrl,
            });
          },
          delete: (invitationId) =>
            Effect.sync(() => {
              deletedInvitations.push(invitationId);
            }),
        }),
      ),
    ),
  );
  return { deletedInvitations, layer, turns, welcomes };
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

const tokenFromEnrollment = (completed: Onboarding.OnboardingCompleted) => {
  expect(completed.channel._tag).toBe("EnrollmentPending");
  if (completed.channel._tag !== "EnrollmentPending") return token("0");
  const { enrollmentUrl } = completed.channel;
  const command = enrollmentUrl.searchParams.get("start") ?? enrollmentUrl.searchParams.get("text");
  const encoded = command?.replace(/^OSFO ENROLL /u, "");
  return Redacted.make(Schema.decodeUnknownSync(Onboarding.RegistrationToken)(encoded));
};
