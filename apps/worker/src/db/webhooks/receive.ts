import { webhookEvents, webhookJobs } from "@osfo/db/schema/webhooks";
import { Effect, Schema } from "effect";

import {
  WebhookPersistenceUnavailable,
  VerifiedStripeEvent,
  type ReceiveResult,
} from "../../services/stripe-webhooks";
import type { Database } from "../index";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns this transaction Promise boundary. */

const encodePayload = Schema.encodeSync(Schema.fromJsonString(VerifiedStripeEvent));

/** Insert one verified Stripe event and its generic processing job. */
export const receive = (
  database: Pick<Database, "transaction">,
  webhookEventId: string,
  event: VerifiedStripeEvent,
): Effect.Effect<ReceiveResult, WebhookPersistenceUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const [inserted] = await transaction
          .insert(webhookEvents)
          .values({
            eventType: event.type,
            externalEventId: event.externalEventId,
            payloadJson: encodePayload(event),
            provider: "stripe",
            webhookEventId,
          })
          .onConflictDoNothing({
            target: [webhookEvents.provider, webhookEvents.externalEventId],
          })
          .returning({ webhookEventId: webhookEvents.webhookEventId });
        if (inserted === undefined) return { _tag: "ProcessedDuplicate" } as const;
        await transaction.insert(webhookJobs).values({ webhookEventId: inserted.webhookEventId });
        return {
          _tag: "Pending",
          attempt: 1,
          webhookEventId: inserted.webhookEventId,
        } as const;
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
