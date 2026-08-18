import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { sessions, users, verifications } from "@osfo/db/schema/auth";
import { userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { count, eq } from "drizzle-orm";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";

import * as App from "../src/app";
import * as AuthRoutes from "../src/auth";
import * as Db from "../src/db";
import type { CloudflareConfig } from "../src/config";
import * as TwilioVerify from "../src/integrations/twilio/verify";

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
            Layer.succeed(TwilioVerify.TwilioVerify, makeTestTwilio().service),
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

  it.effect("exposes email-and-password authentication in development", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.TwilioVerify, makeTestTwilio().service),
            { ...authConfig, credentialAuthentication: "enabled" },
          );

          const response = yield* request(app.handler, "/auth/sign-up/email", {
            email: "tester@osfo.test",
            name: "Osfo Tester",
            password: "test-password",
          });
          const signIn = yield* request(app.handler, "/auth/sign-in/email", {
            email: "tester@osfo.test",
            password: "test-password",
          });
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));

          expect(response.status).toBe(200);
          expect(signIn.status).toBe(200);
          expect(signIn.headers.get("set-cookie")).toContain("better-auth.session_token");
          expect(storedUsers).toHaveLength(1);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

describe("authentication CORS", () => {
  it.effect("allows the Better Auth dashboard origin", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.TwilioVerify, makeTestTwilio().service),
          );

          const response = yield* Effect.promise(() =>
            app.handler(
              new Request("https://osfo.test/auth/dash/config", {
                headers: {
                  "access-control-request-method": "GET",
                  origin: "https://dash.better-auth.com",
                },
                method: "OPTIONS",
              }),
            ),
          );

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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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

  it.effect("signs an existing phone User in without creating another User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const twilio = makeTestTwilio();
          const app = makeAuthApp(
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
              adminActorId: "admin-test",
              eventId: "suspension-test",
              reason: "Test suspension",
              userId: firstBody.user.id,
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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
            Layer.succeed(TwilioVerify.TwilioVerify, twilio.service),
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
  twilioLayer: Layer.Layer<TwilioVerify.TwilioVerify>,
  config: AuthRoutes.AuthRouteConfig = authConfig,
) =>
  HttpRouter.toWebHandler(
    AuthRoutes.layer({
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
  const service = TwilioVerify.TwilioVerify.of({
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
    };
const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const responseJson = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(AuthResponse)(body)),
  );

const runtimeConfig: CloudflareConfig = {
  auth: authConfig,
  meta: {
    appSecret: Redacted.make("test-only-meta-app-secret"),
    webhookVerifyToken: Redacted.make("test-only-meta-webhook-token"),
  },
  stage: "test",
  telegram: {
    allowedUserIds: ["12345"],
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
  whatsApp: { phoneNumber: "14165550100" },
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
      commitAgentWelcome: () =>
        Promise.resolve({
          _tag: "PersonalWelcomeCommitted",
          messageId: "welcome-test",
        }),
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
  resolveOsfoAgent: () =>
    Promise.resolve({
      acceptWhatsAppMessage: () =>
        Promise.resolve({
          _tag: "ManagedConversationDenied",
          reason: "userSuspended",
        }),
      recoverWhatsAppMessage: () => Promise.resolve(null),
    }),
  routeOsfoAgentRequest: () => Promise.resolve(new Response(null, { status: 404 })),
  REGISTRATION_DIALOGUE: {
    getByName: (identity) => ({
      begin: () =>
        Promise.resolve({
          _tag: "RegistrationTurnCompleted",
          response: "Register",
          verifyUrl: "https://osfo.ai/verify/test",
        }),
      deleteDialogue: () => Promise.resolve(),
      probeRuntime: () =>
        Promise.resolve({
          activationId: "test-registration-activation",
          executionUnit: "registration-dialogue" as const,
          identity,
          kind: "RuntimeProbe" as const,
          stage: "test" as const,
        }),
    }),
  },
};
