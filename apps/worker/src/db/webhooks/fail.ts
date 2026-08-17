import { webhookEvents } from "@osfo/db/schema/webhooks";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { StripeCheckoutEvidence } from "../../services/billing-subscriptions";
import {
  PermanentStripeWebhookFailure,
  WebhookPersistenceUnavailable,
} from "../../services/stripe-webhooks";
import { applyCheckoutEvidence, checkoutEvidenceMatches } from "../billing/apply-checkout-evidence";
import type { Database } from "../index";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns these transaction Promise boundaries. */

/** Keep one permanently invalid verified event with a safe error code. */
export const fail = (
  database: Pick<Database, "transaction">,
  webhookEventId: string,
  errorCode: string,
  checkoutEvidence: StripeCheckoutEvidence | null,
): Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable> =>
  execute("fail", database, checkoutEvidence, async (transaction) => {
    await transaction
      .update(webhookEvents)
      .set({
        errorCode,
        processedAt: null,
        status: "failed",
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(webhookEvents.webhookEventId, webhookEventId));
  });

/** Mark a verified no-op or unsupported event processed. */
export const markProcessed = (
  database: Pick<Database, "transaction">,
  webhookEventId: string,
  checkoutEvidence: StripeCheckoutEvidence | null,
): Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable> =>
  execute("markProcessed", database, checkoutEvidence, async (transaction) => {
    await transaction
      .update(webhookEvents)
      .set({
        errorCode: null,
        processedAt: sql`clock_timestamp()`,
        status: "processed",
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(webhookEvents.webhookEventId, webhookEventId));
  });

const execute = (
  operation: "fail" | "markProcessed",
  database: Pick<Database, "transaction">,
  checkoutEvidence: StripeCheckoutEvidence | null,
  updateWebhook: (
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  ) => Promise<void>,
): Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        if (
          checkoutEvidence !== null &&
          !(await checkoutEvidenceMatches(transaction, checkoutEvidence))
        ) {
          return false;
        }
        if (checkoutEvidence !== null) {
          await applyCheckoutEvidence(transaction, checkoutEvidence, null);
        }
        await updateWebhook(transaction);
        return true;
      }),
    catch: (cause) =>
      new WebhookPersistenceUnavailable({
        cause,
        message: `PostgreSQL could not complete ${operation}`,
        operation,
      }),
  }).pipe(
    Effect.flatMap((matched) =>
      matched
        ? Effect.void
        : Effect.fail(
            new PermanentStripeWebhookFailure({
              errorCode: "checkout_identity_mismatch",
              message: "Stripe Checkout identity does not match the local Checkout attempt",
            }),
          ),
    ),
  );
