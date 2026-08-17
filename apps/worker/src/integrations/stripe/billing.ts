import { Effect, Redacted, Result, Schema } from "effect";
import type Stripe from "stripe";

/* oxlint-disable eslint/no-underscore-dangle, osfo/no-runtime-typeof, osfo/no-unknown-parameters -- This provider adapter schema-decodes Stripe SDK unions and tagged domain values before it branches. */
/* oxlint-disable effecttsgo/global-date-in-effect -- Stripe supplies Unix timestamps and the persistence contract uses JavaScript Date values. */

import {
  BillingCheckoutSessionId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripeInvoiceId,
  type StripePriceId,
  type StripeProductId,
  StripeSubscriptionId,
} from "../../domain";
import {
  StripeSubscriptionSnapshot,
  type StripeSubscriptionSnapshot as StripeSubscriptionSnapshotType,
} from "../../services/billing-subscriptions";
import {
  StripeRequestFailed,
  type StripeGateway as StripeBillingGateway,
} from "../../services/stripe-billing";
import {
  InvalidStripeSignature,
  PermanentStripeWebhookFailure,
  type StripeGateway as StripeWebhookGateway,
  type VerifiedStripeEvent,
} from "../../services/stripe-webhooks";

const StripeReference = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]);
const RawSubscription = Schema.Struct({
  cancel_at_period_end: Schema.Boolean,
  customer: StripeReference,
  id: Schema.String,
  items: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        current_period_end: Schema.Finite,
        current_period_start: Schema.Finite,
        price: Schema.Struct({ id: Schema.String, product: StripeReference }),
        quantity: Schema.optionalKey(Schema.Finite),
      }),
    ),
  }),
  latest_invoice: Schema.NullOr(
    Schema.Union([
      Schema.String,
      Schema.Struct({ id: Schema.String, status: Schema.NullOr(Schema.String) }),
    ]),
  ),
  metadata: Schema.Record(Schema.String, Schema.String),
  status: Schema.String,
});
const VerifiedEvent = Schema.Struct({
  data: Schema.Struct({
    object: Schema.Struct({
      client_reference_id: Schema.optionalKey(Schema.NullOr(BillingCheckoutSessionId)),
      id: Schema.String,
    }),
  }),
  id: Schema.String,
  type: Schema.String,
});
const CheckoutLocator = Schema.Struct({ subscription: Schema.NullOr(StripeReference) });
const InvoiceLocator = Schema.Struct({
  parent: Schema.NullOr(
    Schema.Struct({
      subscription_details: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ subscription: StripeReference })),
      ),
    }),
  ),
});
const ChargeLocator = Schema.Struct({
  amount: Schema.Finite,
  amount_refunded: Schema.Finite,
  payment_intent: Schema.NullOr(StripeReference),
});
const InvoicePaymentList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ invoice: StripeReference })),
});
const StripeFailure = Schema.Struct({
  statusCode: Schema.optionalKey(Schema.Finite),
  type: Schema.optionalKey(Schema.String),
});

/** One explicit approved Stripe offer for the Adventurer Plan family. */
export interface AdventurerOffer {
  readonly priceId: StripePriceId;
  readonly productId: StripeProductId;
}

/** Concrete dependencies for the Stripe SDK adapter. */
export interface MakeOptions {
  readonly client: Stripe;
  readonly offer: AdventurerOffer;
  readonly webhookSecret: Redacted.Redacted;
}

/** Direct current-state retrieval used by explicit reconciliation. */
export interface ReconciliationGateway {
  readonly fetchSubscription: (
    subscriptionId: StripeSubscriptionId,
  ) => Effect.Effect<
    StripeSubscriptionSnapshotType,
    PermanentStripeWebhookFailure | StripeRequestFailed
  >;
}

