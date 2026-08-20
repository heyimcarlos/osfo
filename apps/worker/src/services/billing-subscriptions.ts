import { DateTime, Effect, Schema } from "effect";

/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the standard _tag discriminator. */

import type {
  AllowancePeriodId,
  BillingCheckoutSessionId,
  StripeCheckoutSessionId,
} from "../domain";
import {
  StripeCustomerId,
  StripeInvoiceId,
  StripePriceId,
  StripeProductId,
  StripeSubscriptionId,
  UserId,
} from "../domain";
import type { BillingTransactionRetryExhausted, DatabaseUnavailable } from "../domain/allowance";

/** Stripe payment evidence used by Osfo's paid Plan transition. */
export const StripePaymentState = Schema.Union([
  Schema.TaggedStruct("Paid", { invoiceId: StripeInvoiceId }),
  Schema.TaggedStruct("NotPaid", {}),
  Schema.TaggedStruct("Unknown", {}),
]);

/** Stripe payment evidence used by Osfo's paid Plan transition. */
export type StripePaymentState = typeof StripePaymentState.Type;

/** Current normalized Stripe subscription facts accepted by the billing projection. */
export const StripeSubscriptionSnapshot = Schema.Struct({
  cancelAtPeriodEnd: Schema.Boolean,
  customerId: StripeCustomerId,
  currentPeriodRefunded: Schema.Boolean,
  payment: StripePaymentState,
  period: Schema.NullOr(
    Schema.Struct({
      endsAt: Schema.Date,
      startsAt: Schema.Date,
    }),
  ),
  priceId: StripePriceId,
  productId: StripeProductId,
  status: Schema.Literals([
    "active",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "past_due",
    "paused",
    "trialing",
    "unpaid",
  ]),
  subscriptionId: StripeSubscriptionId,
  userId: UserId,
});

/** Current normalized Stripe subscription facts accepted by the billing projection. */
export type StripeSubscriptionSnapshot = typeof StripeSubscriptionSnapshot.Type;

/** Authority source for one Stripe projection transition. */
export const StripeSnapshotSource = Schema.Union([
  Schema.TaggedStruct("Webhook", { attempt: Schema.Int, webhookEventId: Schema.String }),
  Schema.TaggedStruct("Reconciliation", {
    reason: Schema.Literals(["checkoutReturn", "internal", "portalReturn"]),
  }),
]);

/** Authority source for one Stripe projection transition. */
export type StripeSnapshotSource = typeof StripeSnapshotSource.Type;

/** Verified local or provider locator for one Stripe Checkout Session. */
export type StripeCheckoutLocator =
  | {
      readonly _tag: "LocalAttempt";
      readonly billingCheckoutSessionId: BillingCheckoutSessionId;
      readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
    }
  | {
      readonly _tag: "StripeSession";
      readonly stripeCheckoutSessionId: StripeCheckoutSessionId;
    };

/** Verified Checkout evidence selected by the Stripe webhook application service. */
export type StripeCheckoutEvidence =
  | {
      readonly _tag: "Completed";
      readonly locator: StripeCheckoutLocator;
      readonly paymentStatus: "paid" | "unknown";
    }
  | {
      readonly _tag: "PaymentFailed";
      readonly locator: StripeCheckoutLocator;
    };

/** Observable result of applying current Stripe state. */
export const ApplyStripeSnapshotResult = Schema.Union([
  Schema.TaggedStruct("Unchanged", {}),
  Schema.TaggedStruct("Activated", {}),
  Schema.TaggedStruct("DowngradeScheduled", {}),
  Schema.TaggedStruct("AccessEnded", {}),
]);

/** Observable result of applying current Stripe state. */
export type ApplyStripeSnapshotResult = typeof ApplyStripeSnapshotResult.Type;

/** Local facts required to decide one Stripe projection transition. */
export interface CurrentSubscriptionFacts {
  readonly plan: "adventurer" | "free";
  readonly stripeCurrentPeriodEnd: Date | null;
  readonly stripeLatestInvoiceId: StripeInvoiceId | null;
}

