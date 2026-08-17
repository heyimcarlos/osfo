import { DateTime, Effect, Redacted } from "effect";
import Stripe from "stripe";

import * as BillingDb from "./db/billing";
import { inspectStripeBilling } from "./db/billing/stripe-inspect";
import { makeStripePersistence } from "./db/billing/stripe-persistence";
import * as WebhooksDb from "./db/webhooks";
import type { Database } from "./db";
import {
  BillingCheckoutSessionId,
  BillingCustomerId,
  AllowancePeriodId,
  StripePriceId,
  StripePortalConfigurationId,
  StripeProductId,
} from "./domain";
import type { RuntimeConfig } from "./env";
import * as StripeAdapter from "./integrations/stripe/billing";
import * as BillingPresentation from "./services/billing-presentation";
import * as BillingSubscriptions from "./services/billing-subscriptions";
import * as StripeBilling from "./services/stripe-billing";
import * as StripeWebhooks from "./services/stripe-webhooks";

/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- The composition root supplies secure identity effects to application services. */

/** Construct request-scoped Stripe billing services from concrete runtime dependencies. */
export const makeBillingServices = (database: Database, config: RuntimeConfig) => {
  const webBaseUrl = new URL(config.auth.trustedOrigins[0] ?? config.auth.baseURL);
  const offer = {
    priceId: StripePriceId.make(config.stripe.adventurerPriceId),
    productId: StripeProductId.make(config.stripe.adventurerProductId),
  };
  const client = new Stripe(Redacted.value(config.stripe.secretKey), {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
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
    persistence: makeStripePersistence(database),
    portal: {
      configurationId: StripePortalConfigurationId.make(config.stripe.portalConfigurationId),
      returnUrl: new URL("/billing/return?source=portal", webBaseUrl),
    },
    stripe,
    urls: {
      cancel: new URL("/billing", webBaseUrl),
      success: new URL("/billing/return?source=checkout", webBaseUrl),
    },
  });
  const webhookPersistence = WebhooksDb.make({
    database,
    webhookEventId: Effect.sync(() => crypto.randomUUID()),
  });
  return {
    presentation: BillingPresentation.make({
      inspect: (userId) => inspectStripeBilling(database, userId),
    }),
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
