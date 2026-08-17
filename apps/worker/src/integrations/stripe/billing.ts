import { Effect, Redacted, Result, Schema } from "effect";
import type Stripe from "stripe";

/* oxlint-disable eslint/no-underscore-dangle, osfo/no-runtime-typeof, osfo/no-unknown-parameters -- This provider adapter schema-decodes Stripe SDK unions and tagged domain values before it branches. */
/* oxlint-disable effecttsgo/global-date-in-effect -- Stripe supplies Unix timestamps and the persistence contract uses JavaScript Date values. */

import {
  BillingCheckoutSessionId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripeInvoiceId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../../domain";
import {
  StripeSubscriptionSnapshot,
  type StripeSubscriptionSnapshot as StripeSubscriptionSnapshotType,
} from "../../services/billing-subscriptions";
import {
  CheckoutState,
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
const ChargePaymentLocator = Schema.Struct({ payment_intent: Schema.NullOr(StripeReference) });
const DisputeLocator = Schema.Struct({ charge: StripeReference, status: Schema.String });
const InvoicePaymentList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ invoice: StripeReference })),
});
const CurrentInvoicePaymentList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      amount_paid: Schema.NullOr(Schema.Finite),
      payment: Schema.Struct({
        charge: Schema.optionalKey(StripeReference),
        payment_intent: Schema.optionalKey(StripeReference),
        type: Schema.String,
      }),
      status: Schema.String,
    }),
  ),
});
const PaymentIntentLocator = Schema.Struct({ latest_charge: Schema.NullOr(StripeReference) });
const RefundedCharge = Schema.Struct({ amount: Schema.Finite, amount_refunded: Schema.Finite });
const DisputeList = Schema.Struct({ data: Schema.Array(Schema.Struct({ status: Schema.String })) });
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
  readonly retrieveCheckoutForReturn: (
    stripeCheckoutSessionId: StripeCheckoutSessionId,
  ) => Effect.Effect<
    {
      readonly billingCheckoutSessionId: BillingCheckoutSessionId;
      readonly customerId: StripeCustomerId;
      readonly priceId: StripePriceId;
      readonly productId: StripeProductId;
      readonly state: CheckoutState;
      readonly stripeSubscriptionId: StripeSubscriptionId | null;
      readonly userId: UserId;
    },
    StripeRequestFailed
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
      const snapshot = yield* parseSubscriptionSnapshot(subscription, options.offer);
      return yield* discoverCurrentPeriodReversal(options.client, snapshot);
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
      const eventProvesCurrentReversal =
        locator.paymentReversal !== null &&
        locator.paymentReversal.reversed &&
        snapshot.payment._tag === "Paid" &&
        snapshot.payment.invoiceId === locator.paymentReversal.invoiceId;
      const current = eventProvesCurrentReversal
        ? StripeSubscriptionSnapshot.make({
            ...snapshot,
            currentPeriodRefunded: true,
            payment: { _tag: "NotPaid" },
          })
        : yield* discoverCurrentPeriodReversal(options.client, snapshot);
      return {
        _tag: "Snapshot" as const,
        snapshot: current,
      };
    });
  const retrieveCheckout = (stripeCheckoutSessionId: StripeCheckoutSessionId) =>
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
      const customerId =
        session.customer === null
          ? null
          : typeof session.customer === "string"
            ? session.customer
            : session.customer.id;
      const metadata = session.metadata;
      if (metadata === null) {
        return yield* new StripeRequestFailed({
          kind: "permanent",
          message: "Stripe returned Checkout without identity metadata",
          operation: "retrieveCheckout",
        });
      }
      const billingCheckoutSessionId = yield* parseId(
        BillingCheckoutSessionId,
        session.client_reference_id,
        "retrieveCheckout",
      );
      if (metadata.billingCheckoutSessionId !== billingCheckoutSessionId) {
        return yield* new StripeRequestFailed({
          kind: "permanent",
          message: "Stripe returned conflicting Checkout attempt identity",
          operation: "retrieveCheckout",
        });
      }
      return {
        billingCheckoutSessionId,
        customerId: yield* parseId(StripeCustomerId, customerId, "retrieveCheckout"),
        expiresAt: new Date(session.expires_at * 1_000),
        priceId: yield* parseId(StripePriceId, metadata.priceId, "retrieveCheckout"),
        productId: yield* parseId(StripeProductId, metadata.productId, "retrieveCheckout"),
        state: yield* parseId(CheckoutState, session.status, "retrieveCheckout"),
        stripeSubscriptionId:
          subscriptionId === null
            ? null
            : yield* parseId(StripeSubscriptionId, subscriptionId, "retrieveCheckout"),
        userId: yield* parseId(UserId, metadata.userId, "retrieveCheckout"),
        url: session.url === null ? null : new URL(session.url),
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
    retrieveCheckout,
    retrieveCheckoutForReturn: retrieveCheckout,
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

const discoverCurrentPeriodReversal = (
  client: Stripe,
  snapshot: StripeSubscriptionSnapshotType,
): Effect.Effect<
  StripeSubscriptionSnapshotType,
  PermanentStripeWebhookFailure | StripeRequestFailed
> =>
  Effect.gen(function* () {
    if (snapshot.payment._tag !== "Paid") return snapshot;
    const invoiceId = snapshot.payment.invoiceId;
    const payments = yield* tryStripe("listInvoicePayments", () =>
      client.invoicePayments.list({ invoice: invoiceId, status: "paid" }),
    ).pipe(Effect.flatMap((value) => decodeLocator(CurrentInvoicePaymentList, value)));
    const paid = payments.data.filter(
      (payment) =>
        payment.status === "paid" && payment.amount_paid !== null && payment.amount_paid > 0,
    );
    if (paid.length === 0) return snapshot;
    const reversals = yield* Effect.forEach(paid, (payment) =>
      Effect.gen(function* () {
        const locator = payment.payment;
        let chargeId: string;
        if (locator.type === "charge" && locator.charge !== undefined) {
          chargeId = typeof locator.charge === "string" ? locator.charge : locator.charge.id;
        } else if (locator.type === "payment_intent" && locator.payment_intent !== undefined) {
          const paymentIntentId =
            typeof locator.payment_intent === "string"
              ? locator.payment_intent
              : locator.payment_intent.id;
          chargeId = yield* tryStripe("retrievePaymentIntent", () =>
            client.paymentIntents.retrieve(paymentIntentId),
          ).pipe(
            Effect.flatMap((value) => decodeLocator(PaymentIntentLocator, value)),
            Effect.flatMap((intent) => {
              if (intent.latest_charge === null) {
                return Effect.fail(
                  new PermanentStripeWebhookFailure({
                    errorCode: "missing_invoice_payment_charge",
                    message: "A paid Invoice payment has no authoritative Charge",
                  }),
                );
              }
              return Effect.succeed(
                typeof intent.latest_charge === "string"
                  ? intent.latest_charge
                  : intent.latest_charge.id,
              );
            }),
          );
        } else {
          return yield* new PermanentStripeWebhookFailure({
            errorCode: "unsupported_invoice_payment",
            message: "A paid Invoice uses an unsupported payment authority",
          });
        }
        const charge = yield* tryStripe("retrieveCharge", () =>
          client.charges.retrieve(chargeId),
        ).pipe(Effect.flatMap((value) => decodeLocator(RefundedCharge, value)));
        const fullyRefunded = charge.amount > 0 && charge.amount_refunded === charge.amount;
        if (fullyRefunded) return { disputed: false, fullyRefunded };
        const disputes = yield* tryStripe("listDisputes", () =>
          client.disputes.list({ charge: chargeId }),
        ).pipe(Effect.flatMap((value) => decodeLocator(DisputeList, value)));
        const statuses = yield* Effect.forEach(disputes.data, (dispute) =>
          disputeReversal(dispute.status),
        );
        return { disputed: statuses.some(Boolean), fullyRefunded };
      }),
    );
    const reversed =
      reversals.every((payment) => payment.fullyRefunded) ||
      reversals.some((payment) => payment.disputed);
    if (!reversed) return snapshot;
    return StripeSubscriptionSnapshot.make({
      ...snapshot,
      currentPeriodRefunded: true,
      payment: { _tag: "NotPaid" },
    });
  });

const locateSubscription = (
  client: Stripe,
  event: VerifiedStripeEvent,
): Effect.Effect<
  {
    readonly paymentReversal: {
      readonly invoiceId: StripeInvoiceId;
      readonly reversed: boolean;
    } | null;
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
      Effect.map((subscriptionId) => ({ paymentReversal: null, subscriptionId })),
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
        paymentReversal: null,
        subscriptionId: yield* parseWebhookId(StripeSubscriptionId, id),
      };
    });
  }
  if (event.type.startsWith("invoice.")) {
    return Effect.gen(function* () {
      const invoiceId = yield* parseWebhookId(StripeInvoiceId, event.externalObjectId);
      const subscriptionId = yield* locateSubscriptionFromInvoice(client, invoiceId);
      return subscriptionId === null ? null : { paymentReversal: null, subscriptionId };
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
      return subscriptionId === null
        ? null
        : { paymentReversal: { invoiceId, reversed: true }, subscriptionId };
    });
  }
  if (event.type.startsWith("charge.dispute.")) {
    return Effect.gen(function* () {
      const dispute = yield* tryStripe("retrieveDispute", () =>
        client.disputes.retrieve(event.externalObjectId),
      ).pipe(Effect.flatMap((value) => decodeLocator(DisputeLocator, value)));
      const reversed = yield* disputeReversal(dispute.status);
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
      const charge = yield* tryStripe("retrieveCharge", () =>
        client.charges.retrieve(chargeId),
      ).pipe(Effect.flatMap((value) => decodeLocator(ChargePaymentLocator, value)));
      if (charge.payment_intent === null) return null;
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
      return subscriptionId === null
        ? null
        : { paymentReversal: { invoiceId, reversed }, subscriptionId };
    });
  }
  return Effect.succeed(null);
};

const disputeReversal = (status: string): Effect.Effect<boolean, PermanentStripeWebhookFailure> => {
  switch (status) {
    case "lost":
    case "needs_response":
    case "under_review":
    case "warning_needs_response":
    case "warning_under_review":
      return Effect.succeed(true);
    case "warning_closed":
    case "won":
      return Effect.succeed(false);
    default:
      return Effect.fail(
        new PermanentStripeWebhookFailure({
          errorCode: "unsupported_dispute_status",
          message: "Stripe returned an unsupported Dispute status",
        }),
      );
  }
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
