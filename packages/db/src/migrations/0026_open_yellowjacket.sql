ALTER TABLE "scheduled_email_notifications" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "scheduled_email_notifications" ADD COLUMN "send_outcome" text;--> statement-breakpoint
UPDATE "scheduled_email_notifications" n
SET "state" = se."state", "send_outcome" = se."send_outcome"
FROM "scheduled_emails" se
WHERE se."workflow_id" = n."workflow_id";--> statement-breakpoint
ALTER TABLE "scheduled_email_notifications" ALTER COLUMN "state" SET NOT NULL;
