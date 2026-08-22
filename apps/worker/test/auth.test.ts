import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { accounts, sessions, users, verifications } from "@osfo/db/schema/auth";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { count, eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { App } from "../src/app";
import { WorkerAuth } from "../src/auth";
import { Db } from "../src/db";
import type { CloudflareConfig } from "../src/config";
import { launchModelAccessPolicy } from "../src/domain/model-access-policy";
import { TwilioVerify } from "../src/integrations/twilio/verify";
import { ChannelLinks } from "../src/services/channel-links";

const authConfig = {
  baseURL: "https://osfo.test/",
  credentialAuthentication: "disabled" as const,
  dashboard: { kind: "disabled" as const },
  secret: Redacted.make("test-only-better-auth-secret-32-characters"),
  trustedOrigins: ["https://osfo.test"],
};

describe("launch authentication policy", () => {
  it.effect("does not expose email-and-password authentication", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, makeTestTwilio().service),
          );

          const response = yield* request(app.handler, "/auth/sign-up/email", {
            email: "tester@osfo.test",
            name: "Osfo Tester",
            password: "test-password",
          });
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));

          expect(response.status).toBe(400);
          expect(storedUsers).toEqual([]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("does not expose email-and-password sign-up when credential sign-in is enabled", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, makeTestTwilio().service),
            { ...authConfig, credentialAuthentication: "enabled" },
          );

          const response = yield* request(app.handler, "/auth/sign-up/email", {
            email: "tester@osfo.test",
            name: "Osfo Tester",
            password: "test-password",
          });
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));

          expect(response.status).toBe(400);
          expect(storedUsers).toEqual([]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

describe("authentication CORS", () => {
  it.effect("allows the configured web origin on auth preflight requests", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, makeTestTwilio().service),
            { ...authConfig, trustedOrigins: ["https://osfo.ai"] },
          );

          const response = yield* preflight(app.handler, "/auth/phone-number/send-otp", {
            origin: "https://osfo.ai",
          });

          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("https://osfo.ai");
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
          expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
            "b3",
          );
          expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
            "traceparent",
          );

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("removes Better Auth CORS headers for untrusted origins", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, makeTestTwilio().service),
            { ...authConfig, trustedOrigins: ["http://localhost:5173"] },
          );

          const response = yield* authGet(app.handler, "/auth/get-session", {
            origin: "https://osfo.ai",
          });

          expect(response.headers.get("access-control-allow-origin")).toBeNull();
          expect(response.headers.get("access-control-allow-credentials")).toBeNull();

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("allows the Better Auth dashboard origin", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, makeTestTwilio().service),
          );

          const response = yield* preflight(app.handler, "/auth/dash/config", {
            method: "GET",
            origin: "https://dash.better-auth.com",
          });

          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe(
            "https://dash.better-auth.com",
          );
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

