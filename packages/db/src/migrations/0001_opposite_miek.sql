CREATE TABLE "channel_bindings" (
	"channel_binding_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"channel_identity" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "channel_bindings_provider_check" CHECK ("channel_bindings"."provider" = 'whatsapp')
);
--> statement-breakpoint
CREATE TABLE "registration_invitations" (
	"invitation_id" text PRIMARY KEY NOT NULL,
	"token_digest" text NOT NULL,
	"kind" text DEFAULT 'whatsapp_first' NOT NULL,
	"provider" text NOT NULL,
	"channel_identity" text,
	"invited_phone_number" text,
	"locale" text NOT NULL,
	"state" text DEFAULT 'live' NOT NULL,
	"expiry_reason" text,
	"consumption_digest" text,
	"binding_outcome" text,
	"channel_binding_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "registration_invitations_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "registration_invitations_provider_check" CHECK ("registration_invitations"."provider" = 'whatsapp'),
	CONSTRAINT "registration_invitations_kind_check" CHECK ("registration_invitations"."kind" in ('whatsapp_first', 'web_enrollment')),
	CONSTRAINT "registration_invitations_state_check" CHECK ("registration_invitations"."state" in ('live', 'consumed', 'expired')),
	CONSTRAINT "registration_invitations_expiry_reason_check" CHECK (("registration_invitations"."state" = 'expired' and "registration_invitations"."expiry_reason" in ('elapsed', 'replaced')) or ("registration_invitations"."state" <> 'expired' and "registration_invitations"."expiry_reason" is null)),
	CONSTRAINT "registration_invitations_consumption_digest_check" CHECK (("registration_invitations"."state" = 'consumed' and "registration_invitations"."consumption_digest" is not null) or ("registration_invitations"."state" <> 'consumed' and "registration_invitations"."consumption_digest" is null)),
	CONSTRAINT "registration_invitations_binding_outcome_check" CHECK ("registration_invitations"."binding_outcome" is null or "registration_invitations"."binding_outcome" in ('created', 'existing', 'refused')),
	CONSTRAINT "registration_invitations_binding_receipt_check" CHECK (("registration_invitations"."binding_outcome" in ('created', 'existing') and "registration_invitations"."channel_binding_id" is not null) or ("registration_invitations"."binding_outcome" = 'refused' and "registration_invitations"."channel_binding_id" is null) or ("registration_invitations"."binding_outcome" is null and "registration_invitations"."channel_binding_id" is null)),
	CONSTRAINT "registration_invitations_lifecycle_check" CHECK (("registration_invitations"."state" = 'live' and "registration_invitations"."consumed_at" is null) or ("registration_invitations"."state" = 'consumed' and "registration_invitations"."consumed_at" is not null) or ("registration_invitations"."state" = 'expired' and "registration_invitations"."consumed_at" is null)),
	CONSTRAINT "registration_invitations_expiry_check" CHECK ("registration_invitations"."created_at" < "registration_invitations"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "help_areas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invitations" ADD CONSTRAINT "registration_invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_active_identity_unique" ON "channel_bindings" USING btree ("provider","channel_identity") WHERE "channel_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_active_user_unique" ON "channel_bindings" USING btree ("provider","user_id") WHERE "channel_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "channel_bindings_user_index" ON "channel_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "registration_invitations_expiry_index" ON "registration_invitations" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_live_channel_unique" ON "registration_invitations" USING btree ("provider","channel_identity") WHERE "registration_invitations"."state" = 'live' and "registration_invitations"."channel_identity" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_live_web_user_unique" ON "registration_invitations" USING btree ("user_id","kind") WHERE "registration_invitations"."state" = 'live' and "registration_invitations"."kind" = 'web_enrollment' and "registration_invitations"."user_id" is not null;