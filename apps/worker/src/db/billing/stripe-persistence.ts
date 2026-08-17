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
        .set({ state: "failed", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(billingCheckoutSessions.billingCheckoutSessionId, billingCheckoutSessionId),
            inArray(billingCheckoutSessions.state, ["creating", "open"]),
          ),
        )
        .then(() => undefined),
    ),
  inspectCheckoutEligibility: (userId, now) =>
    execute("inspectCheckoutEligibility", () =>
      database
        .select({
          currentPeriodEnd: billingSubscriptions.stripeCurrentPeriodEnd,
          pendingPlan: billingSubscriptions.pendingPlan,
          pendingPlanEffectiveAt: billingSubscriptions.pendingPlanEffectiveAt,
          plan: billingSubscriptions.plan,
          stripeStatus: billingSubscriptions.stripeStatus,
          stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.userId, userId))
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
            currentPeriodEnd: billingSubscriptions.stripeCurrentPeriodEnd,
            pendingPlan: billingSubscriptions.pendingPlan,
            pendingPlanEffectiveAt: billingSubscriptions.pendingPlanEffectiveAt,
            plan: billingSubscriptions.plan,
            stripeStatus: billingSubscriptions.stripeStatus,
            stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.userId, input.userId))
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
          .select({ billingCustomerId: billingCustomers.billingCustomerId })
          .from(billingCustomers)
          .where(
            and(
              eq(billingCustomers.userId, input.userId),
              eq(billingCustomers.billingCustomerId, input.billingCustomerId),
            ),
          )
          .limit(1);
        if (customer === undefined) return undefined;
        const [existing] = await transaction
          .select({
            billingCheckoutSessionId: billingCheckoutSessions.billingCheckoutSessionId,
            claimExpired: sql<boolean>`${billingCheckoutSessions.updatedAt} <= clock_timestamp() - interval '30 seconds'`,
            state: billingCheckoutSessions.state,
            stripeCheckoutSessionId: billingCheckoutSessions.stripeCheckoutSessionId,
          })
          .from(billingCheckoutSessions)
          .where(
            and(
              eq(billingCheckoutSessions.userId, input.userId),
              eq(billingCheckoutSessions.billingCustomerId, input.billingCustomerId),
              eq(billingCheckoutSessions.stripeProductId, input.productId),
              eq(billingCheckoutSessions.stripePriceId, input.priceId),
              inArray(billingCheckoutSessions.state, ["creating", "open"]),
            ),
          )
          .orderBy(desc(billingCheckoutSessions.createdAt))
          .limit(1);
        if (existing !== undefined) {
          if (existing.state === "creating" && existing.claimExpired) {
            await transaction
              .update(billingCheckoutSessions)
              .set({ updatedAt: sql`clock_timestamp()` })
              .where(
                eq(
                  billingCheckoutSessions.billingCheckoutSessionId,
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
            billingCheckoutSessionId: input.billingCheckoutSessionId,
            billingCustomerId: input.billingCustomerId,
            state: "creating",
            stripePriceId: input.priceId,
            stripeProductId: input.productId,
            targetPlan: "adventurer",
            userId: input.userId,
          })
          .returning({
            billingCheckoutSessionId: billingCheckoutSessions.billingCheckoutSessionId,
            state: billingCheckoutSessions.state,
            stripeCheckoutSessionId: billingCheckoutSessions.stripeCheckoutSessionId,
          });
        return created === undefined ? undefined : decodeCheckout(created, "Acquired");
      }),
    ).pipe(Effect.flatMap((checkout) => decodePreparedCheckout(checkout, input))),
  prepareCustomer: (userId, billingCustomerId) =>
    execute("prepareCustomer", () =>
      database.transaction(async (transaction) => {
        await transaction
          .insert(billingCustomers)
          .values({ billingCustomerId, userId })
          .onConflictDoNothing({ target: billingCustomers.userId });
        const [stored] = await transaction
          .select({
            billingCustomerId: billingCustomers.billingCustomerId,
            stripeCustomerId: billingCustomers.stripeCustomerId,
          })
          .from(billingCustomers)
          .where(eq(billingCustomers.userId, userId))
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
        .set({ updatedAt: sql`clock_timestamp() - interval '31 seconds'` })
        .where(
          and(
            eq(billingCheckoutSessions.billingCheckoutSessionId, billingCheckoutSessionId),
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
          expiresAt: session.expiresAt,
          state: "open",
          stripeCheckoutSessionId: session.stripeCheckoutSessionId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(billingCheckoutSessions.billingCheckoutSessionId, billingCheckoutSessionId))
        .then(() => undefined),
    ),
  storeRetrievedCheckout: (billingCheckoutSessionId, session) =>
    execute("storeRetrievedCheckout", () =>
      database
        .update(billingCheckoutSessions)
        .set({
          completedAt: session.state === "complete" ? sql`clock_timestamp()` : null,
          expiresAt: session.expiresAt,
          state: session.state,
          stripeSubscriptionId: session.stripeSubscriptionId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(billingCheckoutSessions.billingCheckoutSessionId, billingCheckoutSessionId),
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
          .set({ stripeCustomerId, updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(billingCustomers.billingCustomerId, billingCustomerId),
              or(
                eq(billingCustomers.stripeCustomerId, stripeCustomerId),
                sql`${billingCustomers.stripeCustomerId} is null`,
              ),
            ),
          );
        const [stored] = await transaction
          .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
          .from(billingCustomers)
          .where(eq(billingCustomers.billingCustomerId, billingCustomerId))
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
