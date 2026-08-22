import { DateTime, Effect, Redacted } from "effect";
import Stripe from "stripe";

import { BillingDb } from "./db/billing";
import { inspectStripeBilling } from "./db/billing/stripe-inspect";
import { makeStripePersistence } from "./db/billing/stripe-persistence";
import { WebhooksDb } from "./db/webhooks";
import type { Database } from "./db";
import {
  BillingCheckoutSessionId,
  BillingCustomerId,
  AllowancePeriodId,
  StripePriceId,
  StripePortalConfigurationId,
  StripeProductId,
} from "./domain";
import type { CloudflareConfig } from "./config";
import { StripeAdapter } from "./integrations/stripe/billing";
import { BillingPresentation } from "./services/billing-presentation";
import { BillingSubscriptions } from "./services/billing-subscriptions";
import { StripeBilling } from "./services/stripe-billing";
import { StripeWebhooks } from "./services/stripe-webhooks";

/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- The composition root supplies secure identity effects to application services. */

/** Construct request-scoped Stripe billing services from concrete runtime dependencies. */
export const makeBillingServices = (database: Database, config: CloudflareConfig) => {
  const webBaseUrl = new URL(config.auth.trustedOrigins[0] ?? config.auth.baseURL);
  const offer = {
    priceId: StripePriceId.make(config.stripe.adventurerPriceId),
    productId: StripeProductId.make(config.stripe.adventurerProductId),
  };
  const client = new Stripe(
    Redacted.value(config.stripe.secretKey),
    stripeClientOptions(config.stripe.apiBaseURL),
  );
  const stripe = StripeAdapter.make({
    client,
    offer,
    webhookSecret: config.stripe.webhookSecret,
  });
  const secureId = Effect.sync(() => crypto.randomUUID());
  const subscriptions = BillingSubscriptions.make(BillingDb.make(database), {
    allowancePeriodId: secureId.pipe(Effect.map((id) => AllowancePeriodId.make(id))),
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  });
  const stripeBilling = StripeBilling.make({
    ids: {
      checkout: secureId.pipe(Effect.map((id) => BillingCheckoutSessionId.make(id))),
      customer: secureId.pipe(Effect.map((id) => BillingCustomerId.make(id))),
    },
    offers: { adventurer: offer },
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    persistence: makeStripePersistence(database),
    portal: {
      configurationId: StripePortalConfigurationId.make(config.stripe.portalConfigurationId),
      returnUrl: new URL("/billing/return?source=portal", webBaseUrl),
    },
    stripe,
    urls: {
      cancel: new URL("/billing", webBaseUrl),
      success: new URL(
        "/billing/return?source=checkout&session_id={CHECKOUT_SESSION_ID}",
        webBaseUrl,
      ),
    },
    waitForCheckoutClaim: Effect.sleep("25 millis"),
  });
  const webhookPersistence = WebhooksDb.make({
    database,
    webhookEventId: Effect.sync(() => crypto.randomUUID()),
  });
  return {
    presentation: BillingPresentation.make(
      {
        inspect: (userId, now) => inspectStripeBilling(database, userId, now),
      },
      { now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)) },
    ),
    stripe,
    stripeBilling,
    subscriptions,
    webhooks: StripeWebhooks.make({
      billing: subscriptions,
      persistence: webhookPersistence,
      stripe,
    }),
  };
};

const stripeClientOptions = (apiBaseURL: string | undefined): Stripe.StripeConfig => {
  const options: Stripe.StripeConfig = {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  };
  if (apiBaseURL === undefined) return options;
  const url = new URL(apiBaseURL);
  options.host = url.hostname;
  options.protocol = url.protocol === "https:" ? "https" : "http";
  if (url.port !== "") options.port = url.port;
  return options;
};
