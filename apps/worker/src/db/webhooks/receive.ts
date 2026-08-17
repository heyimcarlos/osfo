import { webhookEvents } from "@osfo/db/schema/webhooks";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  WebhookPersistenceUnavailable,
  type ReceiveResult,
  type VerifiedStripeEvent,
} from "../../services/stripe-webhooks";
import type { Database } from "../index";
import { beginAttempt } from "./begin-attempt";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns this transaction Promise boundary. */

/** Insert or find one verified Stripe event and begin one processing attempt. */
export const receive = (
  database: Pick<Database, "transaction">,
  webhookEventId: string,
  event: VerifiedStripeEvent,
): Effect.Effect<ReceiveResult, WebhookPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        await transaction
          .insert(webhookEvents)
          .values({
            billingCheckoutSessionId: event.billingCheckoutSessionId,
            eventType: event.type,
            externalEventId: event.externalEventId,
            externalObjectId: event.externalObjectId,
            provider: "stripe",
            webhookEventId,
          })
          .onConflictDoNothing({
            target: [webhookEvents.provider, webhookEvents.externalEventId],
          });
        const [stored] = await transaction
          .select({
            status: webhookEvents.status,
            webhookEventId: webhookEvents.webhookEventId,
          })
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.provider, "stripe"),
              eq(webhookEvents.externalEventId, event.externalEventId),
            ),
          )
          .for("update")
          .limit(1);
        if (stored === undefined) return undefined;
        return beginAttempt(transaction, stored.webhookEventId, stored.status);
      }),
    catch: (cause) =>
      new WebhookPersistenceUnavailable({
        cause,
        message: "PostgreSQL could not receive the verified webhook event",
        operation: "receive",
      }),
  }).pipe(
    Effect.flatMap((receipt) =>
      receipt === undefined
        ? Effect.fail(
            new WebhookPersistenceUnavailable({
              cause: { event },
              message: "PostgreSQL could not receive the verified webhook event",
              operation: "receive",
            }),
          )
        : Effect.succeed(receipt),
    ),
  );
