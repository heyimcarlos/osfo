import { describe, expect, it } from "@effect/vitest";
import type { Database } from "@osfo/db";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { inboundWhatsAppEvents } from "@osfo/db/schema/messaging";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";

import * as Db from "../src/db";
import type { RuntimeConfig } from "../src/env";
import * as WhatsApp from "../src/handlers/whatsapp";
import * as Onboarding from "../src/services/onboarding";
import type { AgentAcceptanceInput, AgentRecoveryInput } from "../src/services/whatsapp-admission";
import { encodeJsonText, sign, statusWebhook, webhook } from "./whatsapp-webhook-fixture";

describe("WhatsApp webhook admission", () => {
  it.effect("keeps signed statuses, provider echoes, and group messages outside admission", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          let acceptanceCalls = 0;
          let recoveryCalls = 0;
          const app = makeHandler(fixture.database, {
            OSFO_AGENT: {
              getByName: () => ({
                acceptWhatsAppMessage: () => {
                  acceptanceCalls += 1;
                  return Promise.resolve({
                    _tag: "ManagedConversationDenied" as const,
                    reason: "userSuspended",
                    resetAt: null,
                  });
                },
                recoverWhatsAppMessage: () => {
                  recoveryCalls += 1;
                  return Promise.resolve(null);
                },
              }),
            },
          });
          const body = encodeJsonText(
            webhook([
              {
                from: "14165550100",
                id: "wamid.provider-echo",
                text: { body: "A business reply" },
                timestamp: "1786924800",
                to: "14165550123",
                type: "text",
              },
              {
                context: {
                  from: "14165550100",
                  group_id: "group-1",
                  id: "wamid.group-prompt",
                },
                from: "14165550123",
                id: "wamid.group",
                text: { body: "A group reply" },
                timestamp: "1786924800",
                type: "text",
              },
            ]),
          );
          const signature = yield* sign(body, "meta-app-secret");
          const statusBody = encodeJsonText(statusWebhook("failed"));
          const statusSignature = yield* sign(statusBody, "meta-app-secret");

          const response = yield* Effect.promise(() =>
            app.handler(
              new Request("https://osfo.test/webhooks/whatsapp", {
                body,
                headers: { "X-Hub-Signature-256": signature },
                method: "POST",
              }),
            ),
          );
          const statusResponse = yield* Effect.promise(() =>
            app.handler(
              new Request("https://osfo.test/webhooks/whatsapp", {
                body: statusBody,
                headers: { "X-Hub-Signature-256": statusSignature },
                method: "POST",
              }),
            ),
          );
          const providerEvents = yield* Effect.promise(() =>
            fixture.database.select().from(inboundWhatsAppEvents),
          );
          const usage = yield* Effect.promise(() => fixture.database.select().from(allowanceUsage));
          const responseBody = yield* Effect.promise(() => response.text());
          const statusResponseBody = yield* Effect.promise(() => statusResponse.text());

          expect({ body: responseBody, status: response.status }).toEqual({
            body: "EVENT_RECEIVED",
            status: 200,
          });
          expect({ body: statusResponseBody, status: statusResponse.status }).toEqual({
            body: "EVENT_RECEIVED",
            status: 200,
          });
          expect(providerEvents).toEqual([]);
          expect(usage).toEqual([]);
          expect(recoveryCalls).toBe(0);
          expect(acceptanceCalls).toBe(0);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );

  it.effect("does not acknowledge a bound UserMessage denied inside the Agent", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          yield* Effect.promise(() => seedBoundUser(fixture.database));
          const acceptanceInputs: Array<AgentAcceptanceInput> = [];
          const recoveryInputs: Array<AgentRecoveryInput> = [];
          const app = makeHandler(fixture.database, {
            OSFO_AGENT: {
              getByName: () => ({
                acceptWhatsAppMessage: (input) => {
                  acceptanceInputs.push(input);
                  return Promise.resolve({
                    _tag: "ManagedConversationDenied" as const,
                    reason: "userSuspended",
                    resetAt: null,
                  });
                },
                recoverWhatsAppMessage: (input) => {
                  recoveryInputs.push(input);
                  return Promise.resolve(null);
                },
              }),
            },
          });
          const body = encodeJsonText(
            webhook([
              {
                from: "14165550123",
                id: "wamid.agent-denied",
                text: { body: "Please help" },
                timestamp: "1786924800",
                type: "text",
              },
            ]),
          );
          const signature = yield* sign(body, "meta-app-secret");
          const send = () =>
            Effect.promise(() =>
              app.handler(
                new Request("https://osfo.test/webhooks/whatsapp", {
                  body,
                  headers: { "X-Hub-Signature-256": signature },
                  method: "POST",
                }),
              ),
            );

          const first = yield* send();
          const replay = yield* send();
          const usage = yield* Effect.promise(() => fixture.database.select().from(allowanceUsage));
          const providerEvents = yield* Effect.promise(() =>
            fixture.database.select().from(inboundWhatsAppEvents),
          );
          const firstBody = yield* Effect.promise(() => first.text());
          const replayBody = yield* Effect.promise(() => replay.text());

          expect([
            { body: firstBody, status: first.status },
            { body: replayBody, status: replay.status },
          ]).toEqual([
            { body: "Temporarily unavailable", status: 503 },
            { body: "Temporarily unavailable", status: 503 },
          ]);
          expect(usage).toEqual([]);
          expect(providerEvents).toHaveLength(1);
          expect(recoveryInputs).toHaveLength(2);
          expect(recoveryInputs[1]).toEqual(recoveryInputs[0]);
          expect(acceptanceInputs).toHaveLength(2);
          expect(acceptanceInputs[1]).toEqual(acceptanceInputs[0]);

          yield* Effect.promise(app.dispose);
        }),
      closeTestDatabase,
    ),
  );
});

