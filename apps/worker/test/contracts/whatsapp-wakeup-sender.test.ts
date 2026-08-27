import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { loadConfig } from "../../src/config";
import { wakeUpSenderLayer } from "../../src/integrations/whatsapp";
import { WhatsAppWakeUps } from "../../src/services/whatsapp-wakeups";

/* oxlint-disable effecttsgo/global-fetch-in-effect, effecttsgo/strict-effect-provide -- This contract test is the application entry point for the local provider boundary. */

const Ledger = Schema.Array(
  Schema.Struct({ body: Schema.String, method: Schema.String, path: Schema.String }),
);

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
