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
        .where(eq(billingSubscriptions.userId, input.snapshot.userId))
        .for("update")
        .limit(1);
      if (current === undefined) return { _tag: "StaleSnapshot" } as const;
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        return { _tag: "StaleSnapshot" } as const;
      }

      const now = input.confirmedAt;
      const [activePeriod] = await transaction
        .select()
        .from(allowancePeriods)
        .where(
          and(
            eq(allowancePeriods.userId, input.snapshot.userId),
            lte(allowancePeriods.startsAt, now),
            gt(allowancePeriods.endsAt, now),
          ),
        )
        .for("update")
        .limit(1);
      const [customer] = await transaction
        .select({
          billingCustomerId: billingCustomers.billingCustomerId,
          stripeCustomerId: billingCustomers.stripeCustomerId,
        })
        .from(billingCustomers)
        .where(eq(billingCustomers.userId, input.snapshot.userId))
        .limit(1);
      if (
        customer?.stripeCustomerId !== input.snapshot.customerId ||
        (current.stripeSubscriptionId !== null &&
          current.stripeSubscriptionId !== input.snapshot.subscriptionId &&
          !(
            current.plan === "free" &&
            (current.stripeStatus === "canceled" || current.stripeStatus === "incomplete_expired")
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
          stripeCurrentPeriodEnd: current.stripeCurrentPeriodEnd,
          stripeLatestInvoiceId:
            current.stripeLatestInvoiceId === null
              ? null
              : StripeInvoiceId.make(current.stripeLatestInvoiceId),
        },
        activePeriod === undefined
          ? null
          : {
              allowancePeriodId: AllowancePeriodId.make(activePeriod.allowancePeriodId),
              endsAt: activePeriod.endsAt,
              startsAt: activePeriod.startsAt,
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
              eq(allowancePeriods.userId, input.snapshot.userId),
              eq(allowancePeriods.plan, "adventurer"),
              gte(allowancePeriods.startsAt, decision.allowance.deleteFutureAdventurerAtOrAfter),
            ),
          );
      }
      if (decision.allowance.shortenActivePeriod !== null) {
        await transaction
          .update(allowancePeriods)
          .set({ endsAt: decision.allowance.shortenActivePeriod.endsAt })
          .where(
            eq(
              allowancePeriods.allowancePeriodId,
              decision.allowance.shortenActivePeriod.allowancePeriodId,
            ),
          );
      }
      if (decision.allowance.deleteActivePeriodId !== null) {
        await transaction
          .delete(allowancePeriods)
          .where(eq(allowancePeriods.allowancePeriodId, decision.allowance.deleteActivePeriodId));
      }
      if (decision.allowance.create !== null) {
        await transaction.insert(allowancePeriods).values({
          allowancePeriodId: input.allowancePeriodId,
          billingSubscriptionId: current.billingSubscriptionId,
          createdAt: now,
          endsAt: decision.allowance.create.endsAt,
          plan: decision.allowance.create.plan,
          planPolicyVersion: current.planPolicyVersion,
          startsAt: decision.allowance.create.startsAt,
          stripeInvoiceId: decision.allowance.create.stripeInvoiceId,
          userId: input.snapshot.userId,
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
            billingCustomerId: customer?.billingCustomerId ?? current.billingCustomerId,
            pendingPlan: input.snapshot.cancelAtPeriodEnd ? "free" : null,
            pendingPlanEffectiveAt: input.snapshot.cancelAtPeriodEnd ? period.endsAt : null,
            plan: "adventurer",
            stripeCancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
            stripeCurrentPeriodEnd: period.endsAt,
            stripeCurrentPeriodStart: period.startsAt,
            stripeLatestInvoiceId: payment.invoiceId,
            stripePriceId: input.snapshot.priceId,
            stripeProductId: input.snapshot.productId,
            stripeStatus: input.snapshot.status,
            stripeSubscriptionId: input.snapshot.subscriptionId,
            updatedAt: sql`greatest(clock_timestamp(), ${billingSubscriptions.updatedAt} + interval '1 microsecond')`,
          })
          .where(eq(billingSubscriptions.userId, input.snapshot.userId));
      } else {
        if (decision._tag === "ScheduleDowngrade") {
          await transaction
            .update(billingSubscriptions)
            .set({
              pendingPlan: "free",
              pendingPlanEffectiveAt: decision.effectiveAt,
              stripeCancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
              stripeCurrentPeriodEnd: current.stripeCurrentPeriodEnd,
              stripeCurrentPeriodStart: current.stripeCurrentPeriodStart,
              stripeLatestInvoiceId: current.stripeLatestInvoiceId,
              stripePriceId: input.snapshot.priceId,
              stripeProductId: input.snapshot.productId,
              stripeStatus: input.snapshot.status,
              stripeSubscriptionId: input.snapshot.subscriptionId,
              updatedAt: sql`greatest(clock_timestamp(), ${billingSubscriptions.updatedAt} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.userId, input.snapshot.userId));
        } else if (decision._tag === "EndAccess") {
          await transaction
            .update(billingSubscriptions)
            .set({
              pendingPlan: null,
              pendingPlanEffectiveAt: null,
              plan: "free",
              stripeCancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
              stripeCurrentPeriodEnd: input.snapshot.period?.endsAt ?? null,
              stripeCurrentPeriodStart: input.snapshot.period?.startsAt ?? null,
              stripeLatestInvoiceId:
                input.snapshot.payment._tag === "Paid"
                  ? input.snapshot.payment.invoiceId
                  : current.stripeLatestInvoiceId,
              stripePriceId: input.snapshot.priceId,
              stripeProductId: input.snapshot.productId,
              stripeStatus: input.snapshot.status,
              stripeSubscriptionId: input.snapshot.subscriptionId,
              updatedAt: sql`greatest(clock_timestamp(), ${billingSubscriptions.updatedAt} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.userId, input.snapshot.userId));
        } else {
          await transaction
            .update(billingSubscriptions)
            .set({
              billingCustomerId: customer.billingCustomerId,
              stripeCancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
              stripeCurrentPeriodEnd: input.snapshot.period?.endsAt ?? null,
              stripeCurrentPeriodStart: input.snapshot.period?.startsAt ?? null,
              stripeLatestInvoiceId:
                input.snapshot.payment._tag === "Paid"
                  ? input.snapshot.payment.invoiceId
                  : current.stripeLatestInvoiceId,
              stripePriceId: input.snapshot.priceId,
              stripeProductId: input.snapshot.productId,
              stripeStatus: input.snapshot.status,
              stripeSubscriptionId: input.snapshot.subscriptionId,
              updatedAt: sql`greatest(clock_timestamp(), ${billingSubscriptions.updatedAt} + interval '1 microsecond')`,
            })
            .where(eq(billingSubscriptions.userId, input.snapshot.userId));
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
          .set({ processedAt: now, status: "processed", updatedAt: now })
          .where(
            and(
              eq(webhookJobs.webhookEventId, input.source.webhookEventId),
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
