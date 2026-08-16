import { describe, expect, it } from "@effect/vitest";
import { RegistrationResponse } from "@osfo/api";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { agents } from "@osfo/db/schema/agents";
import { users } from "@osfo/db/schema/auth";
import { allowancePeriods, subscriptions } from "@osfo/db/schema/billing";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";

import * as App from "../src/app";
import * as Db from "../src/db";
import type { RuntimeConfig } from "../src/env";
import * as TwilioVerify from "../src/integrations/twilio/verify";

describe("Registration HTTP API", () => {
  it.effect("completes registration for the authenticated Better Auth User", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const app = makeApp(fixture.database);
          const signUp = yield* sendJson(app.handler, "POST", "/auth/sign-up/email", {
            email: "registered@osfo.test",
            name: "Registered User",
            password: "test-password",
          });
          const cookie = signUp.headers.get("set-cookie")?.split(";", 1)[0];
          expect(cookie).toContain("better-auth.session_token");

          const first = yield* sendJson(app.handler, "PUT", "/v1/me/registration", {}, cookie);
          const repeated = yield* sendJson(app.handler, "PUT", "/v1/me/registration", {}, cookie);
          const firstBody = yield* responseJson(first);
          const repeatedBody = yield* responseJson(repeated);
          const storedUsers = yield* Effect.promise(() => fixture.database.select().from(users));
          const storedAgents = yield* Effect.promise(() => fixture.database.select().from(agents));
          const storedSubscriptions = yield* Effect.promise(() =>
            fixture.database.select().from(subscriptions),
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

          const response = yield* sendJson(app.handler, "PUT", "/v1/me/registration", {});
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
          const app = makeApp(fixture.database);
          const signUp = yield* sendJson(app.handler, "POST", "/auth/sign-up/email", {
            email: "conflicting-registration@osfo.test",
            name: "Conflicting Registration",
            password: "test-password",
          });
          const cookie = signUp.headers.get("set-cookie")?.split(";", 1)[0];
          const first = yield* sendJson(app.handler, "PUT", "/v1/me/registration", {}, cookie);
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

          const recovery = yield* sendJson(app.handler, "PUT", "/v1/me/registration", {}, cookie);

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
              new Request("https://osfo.test/v1/me/registration", {
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

const makeApp = (database: Parameters<typeof Db.layerFromDatabase>[0]) =>
  App.make(testBindings, runtimeConfig, {
    authDependencies: Layer.merge(
      Db.layerFromDatabase(database),
      Layer.succeed(
        TwilioVerify.TwilioVerify,
        TwilioVerify.TwilioVerify.of({
          sendCode: () => Effect.void,
          verifyCode: () => Effect.succeed(false),
        }),
      ),
    ),
  });

const sendJson = (
  handler: (request: Request) => Promise<Response>,
  method: "POST" | "PUT",
  path: string,
  body: Readonly<Record<string, string>>,
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

const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const responseJson = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(RegistrationResponse)(body)),
  );

const runtimeConfig: RuntimeConfig = {
  auth: {
    baseURL: "https://osfo.test/",
    dashboard: { kind: "disabled" },
    secret: Redacted.make("test-only-better-auth-secret-32-characters"),
    trustedOrigins: ["https://osfo.test"],
  },
  stage: "test",
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
      probeRuntime: () =>
        Promise.resolve({
          activationId: "test-agent-activation",
          executionUnit: "osfo-agent" as const,
          identity,
          kind: "RuntimeProbe" as const,
          stage: "test" as const,
        }),
    }),
  },
  REGISTRATION_DIALOGUE: {
    getByName: (identity) => ({
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
