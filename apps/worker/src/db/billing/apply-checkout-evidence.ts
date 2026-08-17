import { billingCheckoutSessions } from "@osfo/db/schema/billing";
import { and, eq, or, sql } from "drizzle-orm";

import type { StripeSubscriptionId } from "../../domain";
import type { StripeCheckoutEvidence } from "../../services/billing-subscriptions";
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
): Promise<boolean> => {
  if (evidence.locator._tag === "StripeSession") return true;
  const [stored] = await database
    .select({ stripeCheckoutSessionId: billingCheckoutSessions.stripeCheckoutSessionId })
    .from(billingCheckoutSessions)
    .where(
      eq(
        billingCheckoutSessions.billingCheckoutSessionId,
        evidence.locator.billingCheckoutSessionId,
      ),
    )
    .for("update")
    .limit(1);
  return (
    stored === undefined ||
    stored.stripeCheckoutSessionId === null ||
    stored.stripeCheckoutSessionId === evidence.locator.stripeCheckoutSessionId
  );
};
