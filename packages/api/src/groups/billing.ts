import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Safe current Plan and billing-period presentation. */
export const BillingSummary = Schema.Struct({
  currentPlan: Schema.Literals(["free", "adventurer"]),
  paymentState: Schema.Literals(["free", "paid", "paymentNeeded", "changeScheduled"]),
  pendingPlan: Schema.NullOr(
    Schema.Struct({
      effectiveAt: Schema.DateFromString,
      plan: Schema.Literals(["free", "adventurer"]),
    }),
  ),
  period: Schema.NullOr(
    Schema.Struct({ endsAt: Schema.DateFromString, startsAt: Schema.DateFromString }),
  ),
  usage: Schema.NullOr(
    Schema.Struct({
      label: Schema.String,
      remainingPercentage: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
      resetAt: Schema.DateFromString,
      warning: Schema.NullOr(Schema.Literals(["low", "exhausted"])),
    }),
  ),
});

/** Safe current Plan and billing-period presentation. */
export type BillingSummary = typeof BillingSummary.Type;

/** Safe hosted Stripe destination. */
export const BillingRedirect = Schema.Struct({ url: Schema.URLFromString });

/** Safe hosted Stripe destination. */
export type BillingRedirect = typeof BillingRedirect.Type;

/** Safe result after current Stripe state is reconciled. */
export const BillingReconciliation = Schema.Struct({
  result: Schema.Literals(["unchanged", "activated", "downgradeScheduled", "accessEnded"]),
});

/** Safe result after current Stripe state is reconciled. */
export type BillingReconciliation = typeof BillingReconciliation.Type;

/** Authenticated evidence selecting one exact hosted billing return. */
export const BillingReconciliationRequest = Schema.Union([
  Schema.Struct({
    reason: Schema.Literal("checkoutReturn"),
    stripeCheckoutSessionId: Schema.String,
  }),
  Schema.Struct({ reason: Schema.Literal("portalReturn") }),
]);

/** Authenticated evidence selecting one exact hosted billing return. */
export type BillingReconciliationRequest = typeof BillingReconciliationRequest.Type;

/** Safe response when billing or Stripe is unavailable. */
export class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
  "BillingUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Safe response when current Authorization denies a billing operation. */
export class BillingForbidden extends Schema.TaggedError<BillingForbidden>()(
  "BillingForbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Authenticated billing inspection, Checkout, Portal, and reconciliation contract. */
export const BillingGroup = HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.get("inspect", "/v1/billing", {
      error: [BillingForbidden, BillingUnavailable],
      success: BillingSummary,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Show the User's current Plan and safe billing state.",
          identifier: "billing.inspect",
          summary: "Inspect billing",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("checkout", "/v1/billing/checkout", {
      error: [BillingForbidden, BillingUnavailable],
      payload: Schema.Struct({}),
      success: BillingRedirect,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Start or recover Stripe-hosted Adventurer Checkout.",
          identifier: "billing.checkout",
          summary: "Start Checkout",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("portal", "/v1/billing/portal", {
      error: [BillingForbidden, BillingUnavailable],
      payload: Schema.Struct({}),
      success: BillingRedirect,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Open Stripe Customer Portal for billing details and cancellation.",
          identifier: "billing.portal",
          summary: "Open Customer Portal",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("reconcile", "/v1/billing/reconcile", {
      error: [BillingForbidden, BillingUnavailable],
      payload: BillingReconciliationRequest,
      success: BillingReconciliation,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Fetch current Stripe state after a hosted billing return.",
          identifier: "billing.reconcile",
          summary: "Reconcile billing",
        }),
      ),
  );
