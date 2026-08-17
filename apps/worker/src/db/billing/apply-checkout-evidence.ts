import { billingCheckoutSessions, billingCustomers } from "@osfo/db/schema/billing";
import { and, eq, or, sql } from "drizzle-orm";

import type { StripeSubscriptionId } from "../../domain";
import type {
  StripeCheckoutEvidence,
  StripeSubscriptionSnapshot,
} from "../../services/billing-subscriptions";
import type { Database } from "../index";

/* oxlint-disable eslint/no-underscore-dangle -- Effect unions use the standard _tag discriminator. */
/* oxlint-disable effecttsgo/async-function -- Drizzle owns this row-lock Promise boundary. */

/** Execute one application-selected Checkout lifecycle command inside its caller's transaction. */
export const applyCheckoutEvidence = (
  database: Pick<Database, "update">,
  evidence: StripeCheckoutEvidence,
  stripeSubscriptionId: StripeSubscriptionId | null,
) =>
  database
    .update(billingCheckoutSessions)
    .set(
      evidence._tag === "PaymentFailed"
        ? {
            completedAt: null,
            state: "failed",
            stripePaymentStatus: "unpaid",
            stripeCheckoutSessionId: evidence.locator.stripeCheckoutSessionId,
            updatedAt: sql`clock_timestamp()`,
          }
        : {
            completedAt: sql`clock_timestamp()`,
            state: "complete",
            stripePaymentStatus: evidence.paymentStatus,
            stripeCheckoutSessionId: evidence.locator.stripeCheckoutSessionId,
            stripeSubscriptionId,
            updatedAt: sql`clock_timestamp()`,
          },
    )
    .where(
      and(
        evidence.locator._tag === "LocalAttempt"
          ? eq(
              billingCheckoutSessions.billingCheckoutSessionId,
              evidence.locator.billingCheckoutSessionId,
            )
          : eq(
              billingCheckoutSessions.stripeCheckoutSessionId,
              evidence.locator.stripeCheckoutSessionId,
            ),
        or(
          eq(billingCheckoutSessions.state, "creating"),
          eq(billingCheckoutSessions.state, "open"),
        ),
      ),
    );

/** Validate a local Checkout reference against its expected Stripe Session under a row lock. */
export const checkoutEvidenceMatches = async (
  database: Pick<Database, "select">,
  evidence: StripeCheckoutEvidence,
  snapshot?: StripeSubscriptionSnapshot,
): Promise<boolean> => {
  const [stored] = await database
    .select({
      customerId: billingCustomers.stripeCustomerId,
      priceId: billingCheckoutSessions.stripePriceId,
      productId: billingCheckoutSessions.stripeProductId,
      state: billingCheckoutSessions.state,
      stripeCheckoutSessionId: billingCheckoutSessions.stripeCheckoutSessionId,
      userId: billingCheckoutSessions.userId,
    })
    .from(billingCheckoutSessions)
    .innerJoin(
      billingCustomers,
      and(
        eq(billingCustomers.billingCustomerId, billingCheckoutSessions.billingCustomerId),
        eq(billingCustomers.userId, billingCheckoutSessions.userId),
      ),
    )
    .where(
      evidence.locator._tag === "LocalAttempt"
        ? eq(
            billingCheckoutSessions.billingCheckoutSessionId,
            evidence.locator.billingCheckoutSessionId,
          )
        : eq(
            billingCheckoutSessions.stripeCheckoutSessionId,
            evidence.locator.stripeCheckoutSessionId,
          ),
    )
    .for("update")
    .limit(1);
  return (
    stored !== undefined &&
    (snapshot === undefined ||
      (stored.userId === snapshot.userId &&
        stored.customerId === snapshot.customerId &&
        stored.productId === snapshot.productId &&
        stored.priceId === snapshot.priceId)) &&
    (evidence.locator._tag === "StripeSession" ||
      (stored.state === "creating" && stored.stripeCheckoutSessionId === null) ||
      stored.stripeCheckoutSessionId === evidence.locator.stripeCheckoutSessionId)
  );
};