describe("phone authentication", () => {
  it.effect("creates a User and AuthSession after the first valid SMS code", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );

          const sent = yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550101",
          });
          const verified = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber: "+14165550101",
          });
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));
          const storedSessions = yield* Effect.promise(() =>
            fixture.database.select().from(sessions),
          );
          const storedVerifications = yield* Effect.promise(() =>
            fixture.database.select().from(verifications),
          );

          expect(sent.status).toBe(200);
          expect(verified.status).toBe(200);
          expect(verified.headers.get("set-cookie")).toContain("better-auth.session_token");
          expect(storedUsers).toHaveLength(1);
          expect(storedUsers[0]).toMatchObject({
            email: "14165550101@phone-user.osfo.invalid",
            phoneNumber: "+14165550101",
            phoneNumberVerified: true,
          });
          expect(storedSessions).toHaveLength(1);
          expect(storedSessions[0]?.userId).toBe(storedUsers[0]?.id);
          expect(storedVerifications).toEqual([]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("adds email credentials after SMS verification and permits only email sign-in", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
            { ...authConfig, credentialAuthentication: "enabled" },
          );
          const phoneNumber = "+14165550108";

          yield* request(app.handler, "/auth/phone-number/send-otp", { phoneNumber });
          const verified = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber,
          });
          const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
          const credentialsSet = yield* requestWithSession(
            app.handler,
            "/auth/set-login-credentials",
            { email: "tester@osfo.test", newPassword: "test-password" },
            cookie,
          );
          const emailSignIn = yield* request(app.handler, "/auth/sign-in/email", {
            email: "tester@osfo.test",
            password: "test-password",
          });
          const repeatedCredentialSetup = yield* requestWithSession(
            app.handler,
            "/auth/set-login-credentials",
            { email: "replacement@osfo.test", newPassword: "replacement-password" },
            cookie,
          );
          const directEmailChange = yield* requestWithSession(
            app.handler,
            "/auth/change-email",
            { newEmail: "replacement@osfo.test" },
            cookie,
          );
          const blockedPhonePasswordRoutes = yield* Effect.all([
            request(app.handler, "/auth/sign-in/phone-number", {
              password: "test-password",
              phoneNumber,
            }),
            request(app.handler, "/auth/phone-number/request-password-reset", { phoneNumber }),
            request(app.handler, "/auth/phone-number/reset-password", {
              newPassword: "replacement-password",
              otp: twilio.code,
              phoneNumber,
            }),
          ]);
          const storedAccounts = yield* Effect.promise(() =>
            fixture.database.select().from(accounts).where(eq(accounts.providerId, "credential")),
          );
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));

          expect(cookie).toBeDefined();
          expect(credentialsSet.status).toBe(200);
          expect(emailSignIn.status).toBe(200);
          expect(emailSignIn.headers.get("set-cookie")).toContain("better-auth.session_token");
          expect(repeatedCredentialSetup.status).toBe(409);
          expect(directEmailChange.status).toBe(404);
          expect(blockedPhonePasswordRoutes.map((response) => response.status)).toEqual([
            404, 404, 404,
          ]);
          expect(storedAccounts).toHaveLength(1);
          expect(storedUsers).toHaveLength(1);
          expect(storedUsers[0]?.email).toBe("tester@osfo.test");

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("signs an existing phone User in without creating another User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );

          yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550102",
          });
          const first = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber: "+14165550102",
          });
          twilio.advanceBy(30 * 1_000);
          yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550102",
          });
          const second = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber: "+14165550102",
          });
          const userCounts = yield* Effect.promise(() =>
            fixture.database.select({ userCount: count() }).from(users),
          );
          const firstBody = yield* responseJson(first);
          const secondBody = yield* responseJson(second);
          const storedSessions = yield* Effect.promise(() =>
            fixture.database.select().from(sessions),
          );

          expect(second.status).toBe(200);
          expect(secondBody.user.id).toBe(firstBody.user.id);
          expect(userCounts[0]?.userCount).toBe(1);
          expect(storedSessions).toHaveLength(2);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("does not create a new AuthSession for a suspended User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );
          const phoneNumber = "+14165550109";

          yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber,
          });
          const first = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber,
          });
          const firstBody = yield* responseJson(first);
          yield* Effect.promise(() =>
            fixture.database.insert(userSuspensionEvents).values({
              action: "suspended",
              admin_actor_id: "admin-test",
              event_id: "suspension-test",
              reason: "Test suspension",
              user_id: firstBody.user.id,
            }),
          );
          twilio.advanceBy(30 * 1_000);
          yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber,
          });
          const suspendedSignIn = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber,
          });

          expect(first.status).toBe(200);
          expect(suspendedSignIn.status).toBe(403);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rejects an invalid code without creating a User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );

          yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550103",
          });
          const response = yield* request(app.handler, "/auth/phone-number/verify", {
            code: "000000",
            phoneNumber: "+14165550103",
          });
          const storedUsers = yield* Effect.promise(() =>
            fixture.database.select().from(users).where(eq(users.phoneNumber, "+14165550103")),
          );

          expect(response.status).toBe(400);
          expect(storedUsers).toEqual([]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rejects a code after the Twilio verification expires", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );

          yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550104",
          });
          twilio.advanceBy(10 * 60 * 1_000 + 1);
          const response = yield* request(app.handler, "/auth/phone-number/verify", {
            code: twilio.code,
            phoneNumber: "+14165550104",
          });
          const storedUsers = yield* Effect.promise(() =>
            fixture.database.select().from(users).where(eq(users.phoneNumber, "+14165550104")),
          );

          expect(response.status).toBe(400);
          expect(storedUsers).toEqual([]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("honors Twilio resend and verification-attempt limits", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );
          const phoneNumber = "+14165550105";

          const sent = yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber,
          });
          const immediateResend = yield* request(
            app.handler,
            "/auth/phone-number/send-otp",
            { phoneNumber },
            "203.0.113.11",
          );
          for (let send = 0; send < 4; send += 1) {
            twilio.advanceBy(30 * 1_000);
            const response = yield* request(
              app.handler,
              "/auth/phone-number/send-otp",
              { phoneNumber },
              `203.0.113.${send + 12}`,
            );
            expect(response.status).toBe(200);
          }
          twilio.advanceBy(30 * 1_000);
          const afterHourlySendLimit = yield* request(
            app.handler,
            "/auth/phone-number/send-otp",
            { phoneNumber },
            "203.0.113.16",
          );
          for (let attempt = 0; attempt < 5; attempt += 1) {
            yield* request(
              app.handler,
              "/auth/phone-number/verify",
              { code: "000000", phoneNumber },
              `203.0.113.${attempt + 20}`,
            );
          }
          const afterMaximumAttempts = yield* request(
            app.handler,
            "/auth/phone-number/verify",
            { code: twilio.code, phoneNumber },
            "203.0.113.30",
          );

          expect(sent.status).toBe(200);
          expect(immediateResend.status).not.toBe(200);
          expect(afterHourlySendLimit.status).not.toBe(200);
          expect(afterMaximumAttempts.status).toBe(400);
          expect(twilio.sendCount(phoneNumber)).toBe(5);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("returns a safe public error when the SMS provider is unavailable", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio({ unavailable: true });
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );

          const response = yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550106",
          });
          const body = yield* Effect.promise(() => response.text());

          expect(response.status).toBe(500);
          expect(body).not.toContain("provider-secret-sentinel");
          expect(body).not.toContain("test-only-better-auth-secret");

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

