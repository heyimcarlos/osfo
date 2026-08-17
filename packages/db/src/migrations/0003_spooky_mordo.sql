ALTER TABLE "deletion_cases" DROP CONSTRAINT "deletion_cases_actor_check";--> statement-breakpoint
ALTER TABLE "deletion_cases" DROP CONSTRAINT "deletion_cases_reason_check";--> statement-breakpoint
ALTER TABLE "user_suspension_events" DROP CONSTRAINT "user_suspension_events_actor_check";--> statement-breakpoint
ALTER TABLE "user_suspension_events" DROP CONSTRAINT "user_suspension_events_reason_check";--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_actor_check" CHECK (length(btrim("deletion_cases"."requested_by_admin_id")) > 0);--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_reason_check" CHECK (length(btrim("deletion_cases"."reason")) > 0);--> statement-breakpoint
ALTER TABLE "user_suspension_events" ADD CONSTRAINT "user_suspension_events_actor_check" CHECK (length(btrim("user_suspension_events"."admin_actor_id")) > 0);--> statement-breakpoint
ALTER TABLE "user_suspension_events" ADD CONSTRAINT "user_suspension_events_reason_check" CHECK (length(btrim("user_suspension_events"."reason")) > 0);