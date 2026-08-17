import { webhookEvents } from "@osfo/db/schema/webhooks";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { BillingCheckoutSessionId } from "../../domain";
import { WebhookPersistenceUnavailable, type ReplayResult } from "../../services/stripe-webhooks";
import type { Database } from "../index";
import { beginAttempt } from "./begin-attempt";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle owns this transaction Promise boundary and domain results use _tag. */

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
        const transition = await beginAttempt(transaction, webhookEventId, stored.status);
        if (transition._tag === "ProcessedDuplicate") return transition;
        return {
          _tag: "Pending",
          attempt: transition.attempt,
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