/** Parse one freshly retrieved Stripe Subscription into Osfo's normalized projection. */
export const parseSubscriptionSnapshot = (
  input: unknown,
  offer: AdventurerOffer,
): Effect.Effect<StripeSubscriptionSnapshotType, PermanentStripeWebhookFailure> =>
  Effect.gen(function* () {
    const subscription = yield* Schema.decodeUnknownEffect(RawSubscription)(input).pipe(
      Effect.mapError(
        () =>
          new PermanentStripeWebhookFailure({
            errorCode: "invalid_stripe_subscription",
            message: "Stripe returned an invalid Subscription object",
          }),
      ),
    );
    const item = subscription.items.data[0];
    if (subscription.items.data.length !== 1 || item === undefined || item.quantity !== 1) {
      return yield* new PermanentStripeWebhookFailure({
        errorCode: "invalid_subscription_items",
        message: "The Stripe Subscription must contain one Adventurer item with quantity one",
      });
    }
    const productId =
      typeof item.price.product === "string" ? item.price.product : item.price.product.id;
    if (productId !== offer.productId || item.price.id !== offer.priceId) {
      return yield* new PermanentStripeWebhookFailure({
        errorCode: "stripe_offer_not_allowlisted",
        message: "The Stripe Product and Price are not approved for Adventurer",
      });
    }
    const userId = subscription.metadata.userId;
    if (userId === undefined) {
      return yield* new PermanentStripeWebhookFailure({
        errorCode: "missing_user_metadata",
        message: "The Stripe Subscription has no safe User reference",
      });
    }
    const latestInvoice = subscription.latest_invoice;
    const payment =
      latestInvoice === null || typeof latestInvoice === "string"
        ? ({ _tag: "Unknown" } as const)
        : latestInvoice.status === "paid"
          ? ({ _tag: "Paid", invoiceId: latestInvoice.id } as const)
          : ({ _tag: "NotPaid" } as const);
    const customerId =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    return yield* Schema.decodeUnknownEffect(StripeSubscriptionSnapshot)({
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      customerId,
      currentPeriodRefunded: false,
      payment,
      period: {
        endsAt: new Date(item.current_period_end * 1_000),
        startsAt: new Date(item.current_period_start * 1_000),
      },
      priceId: item.price.id,
      productId,
      status: subscription.status,
      subscriptionId: subscription.id,
      userId,
    }).pipe(
      Effect.mapError(
        () =>
          new PermanentStripeWebhookFailure({
            errorCode: "invalid_normalized_snapshot",
            message: "The current Stripe state cannot form a billing projection",
          }),
      ),
    );
  });

