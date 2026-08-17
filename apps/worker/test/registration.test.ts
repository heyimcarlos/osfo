import { describe, expect, it } from "@effect/vitest";
import { OnboardingResponse, RegistrationResponse } from "@osfo/api";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { registrationInvitations } from "@osfo/db/schema/onboarding";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";

import * as App from "../src/app";
import * as Db from "../src/db";
import type { RuntimeConfig } from "../src/env";
import * as TwilioVerify from "../src/integrations/twilio/verify";

/* oxlint-disable eslint/no-underscore-dangle -- HTTP tests assert typed tagged API results. */
/* oxlint-disable effecttsgo/global-date-in-effect -- This HTTP test needs wall time shared with the request runtime. */

describe("Registration HTTP API", () => {
  it.effect("keeps an invited phone server-side while Better Auth sends and verifies SMS", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const sentNumbers: Array<string> = [];
          const app = makeApp(fixture.database, {
            sendCode: (phoneNumber) => Effect.sync(() => sentNumbers.push(phoneNumber)),
            verifyCode: (_phoneNumber, code) => Effect.succeed(Redacted.value(code) === "123456"),
          });
          const token = "7".repeat(64);
          const digest = yield* sha256(token);
          const createdAt = new Date();
          const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000);
          yield* Effect.promise(() =>
            fixture.database.insert(registrationInvitations).values({
              channelIdentity: "whatsapp:server-side-phone",
              createdAt,
              expiresAt,
              invitationId: "registration-invitation-server-side-phone",
              invitedPhoneNumber: "+14165550183",
              kind: "whatsapp_first",
              locale: "en",
              provider: "whatsapp",
              tokenDigest: digest,
            }),
          );

          const inspected = yield* Effect.promise(() =>
            app.handler(
              new Request(`https://osfo.test/v1/onboarding/invitations/${token}`, {
                headers: { origin: "https://osfo.test" },
              }),
            ),
          );
          const inspectedBody = yield* Effect.promise(() => inspected.json());
          const sent = yield* sendJson(app.handler, "POST", "/auth/onboarding/send-otp", {
            token,
          });
          const verified = yield* sendJson(app.handler, "POST", "/auth/onboarding/verify", {
            code: "123456",
            token,
          });

          expect(inspectedBody).toEqual({
            locale: "en",
            maskedPhoneNumber: "••••••••0183",
            state: "live",
          });
          expect(sent.status).toBe(200);
          expect(sentNumbers).toEqual(["+14165550183"]);
          expect(verified.status).toBe(200);
          expect(verified.headers.get("set-cookie")).toContain("better-auth.session_token");

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("requires Phone Verification and completes resumable web onboarding", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeApp(fixture.database, acceptingTwilio);
          const cookie = yield* authenticatePhone(app.handler, "+14165550180");
          yield* Effect.promise(() =>
            fixture.database.update(users).set({ phoneNumberVerified: false }).execute(),
          );
          const payload = {
            existingProfileChoice: null,
            bindingConsent: "web-enrollment",
            helpAreas: ["research"],
            invitationToken: null,
            locale: "en",
            preferredName: "River",
            webEnrollmentToken: "e".repeat(64),
          };

          const unverified = yield* sendJson(app.handler, "PUT", "/v1/onboarding", payload, cookie);
          yield* Effect.promise(() =>
            fixture.database
              .update(users)
              .set({ phoneNumber: "+14165550180", phoneNumberVerified: true })
              .execute(),
          );
          const first = yield* sendJson(app.handler, "PUT", "/v1/onboarding", payload, cookie);
          const retried = yield* sendJson(app.handler, "PUT", "/v1/onboarding", payload, cookie);
          const firstBody = yield* onboardingResponseJson(first);
          const retriedBody = yield* onboardingResponseJson(retried);

          expect(unverified.status).toBe(403);
          expect(first.status).toBe(200);
          expect(firstBody.channel._tag).toBe("EnrollmentPending");
          expect(retriedBody).toEqual(firstBody);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("completes registration for the authenticated Better Auth User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeApp(fixture.database, acceptingTwilio);
          const cookie = yield* authenticatePhone(app.handler, "+14165550181");
          expect(cookie).toContain("better-auth.session_token");

          const first = yield* sendJson(app.handler, "PUT", "/v1/registration", {}, cookie);
          const repeated = yield* sendJson(app.handler, "PUT", "/v1/registration", {}, cookie);
          const firstBody = yield* responseJson(first);
          const repeatedBody = yield* responseJson(repeated);
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));
          const storedAgents = yield* Effect.promise(() => fixture.database.select().from(agents));
          const storedSubscriptions = yield* Effect.promise(() =>
            fixture.database.select().from(billingSubscriptions),
          );
          const storedPeriods = yield* Effect.promise(() =>
            fixture.database.select().from(allowancePeriods),
          );

          expect(first.status).toBe(200);
          expect(repeated.status).toBe(200);
          expect(firstBody.agentId).toMatch(
            /^agent-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(firstBody.completedAt).toBeInstanceOf(Date);
          expect(repeatedBody).toEqual(firstBody);
          expect(storedUsers[0]?.registrationCompletedAt).toBeInstanceOf(Date);
          expect(storedAgents).toHaveLength(1);
          expect(storedSubscriptions).toHaveLength(1);
          expect(storedPeriods).toHaveLength(1);
          expect(storedSubscriptions[0]).toMatchObject({
            billingSubscriptionId: storedPeriods[0]?.billingSubscriptionId,
            plan: "free",
            planPolicyVersion: "launch-v1",
          });
          expect(storedPeriods[0]).toMatchObject({
            plan: "free",
            planPolicyVersion: "launch-v1",
          });
          expect(storedPeriods[0]?.startsAt).toEqual(storedUsers[0]?.registrationCompletedAt);

          const firstPeriod = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              billingSubscriptionId: Schema.String,
              endsAt: Schema.Date,
              userId: Schema.String,
            }),
          )(storedPeriods[0]);
          yield* Effect.promise(() =>
            fixture.database.insert(allowancePeriods).values({
              allowancePeriodId: "allowance-period-later-registration-recovery",
              billingSubscriptionId: firstPeriod.billingSubscriptionId,
              createdAt: firstPeriod.endsAt,
              endsAt: DateTime.toDateUtc(
                DateTime.add(DateTime.fromDateUnsafe(firstPeriod.endsAt), { days: 30 }),
              ),
              plan: "free",
              planPolicyVersion: "launch-v1",
              startsAt: firstPeriod.endsAt,
              userId: firstPeriod.userId,
            }),
          );
          const recovered = yield* sendJson(app.handler, "PUT", "/v1/registration", {}, cookie);
          const recoveredBody = yield* responseJson(recovered);

          expect(recovered.status).toBe(200);
          expect(recoveredBody).toEqual(firstBody);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rejects provisioning without a Better Auth session", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeApp(fixture.database);

          const response = yield* sendJson(app.handler, "PUT", "/v1/registration", {});
          const storedAgents = yield* Effect.promise(() => fixture.database.select().from(agents));

          expect(response.status).toBe(401);
          expect(storedAgents).toEqual([]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("rejects completion when stored registration facts conflict", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeApp(fixture.database, acceptingTwilio);
          const cookie = yield* authenticatePhone(app.handler, "+14165550182");
          const first = yield* sendJson(app.handler, "PUT", "/v1/registration", {}, cookie);
          const [storedUser] = yield* Effect.promise(() =>
            fixture.database.select({ id: users.id }).from(users),
          );
          const storedUserId = yield* Schema.decodeUnknownEffect(Schema.String)(storedUser?.id);
          yield* Effect.promise(() =>
            fixture.database
              .update(users)
              .set({
                registrationCompletedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2026-08-12T15:01:16.000Z"),
                ),
              })
              .where(eq(users.id, storedUserId))
              .execute(),
          );

          const recovery = yield* sendJson(app.handler, "PUT", "/v1/registration", {}, cookie);

          expect(first.status).toBe(200);
          expect(recovery.status).toBe(503);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("allows trusted web origins on the Registration API", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeApp(fixture.database);

          const response = yield* Effect.promise(() =>
            app.handler(
              new Request("https://osfo.test/v1/registration", {
                headers: {
                  "access-control-request-headers": "content-type",
                  "access-control-request-method": "PUT",
                  origin: "https://osfo.test",
                },
                method: "OPTIONS",
              }),
            ),
          );

          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("https://osfo.test");
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

const makeApp = (
  database: Parameters<typeof Db.layerFromDatabase>[0],
  twilio: TwilioVerify.TwilioVerify["Service"] = {
    sendCode: () => Effect.void,
    verifyCode: () => Effect.succeed(false),
  },
) =>
  App.make(testBindings, runtimeConfig, {
    authDependencies: Layer.merge(
      Db.layerFromDatabase(database),
      Layer.succeed(TwilioVerify.TwilioVerify, TwilioVerify.TwilioVerify.of(twilio)),
    ),
  });

const sendJson = (
  handler: (request: Request) => Promise<Response>,
  method: "POST" | "PUT",
  path: string,
  body: JsonValue,
  cookie?: string,
) => {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "https://osfo.test",
  });
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }

  return Effect.promise(() =>
    handler(
      new Request(`https://osfo.test${path}`, {
        body: encodeJsonText(body),
        headers,
        method,
      }),
    ),
  );
};