describe("Channel Link HTTP authentication", () => {
  it.live("accepts only for the session User and rejects incomplete registration", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const dbLayer = Db.layerFromDatabase(fixture.database);
          const authDependencies = Layer.merge(
            dbLayer,
            Layer.succeed(TwilioVerify.Service, twilio.service),
          );
          const app = App.make(testBindings, runtimeConfig, { authDependencies });
          const channelLinksLayer = ChannelLinks.layer({
            invitationLifetime: { hours: 24 },
            verificationBaseUrl: new URL("https://osfo.test/verify/"),
          }).pipe(Layer.provideMerge(dbLayer), Layer.provide(BrowserCrypto.layer));

          const registeredSession = yield* authenticatePhone(app.handler, twilio, "+14165550120");
          const storedRegisteredUsers = yield* Effect.promise(() =>
            fixture.database.select().from(users).where(eq(users.phoneNumber, "+14165550120")),
          );
          const registeredUser = yield* Effect.suspend(() => {
            const user = storedRegisteredUsers[0];
            return user === undefined
              ? Effect.die(new Error("Registered HTTP test User was not created"))
              : Effect.succeed(user);
          });
          yield* Effect.promise(() =>
            fixture.database
              .update(users)
              .set({
                registrationCompletedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2026-08-21T12:00:00.000Z"),
                ),
              })
              .where(eq(users.id, registeredUser.id)),
          );
          const registeredInvite = yield* ensureHttpInvite(
            channelLinksLayer,
            "http-registered-author",
          );
          const inspection = yield* apiRequest(
            app.handler,
            `/v1/channel-link-invites/${registeredInvite}`,
            { method: "GET" },
          );
          const accepted = yield* apiRequest(
            app.handler,
            `/v1/channel-link-invites/${registeredInvite}/accept`,
            {
              body: { userId: "browser-selected-attacker" },
              cookie: registeredSession,
              method: "POST",
            },
          );
          const [storedLink] = yield* Effect.promise(() =>
            fixture.database.select().from(channelLinks),
          );
          expect(registeredInvite).toMatch(/^[A-Za-z0-9]{8}$/u);
          expect(inspection.status).toBe(200);
          expect(yield* Effect.promise(() => inspection.json())).toMatchObject({
            state: "pending",
          });
          expect(accepted.status).toBe(200);
          expect(yield* Effect.promise(() => accepted.json())).toEqual({ state: "linked" });
          expect(storedLink?.user_id).toBe(registeredUser.id);
          expect(storedLink?.user_id).not.toBe("browser-selected-attacker");

          const incompleteSession = yield* authenticatePhone(app.handler, twilio, "+14165550121");
          const incompleteInvite = yield* ensureHttpInvite(
            channelLinksLayer,
            "http-incomplete-author",
          );
          const rejected = yield* apiRequest(
            app.handler,
            `/v1/channel-link-invites/${incompleteInvite}/accept`,
            {
              body: { userId: registeredUser.id },
              cookie: incompleteSession,
              method: "POST",
            },
          );

          expect(rejected.status).toBe(403);
          expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
            _tag: "ChannelLinkRegistrationRequired",
          });
          expect(
            yield* Effect.promise(() => fixture.database.select().from(channelLinks)),
          ).toHaveLength(1);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