/** Construct the explicit Stripe SDK adapter used by billing and webhook services. */
export const make = (
  options: MakeOptions,
): StripeBillingGateway & StripeWebhookGateway & ReconciliationGateway => {
  const fetchSubscription: ReconciliationGateway["fetchSubscription"] = (subscriptionId) =>
    Effect.gen(function* () {
      const subscription = yield* tryStripe("retrieveSubscription", () =>
        options.client.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] }),
      );
      return yield* parseSubscriptionSnapshot(subscription, options.offer);
    });
  const fetchCurrentSnapshot: StripeWebhookGateway["fetchCurrentSnapshot"] = (event) =>
    Effect.gen(function* () {
      const locator = yield* locateSubscription(options.client, event);
      if (locator === null) return { _tag: "NoOp" } as const;
      const subscription = yield* tryStripe("retrieveSubscription", () =>
        options.client.subscriptions.retrieve(locator.subscriptionId, {
          expand: ["latest_invoice"],
        }),
      );
      const snapshot = yield* parseSubscriptionSnapshot(subscription, options.offer);
      const currentPeriodRefunded =
        locator.refundedInvoiceId !== null &&
        snapshot.payment._tag === "Paid" &&
        snapshot.payment.invoiceId === locator.refundedInvoiceId;
      return {
        _tag: "Snapshot" as const,
        snapshot: currentPeriodRefunded
          ? StripeSubscriptionSnapshot.make({
              ...snapshot,
              currentPeriodRefunded: true,
              payment: { _tag: "NotPaid" },
            })
          : snapshot,
      };
    });

  return {
    createCheckout: (input) =>
      Effect.gen(function* () {
        const session = yield* tryStripe("createCheckout", () =>
          options.client.checkout.sessions.create(
            {
              billing_address_collection: "required",
              cancel_url: input.cancelUrl.href,
              client_reference_id: input.idempotencyKey,
              customer: input.customerId,
              line_items: [{ price: input.priceId, quantity: 1 }],
              metadata: input.metadata,
              mode: "subscription",
              payment_method_types: ["card"],
              subscription_data: { metadata: input.metadata },
              success_url: input.successUrl.href,
              tax_id_collection: { enabled: true },
            },
            { idempotencyKey: input.idempotencyKey },
          ),
        );
        if (session.url === null) {
          return yield* new StripeRequestFailed({
            kind: "permanent",
            message: "Stripe did not return a hosted Checkout URL",
            operation: "createCheckout",
          });
        }
        return {
          expiresAt: new Date(session.expires_at * 1_000),
          stripeCheckoutSessionId: yield* parseId(
            StripeCheckoutSessionId,
            session.id,
            "createCheckout",
          ),
          url: new URL(session.url),
        };
      }),
    createCustomer: (input) =>
      Effect.gen(function* () {
        const customer = yield* tryStripe("createCustomer", () =>
          options.client.customers.create(
            { metadata: input.metadata },
            { idempotencyKey: input.idempotencyKey },
          ),
        );
        return yield* parseId(StripeCustomerId, customer.id, "createCustomer");
      }),
    createPortal: (input) =>
      Effect.map(
        tryStripe("createPortal", () =>
          options.client.billingPortal.sessions.create({
            configuration: input.configurationId,
            customer: input.customerId,
            return_url: input.returnUrl.href,
          }),
        ),
        (session) => new URL(session.url),
      ),
    fetchCurrentSnapshot,
    fetchSubscription,
    retrieveCheckout: (stripeCheckoutSessionId) =>
      Effect.gen(function* () {
        const session = yield* tryStripe("retrieveCheckout", () =>
          options.client.checkout.sessions.retrieve(stripeCheckoutSessionId),
        );
        if (session.status === null) {
          return yield* new StripeRequestFailed({
            kind: "permanent",
            message: "Stripe returned a Checkout Session without a state",
            operation: "retrieveCheckout",
          });
        }
        const subscriptionId =
          session.subscription === null
            ? null
            : typeof session.subscription === "string"
              ? session.subscription
              : session.subscription.id;
        return {
          expiresAt: new Date(session.expires_at * 1_000),
          state: session.status === "complete" ? "complete" : session.status,
          stripeSubscriptionId:
            subscriptionId === null
              ? null
              : yield* parseId(StripeSubscriptionId, subscriptionId, "retrieveCheckout"),
          url: session.url === null ? null : new URL(session.url),
        };
      }),
    verify: (rawBody, signature) =>
      Effect.tryPromise({
        try: () =>
          options.client.webhooks.constructEventAsync(
            rawBody,
            signature,
            Redacted.value(options.webhookSecret),
          ),
        catch: () => new InvalidStripeSignature({ message: "Invalid Stripe signature" }),
      }).pipe(
        Effect.flatMap((event) => Schema.decodeUnknownEffect(VerifiedEvent)(event)),
        Effect.map((event) => ({
          billingCheckoutSessionId: event.type.startsWith("checkout.session.")
            ? (event.data.object.client_reference_id ?? null)
            : null,
          externalEventId: event.id,
          externalObjectId: event.data.object.id,
          type: event.type,
        })),
        Effect.mapError(() => new InvalidStripeSignature({ message: "Invalid Stripe event" })),
      ),
  };
};

const locateSubscription = (
  client: Stripe,
  event: VerifiedStripeEvent,
): Effect.Effect<
  {
    readonly refundedInvoiceId: StripeInvoiceId | null;
    readonly subscriptionId: StripeSubscriptionId;
  } | null,
  PermanentStripeWebhookFailure | StripeRequestFailed