const acceptingTwilio: TwilioVerify.TwilioVerify["Service"] = {
  sendCode: () => Effect.void,
  verifyCode: (_phoneNumber, code) => Effect.succeed(Redacted.value(code) === "123456"),
};

const authenticatePhone = (handler: (request: Request) => Promise<Response>, phoneNumber: string) =>
  Effect.gen(function* () {
    const sent = yield* sendJson(handler, "POST", "/auth/phone-number/send-otp", { phoneNumber });
    const verified = yield* sendJson(handler, "POST", "/auth/phone-number/verify", {
      code: "123456",
      phoneNumber,
    });
    expect(sent.status).toBe(200);
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toContain("better-auth.session_token");
    return yield* Schema.decodeUnknownEffect(Schema.String)(cookie);
  });

type JsonValue =
  | boolean
  | null
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const sha256 = (value: string) =>
  Effect.promise(() =>
    globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const responseJson = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(RegistrationResponse)(body)),
  );

const onboardingResponseJson = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(OnboardingResponse)(body)),
  );

const runtimeConfig: RuntimeConfig = {
  auth: {
    baseURL: "https://osfo.test/",
    dashboard: { kind: "disabled" },
    secret: Redacted.make("test-only-better-auth-secret-32-characters"),
    trustedOrigins: ["https://osfo.test"],
  },
  meta: {
    appSecret: Redacted.make("test-only-meta-app-secret"),
    webhookVerifyToken: Redacted.make("test-only-meta-webhook-token"),
  },
  stage: "test",
  whatsApp: { phoneNumber: "14165550100" },
  twilioVerify: {
    accountSid: Redacted.make(`AC${"1".repeat(32)}`),
    authToken: Redacted.make("test-only-token"),
    serviceSid: `VA${"2".repeat(32)}`,
  },
};

const testBindings: App.Bindings = {
  DB: { connectionString: "postgres://unused.invalid/osfo" },
  OSFO_AGENT: {
    getByName: (identity) => ({
      acceptWhatsAppMessage: () =>
        Promise.resolve({ _tag: "ManagedConversationDenied", reason: "test" }),
      commitWelcome: () =>
        Promise.resolve({ _tag: "PersonalWelcomeCommitted", messageId: "welcome-test" }),
      initialize: () => Promise.resolve({ _tag: "AgentInitialized" }),
      probeRuntime: () =>
        Promise.resolve({
          activationId: "test-agent-activation",
          executionUnit: "osfo-agent" as const,
          identity,
          kind: "RuntimeProbe" as const,
          stage: "test" as const,
        }),
      recoverWhatsAppMessage: () => Promise.resolve(null),
    }),
  },
  REGISTRATION_DIALOGUE: {
    getByName: (identity) => ({
      begin: () => Promise.resolve({ _tag: "RegistrationTurnCompleted", response: "Register" }),
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
