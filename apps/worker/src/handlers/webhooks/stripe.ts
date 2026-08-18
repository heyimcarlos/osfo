import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Crypto, DateTime, Effect, Schema } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { makeBillingServices } from "../../billing-composition";
import type { CloudflareConfig } from "../../config";
import * as Db from "../../db";
import * as StripeWebhooks from "../../services/stripe-webhooks";
import * as WebhookIngestion from "../../services/webhook-ingestion";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Effect exits and the WebHandler Promise boundary require these forms. */

const encodePayload = Schema.encodeSync(Schema.fromJsonString(StripeWebhooks.VerifiedStripeEvent));
const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StripeWebhooks.VerifiedStripeEvent),
);

/** Install the canonical Stripe webhook route. */
export const layer = (config: CloudflareConfig) => {
  const handler = Effect.gen(function* () {
    const database = yield* Db.database;
    const crypto = yield* Crypto.Crypto;
    const services = makeBillingServices(database, config);
    const ingestion = WebhookIngestion.make({
      database,
      process: (event) =>
        decodePayload(event.payloadJson).pipe(
          Effect.mapError(
            (cause) =>
              new StripeWebhooks.WebhookPersistenceUnavailable({
                cause,
                message: "The stored Stripe webhook payload is invalid",
                operation: "decodePayload",
              }),
          ),
          Effect.flatMap((stripeEvent) =>
            services.webhooks.processVerified(stripeEvent, event.webhookEventId),
          ),
          Effect.asVoid,
        ),
    });
    const [webhookEventId, receivedAt] = yield* Effect.all([crypto.randomUUIDv7, DateTime.now]);
    return yield* HttpEffect.fromWebHandler(async (request) => {
      const signature = request.headers.get("stripe-signature");
      if (signature === null) return jsonResponse("Invalid Stripe signature", 400);
      const rawBody = await request.text();
      const verified = await Effect.runPromiseExit(
        services.stripe.verifyWebhook(rawBody, signature),
      );
      if (verified._tag === "Failure") {
        return jsonResponse("Invalid Stripe signature", 400);
      }
      const event: WebhookIngestion.VerifiedWebhookEvent = {
        eventType: verified.value.type,
        externalEventId: verified.value.externalEventId,
        payloadJson: encodePayload(verified.value),
        provider: "stripe",
        receivedAt: DateTime.toDateUtc(receivedAt),
        webhookEventId,
      };
      const result = await Effect.runPromiseExit(ingestion.ingest(event));
      return result._tag === "Success"
        ? jsonResponse("Webhook received", 200)
        : jsonResponse("Webhook processing is temporarily unavailable", 503);
    });
  });
  return HttpRouter.add("POST", "/webhooks/stripe", handler).pipe(
    HttpRouter.provideRequest(BrowserCrypto.layer),
  );
};

const jsonResponse = (message: string, status: number) =>
  new Response(JSON.stringify({ message }), {
    headers: { "content-type": "application/json" },
    status,
  });
