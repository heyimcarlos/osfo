import { webhookEvents } from "@osfo/db/schema/webhooks";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { BillingCheckoutSessionId } from "../../domain";
import { WebhookPersistenceUnavailable, type ReplayResult } from "../../services/stripe-webhooks";
import type { Database } from "../index";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns this transaction Promise boundary. */

/** Prepare one pending or failed event for the same processing handler and count the attempt. */
export const replay = (
  database: Pick<Database, "transaction">,
  webhookEventId: string,
): Effect.Effect<ReplayResult, WebhookPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const [stored] = await transaction
          .select({
            billingCheckoutSessionId: webhookEvents.billingCheckoutSessionId,
            eventType: webhookEvents.eventType,
            externalEventId: webhookEvents.externalEventId,
            externalObjectId: webhookEvents.externalObjectId,
            provider: webhookEvents.provider,
            status: webhookEvents.status,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.webhookEventId, webhookEventId))
          .for("update")
          .limit(1);
        if (stored === undefined) return undefined;
        if (stored.status === "processed") return { _tag: "ProcessedDuplicate" } as const;
        await transaction
          .update(webhookEvents)
          .set({
            attempts: sql`${webhookEvents.attempts} + 1`,
            errorCode: null,
            status: "pending",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(webhookEvents.webhookEventId, webhookEventId));
        return {
          _tag: "Pending",
          event: {
            billingCheckoutSessionId:
              stored.billingCheckoutSessionId === null
                ? null
                : BillingCheckoutSessionId.make(stored.billingCheckoutSessionId),
            externalEventId: stored.externalEventId,
            externalObjectId: stored.externalObjectId,
            provider: stored.provider,
            type: stored.eventType,
          },
          webhookEventId,
        } as const;
      }),
    catch: (cause) =>
      new WebhookPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not prepare the webhook event replay",
        operation: "replay",
      }),
  }).pipe(
    Effect.flatMap((receipt) =>
      receipt === undefined
        ? Effect.fail(
            new WebhookPersistenceUnavailable({
              cause: { webhookEventId },
              message: "PostgreSQL could not prepare the webhook event replay",
              operation: "replay",
            }),
          )
        : Effect.succeed(receipt),
    ),
  );
