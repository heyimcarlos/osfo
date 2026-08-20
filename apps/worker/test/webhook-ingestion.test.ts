import { describe, expect, it } from "@effect/vitest";
import { webhookEvents, webhookJobs } from "@osfo/db/schema/webhooks";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import { WebhookIngestion } from "../src/services/webhook-ingestion";

/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Tests use fixed receipt timestamps at the database boundary. */
/* oxlint-disable eslint/no-underscore-dangle -- Effect exits use the standard _tag discriminator. */

describe("Webhook ingestion", () => {
  it.effect("processes one normalized event and makes its duplicate a complete no-op", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const processed: Array<string> = [];
          const ingestion = WebhookIngestion.make({
            database: fixture.database,
            process: (event) =>
              Effect.sync(() => {
                processed.push(event.webhookEventId);
              }),
          });

          yield* ingestion.ingest(event("webhook-first"));
          yield* ingestion.ingest(event("webhook-redelivery"));

          const events = yield* Effect.promise(() => fixture.database.select().from(webhookEvents));
          const jobs = yield* Effect.promise(() => fixture.database.select().from(webhookJobs));

          expect(processed).toEqual(["webhook-first"]);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            event_type: "customer.subscription.updated",
            external_event_id: "evt_1",
            provider: "stripe",
            webhook_event_id: "webhook-first",
          });
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({ status: "processed", webhook_event_id: "webhook-first" });
        }),
      closeTestDatabase,
    ),
  );

  it.effect("keeps failed work pending without restarting it on redelivery", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          let processingAttempts = 0;
          const ingestion = WebhookIngestion.make({
            database: fixture.database,
            process: () => {
              processingAttempts += 1;
              return Effect.fail("downstream unavailable");
            },
          });

          const first = yield* ingestion.ingest(event("webhook-failed")).pipe(Effect.exit);
          yield* ingestion.ingest(event("webhook-redelivery"));
          const jobs = yield* Effect.promise(() => fixture.database.select().from(webhookJobs));

          expect(first._tag).toBe("Failure");
          expect(processingAttempts).toBe(1);
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({ status: "pending", webhook_event_id: "webhook-failed" });
        }),
      closeTestDatabase,
    ),
  );
});

const event = (webhookEventId: string): WebhookIngestion.VerifiedWebhookEvent => ({
  eventType: "customer.subscription.updated",
  externalEventId: "evt_1",
  payloadJson: '{"type":"customer.subscription.updated"}',
  provider: "stripe",
  receivedAt: new Date("2026-08-17T12:00:00.000Z"),
  webhookEventId,
});
