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
  stripe_subscription_id: StripeSubscriptionId | null,
) =>
  database
    .update(billingCheckoutSessions)
    .set(
      evidence._tag === "PaymentFailed"
        ? {
            completed_at: null,
            state: "failed",
            stripe_payment_status: "unpaid",
            stripe_checkout_session_id: evidence.locator.stripeCheckoutSessionId,
            updated_at: sql`clock_timestamp()`,
          }
        : {
            completed_at: sql`clock_timestamp()`,
            state: "complete",
            stripe_payment_status: evidence.paymentStatus,
            stripe_checkout_session_id: evidence.locator.stripeCheckoutSessionId,
            stripe_subscription_id: stripe_subscription_id,
            updated_at: sql`clock_timestamp()`,
          },
    )
    .where(
      and(
        evidence.locator._tag === "LocalAttempt"
          ? eq(
              billingCheckoutSessions.billing_checkout_session_id,
              evidence.locator.billingCheckoutSessionId,
            )
          : eq(
              billingCheckoutSessions.stripe_checkout_session_id,
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
      customerId: billingCustomers.stripe_customer_id,
      priceId: billingCheckoutSessions.stripe_price_id,
      productId: billingCheckoutSessions.stripe_product_id,
      state: billingCheckoutSessions.state,
      stripeCheckoutSessionId: billingCheckoutSessions.stripe_checkout_session_id,
      userId: billingCheckoutSessions.user_id,
    })
    .from(billingCheckoutSessions)
    .innerJoin(
      billingCustomers,
      and(
        eq(billingCustomers.billing_customer_id, billingCheckoutSessions.billing_customer_id),
        eq(billingCustomers.user_id, billingCheckoutSessions.user_id),
      ),
    )
    .where(
      evidence.locator._tag === "LocalAttempt"
        ? eq(
            billingCheckoutSessions.billing_checkout_session_id,
            evidence.locator.billingCheckoutSessionId,
          )
        : eq(
            billingCheckoutSessions.stripe_checkout_session_id,
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
