import { describe, expect, it } from "@effect/vitest";
import { allowanceUsage } from "@osfo/db/schema/allowances";
import { inboundWhatsAppEvents } from "@osfo/db/schema/messaging";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";

import * as Db from "../src/db";
import type { RuntimeConfig } from "../src/env";
import * as WhatsApp from "../src/handlers/whatsapp";
import * as Onboarding from "../src/services/onboarding";

describe("WhatsApp webhook admission", () => {
  it.effect("keeps signed provider echoes and group messages outside UserMessage admission", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          let acceptanceCalls = 0;
          let recoveryCalls = 0;
          const app = HttpRouter.toWebHandler(
            WhatsApp.layer({
              config,
              env: {
                OSFO_AGENT: {
                  getByName: () => ({
                    acceptWhatsAppMessage: () => {
                      acceptanceCalls += 1;
                      return Promise.resolve({
                        _tag: "ManagedConversationDenied" as const,
                        reason: "test",
                      });
                    },
                    recoverWhatsAppMessage: () => {
                      recoveryCalls += 1;
                      return Promise.resolve(null);
                    },
                  }),
                },
              },
            }).pipe(
              HttpRouter.provideRequest(
                Layer.merge(
                  Db.layerFromDatabase(fixture.database),
                  Layer.succeed(Onboarding.Service, testOnboarding),
                ),
              ),
            ),
            { disableLogger: true },
          );
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

          const response = yield* Effect.promise(() =>
            app.handler(
              new Request("https://osfo.test/webhooks/whatsapp", {
                body,
                headers: { "X-Hub-Signature-256": signature },
                method: "POST",
              }),
            ),
          );
          const providerEvents = yield* Effect.promise(() =>
            fixture.database.select().from(inboundWhatsAppEvents),
          );
          const usage = yield* Effect.promise(() => fixture.database.select().from(allowanceUsage));
          const responseBody = yield* Effect.promise(() => response.text());

          expect({ body: responseBody, status: response.status }).toEqual({
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
});

const testOnboarding = Onboarding.Service.of({
  complete: () => Effect.die("unexpected onboarding completion"),
  enrollWhatsApp: () => Effect.die("unexpected WhatsApp enrollment"),
  expireInvitations: Effect.die("unexpected invitation expiry"),
  inspectInvitation: () => Effect.die("unexpected invitation inspection"),
  issueWhatsAppInvitation: () => Effect.die("unexpected invitation issue"),
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
  twilioVerify: {
    accountSid: Redacted.make("AC00000000000000000000000000000000"),
    authToken: Redacted.make("test-only-twilio-token"),
    serviceSid: "VA00000000000000000000000000000000",
  },
  whatsApp: { phoneNumber: "14165550100" },
};

const webhook = (messages: ReadonlyArray<object>) => ({
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            contacts: [{ profile: { name: "Ada" }, wa_id: "14165550123" }],
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "14165550100", phone_number_id: "123456789" },
            messages,
          },
        },
      ],
      id: "waba-1",
    },
  ],
  object: "whatsapp_business_account",
});

const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const sign = (body: string, secret: string) =>
  Effect.gen(function* () {
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      ),
    );
    const bytes = yield* Effect.promise(() =>
      crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const hex = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `sha256=${hex}`;
  });