> => {
  if (event.type.startsWith("customer.subscription.")) {
    return Schema.decodeEffect(StripeSubscriptionId)(event.externalObjectId).pipe(
      Effect.mapError(
        () =>
          new PermanentStripeWebhookFailure({
            errorCode: "invalid_subscription_id",
            message: "The verified event has an invalid Stripe Subscription ID",
          }),
      ),
      Effect.map((subscriptionId) => ({ refundedInvoiceId: null, subscriptionId })),
    );
  }
  if (event.type.startsWith("checkout.session.")) {
    return Effect.gen(function* () {
      const checkoutId = yield* parseWebhookId(StripeCheckoutSessionId, event.externalObjectId);
      const session = yield* tryStripe("retrieveCheckout", () =>
        client.checkout.sessions.retrieve(checkoutId),
      );
      const locator = yield* decodeLocator(CheckoutLocator, session);
      if (locator.subscription === null) return null;
      const id =
        typeof locator.subscription === "string" ? locator.subscription : locator.subscription.id;
      return {
        refundedInvoiceId: null,
        subscriptionId: yield* parseWebhookId(StripeSubscriptionId, id),
      };
    });
  }
  if (event.type.startsWith("invoice.")) {
    return Effect.gen(function* () {
      const invoiceId = yield* parseWebhookId(StripeInvoiceId, event.externalObjectId);
      const subscriptionId = yield* locateSubscriptionFromInvoice(client, invoiceId);
      return subscriptionId === null ? null : { refundedInvoiceId: null, subscriptionId };
    });
  }
  if (event.type === "charge.refunded") {
    return Effect.gen(function* () {
      const charge = yield* tryStripe("retrieveCharge", () =>
        client.charges.retrieve(event.externalObjectId),
      ).pipe(Effect.flatMap((value) => decodeLocator(ChargeLocator, value)));
      if (
        charge.amount <= 0 ||
        charge.amount_refunded !== charge.amount ||
        charge.payment_intent === null
      ) {
        return null;
      }
      const paymentIntentId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent.id;
      const payments = yield* tryStripe("listInvoicePayments", () =>
        client.invoicePayments.list({
          payment: { payment_intent: paymentIntentId, type: "payment_intent" },
        }),
      ).pipe(Effect.flatMap((value) => decodeLocator(InvoicePaymentList, value)));
      const payment = payments.data[0];
      if (payment === undefined) return null;
      const invoiceId = yield* parseWebhookId(
        StripeInvoiceId,
        typeof payment.invoice === "string" ? payment.invoice : payment.invoice.id,
      );
      const subscriptionId = yield* locateSubscriptionFromInvoice(client, invoiceId);
      return subscriptionId === null ? null : { refundedInvoiceId: invoiceId, subscriptionId };
    });
  }
  return Effect.succeed(null);
};

const locateSubscriptionFromInvoice = (
  client: Stripe,
  invoiceId: StripeInvoiceId,
): Effect.Effect<
  StripeSubscriptionId | null,
  PermanentStripeWebhookFailure | StripeRequestFailed
> =>
  Effect.gen(function* () {
    const invoice = yield* tryStripe("retrieveInvoice", () => client.invoices.retrieve(invoiceId));
    const locator = yield* decodeLocator(InvoiceLocator, invoice);
    const subscription = locator.parent?.subscription_details?.subscription;
    if (subscription === undefined || subscription === null) return null;
    const id = typeof subscription === "string" ? subscription : subscription.id;
    return yield* parseWebhookId(StripeSubscriptionId, id);
  });

const decodeLocator = <A, Encoded extends object>(
  schema: Schema.Codec<A, Encoded>,
  input: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () =>
        new PermanentStripeWebhookFailure({
          errorCode: "invalid_stripe_locator",
          message: "Stripe returned an invalid current object locator",
        }),
    ),
  );

const parseWebhookId = <A, Encoded>(schema: Schema.Codec<A, Encoded>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () =>
        new PermanentStripeWebhookFailure({
          errorCode: "invalid_stripe_object_id",
          message: "The verified event contains an invalid Stripe object ID",
        }),
    ),
  );

const parseId = <A, Encoded>(
  schema: Schema.Codec<A, Encoded>,
  input: unknown,
  operation: StripeRequestFailed["operation"],
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () =>
        new StripeRequestFailed({
          kind: "permanent",
          message: "Stripe returned an invalid object identity",
          operation,
        }),
    ),
  );

const tryStripe = <A>(operation: StripeRequestFailed["operation"], request: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => {
      const parsed = Schema.decodeUnknownResult(StripeFailure)(cause);
      const failure = Result.isSuccess(parsed) ? parsed.success : {};
      const permanent =
        failure.type === "StripeInvalidRequestError" ||
        (failure.statusCode !== undefined &&
          failure.statusCode >= 400 &&
          failure.statusCode < 500 &&
          failure.statusCode !== 409 &&
          failure.statusCode !== 429);
      return new StripeRequestFailed({
        kind: permanent ? "permanent" : "transient",
        message: permanent
          ? "Stripe rejected the billing request"
          : "Stripe billing is temporarily unavailable",
        operation,
      });
    },
  });
