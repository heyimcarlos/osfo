import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import Stripe from "stripe";

import {
  StripeCustomerId,
  StripePortalConfigurationId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
} from "../src/domain";
import { StripeAdapter } from "../src/integrations/stripe/billing";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/prefer-schema-over-json -- These provider-boundary tests assert Effect tags and preserve exact signed JSON bytes. */

const secret = "whsec_test_webhook_secret";

const makeAdapter = (client: Stripe) =>
  StripeAdapter.make({
    client,
    offer: {
      priceId: StripePriceId.make("price_adventurer"),
      productId: StripeProductId.make("prod_adventurer"),
    },
    webhookSecret: Redacted.make(secret),
  });

const currentSubscription = (invoiceId: string) => ({
  cancel_at_period_end: false,
  customer: "cus_current",
  id: "sub_current",
  items: {
    data: [
      {
        current_period_end: 1_789_574_400,
        current_period_start: 1_786_982_400,
        price: { id: "price_adventurer", product: "prod_adventurer" },
        quantity: 1,
      },
    ],
  },
  latest_invoice: { id: invoiceId, status: "paid" },
  metadata: { userId: "user-current" },
  status: "active",
});

const installRefundResponses = (
  client: Stripe,
  input: { readonly amount: number; readonly amountRefunded: number; readonly invoiceId: string },
) => {
  Object.defineProperty(client.charges, "retrieve", {
    configurable: true,
    value: () =>
      Promise.resolve({
        amount: input.amount,
        amount_refunded: input.amountRefunded,
        payment_intent: "pi_refunded",
      }),
  });
  Object.defineProperty(client.invoicePayments, "list", {
    configurable: true,
    value: () => Promise.resolve({ data: [{ invoice: input.invoiceId }] }),
  });
  Object.defineProperty(client.invoices, "retrieve", {
    configurable: true,
    value: () =>
      Promise.resolve({ parent: { subscription_details: { subscription: "sub_current" } } }),
  });
};