/** Current allowance-period facts held under the Subscription writer lock. */
export interface CurrentAllowancePeriodFacts {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly endsAt: Date;
  readonly startsAt: Date;
}

/** Exact allowance writes selected by the pure billing transition. */
export interface AllowancePeriodCommands {
  readonly create: {
    readonly endsAt: Date;
    readonly plan: "adventurer" | "free";
    readonly startsAt: Date;
    readonly stripeInvoiceId: StripeInvoiceId | null;
  } | null;
  readonly deleteActivePeriodId: AllowancePeriodId | null;
  readonly deleteFutureAdventurerAtOrAfter: Date | null;
  readonly shortenActivePeriod: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly endsAt: Date;
  } | null;
}

/** Pure transition decision. Persistence owns locks and writes, not billing policy. */
export type StripeTransitionDecision =
  | {
      readonly _tag: "Activate";
      readonly allowance: AllowancePeriodCommands;
      readonly result: ApplyStripeSnapshotResult;
    }
  | {
      readonly _tag: "ScheduleDowngrade";
      readonly allowance: AllowancePeriodCommands;
      readonly effectiveAt: Date;
      readonly result: ApplyStripeSnapshotResult;
    }
  | {
      readonly _tag: "EndAccess";
      readonly allowance: AllowancePeriodCommands;
      readonly result: ApplyStripeSnapshotResult;
    }
  | {
      readonly _tag: "Observe";
      readonly allowance: AllowancePeriodCommands;
      readonly result: ApplyStripeSnapshotResult;
    };

const noAllowanceWrites = (): AllowancePeriodCommands => ({
  create: null,
  deleteActivePeriodId: null,
  deleteFutureAdventurerAtOrAfter: null,
  shortenActivePeriod: null,
});

/** Decide access from current local facts and a normalized current Stripe snapshot. */
export const decideStripeTransition = (
  current: CurrentSubscriptionFacts,
  activePeriod: CurrentAllowancePeriodFacts | null,
  snapshot: StripeSubscriptionSnapshot,
  confirmedAt: Date,
  freePeriodEndsAt: Date,
): StripeTransitionDecision => {
  const paidActive =
    snapshot.status === "active" &&
    snapshot.payment._tag === "Paid" &&
    snapshot.period !== null &&
    snapshot.period.startsAt < snapshot.period.endsAt &&
    snapshot.period.startsAt <= confirmedAt &&
    confirmedAt < snapshot.period.endsAt;
  if (paidActive) {
    const startsPaidPeriod =
      current.plan === "free" || current.stripeLatestInvoiceId !== snapshot.payment.invoiceId;
    const startsAt =
      current.plan === "free" || snapshot.period.startsAt < confirmedAt
        ? confirmedAt
        : snapshot.period.startsAt;
    return {
      _tag: "Activate",
      allowance: startsPaidPeriod
        ? {
            create: {
              endsAt: snapshot.period.endsAt,
              plan: "adventurer",
              startsAt,
              stripeInvoiceId: snapshot.payment.invoiceId,
            },
            deleteActivePeriodId:
              activePeriod?.startsAt.getTime() === startsAt.getTime()
                ? activePeriod.allowancePeriodId
                : null,
            deleteFutureAdventurerAtOrAfter: null,
            shortenActivePeriod:
              activePeriod !== null &&
              activePeriod.startsAt < startsAt &&
              startsAt < activePeriod.endsAt
                ? { allowancePeriodId: activePeriod.allowancePeriodId, endsAt: startsAt }
                : null,
          }
        : noAllowanceWrites(),
      result: startsPaidPeriod
        ? { _tag: "Activated" }
        : snapshot.cancelAtPeriodEnd
          ? { _tag: "DowngradeScheduled" }
          : { _tag: "Unchanged" },
    };
  }
  const confirmedPaidEnd = current.stripeCurrentPeriodEnd;
  if (
    current.plan === "adventurer" &&
    confirmedPaidEnd !== null &&
    confirmedAt < confirmedPaidEnd &&
    !snapshot.currentPeriodRefunded &&
    (snapshot.status === "active" || snapshot.status === "past_due")
  ) {
    return {
      _tag: "ScheduleDowngrade",
      allowance: noAllowanceWrites(),
      effectiveAt: confirmedPaidEnd,
      result: { _tag: "DowngradeScheduled" },
    };
  }
  if (current.plan !== "adventurer") {
    return {
      _tag: "Observe",
      allowance: noAllowanceWrites(),
      result: { _tag: "Unchanged" },
    };
  }
  return {
    _tag: "EndAccess",
    allowance: {
      create: {
        endsAt: freePeriodEndsAt,
        plan: "free",
        startsAt: confirmedAt,
        stripeInvoiceId: null,
      },
      deleteActivePeriodId:
        activePeriod?.startsAt.getTime() === confirmedAt.getTime()
          ? activePeriod.allowancePeriodId
          : null,
      deleteFutureAdventurerAtOrAfter: confirmedAt,
      shortenActivePeriod:
        activePeriod !== null && activePeriod.startsAt < confirmedAt
          ? { allowancePeriodId: activePeriod.allowancePeriodId, endsAt: confirmedAt }
          : null,
    },
    result: { _tag: "AccessEnded" },
  };
};

