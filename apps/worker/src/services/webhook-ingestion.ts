import { webhookEvents, webhookJobs } from "@osfo/db/schema/webhooks";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "../db";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns the atomic transaction Promise boundary. */

/** Provider names accepted by the shared webhook ingestion boundary. */
export const WebhookProvider = Schema.Literal("stripe");

/** Provider names accepted by the shared webhook ingestion boundary. */
export type WebhookProvider = typeof WebhookProvider.Type;

/** One authenticated and provider-decoded event ready for durable ingestion. */
export const VerifiedWebhookEvent = Schema.Struct({
  eventType: Schema.String.check(Schema.isMinLength(1)),
  externalEventId: Schema.String.check(Schema.isMinLength(1)),
  payloadJson: Schema.String,
  provider: WebhookProvider,
  receivedAt: Schema.Date,
  webhookEventId: Schema.String.check(Schema.isMinLength(1)),
});

/** One authenticated and provider-decoded event ready for durable ingestion. */
export type VerifiedWebhookEvent = typeof VerifiedWebhookEvent.Type;

/** Expected failure while storing or processing a verified webhook event. */
export class WebhookIngestionUnavailable extends Schema.TaggedError<WebhookIngestionUnavailable>()(
  "WebhookIngestionUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["complete", "persist", "process"]),
    provider: WebhookProvider,
  },
) {}

/** Shared webhook ingestion operation. */
export interface Interface {
  readonly ingest: (
    event: VerifiedWebhookEvent,
  ) => Effect.Effect<void, WebhookIngestionUnavailable>;
}

/** Construct provider-neutral ingestion with an internal new-event processing gate. */
export const make = <E>(options: {
  readonly database: Pick<Database, "transaction" | "update">;
  readonly process: (event: VerifiedWebhookEvent) => Effect.Effect<void, E>;
}): Interface => ({
  ingest: (event) =>
    persistNew(options.database, event).pipe(
      Effect.flatMap((inserted) =>
        inserted
          ? options.process(event).pipe(
              Effect.mapError(
                (cause) =>
                  new WebhookIngestionUnavailable({
                    cause,
                    message: "The verified webhook event could not be processed",
                    operation: "process",
                    provider: event.provider,
                  }),
              ),
              Effect.andThen(complete(options.database, event)),
            )
          : Effect.void,
      ),
    ),
});

const persistNew = (
  database: Pick<Database, "transaction">,
  event: VerifiedWebhookEvent,
): Effect.Effect<boolean, WebhookIngestionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const [inserted] = await transaction
          .insert(webhookEvents)
          .values({
            event_type: event.eventType,
            external_event_id: event.externalEventId,
            payload_json: event.payloadJson,
            provider: event.provider,
            received_at: event.receivedAt,
            webhook_event_id: event.webhookEventId,
          })
          .onConflictDoNothing({
            target: [webhookEvents.provider, webhookEvents.external_event_id],
          })
          .returning({ webhookEventId: webhookEvents.webhook_event_id });
        if (inserted === undefined) return false;
        await transaction.insert(webhookJobs).values({
          attempts: 1,
          webhook_event_id: inserted.webhookEventId,
        });
        return true;
      }),
    catch: (cause) =>
      new WebhookIngestionUnavailable({
        cause,
        message: "The verified webhook event could not be stored",
        operation: "persist",
        provider: event.provider,
      }),
  });

const complete = (
  database: Pick<Database, "update">,
  event: VerifiedWebhookEvent,
): Effect.Effect<void, WebhookIngestionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database
        .update(webhookJobs)
        .set({
          error_code: null,
          processed_at: sql`clock_timestamp()`,
          status: "processed",
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(webhookJobs.webhook_event_id, event.webhookEventId),
            eq(webhookJobs.attempts, 1),
            eq(webhookJobs.status, "pending"),
          ),
        )
        .then(() => undefined),
    catch: (cause) =>
      new WebhookIngestionUnavailable({
        cause,
        message: "The processed webhook event could not be completed",
        operation: "complete",
        provider: event.provider,
      }),
  });

export * as WebhookIngestion from "./webhook-ingestion";