describe("authentication dependency scope", () => {
  it.effect("shares one dependency graph across typed and raw routes", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          let acquisitions = 0;
          let releases = 0;
          const trackedDependencies = Layer.mergeAll(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.Service, twilio.service),
            Layer.effectDiscard(
              Effect.acquireRelease(
                Effect.sync(() => {
                  acquisitions += 1;
                }),
                () =>
                  Effect.sync(() => {
                    releases += 1;
                  }),
              ),
            ),
          );
          const app = App.make(testBindings, runtimeConfig, {
            authDependencies: trackedDependencies,
          });

          const health = yield* Effect.promise(() =>
            app.handler(new Request("https://osfo.test/health")),
          );
          const notFound = yield* Effect.promise(() =>
            app.handler(new Request("https://osfo.test/not-found")),
          );

          expect(health.status).toBe(200);
          expect(notFound.status).toBe(404);
          expect(acquisitions).toBe(1);
          expect(releases).toBe(0);

          const auth = yield* request(app.handler, "/auth/phone-number/send-otp", {
            phoneNumber: "+14165550107",
          });

          expect(auth.status).toBe(200);
          expect(acquisitions).toBe(1);
          expect(releases).toBe(0);

          yield* Effect.promise(app.dispose);
          expect(releases).toBe(1);
        }),
      closeTestDatabase,
    ),
  );
});

const makeAuthApp = (
  dbLayer: ReturnType<typeof Db.layerFromDatabase>,
  twilioLayer: Layer.Layer<TwilioVerify.Service>,
  config: WorkerAuth.AuthRouteConfig = authConfig,
) =>
  HttpRouter.toWebHandler(
    WorkerAuth.layer({
      config,
      dependencies: Layer.merge(dbLayer, twilioLayer),
    }),
    { disableLogger: true },
  );

