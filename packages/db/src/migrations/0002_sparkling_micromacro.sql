ALTER TABLE "webhook_events" ADD COLUMN "binding_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "resolved_channel_binding_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_resolved_channel_binding_id_channel_bindings_channel_binding_id_fk" FOREIGN KEY ("resolved_channel_binding_id") REFERENCES "public"."channel_bindings"("channel_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_binding_resolution_check" CHECK ("webhook_events"."binding_resolved_at" is not null or "webhook_events"."resolved_channel_binding_id" is null);--> statement-breakpoint
ALTER TABLE "inbound_whatsapp_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "inbound_whatsapp_events" CASCADE;
