import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  BillingCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../src/domain";
import * as BillingSubscriptions from "../src/services/billing-subscriptions";
import { StripeRequestFailed } from "../src/services/stripe-billing";
import * as StripeWebhooks from "../src/services/stripe-webhooks";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/global-date, effecttsgo/global-date-in-effect -- These tests assert typed Effect results with fixed boundary dates. */

const supportedTypes = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
] as const;

describe("StripeWebhooks", () => {
  it.effect("verifies exact bytes before persistence and rejects a mutated signature", () =>
    Effect.gen(function* () {
      let receives = 0;
      const service = StripeWebhooks.make({
        billing: {
          loadRevision: () => Effect.die("unused"),
          applyStripeSnapshot: () => Effect.die("unused"),
        },
        persistence: {
          fail: () => Effect.void,
          markProcessed: () => Effect.void,
          receive: () => {
            receives += 1;
            return Effect.die("must not persist");
          },
          replay: () => Effect.die("unused"),
        },
        stripe: {
          fetchCurrentSnapshot: () => Effect.die("unused"),
          verify: (rawBody, signature) =>
            rawBody === "exact-body" && signature === "valid-signature"
              ? Effect.succeed({
                  billingCheckoutSessionId: null,
                  externalEventId: "evt_exact",
                  externalObjectId: "in_exact",
                  type: "invoice.paid",
                })
              : Effect.fail(
                  new StripeWebhooks.InvalidStripeSignature({ message: "Invalid signature" }),
                ),
        },
      });

      const result = yield* service.handle("exact-body ", "valid-signature").pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(receives).toBe(0);
    }),
  );

  it.effect("deduplicates a processed Stripe redelivery", () =>
    Effect.gen(function* () {
      let fetches = 0;
      const service = StripeWebhooks.make({
        billing: {
          loadRevision: () => Effect.die("unused"),
          applyStripeSnapshot: () => Effect.die("unused"),
        },
        persistence: {
          fail: () => Effect.void,
          markProcessed: () => Effect.void,
          receive: () => Effect.succeed({ _tag: "ProcessedDuplicate" }),
          replay: () => Effect.die("unused"),
        },
        stripe: {
          fetchCurrentSnapshot: () => {
            fetches += 1;
            return Effect.die("must not fetch");
          },
          verify: () =>
            Effect.succeed({
              billingCheckoutSessionId: null,
              externalEventId: "evt_duplicate",
              externalObjectId: "sub_duplicate",
              type: "customer.subscription.updated",
            }),
        },
      });

      const result = yield* service.handle("body", "signature");

      expect(result).toEqual({ _tag: "ProcessedDuplicate" });
      expect(fetches).toBe(0);
    }),
  );

  for (const type of supportedTypes) {
    it.effect(`retrieves current Stripe state for ${type}`, () =>
      Effect.gen(function* () {
        const observations: Array<string> = [];
        const service = StripeWebhooks.make({
          billing: {
            loadRevision: () => Effect.succeed(new Date("2026-08-16T00:00:00.000Z")),
            applyStripeSnapshot: (_source, _expectedUpdatedAt, snapshot, checkoutEvidence) => {
              observations.push(`apply:${snapshot.userId}`);
              observations.push(`evidence:${checkoutEvidence?._tag ?? "none"}`);
              return Effect.succeed({ _tag: "Unchanged" });
            },
          },
          persistence: {
            fail: () => Effect.void,
            markProcessed: () => Effect.void,
            receive: () => Effect.succeed({ _tag: "Pending", webhookEventId: `webhook-${type}` }),
            replay: () => Effect.die("unused"),
          },
          stripe: {
            fetchCurrentSnapshot: (event) => {
              observations.push(`fetch:${event.externalObjectId}`);
              return Effect.succeed({
                _tag: "Snapshot" as const,
                snapshot: BillingSubscriptions.StripeSubscriptionSnapshot.make({
                  cancelAtPeriodEnd: false,
                  customerId: StripeCustomerId.make("cus_current"),
                  currentPeriodRefunded: false,
                  payment: { _tag: "Unknown" },
                  period: null,
                  priceId: StripePriceId.make("price_current"),
                  productId: StripeProductId.make("prod_current"),
                  status: "incomplete",
                  subscriptionId: StripeSubscriptionId.make("sub_current"),
                  userId: UserId.make("user-current"),
                }),
              });
            },
            verify: () =>
              Effect.succeed({
                billingCheckoutSessionId: type.startsWith("checkout.session.")
                  ? BillingCheckoutSessionId.make("checkout-supported")
                  : null,
                externalEventId: `evt_${type}`,
                externalObjectId: type.startsWith("checkout.session.")
                  ? "cs_test_supported"
                  : "embedded-object-id-only",
                type,
              }),
          },
        });

        const result = yield* service.handle("body", "signature");

        expect(result).toEqual({ _tag: "Processed" });
        expect(observations).toEqual([
          type.startsWith("checkout.session.")
            ? "fetch:cs_test_supported"
            : "fetch:embedded-object-id-only",
          type.startsWith("checkout.session.")
            ? "fetch:cs_test_supported"
            : "fetch:embedded-object-id-only",
          "apply:user-current",
          type.startsWith("checkout.session.")
            ? type === "checkout.session.async_payment_failed"
              ? "evidence:PaymentFailed"
              : "evidence:Completed"
            : "evidence:none",
        ]);
      }),
    );
  }

  it.effect("marks checkout.session.expired processed without changing Checkout state", () =>
    Effect.gen(function* () {
      let processed = 0;
      let evidence: BillingSubscriptions.StripeCheckoutEvidence | null = null;
      const service = StripeWebhooks.make({
        billing: {
          loadRevision: () => Effect.die("unused"),
          applyStripeSnapshot: () => Effect.die("unused"),
        },
        persistence: {
          fail: () => Effect.void,
          markProcessed: (_webhookEventId, checkoutEvidence) => {
            processed += 1;
            evidence = checkoutEvidence;
            return Effect.void;
          },
          receive: () => Effect.succeed({ _tag: "Pending", webhookEventId: "webhook-unsupported" }),
          replay: () => Effect.die("unused"),
        },
        stripe: {
          fetchCurrentSnapshot: () => Effect.die("must not fetch"),
          verify: () =>
            Effect.succeed({
              billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-expired"),
              externalEventId: "evt_unsupported",
              externalObjectId: "cs_test_expired",
              type: "checkout.session.expired",
            }),
        },
      });

      const result = yield* service.handle("body", "signature");

      expect(result).toEqual({ _tag: "Processed" });
      expect(processed).toBe(1);
      expect(evidence).toBeNull();
    }),
  );

  it.effect("replays one dispute projection and treats its processed replay as idempotent", () =>
    Effect.gen(function* () {
      const observations: Array<string> = [];
      let replayCalls = 0;
      const snapshot = BillingSubscriptions.StripeSubscriptionSnapshot.make({
        cancelAtPeriodEnd: false,
        customerId: StripeCustomerId.make("cus_disputereplay"),
        currentPeriodRefunded: true,
        payment: { _tag: "NotPaid" },
        period: {
          endsAt: new Date("2026-09-16T00:00:00.000Z"),
          startsAt: new Date("2026-08-16T00:00:00.000Z"),
        },
        priceId: StripePriceId.make("price_adventurer"),
        productId: StripeProductId.make("prod_adventurer"),
        status: "active",
        subscriptionId: StripeSubscriptionId.make("sub_disputereplay"),
        userId: UserId.make("user-dispute-replay"),
      });
      const service = StripeWebhooks.make({
        billing: {
          loadRevision: () => Effect.succeed(new Date("2026-08-16T00:00:00.000Z")),
          applyStripeSnapshot: () => {
            observations.push("apply:dispute");
            return Effect.succeed({ _tag: "AccessEnded" });
          },
        },
        persistence: {
          fail: () => Effect.void,
          markProcessed: () => Effect.die("must project a supported dispute"),
          receive: () => Effect.die("unused"),
          replay: () => {
            replayCalls += 1;
            return replayCalls === 1
              ? Effect.succeed({
                  _tag: "Pending" as const,
                  event: {
                    billingCheckoutSessionId: null,
                    externalEventId: "evt_dispute_replay",
                    externalObjectId: "dp_dispute_replay",
                    provider: "stripe",
                    type: "charge.dispute.funds_withdrawn",
                  },
                  webhookEventId: "webhook-dispute-replay",
                })
              : Effect.succeed({ _tag: "ProcessedDuplicate" as const });
          },
        },
        stripe: {
          fetchCurrentSnapshot: (event) => {
            observations.push(`fetch:${event.externalObjectId}`);
            return Effect.succeed({ _tag: "Snapshot", snapshot });
          },
          verify: () => Effect.die("unused"),
        },
      });

      const result = yield* service.replay("webhook-dispute-replay");
      const duplicate = yield* service.replay("webhook-dispute-replay");

      expect(result).toEqual({ _tag: "Processed" });
      expect(duplicate).toEqual({ _tag: "ProcessedDuplicate" });
      expect(observations).toEqual([
        "fetch:dp_dispute_replay",
        "fetch:dp_dispute_replay",
        "apply:dispute",
      ]);
    }),
  );

  it.effect(
    "acknowledges a signed unsupported event after retaining permanent failure evidence",
    () =>
      Effect.gen(function* () {
        let failedCode: string | null = null;
        let processed = 0;
        const service = StripeWebhooks.make({
          billing: {
            applyStripeSnapshot: () => Effect.die("must not project an unsupported dispute"),
            loadRevision: () => Effect.die("must not load an unsupported dispute"),
          },
          persistence: {
            fail: (_webhookEventId, errorCode) => {
              failedCode = errorCode;
              return Effect.void;
            },
            markProcessed: () => {
              processed += 1;
              return Effect.void;
            },
            receive: () =>
              Effect.succeed({ _tag: "Pending", webhookEventId: "webhook-unsupported" }),
            replay: () => Effect.die("unused"),
          },
          stripe: {
            fetchCurrentSnapshot: () => Effect.die("must not fetch an unsupported dispute"),
            verify: () =>
              Effect.succeed({
                billingCheckoutSessionId: null,
                externalEventId: "evt_unsupported_dispute",
                externalObjectId: "dp_unsupported",
                type: "charge.dispute.updated",
              }),
          },
        });

        expect(yield* service.handle("body", "signature")).toEqual({
          _tag: "Processed",
        });
        expect(failedCode).toBeNull();
        expect(processed).toBe(1);
      }),
  );

  for (const testCase of [
    { acknowledged: true, kind: "permanent" as const },
    { acknowledged: false, kind: "transient" as const },
  ]) {
    it.effect(`${testCase.kind} Stripe retrieval failures use the required acknowledgement`, () =>
      Effect.gen(function* () {
        let failed = 0;
        let failedEvidence: BillingSubscriptions.StripeCheckoutEvidence | null = null;
        const service = StripeWebhooks.make({
          billing: {
            applyStripeSnapshot: () => Effect.die("unused"),
            loadRevision: () => Effect.die("unused"),
          },
          persistence: {
            fail: (_webhookEventId, _errorCode, checkoutEvidence) => {
              failed += 1;
              failedEvidence = checkoutEvidence;
              return Effect.void;
            },
            markProcessed: () => Effect.die("unused"),
            receive: () => Effect.succeed({ _tag: "Pending", webhookEventId: "webhook-failure" }),
            replay: () => Effect.die("unused"),
          },
          stripe: {
            fetchCurrentSnapshot: () =>
              Effect.fail(
                new StripeRequestFailed({
                  kind: testCase.kind,
                  message: "Stripe retrieval failed",
                  operation: "retrieveSubscription",
                }),
              ),
            verify: () =>
              Effect.succeed({
                billingCheckoutSessionId: BillingCheckoutSessionId.make("checkout-failure"),
                externalEventId: "evt_failure",
                externalObjectId: "cs_test_failure",
                type: "checkout.session.completed",
              }),
          },
        });

        const exit = yield* service.handle("body", "signature").pipe(Effect.exit);

        expect(failed).toBe(testCase.acknowledged ? 1 : 0);
        if (testCase.acknowledged) {
          expect(failedEvidence).toMatchObject({
            _tag: "Completed",
            locator: {
              _tag: "LocalAttempt",
              billingCheckoutSessionId: "checkout-failure",
              stripeCheckoutSessionId: "cs_test_failure",
            },
          });
        }
        expect(exit._tag).toBe(testCase.acknowledged ? "Success" : "Failure");
      }),
    );
  }
});
