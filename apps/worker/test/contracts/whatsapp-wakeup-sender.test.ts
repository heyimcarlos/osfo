import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { loadConfig } from "../../src/config";
import { wakeUpSenderLayer } from "../../src/integrations/whatsapp";
import { WhatsAppWakeUps } from "../../src/services/whatsapp-wakeups";

/* oxlint-disable effecttsgo/global-fetch-in-effect, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- This contract test is the application entry point for the local provider boundary and asserts Effect failure tags. */

const Ledger = Schema.Array(
  Schema.Struct({ body: Schema.String, method: Schema.String, path: Schema.String }),
);
const TimestampedLedger = Schema.Array(
  Schema.Struct({
    body: Schema.String,
    method: Schema.String,
    path: Schema.String,
    recordedAt: Schema.DateFromString,
  }),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("uses only the fixed variable-free Meta template shape for en and es", () =>
  Effect.gen(function* () {
    const config = loadConfig(env);
    yield* Effect.promise(() =>
      fetch(`${config.whatsApp.apiBaseURL ?? ""}/_test/whatsapp/template-only`, {
        method: "POST",
      }),
    );
    const sender = yield* WhatsAppWakeUps.Sender;
    yield* sender.sendTemplate({
      endpoint: WhatsAppWakeUps.EndpointIdentity.make("15551234567"),
      locale: "en",
    });
    yield* sender.sendTemplate({
      endpoint: WhatsAppWakeUps.EndpointIdentity.make("15551234567"),
      locale: "es",
    });
    const response = yield* Effect.promise(() =>
      fetch(`${config.whatsApp.apiBaseURL ?? ""}/_test/whatsapp/ledger`),
    );
    const ledger = yield* Effect.promise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
    );
    expect(
      ledger.map(({ body, method, path }) => ({
        body: Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(body),
        method,
        path,
      })),
    ).toEqual([
      {
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          template: { language: { code: "en" }, name: "osfo_update" },
          to: "15551234567",
          type: "template",
        },
        method: "POST",
        path: "/v25.0/123456789/messages",
      },
      {
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          template: { language: { code: "es" }, name: "osfo_update" },
          to: "15551234567",
          type: "template",
        },
        method: "POST",
        path: "/v25.0/123456789/messages",
      },
    ]);
  }).pipe(Effect.provide(wakeUpSenderLayer(loadConfig(env).whatsApp))),
);

it.effect("rejects every excess field at the local Meta boundary", () =>
  Effect.gen(function* () {
    const providerOrigin = loadConfig(env).whatsApp.apiBaseURL ?? "";
    yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/template-only`, { method: "POST" }),
    );
    const valid = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      template: { language: { code: "en" }, name: "osfo_update" },
      to: "15551234567",
      type: "template",
    };
    const statuses = yield* Effect.forEach(
      [
        { ...valid, private_data: "must-not-pass" },
        { ...valid, template: { ...valid.template, result_summary: "must-not-pass" } },
        {
          ...valid,
          template: {
            ...valid.template,
            language: { ...valid.template.language, fallback: "must-not-pass" },
          },
        },
      ],
      (body) =>
        Effect.promise(() =>
          fetch(`${providerOrigin}/v25.0/123456789/messages`, {
            body: encodeUnknownJson(body),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        ).pipe(Effect.map((response) => response.status)),
    );
    expect(statuses).toEqual([422, 422, 422]);
  }),
);

it.effect("scopes verifier resets and allows normal replies after timestamped template proof", () =>
  Effect.gen(function* () {
    const providerOrigin = loadConfig(env).whatsApp.apiBaseURL ?? "";
    const ordinaryMessage = encodeUnknownJson({
      messaging_product: "whatsapp",
      text: { body: "Normal reply" },
      to: "15551234567",
      type: "text",
    });
    yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/reset`, { method: "POST" }),
    );
    yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/template-only`, { method: "POST" }),
    );
    expect(
      (yield* Effect.promise(() =>
        fetch(`${providerOrigin}/v25.0/123456789/messages`, {
          body: ordinaryMessage,
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      )).status,
    ).toBe(422);
    yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/allow-messages`, { method: "POST" }),
    );
    expect(
      (yield* Effect.promise(() =>
        fetch(`${providerOrigin}/v25.0/123456789/messages`, {
          body: ordinaryMessage,
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      )).status,
    ).toBe(200);
    const ledgerResponse = yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/ledger`),
    );
    const ledger = yield* Effect.promise(() => ledgerResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TimestampedLedger)),
    );
    expect(ledger).toHaveLength(2);
    expect(ledger.every(({ recordedAt }) => recordedAt.getTime() > 0)).toBe(true);
    yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/reset`, { method: "POST" }),
    );
    const resetResponse = yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/ledger`),
    );
    expect(yield* Effect.promise(() => resetResponse.json())).toEqual([]);
  }),
);

it.effect("treats server and rate-limit responses as ambiguous, not proven rejection", () =>
  Effect.gen(function* () {
    const config = loadConfig(env);
    const providerOrigin = config.whatsApp.apiBaseURL ?? "";
    const sender = yield* WhatsAppWakeUps.Sender;
    for (const status of [503, 429]) {
      yield* Effect.promise(() =>
        fetch(`${providerOrigin}/_test/whatsapp/next-response?status=${status}`, {
          method: "POST",
        }),
      );
      expect(
        yield* sender
          .sendTemplate({
            endpoint: WhatsAppWakeUps.EndpointIdentity.make("15551234567"),
            locale: "en",
          })
          .pipe(
            Effect.flip,
            Effect.map((failure) => failure._tag),
          ),
      ).toBe("ProviderAmbiguous");
    }
    yield* Effect.promise(() =>
      fetch(`${providerOrigin}/_test/whatsapp/next-response?status=400`, { method: "POST" }),
    );
    expect(
      yield* sender
        .sendTemplate({
          endpoint: WhatsAppWakeUps.EndpointIdentity.make("15551234567"),
          locale: "es",
        })
        .pipe(
          Effect.flip,
          Effect.map((failure) => failure._tag),
        ),
    ).toBe("ProviderRejected");
  }).pipe(Effect.provide(wakeUpSenderLayer(loadConfig(env).whatsApp))),
);