const makeHandler = (database: Database, env: WhatsApp.Bindings) =>
  HttpRouter.toWebHandler(
    WhatsApp.layer({ config, env }).pipe(
      HttpRouter.provideRequest(
        Layer.merge(
          Db.layerFromDatabase(database),
          Layer.succeed(Onboarding.Service, testOnboarding),
        ),
      ),
    ),
    { disableLogger: true },
  );

// oxlint-disable-next-line effecttsgo/async-function -- Drizzle test setup is a contained Promise boundary.
const seedBoundUser = async (database: Database) => {
  const userId = "user-handler-denied";
  await database.insert(users).values({
    email: "handler-denied@invalid.example",
    id: userId,
    name: "Handler Denied",
  });
  await database.insert(agents).values({
    agentId: "agent-handler-denied",
    createdAt: "2026-08-16T12:00:00.000Z",
    userId,
  });
  await database.insert(billingSubscriptions).values({
    billingSubscriptionId: "subscription-handler-denied",
    plan: "free",
    planPolicyVersion: "launch-v1",
    userId,
  });
  await database.insert(allowancePeriods).values({
    allowancePeriodId: "period-handler-denied",
    billingSubscriptionId: "subscription-handler-denied",
    endsAt: date("2026-09-01T00:00:00.000Z"),
    plan: "free",
    planPolicyVersion: "launch-v1",
    startsAt: date("2026-08-01T00:00:00.000Z"),
    userId,
  });
  await database.insert(channelBindings).values({
    channelBindingId: "binding-handler-denied",
    channelIdentity: "14165550123",
    provider: "whatsapp",
    userId,
  });
};

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

const testOnboarding = Onboarding.Service.of({
  beginTelegramEvent: () => Effect.die("unexpected Telegram event"),
  complete: () => Effect.die("unexpected onboarding completion"),
  completeTelegramEvent: () => Effect.die("unexpected Telegram completion"),
  enrollTelegram: () => Effect.die("unexpected Telegram enrollment"),
  enrollWhatsApp: () => Effect.die("unexpected WhatsApp enrollment"),
  expireInvitations: Effect.die("unexpected invitation expiry"),
  inspectInvitation: () => Effect.die("unexpected invitation inspection"),
  issueWhatsAppInvitation: () => Effect.die("unexpected invitation issue"),
  issueTelegramInvitation: () => Effect.die("unexpected Telegram invitation"),
  markTelegramEventAmbiguous: () => Effect.die("unexpected Telegram delivery"),
  phoneVerificationTarget: () => Effect.die("unexpected verification target"),
});

const config: RuntimeConfig = {
  auth: {
    baseURL: "https://osfo.test/",
    dashboard: { kind: "disabled" },
    secret: Redacted.make("test-only-better-auth-secret-32-characters"),
    trustedOrigins: ["https://osfo.test"],
  },
  meta: {
    appSecret: Redacted.make("meta-app-secret"),
    webhookVerifyToken: Redacted.make("verify-me"),
  },
  stage: "test",
  telegram: { kind: "disabled" },
  twilioVerify: {
    accountSid: Redacted.make("AC00000000000000000000000000000000"),
    authToken: Redacted.make("test-only-twilio-token"),
    serviceSid: "VA00000000000000000000000000000000",
  },
  whatsApp: { phoneNumber: "14165550100" },
};
