import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
} from "@osfo/db/schema/billing";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  BillingCheckoutSessionId,
  BillingCustomerId,
  StripeCheckoutSessionId,
  StripeCustomerId,
} from "../../domain";
import {
  BillingPersistenceUnavailable,
  checkoutEligibility,
  CheckoutIneligible,
  type PreparedCheckout,
  type Persistence,
} from "../../services/stripe-billing";
import { effectivePlanAt } from "../../services/billing-authorization";
import type { Database } from "../index";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle owns these transaction Promise boundaries and domain tags use _tag. */

/** Construct PostgreSQL coordination for stable Stripe Customer and Checkout attempts. */
export const makeStripePersistence = (database: Database): Persistence => ({
  failCheckout: (billingCheckoutSessionId) =>
    execute("failCheckout", () =>
      database
        .update(billingCheckoutSessions)
        .set({ state: "failed", updated_at: sql`clock_timestamp()` })
        .where(
          and(
            eq(billingCheckoutSessions.billing_checkout_session_id, billingCheckoutSessionId),
            inArray(billingCheckoutSessions.state, ["creating", "open"]),
          ),
        )
        .then(() => undefined),
    ),
  inspectCheckoutEligibility: (userId, now) =>
    execute("inspectCheckoutEligibility", () =>
      database
        .select({
          currentPeriodEnd: billingSubscriptions.stripe_current_period_end,
          pendingPlan: billingSubscriptions.pending_plan,
          pendingPlanEffectiveAt: billingSubscriptions.pending_plan_effective_at,
          plan: billingSubscriptions.plan,
          stripeStatus: billingSubscriptions.stripe_status,
          stripeSubscriptionId: billingSubscriptions.stripe_subscription_id,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.user_id, userId))
        .limit(1)
        .then(([subscription]) =>
          subscription === undefined
            ? undefined
            : checkoutEligibility({
                ...subscription,
                plan: effectivePlanAt(subscription, now),
              }),
        ),
    ).pipe(
      Effect.flatMap((eligibility) =>
        eligibility === undefined
          ? persistenceFailure("inspectCheckoutEligibility", { userId })
          : Effect.succeed(eligibility),
      ),
    ),
  prepareCheckout: (input) =>
    execute("prepareCheckout", () =>
      database.transaction(async (transaction) => {
        const [subscription] = await transaction
          .select({
            currentPeriodEnd: billingSubscriptions.stripe_current_period_end,
            pendingPlan: billingSubscriptions.pending_plan,
            pendingPlanEffectiveAt: billingSubscriptions.pending_plan_effective_at,
            plan: billingSubscriptions.plan,
            stripeStatus: billingSubscriptions.stripe_status,
            stripeSubscriptionId: billingSubscriptions.stripe_subscription_id,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, input.userId))
          .limit(1)
          .for("update");
        if (subscription === undefined) return undefined;
        const eligibility = checkoutEligibility({
          ...subscription,
          plan: effectivePlanAt(subscription, input.now),
        });
        if (eligibility._tag === "Ineligible") {
          return { ineligibleReason: eligibility.reason } as const;
        }
        const [customer] = await transaction
          .select({ billingCustomerId: billingCustomers.billing_customer_id })
          .from(billingCustomers)
          .where(
            and(
              eq(billingCustomers.user_id, input.userId),
              eq(billingCustomers.billing_customer_id, input.billingCustomerId),
            ),
          )
          .limit(1);
        if (customer === undefined) return undefined;
        const [existing] = await transaction
          .select({
            billingCheckoutSessionId: billingCheckoutSessions.billing_checkout_session_id,
            claimExpired: sql<boolean>`${billingCheckoutSessions.updated_at} <= clock_timestamp() - interval '30 seconds'`,
            state: billingCheckoutSessions.state,
            stripeCheckoutSessionId: billingCheckoutSessions.stripe_checkout_session_id,
          })
          .from(billingCheckoutSessions)
          .where(
            and(
              eq(billingCheckoutSessions.user_id, input.userId),
              eq(billingCheckoutSessions.billing_customer_id, input.billingCustomerId),
              eq(billingCheckoutSessions.stripe_product_id, input.productId),
              eq(billingCheckoutSessions.stripe_price_id, input.priceId),
              inArray(billingCheckoutSessions.state, ["creating", "open"]),
            ),
          )
          .orderBy(desc(billingCheckoutSessions.created_at))
          .limit(1);
        if (existing !== undefined) {
          if (existing.state === "creating" && existing.claimExpired) {
            await transaction
              .update(billingCheckoutSessions)
              .set({ updated_at: sql`clock_timestamp()` })
              .where(
                eq(
                  billingCheckoutSessions.billing_checkout_session_id,
                  existing.billingCheckoutSessionId,
                ),
              );
            return decodeCheckout(existing, "Acquired");
          }
          return decodeCheckout(existing, existing.state === "creating" ? "Pending" : "Acquired");
        }
        const [created] = await transaction
          .insert(billingCheckoutSessions)
          .values({
            billing_checkout_session_id: input.billingCheckoutSessionId,
            billing_customer_id: input.billingCustomerId,
            state: "creating",
            stripe_price_id: input.priceId,
            stripe_product_id: input.productId,
            target_plan: "adventurer",
            user_id: input.userId,
          })
          .returning({
            billingCheckoutSessionId: billingCheckoutSessions.billing_checkout_session_id,
            state: billingCheckoutSessions.state,
            stripeCheckoutSessionId: billingCheckoutSessions.stripe_checkout_session_id,
          });
        return created === undefined ? undefined : decodeCheckout(created, "Acquired");
      }),
    ).pipe(Effect.flatMap((checkout) => decodePreparedCheckout(checkout, input))),
  prepareCustomer: (userId, billingCustomerId) =>
    execute("prepareCustomer", () =>
      database.transaction(async (transaction) => {
        await transaction
          .insert(billingCustomers)
          .values({ billing_customer_id: billingCustomerId, user_id: userId })
          .onConflictDoNothing({ target: billingCustomers.user_id });
        const [stored] = await transaction
          .select({
            billingCustomerId: billingCustomers.billing_customer_id,
            stripeCustomerId: billingCustomers.stripe_customer_id,
          })
          .from(billingCustomers)
          .where(eq(billingCustomers.user_id, userId))
          .limit(1);
        return stored === undefined
          ? undefined
          : {
              billingCustomerId: BillingCustomerId.make(stored.billingCustomerId),
              stripeCustomerId:
                stored.stripeCustomerId === null
                  ? null
                  : StripeCustomerId.make(stored.stripeCustomerId),
            };
      }),
    ).pipe(
      Effect.flatMap((customer) =>
        customer === undefined
          ? persistenceFailure("prepareCustomer", { billingCustomerId, userId })
          : Effect.succeed(customer),
      ),
    ),
  releaseCheckoutClaim: (billingCheckoutSessionId) =>
    execute("releaseCheckoutClaim", () =>
      database
        .update(billingCheckoutSessions)
        .set({ updated_at: sql`clock_timestamp() - interval '31 seconds'` })
        .where(
          and(
            eq(billingCheckoutSessions.billing_checkout_session_id, billingCheckoutSessionId),
            eq(billingCheckoutSessions.state, "creating"),
          ),
        )
        .then(() => undefined),
    ),
  storeCheckout: (billingCheckoutSessionId, session) =>
    execute("storeCheckout", () =>
      database
        .update(billingCheckoutSessions)
        .set({
          expires_at: session.expiresAt,
          state: "open",
          stripe_checkout_session_id: session.stripeCheckoutSessionId,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(billingCheckoutSessions.billing_checkout_session_id, billingCheckoutSessionId),
            eq(billingCheckoutSessions.state, "creating"),
            sql`${billingCheckoutSessions.stripe_checkout_session_id} is null`,
          ),
        )
        .then(() => undefined),
    ),
  storeRetrievedCheckout: (billingCheckoutSessionId, session) =>
    execute("storeRetrievedCheckout", () =>
      database
        .update(billingCheckoutSessions)
        .set({
          completed_at: session.state === "complete" ? sql`clock_timestamp()` : null,
          expires_at: session.expiresAt,
          state: session.state,
          stripe_subscription_id: session.stripeSubscriptionId,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(billingCheckoutSessions.billing_checkout_session_id, billingCheckoutSessionId),
            eq(billingCheckoutSessions.state, "open"),
          ),
        )
        .then(() => undefined),
    ),
  storeCustomer: (billingCustomerId, stripeCustomerId) =>
    execute("storeCustomer", () =>
      database.transaction(async (transaction) => {
        await transaction
          .update(billingCustomers)
          .set({ stripe_customer_id: stripeCustomerId, updated_at: sql`clock_timestamp()` })
          .where(
            and(
              eq(billingCustomers.billing_customer_id, billingCustomerId),
              or(
                eq(billingCustomers.stripe_customer_id, stripeCustomerId),
                sql`${billingCustomers.stripe_customer_id} is null`,
              ),
            ),
          );
        const [stored] = await transaction
          .select({ stripeCustomerId: billingCustomers.stripe_customer_id })
          .from(billingCustomers)
          .where(eq(billingCustomers.billing_customer_id, billingCustomerId))
          .limit(1);
        return stored?.stripeCustomerId === stripeCustomerId;
      }),
    ).pipe(
      Effect.flatMap((stored) =>
        stored ? Effect.void : persistenceFailure("storeCustomer", { billingCustomerId }),
      ),
    ),
});

