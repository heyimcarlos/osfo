import { Effect } from "effect";

import type { StripeCheckoutSessionId, StripeSubscriptionId, UserId } from "../domain";
import type {
  ApplyStripeSnapshotResult,
  ReconciliationSubject,
  StripeStateUnavailable,
  StripeSubscriptionSnapshot,
} from "./billing-subscriptions";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

/** Input from one authenticated billing return request. */
export interface BillingReturnInput {
  readonly reason: "checkoutReturn" | "portalReturn";
  readonly userId: UserId;
}

/** Observable API result for one explicit billing return reconciliation. */
export interface BillingReturnResult {
  readonly result: "accessEnded" | "activated" | "downgradeScheduled" | "unchanged";
}

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
    ) => Effect.Effect<StripeCheckoutSessionId | null, LookupError>;
    readonly findStoredSubscription: (
      userId: UserId,
    ) => Effect.Effect<StripeSubscriptionId | null, LookupError>;
    readonly reconcile: (
      subject: ReconciliationSubject,
      reason: BillingReturnInput["reason"],
      retrieveCurrentSnapshot: (
        subject: ReconciliationSubject,
      ) => Effect.Effect<StripeSubscriptionSnapshot, StripeStateUnavailable>,
    ) => Effect.Effect<ApplyStripeSnapshotResult, ReconciliationError>;
    readonly retrieveCheckout: (
      checkoutId: StripeCheckoutSessionId,
    ) => Effect.Effect<
      { readonly stripeSubscriptionId: StripeSubscriptionId | null },
      CheckoutError
    >;
  },
): Effect.Effect<
  BillingReturnResult,
  AuthorizeError | LookupError | CheckoutError | ReconciliationError
> =>
  Effect.gen(function* () {
    yield* dependencies.authorize;
    const storedSubscriptionId = yield* dependencies.findStoredSubscription(input.userId);
    const subscriptionId =
      storedSubscriptionId === null
        ? yield* findCheckoutSubscription(input.userId, dependencies)
        : storedSubscriptionId;
    if (subscriptionId === null) return { result: "unchanged" as const };
    const result = yield* dependencies.reconcile(
      { _tag: "User", userId: input.userId },
      input.reason,
      () => dependencies.fetchSubscription(subscriptionId),
    );
    return { result: toReconciliationResult(result) };
  });

const findCheckoutSubscription = <LookupError, CheckoutError>(
  userId: UserId,
  dependencies: {
    readonly findCheckoutSession: (
      userId: UserId,
    ) => Effect.Effect<StripeCheckoutSessionId | null, LookupError>;
    readonly retrieveCheckout: (
      checkoutId: StripeCheckoutSessionId,
    ) => Effect.Effect<
      { readonly stripeSubscriptionId: StripeSubscriptionId | null },
      CheckoutError
    >;
  },
) =>
  Effect.gen(function* () {
    const checkoutId = yield* dependencies.findCheckoutSession(userId);
    if (checkoutId === null) return null;
    const checkout = yield* dependencies.retrieveCheckout(checkoutId);
    return checkout.stripeSubscriptionId;
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
