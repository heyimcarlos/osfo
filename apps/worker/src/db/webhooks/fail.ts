import { webhookJobs } from "@osfo/db/schema/webhooks";
import { and, eq, sql } from "drizzle-orm";
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
  attempt: number,
  error_code: string,
  checkoutEvidence: StripeCheckoutEvidence | null,
): Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable> =>
  execute("fail", database, webhookEventId, attempt, checkoutEvidence, async (transaction) => {
    const [updated] = await transaction
      .update(webhookJobs)
      .set({
        error_code: error_code,
        processed_at: null,
        status: "failed",
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        attempt === 0
          ? eq(webhookJobs.webhook_event_id, webhookEventId)
          : and(
              eq(webhookJobs.webhook_event_id, webhookEventId),
              eq(webhookJobs.attempts, attempt),
              eq(webhookJobs.status, "pending"),
            ),
      )
      .returning({ webhookEventId: webhookJobs.webhook_event_id });
    return updated !== undefined;
  });

/** Mark a verified no-op or unsupported event processed. */
export const markProcessed = (
  database: Pick<Database, "transaction">,
  webhookEventId: string,
  attempt: number,
  checkoutEvidence: StripeCheckoutEvidence | null,
): Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable> =>
  execute(
    "markProcessed",
    database,
    webhookEventId,
    attempt,
    checkoutEvidence,
    async (transaction) => {
      const [updated] = await transaction
        .update(webhookJobs)
        .set({
          error_code: null,
          processed_at: sql`clock_timestamp()`,
          status: "processed",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          attempt === 0
            ? eq(webhookJobs.webhook_event_id, webhookEventId)
            : and(
                eq(webhookJobs.webhook_event_id, webhookEventId),
                eq(webhookJobs.attempts, attempt),
                eq(webhookJobs.status, "pending"),
              ),
        )
        .returning({ webhookEventId: webhookJobs.webhook_event_id });
      return updated !== undefined;
    },
  );

const execute = (
  operation: "fail" | "markProcessed",
  database: Pick<Database, "transaction">,
  webhookEventId: string,
  attempt: number,
  checkoutEvidence: StripeCheckoutEvidence | null,
  updateWebhook: (
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  ) => Promise<boolean>,
): Effect.Effect<void, PermanentStripeWebhookFailure | WebhookPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const [claim] = await transaction
          .select({ webhookEventId: webhookJobs.webhook_event_id })
          .from(webhookJobs)
          .where(
            attempt === 0
              ? eq(webhookJobs.webhook_event_id, webhookEventId)
              : and(
                  eq(webhookJobs.webhook_event_id, webhookEventId),
                  eq(webhookJobs.attempts, attempt),
                  eq(webhookJobs.status, "pending"),
                ),
          )
          .for("update")
          .limit(1);
        if (claim === undefined) return true;
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
