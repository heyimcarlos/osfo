import { allowancePeriods } from "@osfo/db/schema/allowances";
import { billingCustomers, billingSubscriptions } from "@osfo/db/schema/billing";
import { webhookJobs } from "@osfo/db/schema/webhooks";
import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import { Effect } from "effect";

import { AllowancePeriodId, StripeInvoiceId } from "../../domain";
import type {
  ApplyStripeSnapshotInput,
  ApplyStripeSnapshotResult,
  Persistence,
} from "../../services/billing-subscriptions";
import {
  decideStripeTransition,
  InvalidStripeSnapshot,
} from "../../services/billing-subscriptions";
import type { BillingDatabase } from "./database";
import { applyCheckoutEvidence, checkoutEvidenceMatches } from "./apply-checkout-evidence";
import { runBillingTransaction } from "./transaction";

/* oxlint-disable eslint/no-underscore-dangle -- Effect unions use the standard _tag discriminator. */
/* oxlint-disable effecttsgo/async-function -- Drizzle owns this transaction Promise boundary. */

/** Apply one normalized Stripe snapshot while holding the User's Subscription lock. */
export const applyStripeSnapshot = (
  database: BillingDatabase,
  input: ApplyStripeSnapshotInput,
): ReturnType<Persistence["apply"]> =>
  runBillingTransaction("applyStripeSnapshot", () =>
    database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.user_id, input.snapshot.userId))
        .for("update")
        .limit(1);
      if (current === undefined) return { _tag: "StaleSnapshot" } as const;
      if (current.updated_at.getTime() !== input.expectedUpdatedAt.getTime()) {
        return { _tag: "StaleSnapshot" } as const;
      }

      const now = input.confirmedAt;
      const [activePeriod] = await transaction
        .select()
        .from(allowancePeriods)
        .where(
          and(
            eq(allowancePeriods.user_id, input.snapshot.userId),
            lte(allowancePeriods.starts_at, now),
            gt(allowancePeriods.ends_at, now),
          ),
        )
        .for("update")
        .limit(1);
      const [customer] = await transaction
        .select({
          billingCustomerId: billingCustomers.billing_customer_id,
          stripeCustomerId: billingCustomers.stripe_customer_id,
        })
        .from(billingCustomers)
        .where(eq(billingCustomers.user_id, input.snapshot.userId))
        .limit(1);
      if (
        customer?.stripeCustomerId !== input.snapshot.customerId ||
        (current.stripe_subscription_id !== null &&
          current.stripe_subscription_id !== input.snapshot.subscriptionId &&
          !(
            current.plan === "free" &&
            (current.stripe_status === "canceled" || current.stripe_status === "incomplete_expired")
          ))
      ) {
        return new InvalidStripeSnapshot({
          message: "Stripe subscription identity does not match the local billing projection",
        });
      }
      if (
        input.checkoutEvidence !== null &&
        !(await checkoutEvidenceMatches(transaction, input.checkoutEvidence, input.snapshot))
      ) {
        return new InvalidStripeSnapshot({
          message: "Stripe Checkout identity does not match the local Checkout attempt",
        });
      }
      const decision = decideStripeTransition(
        {
          plan: current.plan,
          stripeCurrentPeriodEnd: current.stripe_current_period_end,
          stripeLatestInvoiceId:
            current.stripe_latest_invoice_id === null
              ? null
              : StripeInvoiceId.make(current.stripe_latest_invoice_id),
        },
        activePeriod === undefined
          ? null
          : {
              allowancePeriodId: AllowancePeriodId.make(activePeriod.allowance_period_id),
              endsAt: activePeriod.ends_at,
              startsAt: activePeriod.starts_at,
            },
        input.snapshot,
        now,
        input.freePeriodEndsAt,
      );

      if (decision.allowance.deleteFutureAdventurerAtOrAfter !== null) {
        await transaction
          .delete(allowancePeriods)
          .where(
            and(
              eq(allowancePeriods.user_id, input.snapshot.userId),
              eq(allowancePeriods.plan, "adventurer"),
              gte(allowancePeriods.starts_at, decision.allowance.deleteFutureAdventurerAtOrAfter),
            ),
          );
      }
      if (decision.allowance.shortenActivePeriod !== null) {
        await transaction
          .update(allowancePeriods)
          .set({ ends_at: decision.allowance.shortenActivePeriod.endsAt })
          .where(
            eq(
              allowancePeriods.allowance_period_id,
              decision.allowance.shortenActivePeriod.allowancePeriodId,
            ),
          );
      }
      if (decision.allowance.deleteActivePeriodId !== null) {
        await transaction
          .delete(allowancePeriods)
          .where(eq(allowancePeriods.allowance_period_id, decision.allowance.deleteActivePeriodId));
      }
      if (decision.allowance.create !== null) {
        await transaction.insert(allowancePeriods).values({
          allowance_period_id: input.allowancePeriodId,
          billing_subscription_id: current.billing_subscription_id,
          created_at: now,
          ends_at: decision.allowance.create.endsAt,
          plan: decision.allowance.create.plan,
          plan_policy_version: current.plan_policy_version,
          starts_at: decision.allowance.create.startsAt,
          stripe_invoice_id: decision.allowance.create.stripeInvoiceId,
          user_id: input.snapshot.userId,
        });
      }

      const result: ApplyStripeSnapshotResult = decision.result;
      if (decision._tag === "Activate") {
        if (input.snapshot.period === null || input.snapshot.payment._tag !== "Paid") {
          return new InvalidStripeSnapshot({
            message: "Paid transition lacks payment evidence",
          });
        }
        const period = input.snapshot.period;
        const payment = input.snapshot.payment;

        await transaction
          .update(billingSubscriptions)
          .set({
            billing_customer_id: customer?.billingCustomerId ?? current.billing_customer_id,
            pending_plan: input.snapshot.cancelAtPeriodEnd ? "free" : null,
            pending_plan_effective_at: input.snapshot.cancelAtPeriodEnd ? period.endsAt : null,
            plan: "adventurer",
            stripe_cancel_at_period_end: input.snapshot.cancelAtPeriodEnd,
            stripe_current_period_end: period.endsAt,
            stripe_current_period_start: period.startsAt,
            stripe_latest_invoice_id: payment.invoiceId,
            stripe_price_id: input.snapshot.priceId,
            stripe_product_id: input.snapshot.productId,
            stripe_status: input.snapshot.status,
            stripe_subscription_id: input.snapshot.subscriptionId,
            updated_at: sql`greatest(clock_timestamp(), ${billingSubscriptions.updated_at} + interval '1 microsecond')`,
          })
          .where(eq(billingSubscriptions.user_id, input.snapshot.userId));
      } else {
        if (decision._tag === "ScheduleDowngrade") {
          await transaction
            .update(billingSubscriptions)
            .set({
              pending_plan: "free",
              pending_plan_effective_at: decision.effectiveAt,
              stripe_cancel_at_period_end: input.snapshot.cancelAtPeriodEnd,
              stripe_current_period_end: current.stripe_current_period_end,
              stripe_current_period_start: current.stripe_current_period_start,
              stripe_latest_invoice_id: current.stripe_latest_invoice_id,
              stripe_price_id: input.snapshot.priceId,
              stripe_product_id: input.snapshot.productId,
              stripe_status: input.snapshot.status,
              stripe_subscription_id: input.snapshot.subscriptionId,
              updated_at: sql`greatest(clock_timestamp(), ${billingSubscriptions.updated_at} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.user_id, input.snapshot.userId));
        } else if (decision._tag === "EndAccess") {
          await transaction
            .update(billingSubscriptions)
            .set({
              pending_plan: null,
              pending_plan_effective_at: null,
              plan: "free",
              stripe_cancel_at_period_end: input.snapshot.cancelAtPeriodEnd,
              stripe_current_period_end: input.snapshot.period?.endsAt ?? null,
              stripe_current_period_start: input.snapshot.period?.startsAt ?? null,
              stripe_latest_invoice_id:
                input.snapshot.payment._tag === "Paid"
                  ? input.snapshot.payment.invoiceId
                  : current.stripe_latest_invoice_id,
              stripe_price_id: input.snapshot.priceId,
              stripe_product_id: input.snapshot.productId,
              stripe_status: input.snapshot.status,
              stripe_subscription_id: input.snapshot.subscriptionId,
              updated_at: sql`greatest(clock_timestamp(), ${billingSubscriptions.updated_at} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.user_id, input.snapshot.userId));
        } else {
          await transaction
            .update(billingSubscriptions)
            .set({
              billing_customer_id: customer.billingCustomerId,
              stripe_cancel_at_period_end: input.snapshot.cancelAtPeriodEnd,
              stripe_current_period_end: input.snapshot.period?.endsAt ?? null,
              stripe_current_period_start: input.snapshot.period?.startsAt ?? null,
              stripe_latest_invoice_id:
                input.snapshot.payment._tag === "Paid"
                  ? input.snapshot.payment.invoiceId
                  : current.stripe_latest_invoice_id,
              stripe_price_id: input.snapshot.priceId,
              stripe_product_id: input.snapshot.productId,
              stripe_status: input.snapshot.status,
              stripe_subscription_id: input.snapshot.subscriptionId,
              updated_at: sql`greatest(clock_timestamp(), ${billingSubscriptions.updated_at} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.user_id, input.snapshot.userId));
        }
      }

      if (input.checkoutEvidence !== null) {
        await applyCheckoutEvidence(
          transaction,
          input.checkoutEvidence,
          input.snapshot.subscriptionId,
        );
      }
      if (input.source._tag === "Webhook") {
        await transaction
          .update(webhookJobs)
          .set({ processed_at: now, status: "processed", updated_at: now })
          .where(
            and(
              eq(webhookJobs.webhook_event_id, input.source.webhookEventId),
              eq(webhookJobs.attempts, input.source.attempt),
              eq(webhookJobs.status, "pending"),
            ),
          );
      }
      return result;
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === "InvalidStripeSnapshot" ? Effect.fail(result) : Effect.succeed(result),
    ),
  );