/** Optimistic update result that requires a complete Stripe refetch. */
export const StaleSnapshot = Schema.TaggedStruct("StaleSnapshot", {});

/** Optimistic update result that requires a complete Stripe refetch. */
export type StaleSnapshot = typeof StaleSnapshot.Type;

/** User or Stripe identity used to locate current state for reconciliation. */
export const ReconciliationSubject = Schema.Union([
  Schema.TaggedStruct("User", { userId: UserId }),
  Schema.TaggedStruct("StripeSubscription", { subscriptionId: StripeSubscriptionId }),
]);

/** User or Stripe identity used to locate current state for reconciliation. */
export type ReconciliationSubject = typeof ReconciliationSubject.Type;

/** Expected input for one optimistic persistence transition. */
export interface ApplyStripeSnapshotInput {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly confirmedAt: Date;
  readonly checkoutEvidence: StripeCheckoutEvidence | null;
  readonly expectedUpdatedAt: Date;
  readonly freePeriodEndsAt: Date;
  readonly snapshot: StripeSubscriptionSnapshot;
  readonly source: StripeSnapshotSource;
}

/** Verified Stripe facts that conflict with Osfo's local identity projection. */
export class InvalidStripeSnapshot extends Schema.TaggedError<InvalidStripeSnapshot>()(
  "InvalidStripeSnapshot",
  { message: Schema.String },
) {}

