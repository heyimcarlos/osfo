import { Effect, Schema } from "effect";

import type {
  BillingCheckoutSessionId,
  BillingCustomerId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripeProductId,
  StripePortalConfigurationId,
  StripeSubscriptionId,
  UserId,
} from "../domain";

/** Local lifecycle state for one Stripe Checkout attempt. */
export const CheckoutState = Schema.Literals(["creating", "open", "complete", "expired", "failed"]);

/** Local lifecycle state for one Stripe Checkout attempt. */
export type CheckoutState = typeof CheckoutState.Type;

/** Classified Stripe request failure owned by the provider adapter. */
export class StripeRequestFailed extends Schema.TaggedError<StripeRequestFailed>()(
  "StripeRequestFailed",
  {
    kind: Schema.Literals(["permanent", "transient"]),
    message: Schema.String,
    operation: Schema.Literals([
      "createCheckout",
      "createCustomer",
      "createPortal",
      "retrieveCheckout",
      "retrieveCharge",
      "retrieveInvoice",
      "listInvoicePayments",
      "retrieveSubscription",
      "verifyWebhook",
    ]),
  },
) {}

/** Safe persistence failure for Stripe billing coordination. */
export class BillingPersistenceUnavailable extends Schema.TaggedError<BillingPersistenceUnavailable>()(
  "BillingPersistenceUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected refusal when current billing facts do not permit a new subscription Checkout. */
export class CheckoutIneligible extends Schema.TaggedError<CheckoutIneligible>()(
  "CheckoutIneligible",
  {
    reason: Schema.Literals(["activePlan", "existingStripeSubscription"]),
  },
) {}

/** Current facts that determine whether a User can start subscription Checkout. */
export interface CheckoutEligibility {
  readonly hasRecoverableStripeSubscription: boolean;
  readonly plan: "adventurer" | "free";
}

/** Local Customer fact returned by idempotent preparation. */
export interface PreparedCustomer {
  readonly billingCustomerId: BillingCustomerId;
  readonly stripeCustomerId: StripeCustomerId | null;
}

/** Local Checkout fact returned by idempotent preparation. */
export interface PreparedCheckout {
  readonly billingCheckoutSessionId: BillingCheckoutSessionId;
  readonly state: CheckoutState;
  readonly stripeCheckoutSessionId: StripeCheckoutSessionId | null;
}

/** Narrow PostgreSQL port required by Stripe Customer and Checkout coordination. */
export interface Persistence {
  readonly failCheckout: (
    billingCheckoutSessionId: BillingCheckoutSessionId,
    errorCode: string,
  ) => Effect.Effect<void, BillingPersistenceUnavailable>;
  readonly inspectCheckoutEligibility: (
    userId: UserId,
  ) => Effect.Effect<CheckoutEligibility, BillingPersistenceUnavailable>;
  readonly prepareCheckout: (input: {
    readonly billingCheckoutSessionId: BillingCheckoutSessionId;
    readonly billingCustomerId: BillingCustomerId;
    readonly priceId: StripePriceId;
    readonly productId: StripeProductId;
    readonly userId: UserId;
  }) => Effect.Effect<PreparedCheckout, BillingPersistenceUnavailable | CheckoutIneligible>;
  readonly prepareCustomer: (
    userId: UserId,
    billingCustomerId: BillingCustomerId,
  ) => Effect.Effect<PreparedCustomer, BillingPersistenceUnavailable>;
  readonly storeCheckout: (
    billingCheckoutSessionId: BillingCheckoutSessionId,
    session: {
      readonly expiresAt: Date;
      readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
    },
  ) => Effect.Effect<void, BillingPersistenceUnavailable>;
  readonly storeRetrievedCheckout: (
    billingCheckoutSessionId: BillingCheckoutSessionId,
    session: {
      readonly expiresAt: Date;
      readonly state: "complete" | "expired";
      readonly stripeSubscriptionId: StripeSubscriptionId | null;
    },
  ) => Effect.Effect<void, BillingPersistenceUnavailable>;
  readonly storeCustomer: (
    billingCustomerId: BillingCustomerId,
    stripeCustomerId: StripeCustomerId,
  ) => Effect.Effect<void, BillingPersistenceUnavailable>;
}

/** Explicit Stripe operations used by Osfo billing. */
export interface StripeGateway {
  readonly createCheckout: (input: {
    readonly cancelUrl: URL;
    readonly customerId: StripeCustomerId;
    readonly idempotencyKey: BillingCheckoutSessionId;
    readonly metadata: {
      readonly billingCheckoutSessionId: BillingCheckoutSessionId;
      readonly priceId: StripePriceId;
      readonly productId: StripeProductId;
      readonly userId: UserId;
    };
    readonly priceId: StripePriceId;
    readonly successUrl: URL;
  }) => Effect.Effect<
    {
      readonly expiresAt: Date;
      readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
      readonly url: URL;
    },
    StripeRequestFailed
  >;
  readonly createCustomer: (input: {
    readonly idempotencyKey: BillingCustomerId;
    readonly metadata: { readonly billingCustomerId: BillingCustomerId; readonly userId: UserId };
  }) => Effect.Effect<StripeCustomerId, StripeRequestFailed>;
  readonly createPortal: (input: {
    readonly configurationId: StripePortalConfigurationId;
    readonly customerId: StripeCustomerId;
    readonly returnUrl: URL;
  }) => Effect.Effect<URL, StripeRequestFailed>;
  readonly retrieveCheckout: (stripeCheckoutSessionId: StripeCheckoutSessionId) => Effect.Effect<
    {
      readonly expiresAt: Date;
      readonly state: CheckoutState;
      readonly stripeSubscriptionId: StripeSubscriptionId | null;
      readonly url: URL | null;
    },
    StripeRequestFailed
  >;
}

/** Concrete dependencies for explicit Stripe billing coordination. */
export interface MakeOptions {
  readonly ids: {
    readonly checkout: Effect.Effect<BillingCheckoutSessionId>;
    readonly customer: Effect.Effect<BillingCustomerId>;
  };
  readonly offers: {
    readonly adventurer: { readonly priceId: StripePriceId; readonly productId: StripeProductId };
  };
  readonly persistence: Persistence;
  readonly portal: {
    readonly configurationId: StripePortalConfigurationId;
    readonly returnUrl: URL;
  };
  readonly stripe: StripeGateway;
  readonly urls: { readonly cancel: URL; readonly success: URL };
}

/** Customer Checkout and Customer Portal operations for Stripe-hosted billing. */
export interface Interface {
  readonly openPortal: (
    userId: UserId,
  ) => Effect.Effect<URL, BillingPersistenceUnavailable | StripeRequestFailed>;
  readonly startCheckout: (
    userId: UserId,
  ) => Effect.Effect<
    { readonly billingCheckoutSessionId: BillingCheckoutSessionId; readonly url: URL },
    BillingPersistenceUnavailable | CheckoutIneligible | StripeRequestFailed
  >;
}

/** Construct explicit Stripe billing operations from application-owned ports. */
export const make = (options: MakeOptions): Interface => {
  const ensureCustomer = (userId: UserId) =>
    Effect.gen(function* () {
      const candidateId = yield* options.ids.customer;
      const local = yield* options.persistence.prepareCustomer(userId, candidateId);
      if (local.stripeCustomerId !== null) {
        return {
          billingCustomerId: local.billingCustomerId,
          stripeCustomerId: local.stripeCustomerId,
        };
      }
      const stripeCustomerId = yield* options.stripe.createCustomer({
        idempotencyKey: local.billingCustomerId,
        metadata: { billingCustomerId: local.billingCustomerId, userId },
      });
      yield* options.persistence.storeCustomer(local.billingCustomerId, stripeCustomerId);
      return { billingCustomerId: local.billingCustomerId, stripeCustomerId };
    });

  const createCheckout = (
    userId: UserId,
    customer: {
      readonly billingCustomerId: BillingCustomerId;
      readonly stripeCustomerId: StripeCustomerId;
    },
  ): ReturnType<Interface["startCheckout"]> =>
    Effect.gen(function* () {
      const candidateId = yield* options.ids.checkout;
      const offer = options.offers.adventurer;
      const checkout = yield* options.persistence.prepareCheckout({
        billingCheckoutSessionId: candidateId,
        billingCustomerId: customer.billingCustomerId,
        priceId: offer.priceId,
        productId: offer.productId,
        userId,
      });

      if (checkout.stripeCheckoutSessionId !== null && checkout.state === "open") {
        const existing = yield* options.stripe.retrieveCheckout(checkout.stripeCheckoutSessionId);
        if (existing.state === "open" && existing.url !== null) {
          return {
            billingCheckoutSessionId: checkout.billingCheckoutSessionId,
            url: existing.url,
          };
        }
        if (existing.state === "complete" || existing.state === "expired") {
          yield* options.persistence.storeRetrievedCheckout(checkout.billingCheckoutSessionId, {
            expiresAt: existing.expiresAt,
            state: existing.state,
            stripeSubscriptionId: existing.stripeSubscriptionId,
          });
          if (existing.state === "expired") return yield* createCheckout(userId, customer);
          return yield* new StripeRequestFailed({
            kind: "permanent",
            message: "The existing Stripe Checkout Session is already complete",
            operation: "retrieveCheckout",
          });
        }
      }

      const created = yield* options.stripe
        .createCheckout({
          cancelUrl: options.urls.cancel,
          customerId: customer.stripeCustomerId,
          idempotencyKey: checkout.billingCheckoutSessionId,
          metadata: {
            billingCheckoutSessionId: checkout.billingCheckoutSessionId,
            priceId: offer.priceId,
            productId: offer.productId,
            userId,
          },
          priceId: offer.priceId,
          successUrl: options.urls.success,
        })
        .pipe(
          Effect.tapError((failure) =>
            failure.kind === "permanent"
              ? options.persistence.failCheckout(
                  checkout.billingCheckoutSessionId,
                  failure.operation,
                )
              : Effect.void,
          ),
        );
      yield* options.persistence.storeCheckout(checkout.billingCheckoutSessionId, created);
      return { billingCheckoutSessionId: checkout.billingCheckoutSessionId, url: created.url };
    });

  return {
    openPortal: (userId) =>
      Effect.gen(function* () {
        const customer = yield* ensureCustomer(userId);
        return yield* options.stripe.createPortal({
          configurationId: options.portal.configurationId,
          customerId: customer.stripeCustomerId,
          returnUrl: options.portal.returnUrl,
        });
      }),
    startCheckout: (userId) =>
      Effect.gen(function* () {
        const eligibility = yield* options.persistence.inspectCheckoutEligibility(userId);
        if (eligibility.plan === "adventurer") {
          return yield* new CheckoutIneligible({ reason: "activePlan" });
        }
        if (eligibility.hasRecoverableStripeSubscription) {
          return yield* new CheckoutIneligible({ reason: "existingStripeSubscription" });
        }
        const customer = yield* ensureCustomer(userId);
        return yield* createCheckout(userId, customer);
      }),
  };
};
