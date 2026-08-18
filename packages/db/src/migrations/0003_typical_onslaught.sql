ALTER TABLE "telegram_onboarding_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "telegram_onboarding_deliveries" CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_binding_resolution_check";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_provider_check";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_resolved_channel_binding_id_channel_bindings_channel_binding_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "binding_resolved_at";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "resolved_channel_binding_id";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_check" CHECK ("webhook_events"."provider" = 'stripe');