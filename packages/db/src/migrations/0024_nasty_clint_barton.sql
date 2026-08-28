ALTER TABLE "document_build_notifications" DROP CONSTRAINT "document_build_notifications_identity_check";--> statement-breakpoint
ALTER TABLE "document_build_notifications" ADD COLUMN "delivery_session_id" text;--> statement-breakpoint
ALTER TABLE "document_build_notifications" ADD CONSTRAINT "document_build_notifications_identity_check" CHECK (length(btrim("document_build_notifications"."notification_id")) > 0
        and "document_build_notifications"."kind" in ('previewReady', 'terminal')
        and ("document_build_notifications"."delivery_session_id" is null or length(btrim("document_build_notifications"."delivery_session_id")) > 0)
        and (("document_build_notifications"."think_submission_id" is null) = ("document_build_notifications"."delivered_at" is null))
        and ("document_build_notifications"."think_submission_id" is null or (length("document_build_notifications"."think_submission_id") between 1 and 160 and position(':' in "document_build_notifications"."think_submission_id") = 0))
        and ("document_build_notifications"."delivered_at" is null or "document_build_notifications"."delivered_at" >= "document_build_notifications"."claimed_at"));