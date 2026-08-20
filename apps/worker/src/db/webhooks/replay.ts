import { webhookEvents, webhookJobs } from "@osfo/db/schema/webhooks";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  VerifiedStripeEvent,
  WebhookPersistenceUnavailable,
  type ReplayResult,
} from "../../services/stripe-webhooks";
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
            payloadJson: webhookEvents.payload_json,
            provider: webhookEvents.provider,
            status: webhookJobs.status,
          })
          .from(webhookEvents)
          .innerJoin(webhookJobs, eq(webhookJobs.webhook_event_id, webhookEvents.webhook_event_id))
          .where(eq(webhookEvents.webhook_event_id, webhookEventId))
          .for("update")
          .limit(1);
        if (stored === undefined) return undefined;
        const transition = await beginAttempt(transaction, webhookEventId, stored.status);
        if (transition._tag === "ProcessedDuplicate") return transition;
        const event = Schema.decodeSync(Schema.fromJsonString(VerifiedStripeEvent))(
          stored.payloadJson,
        );
        return {
          _tag: "Pending",
          attempt: transition.attempt,
          event: {
            ...event,
            provider: stored.provider,
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
