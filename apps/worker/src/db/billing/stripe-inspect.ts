import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
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
import { presentPlanUsage } from "../../domain/allowance";
import {
  effectivePlanAt,
  type BillingAuthorizationFacts,
} from "../../services/billing-authorization";
import type { Persistence, StoredBillingSummary } from "../../services/billing-presentation";
import { isSharedUsagePolicy, retainedCatalog } from "../../domain/plan-policy";
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
            pendingPlan: billingSubscriptions.pending_plan,
            pendingPlanEffectiveAt: billingSubscriptions.pending_plan_effective_at,
            plan: billingSubscriptions.plan,
            stripeCurrentPeriodEnd: billingSubscriptions.stripe_current_period_end,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, userId))
          .limit(1);
        if (subscription === undefined) return undefined;
        const [period] = await transaction
          .select({
            allowancePeriodId: allowancePeriods.allowance_period_id,
            endsAt: allowancePeriods.ends_at,
            plan: allowancePeriods.plan,
            planPolicyVersion: allowancePeriods.plan_policy_version,
            startsAt: allowancePeriods.starts_at,
          })
          .from(allowancePeriods)
          .where(
            and(
              eq(allowancePeriods.user_id, userId),
              lte(allowancePeriods.starts_at, now),
              gt(allowancePeriods.ends_at, now),
            ),
          )
          .limit(1);
        const [usage] =
          period === undefined
            ? []
            : await transaction
                .select({
                  quantity: sql<bigint>`coalesce(sum(${allowanceUsage.quantity}), 0)`.mapWith(
                    allowanceUsage.quantity,
                  ),
                })
                .from(allowanceUsage)
                .where(
                  and(
                    eq(allowanceUsage.allowance_period_id, period.allowancePeriodId),
                    eq(allowanceUsage.allowance_kind, "planUsageMicros"),
                  ),
                );
        const [checkout] = await transaction
          .select({
            state: billingCheckoutSessions.state,
            stripePaymentStatus: billingCheckoutSessions.stripe_payment_status,
          })
          .from(billingCheckoutSessions)
          .where(eq(billingCheckoutSessions.user_id, userId))
          .orderBy(desc(billingCheckoutSessions.created_at))
          .limit(1);
        return {
          ...subscription,
          checkoutPaymentState:
            checkout?.state === "failed" || checkout?.stripePaymentStatus === "unpaid"
              ? ("paymentNeeded" as const)
              : null,
          currentPeriod:
            period === undefined ? null : { endsAt: period.endsAt, startsAt: period.startsAt },
          usage: planUsageSummary(period, usage?.quantity ?? 0n),
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

const planUsageSummary = (
  period:
    | {
        readonly endsAt: Date;
        readonly plan: "free" | "adventurer";
        readonly planPolicyVersion: string;
      }
    | undefined,
  recorded: bigint,
): StoredBillingSummary["usage"] => {
  if (period === undefined) return null;
  const policy = retainedCatalog.policies.find(
    (candidate) => candidate.version === period.planPolicyVersion,
  );
  if (policy === undefined || !isSharedUsagePolicy(policy)) return null;
  const included = policy.plans[period.plan].includedPlanUsageMicros;
  const presentation = presentPlanUsage(recorded, included);
  return {
    label: presentation.remainingLabel,
    remainingPercentage: presentation.remainingPercent,
    resetAt: period.endsAt,
    warning: presentation.warning === "twentyPercent" ? "low" : presentation.warning,
  };
};

/** Read the current Stripe Subscription identity for explicit reconciliation. */
export const findStripeSubscription = (database: Pick<Database, "select">, userId: UserId) =>
  Effect.tryPromise({
    try: () =>
      database
        .select({ stripeSubscriptionId: billingSubscriptions.stripe_subscription_id })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.user_id, userId))
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
          billingCheckoutSessionId: billingCheckoutSessions.billing_checkout_session_id,
          customerId: billingCustomers.stripe_customer_id,
          priceId: billingCheckoutSessions.stripe_price_id,
          productId: billingCheckoutSessions.stripe_product_id,
          stripeCheckoutSessionId: billingCheckoutSessions.stripe_checkout_session_id,
          userId: billingCheckoutSessions.user_id,
        })
        .from(billingCheckoutSessions)
        .innerJoin(
          billingCustomers,
          eq(billingCustomers.billing_customer_id, billingCheckoutSessions.billing_customer_id),
        )
        .where(
          and(
            eq(billingCheckoutSessions.user_id, userId),
            eq(billingCheckoutSessions.stripe_checkout_session_id, stripeCheckoutSessionId),
            inArray(billingCheckoutSessions.state, ["creating", "open", "complete"]),
            isNotNull(billingCheckoutSessions.stripe_checkout_session_id),
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
            billingSubscriptionId: billingSubscriptions.billing_subscription_id,
            currentPeriodEnd: billingSubscriptions.stripe_current_period_end,
            pendingPlan: billingSubscriptions.pending_plan,
            pendingPlanEffectiveAt: billingSubscriptions.pending_plan_effective_at,
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.plan_policy_version,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, userId))
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
              allowancePeriodId: allowancePeriods.allowance_period_id,
              plan: allowancePeriods.plan,
              startsAt: allowancePeriods.starts_at,
            })
            .from(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.user_id, userId),
                lte(allowancePeriods.starts_at, now),
                gt(allowancePeriods.ends_at, now),
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
              .set({ ends_at: now })
              .where(eq(allowancePeriods.allowance_period_id, activePeriod.allowancePeriodId));
          }
          await transaction
            .delete(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.user_id, userId),
                eq(allowancePeriods.plan, "adventurer"),
                gte(allowancePeriods.starts_at, now),
              ),
            );
          const [currentFreePeriod] = await transaction
            .select({ allowancePeriodId: allowancePeriods.allowance_period_id })
            .from(allowancePeriods)
            .where(
              and(
                eq(allowancePeriods.user_id, userId),
                eq(allowancePeriods.plan, "free"),
                lte(allowancePeriods.starts_at, now),
                gt(allowancePeriods.ends_at, now),
              ),
            )
            .limit(1);
          if (currentFreePeriod === undefined) {
            await transaction.insert(allowancePeriods).values({
              allowance_period_id: repair.allowancePeriodId,
              billing_subscription_id: stored.billingSubscriptionId,
              ends_at: repair.freePeriodEnd,
              plan: "free",
              plan_policy_version: stored.planPolicyVersion,
              starts_at: now,
              user_id: userId,
            });
          }
          await transaction
            .update(billingSubscriptions)
            .set({
              pending_plan: null,
              pending_plan_effective_at: null,
              plan,
              updated_at: sql`greatest(clock_timestamp(), ${billingSubscriptions.updated_at} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.user_id, userId));
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
