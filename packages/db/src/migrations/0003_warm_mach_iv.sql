CREATE TABLE "inbound_whatsapp_events" (
	"binding_resolved_at" timestamp with time zone,
	"channel_identity" text NOT NULL,
	"content_digest" text NOT NULL,
	"message_kind" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_channel_binding_id" text,
	CONSTRAINT "inbound_whatsapp_events_phone_number_id_provider_message_id_pk" PRIMARY KEY("phone_number_id","provider_message_id"),
	CONSTRAINT "inbound_whatsapp_events_message_kind_check" CHECK ("inbound_whatsapp_events"."message_kind" in ('text', 'button_reply')),
	CONSTRAINT "inbound_whatsapp_events_resolution_check" CHECK ("inbound_whatsapp_events"."binding_resolved_at" is not null or "inbound_whatsapp_events"."resolved_channel_binding_id" is null)
);
--> statement-breakpoint
ALTER TABLE "inbound_whatsapp_events" ADD CONSTRAINT "inbound_whatsapp_events_resolved_channel_binding_id_channel_bindings_channel_binding_id_fk" FOREIGN KEY ("resolved_channel_binding_id") REFERENCES "public"."channel_bindings"("channel_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_whatsapp_events_binding_index" ON "inbound_whatsapp_events" USING btree ("resolved_channel_binding_id");