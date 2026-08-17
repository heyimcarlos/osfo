import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingCheckoutSessions, billingSubscriptions } from "@osfo/db/schema/billing";
import { and, desc, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { Plan, PlanPolicyVersion, type UserId } from "../../domain";
import type { BillingAuthorizationFacts } from "../../services/billing-authorization";
import type { Persistence } from "../../services/billing-presentation";
import { BillingPersistenceUnavailable } from "../../services/stripe-billing";
import type { Database } from "../index";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Drizzle owns this transaction Promise boundary and database timestamp representation. */

/** Read current Plan and allowance-period facts for safe billing presentation. */
export const inspectStripeBilling = (
  database: Pick<Database, "transaction">,
  userId: UserId,
): ReturnType<Persistence["inspect"]> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const now = new Date();
        const [subscription] = await transaction
          .select({
            pendingPlan: billingSubscriptions.pendingPlan,
            pendingPlanEffectiveAt: billingSubscriptions.pendingPlanEffectiveAt,
            plan: billingSubscriptions.plan,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.userId, userId))
          .limit(1);
        if (subscription === undefined) return undefined;
        const [period] = await transaction
          .select({ endsAt: allowancePeriods.endsAt, startsAt: allowancePeriods.startsAt })
          .from(allowancePeriods)
          .where(
            and(
              eq(allowancePeriods.userId, userId),
              lte(allowancePeriods.startsAt, now),
              gt(allowancePeriods.endsAt, now),
            ),
          )
          .limit(1);
        const [checkout] = await transaction
          .select({
            state: billingCheckoutSessions.state,
            stripePaymentStatus: billingCheckoutSessions.stripePaymentStatus,
          })
          .from(billingCheckoutSessions)
          .where(eq(billingCheckoutSessions.userId, userId))
          .orderBy(desc(billingCheckoutSessions.createdAt))
          .limit(1);
        return {
          ...subscription,
          checkoutPaymentState:
            checkout?.state === "failed" || checkout?.stripePaymentStatus === "unpaid"
              ? ("paymentNeeded" as const)
              : null,
          currentPeriod: period ?? null,
        };
      }),
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not inspect the current billing state",
        operation: "inspectBilling",
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result === undefined
        ? Effect.fail(
            new BillingPersistenceUnavailable({
              cause: { userId },
              message: "PostgreSQL could not inspect the current billing state",
              operation: "inspectBilling",
            }),
          )
        : Effect.succeed(result),
    ),
  );

/** Read the current Stripe Subscription identity for explicit reconciliation. */
export const findStripeSubscription = (database: Pick<Database, "select">, userId: UserId) =>
  Effect.tryPromise({
    try: () =>
      database
        .select({ stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.userId, userId))
        .limit(1)
        .then(([stored]) => stored?.stripeSubscriptionId ?? null),
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not locate the Stripe Subscription",
        operation: "findStripeSubscription",
      }),
  });

/** Read the latest recoverable Stripe Checkout Session for return reconciliation. */
export const findStripeCheckoutSession = (database: Pick<Database, "select">, userId: UserId) =>
  Effect.tryPromise({
    try: () =>
      database
        .select({ stripeCheckoutSessionId: billingCheckoutSessions.stripeCheckoutSessionId })
        .from(billingCheckoutSessions)
        .where(
          and(
            eq(billingCheckoutSessions.userId, userId),
            inArray(billingCheckoutSessions.state, ["creating", "open", "complete"]),
            isNotNull(billingCheckoutSessions.stripeCheckoutSessionId),
          ),
        )
        .orderBy(desc(billingCheckoutSessions.createdAt))
        .limit(1)
        .then(([stored]) => stored?.stripeCheckoutSessionId ?? null),
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not locate the Stripe Checkout Session",
        operation: "findStripeCheckoutSession",
      }),
  });

/** Read the persisted Subscription facts required by central Authorization. */
export const inspectBillingAuthorization = (
  database: Pick<Database, "select">,
  userId: UserId,
): Effect.Effect<
  Pick<BillingAuthorizationFacts, "deletionAccess" | "plan" | "planPolicyVersion" | "user">,
  BillingPersistenceUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      database
        .select({
          deletionAccessRevokedAt: users.deletionAccessRevokedAt,
          plan: billingSubscriptions.plan,
          planPolicyVersion: billingSubscriptions.planPolicyVersion,
          suspendedAt: users.suspendedAt,
        })
        .from(billingSubscriptions)
        .innerJoin(users, eq(users.id, billingSubscriptions.userId))
        .where(eq(billingSubscriptions.userId, userId))
        .limit(1)
        .then(([stored]) => stored ?? null),
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not inspect billing authorization facts",
        operation: "inspectBillingAuthorization",
      }),
  }).pipe(
    Effect.flatMap((stored) =>
      stored === null
        ? Effect.fail(
            new BillingPersistenceUnavailable({
              cause: { userId },
              message: "The User has no billing Subscription facts",
              operation: "inspectBillingAuthorization",
            }),
          )
        : Effect.all({
            deletionAccess: Effect.succeed(
              stored.deletionAccessRevokedAt === null
                ? ({ _tag: "DeletionAccessAvailable" } as const)
                : ({ _tag: "DeletionAccessRevoked" } as const),
            ),
            plan: Schema.decodeEffect(Plan)(stored.plan),
            planPolicyVersion: Schema.decodeEffect(PlanPolicyVersion)(stored.planPolicyVersion),
            user: Effect.succeed(
              stored.suspendedAt === null
                ? ({ _tag: "ActiveUser", userId } as const)
                : ({ _tag: "SuspendedUser", userId } as const),
            ),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new BillingPersistenceUnavailable({
                  cause,
                  message: "PostgreSQL returned invalid billing authorization facts",
                  operation: "inspectBillingAuthorization",
                }),
            ),
          ),
    ),
  );
