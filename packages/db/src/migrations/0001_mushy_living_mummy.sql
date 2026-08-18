CREATE TABLE "webhook_jobs" (
	"attempts" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_event_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "webhook_jobs_attempts_check" CHECK ("webhook_jobs"."attempts" >= 1),
	CONSTRAINT "webhook_jobs_status_check" CHECK ("webhook_jobs"."status" in ('pending', 'processed', 'failed')),
	CONSTRAINT "webhook_jobs_processed_at_check" CHECK (("webhook_jobs"."status" = 'processed') = ("webhook_jobs"."processed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_attempts_check";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_status_check";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_processed_at_check";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "payload_json" text;--> statement-breakpoint
UPDATE "webhook_events"
SET "payload_json" = json_build_object(
	'billingCheckoutSessionId', "billing_checkout_session_id",
	'externalEventId', "external_event_id",
	'externalObjectId', "external_object_id",
	'type', "event_type"
)::text;--> statement-breakpoint
INSERT INTO "webhook_jobs" (
	"attempts", "error_code", "processed_at", "status", "updated_at", "webhook_event_id"
)
SELECT
	greatest("attempts", 1), "error_code", "processed_at", "status", "updated_at", "webhook_event_id"
FROM "webhook_events";--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "payload_json" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_jobs" ADD CONSTRAINT "webhook_jobs_event_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("webhook_event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "billing_checkout_session_id";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "error_code";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "external_object_id";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "processed_at";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_check" CHECK ("webhook_events"."provider" in ('stripe', 'telegram', 'whatsapp'));
