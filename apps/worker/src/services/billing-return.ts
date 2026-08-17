import { Effect, Schema } from "effect";

import type {
  BillingCheckoutSessionId,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../domain";
import type {
  ApplyStripeSnapshotResult,
  ReconciliationSubject,
  StripeStateUnavailable,
  StripeSubscriptionSnapshot,
} from "./billing-subscriptions";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Input from one authenticated billing return request. */
export type BillingReturnInput =
  | {
      readonly reason: "checkoutReturn";
      readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
      readonly userId: UserId;
    }
  | { readonly reason: "portalReturn"; readonly userId: UserId };

/** Observable API result for one explicit billing return reconciliation. */
export interface BillingReturnResult {
  readonly result: "accessEnded" | "activated" | "downgradeScheduled" | "unchanged";
}

/** Stored identity contract for the Checkout attempt selected by an authenticated return. */
export interface BillingReturnCheckout {
  readonly billingCheckoutSessionId: BillingCheckoutSessionId;
  readonly customerId: StripeCustomerId;
  readonly priceId: StripePriceId;
  readonly productId: StripeProductId;
  readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
  readonly userId: UserId;
}

/** Verified Checkout identity conflicts that must not reach Subscription projection. */
export class BillingReturnConflict extends Schema.TaggedError<BillingReturnConflict>()(
  "BillingReturnConflict",
  { message: Schema.String },
) {}

/** Reconcile an authenticated billing return after central Authorization admits it. */
export const reconcileBillingReturn = <
  AuthorizeError,
  LookupError,
  CheckoutError,
  ReconciliationError,
>(
  input: BillingReturnInput,
  dependencies: {
    readonly authorize: Effect.Effect<void, AuthorizeError>;
    readonly fetchSubscription: (
      subscriptionId: StripeSubscriptionId,
    ) => Effect.Effect<StripeSubscriptionSnapshot, StripeStateUnavailable>;
    readonly findCheckoutSession: (
      userId: UserId,
      stripeCheckoutSessionId: StripeCheckoutSessionId,
    ) => Effect.Effect<BillingReturnCheckout | null, LookupError>;
    readonly findStoredSubscription: (
      userId: UserId,
    ) => Effect.Effect<StripeSubscriptionId | null, LookupError>;
    readonly reconcile: (
      subject: ReconciliationSubject,
      reason: BillingReturnInput["reason"],
      retrieveCurrentSnapshot: (
        subject: ReconciliationSubject,
      ) => Effect.Effect<StripeSubscriptionSnapshot, StripeStateUnavailable>,
      checkoutEvidence?: {
        readonly _tag: "Completed";
        readonly locator: {
          readonly _tag: "LocalAttempt";
          readonly billingCheckoutSessionId: BillingCheckoutSessionId;
          readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
        };
        readonly paymentStatus: "unknown";
      },
    ) => Effect.Effect<ApplyStripeSnapshotResult, ReconciliationError>;
    readonly retrieveCheckout: (checkoutId: StripeCheckoutSessionId) => Effect.Effect<
      {
        readonly billingCheckoutSessionId: BillingCheckoutSessionId;
        readonly customerId: StripeCustomerId;
        readonly priceId: StripePriceId;
        readonly productId: StripeProductId;
        readonly state: "complete" | "creating" | "expired" | "failed" | "open";
        readonly stripeSubscriptionId: StripeSubscriptionId | null;
        readonly userId: UserId;
      },
      CheckoutError
    >;
  },
): Effect.Effect<
  BillingReturnResult,
  AuthorizeError | LookupError | CheckoutError | ReconciliationError | BillingReturnConflict
> =>
  Effect.gen(function* () {
    yield* dependencies.authorize;
    const checkout =
      input.reason === "checkoutReturn"
        ? yield* findCheckoutSubscription(input.userId, input.stripeCheckoutSessionId, dependencies)
        : null;
    const subscriptionId =
      checkout === null
        ? yield* dependencies.findStoredSubscription(input.userId)
        : checkout.subscriptionId;
    if (subscriptionId === null) return { result: "unchanged" as const };
    const result = yield* dependencies.reconcile(
      { _tag: "User", userId: input.userId },
      input.reason,
      () => dependencies.fetchSubscription(subscriptionId),
      checkout === null
        ? undefined
        : {
            _tag: "Completed",
            locator: {
              _tag: "LocalAttempt",
              billingCheckoutSessionId: checkout.attempt.billingCheckoutSessionId,
              stripeCheckoutSessionId: checkout.attempt.stripeCheckoutSessionId,
            },
            paymentStatus: "unknown",
          },
    );
    return { result: toReconciliationResult(result) };
  });

const findCheckoutSubscription = <LookupError, CheckoutError>(
  userId: UserId,
  stripeCheckoutSessionId: StripeCheckoutSessionId,
  dependencies: {
    readonly findCheckoutSession: (
      userId: UserId,
      stripeCheckoutSessionId: StripeCheckoutSessionId,
    ) => Effect.Effect<BillingReturnCheckout | null, LookupError>;
    readonly retrieveCheckout: (checkoutId: StripeCheckoutSessionId) => Effect.Effect<
      {
        readonly billingCheckoutSessionId: BillingCheckoutSessionId;
        readonly customerId: StripeCustomerId;
        readonly priceId: StripePriceId;
        readonly productId: StripeProductId;
        readonly state: "complete" | "creating" | "expired" | "failed" | "open";
        readonly stripeSubscriptionId: StripeSubscriptionId | null;
        readonly userId: UserId;
      },
      CheckoutError
    >;
  },
) =>
  Effect.gen(function* () {
    const attempt = yield* dependencies.findCheckoutSession(userId, stripeCheckoutSessionId);
    if (attempt === null) {
      return yield* new BillingReturnConflict({
        message: "The returned Stripe Checkout Session has no exact local attempt",
      });
    }
    const checkout = yield* dependencies.retrieveCheckout(attempt.stripeCheckoutSessionId);
    if (
      checkout.billingCheckoutSessionId !== attempt.billingCheckoutSessionId ||
      checkout.userId !== attempt.userId ||
      checkout.customerId !== attempt.customerId ||
      checkout.productId !== attempt.productId ||
      checkout.priceId !== attempt.priceId ||
      checkout.state !== "complete" ||
      checkout.stripeSubscriptionId === null
    ) {
      return yield* new BillingReturnConflict({
        message: "The returned Stripe Checkout Session conflicts with its local attempt",
      });
    }
    return { attempt, subscriptionId: checkout.stripeSubscriptionId };
  });

const toReconciliationResult = (result: ApplyStripeSnapshotResult) => {
  switch (result._tag) {
    case "Activated":
      return "activated" as const;
    case "DowngradeScheduled":
      return "downgradeScheduled" as const;
    case "AccessEnded":
      return "accessEnded" as const;
    default:
      return "unchanged" as const;
  }
};