const makeTestTwilio = (options?: { readonly unavailable?: boolean }) => {
  const code = "123456";
  let now = 0;
  const sends = new Map<string, Array<number>>();
  const pending = new Map<
    string,
    { readonly expiresAt: number; readonly code: string; attempts: number }
  >();
  const service = TwilioVerify.Service.of({
    sendCode: (phoneNumber) =>
      options?.unavailable
        ? Effect.fail(
            new TwilioVerify.TwilioVerifyUnavailable({
              message: "The SMS verification provider is unavailable",
              operation: "sendCode",
            }),
          )
        : Effect.gen(function* () {
            const history = sends.get(phoneNumber) ?? [];
            const recent = history.filter((sentAt) => sentAt > now - 60 * 60 * 1_000);
            const previous = recent.at(-1);
            if (previous !== undefined && now - previous < 30 * 1_000) {
              return yield* new TwilioVerify.TwilioVerifyRejected({
                message: "The SMS verification request was rejected",
                operation: "sendCode",
              });
            }
            if (recent.length >= 5) {
              return yield* new TwilioVerify.TwilioVerifyRejected({
                message: "The SMS verification request was rejected",
                operation: "sendCode",
              });
            }
            sends.set(phoneNumber, [...recent, now]);
            pending.set(phoneNumber, {
              attempts: 0,
              code,
              expiresAt: now + 10 * 60 * 1_000,
            });
            return undefined;
          }),
    verifyCode: (phoneNumber, submittedCode) =>
      Effect.sync(() => {
        const verification = pending.get(phoneNumber);
        if (verification === undefined || now >= verification.expiresAt) {
          pending.delete(phoneNumber);
          return false;
        }
        verification.attempts += 1;
        const approved =
          verification.attempts <= 5 && Redacted.value(submittedCode) === verification.code;
        if (approved) {
          pending.delete(phoneNumber);
          return true;
        }
        if (verification.attempts >= 5) {
          pending.delete(phoneNumber);
        }
        return false;
      }),
  });

  return {
    advanceBy: (duration: number) => {
      now += duration;
    },
    code,
    sendCount: (phoneNumber: string) => sends.get(phoneNumber)?.length ?? 0,
    service,
  };
};

const request = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: AuthRequestBody,
  connectingIp = "203.0.113.10",
) =>
  Effect.promise(() =>
    handler(
      new Request(`https://osfo.test${path}`, {
        body: encodeJsonText(body),
        headers: {
          "cf-connecting-ip": connectingIp,
          "content-type": "application/json",
          origin: "https://osfo.test",
        },
        method: "POST",
      }),
    ),
  );

const authenticatePhone = (
  handler: (request: Request) => Promise<Response>,
  twilio: ReturnType<typeof makeTestTwilio>,
  phoneNumber: string,
) =>
  Effect.gen(function* () {
    yield* request(handler, "/auth/phone-number/send-otp", { phoneNumber });
    const verified = yield* request(handler, "/auth/phone-number/verify", {
      code: twilio.code,
      phoneNumber,
    });
    const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) return yield* Effect.die(new Error("Authentication cookie missing"));
    return cookie;
  });

const ensureHttpInvite = (layer: Layer.Layer<ChannelLinks.Service>, authorId: string) =>
  Effect.scoped(
    ChannelLinks.Service.pipe(
      Effect.flatMap((channelLinksService) =>
        channelLinksService.ensure(
          ChannelLinks.ChannelAddress.make({
            authorId: ChannelLinks.ChannelAuthorId.make(authorId),
            channelId: ChannelLinks.ChannelId.make("telegram-http"),
          }),
        ),
      ),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- HTTP integration test constructs the production authority at its application boundary.
      Effect.provide(layer),
      Effect.flatMap((ensured) =>
        // oxlint-disable-next-line eslint/no-underscore-dangle -- Effect tagged unions use the canonical `_tag` discriminator.
        ensured._tag === "Invited"
          ? Effect.succeed(ensured.verificationUrl.pathname.split("/").at(-1) ?? "")
          : Effect.die(new Error("Expected a fresh HTTP Channel Link Invite")),
      ),
    ),
  );