describe("Stripe adapter", () => {
  it.effect("creates Customer Portal sessions with the approved configuration and return URL", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      const requests: Array<Stripe.BillingPortal.SessionCreateParams> = [];
      Object.defineProperty(client.billingPortal.sessions, "create", {
        value: (request: Stripe.BillingPortal.SessionCreateParams) => {
          requests.push(request);
          return Promise.resolve({ url: "https://billing.stripe.test/session" });
        },
      });

      const result = yield* makeAdapter(client).createPortal({
        configurationId: StripePortalConfigurationId.make("bpc_approved"),
        customerId: StripeCustomerId.make("cus_portal"),
        returnUrl: new URL("https://osfo.test/billing/return?source=portal"),
      });

      expect(result.href).toBe("https://billing.stripe.test/session");
      expect(requests).toEqual([
        {
          configuration: "bpc_approved",
          customer: "cus_portal",
          return_url: "https://osfo.test/billing/return?source=portal",
        },
      ]);
    }),
  );

  it.effect("verifies the exact raw webhook body and rejects mutated bytes", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      const adapter = StripeAdapter.make({
        client,
        offer: {
          priceId: StripePriceId.make("price_adventurer"),
          productId: StripeProductId.make("prod_adventurer"),
        },
        webhookSecret: Redacted.make(secret),
      });
      const rawBody = JSON.stringify({
        created: 1_786_939_200,
        data: { object: { id: "in_signature", object: "invoice" } },
        id: "evt_signature",
        livemode: false,
        object: "event",
        pending_webhooks: 1,
        type: "invoice.paid",
      });
      const signature = yield* Effect.promise(() =>
        client.webhooks.generateTestHeaderStringAsync({ payload: rawBody, secret }),
      );
      const verified = yield* adapter.verify(rawBody, signature);
      const mutated = yield* adapter.verify(`${rawBody} `, signature).pipe(Effect.exit);
      const checkoutBody = JSON.stringify({
        created: 1_786_939_200,
        data: {
          object: {
            client_reference_id: "checkout-local-recovery",
            id: "cs_test_recovery",
            object: "checkout.session",
          },
        },
        id: "evt_checkoutrecovery",
        livemode: false,
        object: "event",
        pending_webhooks: 1,
        type: "checkout.session.completed",
      });
      const checkoutSignature = yield* Effect.promise(() =>
        client.webhooks.generateTestHeaderStringAsync({ payload: checkoutBody, secret }),
      );
      const verifiedCheckout = yield* adapter.verify(checkoutBody, checkoutSignature);

      expect(verified).toEqual({
        billingCheckoutSessionId: null,
        externalEventId: "evt_signature",
        externalObjectId: "in_signature",
        type: "invoice.paid",
      });
      expect(mutated._tag).toBe("Failure");
      expect(verifiedCheckout).toEqual({
        billingCheckoutSessionId: "checkout-local-recovery",
        externalEventId: "evt_checkoutrecovery",
        externalObjectId: "cs_test_recovery",
        type: "checkout.session.completed",
      });
    }),
  );

  it.effect("parses paid current state only for the allowlisted Product and Price", () =>
    Effect.gen(function* () {
      const offer = {
        priceId: StripePriceId.make("price_adventurer"),
        productId: StripeProductId.make("prod_adventurer"),
      };
      const current = {
        cancel_at_period_end: false,
        customer: "cus_current",
        id: "sub_current",
        items: {
          data: [
            {
              current_period_end: 1_789_574_400,
              current_period_start: 1_786_982_400,
              price: { id: "price_adventurer", product: "prod_adventurer" },
              quantity: 1,
            },
          ],
        },
        latest_invoice: { id: "in_current", status: "paid" },
        metadata: { userId: "user-current" },
        status: "active",
      };

      const snapshot = yield* StripeAdapter.parseSubscriptionSnapshot(current, offer);
      const rejected = yield* StripeAdapter.parseSubscriptionSnapshot(
        {
          ...current,
          items: {
            data: [
              {
                ...current.items.data[0],
                price: { id: "price_unapproved", product: "prod_adventurer" },
              },
            ],
          },
        },
        offer,
      ).pipe(Effect.exit);

      expect(snapshot).toMatchObject({
        payment: { _tag: "Paid", invoiceId: "in_current" },
        priceId: "price_adventurer",
        productId: "prod_adventurer",
        status: "active",
        subscriptionId: "sub_current",
        userId: "user-current",
      });
      expect(rejected._tag).toBe("Failure");
    }),
  );

  it.effect("does not revoke access for a partial refund", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      installRefundResponses(client, {
        amount: 2_000,
        amountRefunded: 500,
        invoiceId: "in_current",
      });

      const result = yield* makeAdapter(client).fetchCurrentSnapshot({
        billingCheckoutSessionId: null,
        externalEventId: "evt_partial_refund",
        externalObjectId: "ch_partial_refund",
        type: "charge.refunded",
      });

      expect(result).toEqual({ _tag: "NoOp" });
    }),
  );

  it.effect("does not revoke access when a historical invoice is fully refunded", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      installRefundResponses(client, {
        amount: 2_000,
        amountRefunded: 2_000,
        invoiceId: "in_historical",
      });
      Object.defineProperty(client.subscriptions, "retrieve", {
        value: () => Promise.resolve(currentSubscription("in_current")),
      });
      Object.defineProperty(client.invoicePayments, "list", {
        value: (request: Stripe.InvoicePaymentListParams) =>
          Promise.resolve(
            "invoice" in request
              ? {
                  data: [
                    {
                      amount_paid: 2_000,
                      payment: { charge: "ch_current", type: "charge" },
                      status: "paid",
                    },
                  ],
                }
              : { data: [{ invoice: "in_historical" }] },
          ),
      });
      Object.defineProperty(client.charges, "retrieve", {
        value: (chargeId: string) =>
          Promise.resolve(
            chargeId === "ch_current"
              ? { amount: 2_000, amount_refunded: 0 }
              : { amount: 2_000, amount_refunded: 2_000, payment_intent: "pi_refunded" },
          ),
      });
      Object.defineProperty(client.disputes, "list", {
        value: () => Promise.resolve({ data: [] }),
      });

      const result = yield* makeAdapter(client).fetchCurrentSnapshot({
        billingCheckoutSessionId: null,
        externalEventId: "evt_historical_refund",
        externalObjectId: "ch_historical_refund",
        type: "charge.refunded",
      });

      expect(result).toMatchObject({
        _tag: "Snapshot",
        snapshot: {
          currentPeriodRefunded: false,
          payment: { _tag: "Paid", invoiceId: "in_current" },
        },
      });
    }),
  );

  it.effect("revokes access when the current paid invoice is fully refunded", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      installRefundResponses(client, {
        amount: 2_000,
        amountRefunded: 2_000,
        invoiceId: "in_current",
      });
      Object.defineProperty(client.subscriptions, "retrieve", {
        value: () => Promise.resolve(currentSubscription("in_current")),
      });

      const result = yield* makeAdapter(client).fetchCurrentSnapshot({
        billingCheckoutSessionId: null,
        externalEventId: "evt_current_refund",
        externalObjectId: "ch_current_refund",
        type: "charge.refunded",
      });

      expect(result).toMatchObject({
        _tag: "Snapshot",
        snapshot: { currentPeriodRefunded: true, payment: { _tag: "NotPaid" } },
      });
    }),
  );

  it.effect("discovers a missed full refund during explicit reconciliation", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      Object.defineProperty(client.subscriptions, "retrieve", {
        value: () => Promise.resolve(currentSubscription("in_current")),
      });
      Object.defineProperty(client.invoicePayments, "list", {
        value: () =>
          Promise.resolve({
            data: [
              {
                amount_paid: 2_500,
                invoice: "in_current",
                payment: { payment_intent: "pi_current", type: "payment_intent" },
                status: "paid",
              },
            ],
          }),
      });
      Object.defineProperty(client.paymentIntents, "retrieve", {
        value: () => Promise.resolve({ latest_charge: "ch_current" }),
      });
      Object.defineProperty(client.charges, "retrieve", {
        value: () => Promise.resolve({ amount: 2_500, amount_refunded: 2_500 }),
      });

      const snapshot = yield* makeAdapter(client).fetchSubscription(
        StripeSubscriptionId.make("sub_current"),
      );

      expect(snapshot).toMatchObject({
        currentPeriodRefunded: true,
        payment: { _tag: "NotPaid" },
      });
    }),
  );

  it.effect("discovers an open current-period dispute during explicit reconciliation", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      Object.defineProperty(client.subscriptions, "retrieve", {
        value: () => Promise.resolve(currentSubscription("in_current")),
      });
      Object.defineProperty(client.invoicePayments, "list", {
        value: () =>
          Promise.resolve({
            data: [
              {
                amount_paid: 2_500,
                payment: { charge: "ch_current", type: "charge" },
                status: "paid",
              },
            ],
          }),
      });
      Object.defineProperty(client.charges, "retrieve", {
        value: () => Promise.resolve({ amount: 2_500, amount_refunded: 0 }),
      });
      Object.defineProperty(client.disputes, "list", {
        value: () => Promise.resolve({ data: [{ status: "under_review" }] }),
      });

      const snapshot = yield* makeAdapter(client).fetchSubscription(
        StripeSubscriptionId.make("sub_current"),
      );

      expect(snapshot).toMatchObject({
        currentPeriodRefunded: true,
        payment: { _tag: "NotPaid" },
      });
    }),
  );

  it.effect("keeps access reversed when a later Subscription event arrives during a dispute", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      Object.defineProperty(client.subscriptions, "retrieve", {
        value: () => Promise.resolve(currentSubscription("in_current")),
      });
      Object.defineProperty(client.invoicePayments, "list", {
        value: () =>
          Promise.resolve({
            data: [
              {
                amount_paid: 2_500,
                payment: { charge: "ch_current", type: "charge" },
                status: "paid",
              },
            ],
          }),
      });
      Object.defineProperty(client.charges, "retrieve", {
        value: () => Promise.resolve({ amount: 2_500, amount_refunded: 0 }),
      });
      Object.defineProperty(client.disputes, "list", {
        value: () => Promise.resolve({ data: [{ status: "needs_response" }] }),
      });

      const result = yield* makeAdapter(client).fetchCurrentSnapshot({
        billingCheckoutSessionId: null,
        externalEventId: "evt_subscription_during_dispute",
        externalObjectId: "sub_current",
        type: "customer.subscription.updated",
      });

      expect(result).toMatchObject({
        _tag: "Snapshot",
        snapshot: { currentPeriodRefunded: true, payment: { _tag: "NotPaid" } },
      });
    }),
  );

  it.effect("keeps a current dispute reversed after a later historical refund event", () =>
    Effect.gen(function* () {
      const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
      Object.defineProperty(client.subscriptions, "retrieve", {
        value: () => Promise.resolve(currentSubscription("in_current")),
      });
      Object.defineProperty(client.invoicePayments, "list", {
        value: (request: Stripe.InvoicePaymentListParams) =>
          Promise.resolve(
            "invoice" in request
              ? {
                  data: [
                    {
                      amount_paid: 2_500,
                      payment: { charge: "ch_current", type: "charge" },
                      status: "paid",
                    },
                  ],
                }
              : { data: [{ invoice: "in_historical" }] },
          ),
      });
      Object.defineProperty(client.invoices, "retrieve", {
        value: () =>
          Promise.resolve({ parent: { subscription_details: { subscription: "sub_current" } } }),
      });
      Object.defineProperty(client.charges, "retrieve", {
        value: (chargeId: string) =>
          Promise.resolve(
            chargeId === "ch_current"
              ? { amount: 2_500, amount_refunded: 0 }
              : { amount: 2_500, amount_refunded: 2_500, payment_intent: "pi_historical" },
          ),
      });
      Object.defineProperty(client.disputes, "list", {
        value: () => Promise.resolve({ data: [{ status: "needs_response" }] }),
      });

      const result = yield* makeAdapter(client).fetchCurrentSnapshot({
        billingCheckoutSessionId: null,
        externalEventId: "evt_historical_with_current_dispute",
        externalObjectId: "ch_historical",
        type: "charge.refunded",
      });

      expect(result).toMatchObject({
        _tag: "Snapshot",
        snapshot: { currentPeriodRefunded: true, payment: { _tag: "NotPaid" } },
      });
    }),
  );

  for (const testCase of [
    { eventType: "charge.dispute.created", expectedReversed: true, status: "needs_response" },
    {
      eventType: "charge.dispute.funds_withdrawn",
      expectedReversed: true,
      status: "under_review",
    },
    { eventType: "charge.dispute.closed", expectedReversed: true, status: "lost" },
    {
      eventType: "charge.dispute.funds_reinstated",
      expectedReversed: false,
      status: "won",
    },
  ] as const) {
    it.effect(`maps ${testCase.eventType} from authoritative dispute state`, () =>
      Effect.gen(function* () {
        const client = new Stripe("sk_test_adapter", { apiVersion: "2026-07-29.dahlia" });
        Object.defineProperty(client.disputes, "retrieve", {
          value: () => Promise.resolve({ charge: "ch_disputed", status: testCase.status }),
        });
        Object.defineProperty(client.charges, "retrieve", {
          value: (chargeId: string) =>
            Promise.resolve(
              chargeId === "ch_current"
                ? { amount: 2_500, amount_refunded: 0 }
                : { payment_intent: "pi_disputed" },
            ),
        });
        Object.defineProperty(client.invoicePayments, "list", {
          value: (request: Stripe.InvoicePaymentListParams) =>
            Promise.resolve(
              "invoice" in request
                ? {
                    data: [
                      {
                        amount_paid: 2_500,
                        payment: { charge: "ch_current", type: "charge" },
                        status: "paid",
                      },
                    ],
                  }
                : { data: [{ invoice: "in_current" }] },
            ),
        });
        Object.defineProperty(client.disputes, "list", {
          value: () => Promise.resolve({ data: [{ status: testCase.status }] }),
        });
        Object.defineProperty(client.invoices, "retrieve", {
          value: () =>
            Promise.resolve({ parent: { subscription_details: { subscription: "sub_current" } } }),
        });
        Object.defineProperty(client.subscriptions, "retrieve", {
          value: () => Promise.resolve(currentSubscription("in_current")),
        });

        const result = yield* makeAdapter(client).fetchCurrentSnapshot({
          billingCheckoutSessionId: null,
          externalEventId: `evt_${testCase.status}`,
          externalObjectId: `dp_${testCase.status}`,
          type: testCase.eventType,
        });

        expect(result).toMatchObject({
          _tag: "Snapshot",
          snapshot: {
            currentPeriodRefunded: testCase.expectedReversed,
            payment: { _tag: testCase.expectedReversed ? "NotPaid" : "Paid" },
          },
        });
      }),
    );
  }
});