const decodeCheckout = (
  stored: {
    readonly billingCheckoutSessionId: string;
    readonly state: "complete" | "creating" | "expired" | "failed" | "open";
    readonly stripeCheckoutSessionId: string | null;
  },
  claim: "Acquired" | "Pending",
) => ({
  billingCheckoutSessionId: BillingCheckoutSessionId.make(stored.billingCheckoutSessionId),
  claim,
  state: stored.state,
  stripeCheckoutSessionId:
    stored.stripeCheckoutSessionId === null
      ? null
      : StripeCheckoutSessionId.make(stored.stripeCheckoutSessionId),
});

type StoredPreparedCheckout =
  | PreparedCheckout
  | {
      readonly ineligibleReason: "activePlan" | "existingStripeSubscription";
    }
  | undefined;

const decodePreparedCheckout = (
  checkout: StoredPreparedCheckout,
  input: Parameters<Persistence["prepareCheckout"]>[0],
): Effect.Effect<PreparedCheckout, BillingPersistenceUnavailable | CheckoutIneligible> => {
  if (checkout === undefined) return persistenceFailure("prepareCheckout", { input });
  if ("ineligibleReason" in checkout) {
    return Effect.fail(new CheckoutIneligible({ reason: checkout.ineligibleReason }));
  }
  return Effect.succeed(checkout);
};

const execute = <A>(operation: string, request: () => Promise<A>) =>
  Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new BillingPersistenceUnavailable({
        cause,
        message: `PostgreSQL could not complete ${operation}`,
        operation,
      }),
  });

const persistenceFailure = (operation: string, cause: unknown) =>
  Effect.fail(
    new BillingPersistenceUnavailable({
      cause,
      message: `PostgreSQL could not complete ${operation}`,
      operation,
    }),
  );
