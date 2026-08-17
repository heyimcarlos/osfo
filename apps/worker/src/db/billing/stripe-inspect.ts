import { allowancePeriods } from "@osfo/db/schema/allowances";
import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
} from "@osfo/db/schema/billing";
import { and, desc, eq, gt, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  BillingCheckoutSessionId,
  type AllowancePeriodId,
  Plan,
  PlanPolicyVersion,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripeProductId,
  UserId,
} from "../../domain";
import {
  effectivePlanAt,
  type BillingAuthorizationFacts,
} from "../../services/billing-authorization";
import type { Persistence } from "../../services/billing-presentation";
import { BillingPersistenceUnavailable } from "../../services/stripe-billing";
import type { Database } from "../index";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Drizzle owns this transaction Promise boundary and database timestamp representation. */

/** Read current Plan and allowance-period facts for safe billing presentation. */
export const inspectStripeBilling = (
  database: Pick<Database, "transaction">,
  userId: UserId,
  now: Date,
): ReturnType<Persistence["inspect"]> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const [subscription] = await transaction
          .select({
            pendingPlan: billingSubscriptions.pendingPlan,
            pendingPlanEffectiveAt: billingSubscriptions.pendingPlanEffectiveAt,
            plan: billingSubscriptions.plan,
            stripeCurrentPeriodEnd: billingSubscriptions.stripeCurrentPeriodEnd,
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

/** Read one exact User-owned Stripe Checkout Session for return reconciliation. */
export const findStripeCheckoutSession = (
  database: Pick<Database, "select">,
  userId: UserId,
  stripeCheckoutSessionId: StripeCheckoutSessionId,
) =>
  Effect.tryPromise({
    try: () =>
      database
        .select({
          billingCheckoutSessionId: billingCheckoutSessions.billingCheckoutSessionId,
          customerId: billingCustomers.stripeCustomerId,
          priceId: billingCheckoutSessions.stripePriceId,
          productId: billingCheckoutSessions.stripeProductId,
          stripeCheckoutSessionId: billingCheckoutSessions.stripeCheckoutSessionId,
          userId: billingCheckoutSessions.userId,
        })
        .from(billingCheckoutSessions)
        .innerJoin(
          billingCustomers,
          eq(billingCustomers.billingCustomerId, billingCheckoutSessions.billingCustomerId),
        )
        .where(
          and(
            eq(billingCheckoutSessions.userId, userId),
            eq(billingCheckoutSessions.stripeCheckoutSessionId, stripeCheckoutSessionId),
            inArray(billingCheckoutSessions.state, ["creating", "open", "complete"]),
            isNotNull(billingCheckoutSessions.stripeCheckoutSessionId),
          ),
        )
        .limit(1)
        .then(([stored]) => stored ?? null),
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not locate the Stripe Checkout Session",
        operation: "findStripeCheckoutSession",
      }),
  }).pipe(
    Effect.flatMap((stored) =>
      stored === null
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(
            Schema.Struct({
              billingCheckoutSessionId: BillingCheckoutSessionId,
              customerId: StripeCustomerId,
              priceId: StripePriceId,
              productId: StripeProductId,
              stripeCheckoutSessionId: StripeCheckoutSessionId,
              userId: UserId,
            }),
          )(stored).pipe(
            Effect.mapError(
              (cause) =>
                new BillingPersistenceUnavailable({
                  cause,
                  message: "PostgreSQL returned invalid Checkout return identity",
                  operation: "findStripeCheckoutSession",
                }),
            ),
          ),
    ),
  );

/** Read and repair time-bounded Subscription facts required by central Authorization. */
export const inspectAndRepairBillingAuthorization = (
  database: Pick<Database, "transaction">,
  userId: UserId,
  now: Date,
  repair: { readonly allowancePeriodId: AllowancePeriodId; readonly freePeriodEnd: Date },
): Effect.Effect<
  Pick<BillingAuthorizationFacts, "plan" | "planPolicyVersion">,
  BillingPersistenceUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const [stored] = await transaction
          .select({
            billingSubscriptionId: billingSubscriptions.billingSubscriptionId,
            currentPeriodEnd: billingSubscriptions.stripeCurrentPeriodEnd,
            pendingPlan: billingSubscriptions.pendingPlan,
            pendingPlanEffectiveAt: billingSubscriptions.pendingPlanEffectiveAt,
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.planPolicyVersion,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.userId, userId))
          .for("update", { of: billingSubscriptions })
          .limit(1);
        if (stored === undefined) return null;
        const plan = effectivePlanAt(
          {
            currentPeriodEnd: stored.currentPeriodEnd,
            pendingPlan: stored.pendingPlan,
            pendingPlanEffectiveAt: stored.pendingPlanEffectiveAt,
            plan: stored.plan,
          },
          now,
        );
        if (plan !== stored.plan) {
          const [activePeriod] = await transaction
            .select({
              allowancePeriodId: allowancePeriods.allowancePeriodId,
              plan: allowancePeriods.plan,
              startsAt: allowancePeriods.startsAt,
            })
            .from(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.userId, userId),
                lte(allowancePeriods.startsAt, now),
                gt(allowancePeriods.endsAt, now),
              ),
            )
            .for("update")
            .limit(1);
          if (
            activePeriod?.plan === "adventurer" &&
            activePeriod.startsAt !== null &&
            activePeriod.startsAt < now
          ) {
            await transaction
              .update(allowancePeriods)
              .set({ endsAt: now })
              .where(eq(allowancePeriods.allowancePeriodId, activePeriod.allowancePeriodId));
          }
          await transaction
            .delete(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.userId, userId),
                eq(allowancePeriods.plan, "adventurer"),
                gte(allowancePeriods.startsAt, now),
              ),
            );
          const [currentFreePeriod] = await transaction
            .select({ allowancePeriodId: allowancePeriods.allowancePeriodId })
            .from(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.userId, userId),
                eq(allowancePeriods.plan, "free"),
                lte(allowancePeriods.startsAt, now),
                gt(allowancePeriods.endsAt, now),
              ),
            )
            .limit(1);
          if (currentFreePeriod === undefined) {
            await transaction.insert(allowancePeriods).values({
              allowancePeriodId: repair.allowancePeriodId,
              billingSubscriptionId: stored.billingSubscriptionId,
              endsAt: repair.freePeriodEnd,
              plan: "free",
              planPolicyVersion: stored.planPolicyVersion,
              startsAt: now,
              userId,
            });
          }
          await transaction
            .update(billingSubscriptions)
            .set({
              pendingPlan: null,
              pendingPlanEffectiveAt: null,
              plan,
              updatedAt: sql`greatest(clock_timestamp(), ${billingSubscriptions.updatedAt} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.userId, userId));
        }
        return { ...stored, plan };
      }),
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not inspect billing authorization facts",
        operation: "inspectAndRepairBillingAuthorization",
      }),
  }).pipe(
    Effect.flatMap((stored) =>
      stored === null
        ? Effect.fail(
            new BillingPersistenceUnavailable({
              cause: { userId },
              message: "The User has no billing Subscription facts",
              operation: "inspectAndRepairBillingAuthorization",
            }),
          )
        : Effect.all({
            plan: Schema.decodeEffect(Plan)(stored.plan),
            planPolicyVersion: Schema.decodeEffect(PlanPolicyVersion)(stored.planPolicyVersion),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new BillingPersistenceUnavailable({
                  cause,
                  message: "PostgreSQL returned invalid billing authorization facts",
                  operation: "inspectAndRepairBillingAuthorization",
                }),
            ),
          ),
    ),
  );
