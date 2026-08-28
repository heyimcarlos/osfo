ALTER TABLE "research_report_notifications" DROP CONSTRAINT "research_report_notifications_identity_check";--> statement-breakpoint
ALTER TABLE "research_report_notifications" ADD COLUMN "think_submission_id" text;--> statement-breakpoint
ALTER TABLE "research_report_notifications" ADD COLUMN "source_exposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_report_notifications" ADD CONSTRAINT "research_report_notifications_identity_check" CHECK (length(btrim("research_report_notifications"."notification_id")) > 0
        and "research_report_notifications"."kind" in ('sourcesCollected', 'terminal')
        and (("research_report_notifications"."think_submission_id" is null) = ("research_report_notifications"."delivered_at" is null))
        and ("research_report_notifications"."think_submission_id" is null or (length("research_report_notifications"."think_submission_id") between 1 and 160 and position(':' in "research_report_notifications"."think_submission_id") = 0))
        and ("research_report_notifications"."delivered_at" is null or "research_report_notifications"."delivered_at" >= "research_report_notifications"."claimed_at")
        and ("research_report_notifications"."source_exposed_at" is null or ("research_report_notifications"."delivered_at" is not null and "research_report_notifications"."source_exposed_at" >= "research_report_notifications"."delivered_at")));