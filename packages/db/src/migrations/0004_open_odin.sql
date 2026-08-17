CREATE TABLE "telegram_onboarding_deliveries" (
	"event_id" text PRIMARY KEY NOT NULL,
	"claim_token" text NOT NULL,
	"state" text DEFAULT 'not_applied' NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "telegram_onboarding_deliveries_state_check" CHECK ("telegram_onboarding_deliveries"."state" in ('not_applied', 'prepared', 'ambiguous', 'applied')),
	CONSTRAINT "telegram_onboarding_deliveries_lifecycle_check" CHECK (("telegram_onboarding_deliveries"."state" in ('not_applied', 'prepared') and "telegram_onboarding_deliveries"."lease_expires_at" is not null and "telegram_onboarding_deliveries"."applied_at" is null) or ("telegram_onboarding_deliveries"."state" = 'ambiguous' and "telegram_onboarding_deliveries"."lease_expires_at" is null and "telegram_onboarding_deliveries"."applied_at" is null) or ("telegram_onboarding_deliveries"."state" = 'applied' and "telegram_onboarding_deliveries"."lease_expires_at" is null and "telegram_onboarding_deliveries"."applied_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "channel_bindings" DROP CONSTRAINT "channel_bindings_provider_check";--> statement-breakpoint
ALTER TABLE "registration_invitations" DROP CONSTRAINT "registration_invitations_provider_check";--> statement-breakpoint
ALTER TABLE "registration_invitations" DROP CONSTRAINT "registration_invitations_kind_check";--> statement-breakpoint
ALTER TABLE "inbound_whatsapp_events" DROP CONSTRAINT "inbound_whatsapp_events_phone_number_id_provider_message_id_pk";--> statement-breakpoint
ALTER TABLE "inbound_whatsapp_events" ADD COLUMN "provider" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_whatsapp_events" ADD CONSTRAINT "inbound_whatsapp_events_provider_phone_number_id_provider_message_id_pk" PRIMARY KEY("provider","phone_number_id","provider_message_id");--> statement-breakpoint
ALTER TABLE "registration_invitations" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_provider_event_unique" ON "registration_invitations" USING btree ("provider","provider_event_id") WHERE "registration_invitations"."provider_event_id" is not null;--> statement-breakpoint
ALTER TABLE "inbound_whatsapp_events" ADD CONSTRAINT "inbound_provider_events_provider_check" CHECK ("inbound_whatsapp_events"."provider" in ('telegram', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_provider_check" CHECK ("channel_bindings"."provider" in ('telegram', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "registration_invitations" ADD CONSTRAINT "registration_invitations_provider_check" CHECK ("registration_invitations"."provider" in ('telegram', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "registration_invitations" ADD CONSTRAINT "registration_invitations_kind_check" CHECK ("registration_invitations"."kind" in ('telegram_first', 'whatsapp_first', 'web_enrollment'));