const apiRequest = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  options: {
    readonly body?: Readonly<Record<string, string>>;
    readonly cookie?: string;
    readonly method: "GET" | "POST";
  },
) =>
  Effect.promise(() => {
    const headers = new Headers({ origin: "https://osfo.test" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.cookie !== undefined) headers.set("cookie", options.cookie);
    const init =
      options.body === undefined
        ? { headers, method: options.method }
        : { body: encodeJsonText(options.body), headers, method: options.method };
    return handler(new Request(`https://osfo.test${path}`, init));
  });

const requestWithSession = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: AuthRequestBody,
  cookie: string | undefined,
) =>
  Effect.promise(() => {
    const headers = new Headers({
      "content-type": "application/json",
      origin: "https://osfo.test",
    });
    if (cookie !== undefined) headers.set("cookie", cookie);
    return handler(
      new Request(`https://osfo.test${path}`, {
        body: encodeJsonText(body),
        headers,
        method: "POST",
      }),
    );
  });

const preflight = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  options: { readonly method?: string; readonly origin: string },
) =>
  Effect.promise(() =>
    handler(
      new Request(`https://osfo.test${path}`, {
        headers: {
          "access-control-request-method": options.method ?? "POST",
          origin: options.origin,
        },
        method: "OPTIONS",
      }),
    ),
  );

const authGet = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  options: { readonly origin: string },
) =>
  Effect.promise(() =>
    handler(
      new Request(`https://osfo.test${path}`, {
        headers: { origin: options.origin },
        method: "GET",
      }),
    ),
  );

const AuthResponse = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
});
type AuthRequestBody =
  | {
      readonly code?: string;
      readonly phoneNumber: string;
    }
  | {
      readonly email: string;
      readonly name?: string;
      readonly password: string;
    }
  | {
      readonly email: string;
      readonly newPassword: string;
    }
  | {
      readonly password: string;
      readonly phoneNumber: string;
    }
  | {
      readonly phoneNumber: string;
    }
  | {
      readonly newPassword: string;
      readonly otp: string;
      readonly phoneNumber: string;
    }
  | {
      readonly newEmail: string;
    };
const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const responseJson = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(AuthResponse)(body)),
  );

const runtimeConfig: CloudflareConfig = {
  auth: authConfig,
  companyConversation: {
    dailyTurnLimit: null,
    modelRoute: launchModelAccessPolicy.plans.free.route,
  },
  stage: "test",
  telegram: {
    botToken: Redacted.make("telegram-test-bot-token"),
    botUsername: "osfo_test_bot",
    webhookSecret: Redacted.make("telegram-test-webhook-secret"),
  },
  stripe: {
    adventurerPriceId: "price_adventurer",
    adventurerProductId: "prod_adventurer",
    portalConfigurationId: "bpc_approved",
    secretKey: Redacted.make("sk_test_osfo"),
    webhookSecret: Redacted.make("whsec_test_osfo"),
  },
  whatsApp: {
    accessToken: Redacted.make("test-only-whatsapp-access-token"),
    appSecret: Redacted.make("test-only-whatsapp-app-secret"),
    botUsername: "osfo_test_whatsapp",
    phoneNumberId: "123456789",
    verifyToken: Redacted.make("test-only-whatsapp-verify-token"),
  },
  twilioVerify: {
    accountSid: Redacted.make(`AC${"1".repeat(32)}`),
    authToken: Redacted.make("test-only-token"),
    serviceSid: `VA${"2".repeat(32)}`,
  },
};

const testBindings: App.Bindings = {
  DB: { connectionString: "postgres://unused.invalid/osfo" },
  OSFO_DIRECTORY: {
    getByName: (identity) => ({
      ensureAgent: (agentId) => Promise.resolve({ className: "OsfoAgent", name: agentId }),
      initializeAgent: () => Promise.resolve({ _tag: "AgentInitialized" }),
      probeAgent: () =>
        Promise.resolve({
          activationId: "test-agent-activation",
          executionUnit: "osfo-agent" as const,
          identity,
          kind: "RuntimeProbe" as const,
          stage: "test" as const,
        }),
    }),
  },
  routeOsfoAgentRequest: () => Promise.resolve(new Response(null, { status: 404 })),
};