/** Expected failure when current Stripe state cannot be retrieved. */
export class StripeStateUnavailable extends Schema.TaggedError<StripeStateUnavailable>()(
  "StripeStateUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Expected failure when optimistic projection retries cannot converge. */
export class BillingProjectionRetryExhausted extends Schema.TaggedError<BillingProjectionRetryExhausted>()(
  "BillingProjectionRetryExhausted",
  { attempts: Schema.Finite, message: Schema.String },
) {}

/** Narrow persistence port for the billing Subscription projection. */
export interface Persistence {
  readonly apply: (
    input: ApplyStripeSnapshotInput,
  ) => Effect.Effect<
    ApplyStripeSnapshotResult | StaleSnapshot,
    BillingTransactionRetryExhausted | DatabaseUnavailable | InvalidStripeSnapshot
  >;
  readonly load: (
    userId: UserId,
  ) => Effect.Effect<
    { readonly updatedAt: Date },
    BillingTransactionRetryExhausted | DatabaseUnavailable
  >;
}

/** Subscription projection and explicit reconciliation operations. */
export interface Interface {
  readonly loadRevision: (
    userId: UserId,
  ) => Effect.Effect<Date, BillingTransactionRetryExhausted | DatabaseUnavailable>;
  readonly applyStripeSnapshot: (
    source: StripeSnapshotSource,
    expectedUpdatedAt: Date,
    snapshot: StripeSubscriptionSnapshot,
    checkoutEvidence: StripeCheckoutEvidence | null,
  ) => Effect.Effect<
    ApplyStripeSnapshotResult | StaleSnapshot,
    BillingTransactionRetryExhausted | DatabaseUnavailable | InvalidStripeSnapshot
  >;
  readonly reconcile: (
    subject: ReconciliationSubject,
    reason: "checkoutReturn" | "internal" | "portalReturn",
    retrieveCurrentSnapshot: (
      subject: ReconciliationSubject,
    ) => Effect.Effect<StripeSubscriptionSnapshot, StripeStateUnavailable>,
    checkoutEvidence?: StripeCheckoutEvidence,
  ) => Effect.Effect<
    ApplyStripeSnapshotResult,
    | BillingProjectionRetryExhausted
    | BillingTransactionRetryExhausted
    | DatabaseUnavailable
    | InvalidStripeSnapshot
    | StripeStateUnavailable
  >;
}

/** Construct billing Subscription operations from the PostgreSQL projection port. */
export const make = (
  persistence: Persistence,
  environment: {
    readonly allowancePeriodId: Effect.Effect<AllowancePeriodId>;
    readonly now: Effect.Effect<Date>;
  },
): Interface => {
  const loadRevision: Interface["loadRevision"] = (userId) =>
    persistence.load(userId).pipe(Effect.map((current) => current.updatedAt));
  const applyStripeSnapshot: Interface["applyStripeSnapshot"] = (
    source,
    expectedUpdatedAt,
    snapshot,
    checkoutEvidence,
  ) =>
    Effect.gen(function* () {
      const confirmedAt = yield* environment.now;
      const allowancePeriodId = yield* environment.allowancePeriodId;
      return yield* persistence.apply({
        allowancePeriodId,
        checkoutEvidence,
        confirmedAt,
        expectedUpdatedAt,
        freePeriodEndsAt: DateTime.toDateUtc(
          DateTime.add(DateTime.fromDateUnsafe(confirmedAt), { days: 30 }),
        ),
        snapshot,
        source,
      });
    });

  const reconcileAttempt = (
    subject: ReconciliationSubject,
    reason: "checkoutReturn" | "internal" | "portalReturn",
    retrieveCurrentSnapshot: (
      subject: ReconciliationSubject,
    ) => Effect.Effect<StripeSubscriptionSnapshot, StripeStateUnavailable>,
    checkoutEvidence: StripeCheckoutEvidence | undefined,
    attempt: number,
  ): ReturnType<Interface["reconcile"]> =>
    Effect.gen(function* () {
      const expectedUpdatedAt =
        subject._tag === "User"
          ? yield* loadRevision(subject.userId)
          : yield* retrieveCurrentSnapshot(subject).pipe(
              Effect.flatMap((located) => loadRevision(located.userId)),
            );
      const snapshot = yield* retrieveCurrentSnapshot(subject);
      const result = yield* applyStripeSnapshot(
        { _tag: "Reconciliation", reason },
        expectedUpdatedAt,
        snapshot,
        checkoutEvidence ?? null,
      );
      if (result._tag !== "StaleSnapshot") return result;
      if (attempt >= 3) {
        return yield* new BillingProjectionRetryExhausted({
          attempts: attempt,
          message: "Billing projection did not converge after current Stripe state was refetched",
        });
      }
      return yield* reconcileAttempt(
        subject,
        reason,
        retrieveCurrentSnapshot,
        checkoutEvidence,
        attempt + 1,
      );
    });

  return {
    applyStripeSnapshot,
    loadRevision,
    reconcile: (subject, reason, fetch, checkoutEvidence) =>
      reconcileAttempt(subject, reason, fetch, checkoutEvidence, 1),
  };
};

export * as BillingSubscriptions from "./billing-subscriptions";
