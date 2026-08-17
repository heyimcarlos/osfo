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
  CheckoutIneligible,
  type PreparedCheckout,
  type Persistence,
} from "../../services/stripe-billing";
import type { Database } from "../index";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns these transaction Promise boundaries. */

/** Construct PostgreSQL coordination for stable Stripe Customer and Checkout attempts. */
export const makeStripePersistence = (database: Database): Persistence => ({
  failCheckout: (billingCheckoutSessionId, _errorCode) =>
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
  inspectCheckoutEligibility: (userId) =>
    execute("inspectCheckoutEligibility", () =>
      database
        .select({
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
            : {
                hasRecoverableStripeSubscription:
                  subscription.stripeSubscriptionId !== null &&
                  subscription.stripeStatus !== "canceled" &&
                  subscription.stripeStatus !== "incomplete_expired",
                plan: subscription.plan,
              },
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
            plan: billingSubscriptions.plan,
            stripeStatus: billingSubscriptions.stripeStatus,
            stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.userId, input.userId))
          .limit(1)
          .for("update");
        if (subscription === undefined) return undefined;
        if (subscription.plan === "adventurer") {
          return { ineligibleReason: "activePlan" } as const;
        }
        if (
          subscription.stripeSubscriptionId !== null &&
          subscription.stripeStatus !== "canceled" &&
          subscription.stripeStatus !== "incomplete_expired"
        ) {
          return { ineligibleReason: "existingStripeSubscription" } as const;
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
        if (existing !== undefined) return decodeCheckout(existing);
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
        return created === undefined ? undefined : decodeCheckout(created);
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

const decodeCheckout = (stored: {
  readonly billingCheckoutSessionId: string;
  readonly state: "complete" | "creating" | "expired" | "failed" | "open";
  readonly stripeCheckoutSessionId: string | null;
}) => ({
  billingCheckoutSessionId: BillingCheckoutSessionId.make(stored.billingCheckoutSessionId),
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
