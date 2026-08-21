CREATE TABLE "channel_link_audit_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"invite_id" text,
	"channel_link_id" text,
	"user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_link_audit_events_type_check" CHECK ("channel_link_audit_events"."event_type" in ('invite_issued', 'link_accepted', 'accept_conflict', 'link_revoked')),
	CONSTRAINT "channel_link_audit_events_actor_check" CHECK (length(btrim("channel_link_audit_events"."actor_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "channel_link_invites" (
	"invite_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"token_version" integer NOT NULL,
	"signing_key_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"accepted_channel_link_id" text,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "channel_link_invites_token_version_check" CHECK ("channel_link_invites"."token_version" > 0),
	CONSTRAINT "channel_link_invites_expiry_check" CHECK ("channel_link_invites"."created_at" < "channel_link_invites"."expires_at"),
	CONSTRAINT "channel_link_invites_state_check" CHECK ("channel_link_invites"."state" in ('pending', 'accepted', 'expired', 'cancelled', 'superseded')),
	CONSTRAINT "channel_link_invites_lifecycle_check" CHECK (("channel_link_invites"."state" = 'pending' and "channel_link_invites"."accepted_at" is null and "channel_link_invites"."accepted_user_id" is null and "channel_link_invites"."accepted_channel_link_id" is null and "channel_link_invites"."expired_at" is null and "channel_link_invites"."cancelled_at" is null and "channel_link_invites"."superseded_at" is null)
        or ("channel_link_invites"."state" = 'accepted' and "channel_link_invites"."accepted_at" is not null and "channel_link_invites"."accepted_user_id" is not null and "channel_link_invites"."accepted_channel_link_id" is not null and "channel_link_invites"."expired_at" is null and "channel_link_invites"."cancelled_at" is null and "channel_link_invites"."superseded_at" is null)
        or ("channel_link_invites"."state" = 'expired' and "channel_link_invites"."accepted_at" is null and "channel_link_invites"."accepted_user_id" is null and "channel_link_invites"."accepted_channel_link_id" is null and "channel_link_invites"."expired_at" is not null and "channel_link_invites"."cancelled_at" is null and "channel_link_invites"."superseded_at" is null)
        or ("channel_link_invites"."state" = 'cancelled' and "channel_link_invites"."accepted_at" is null and "channel_link_invites"."accepted_user_id" is null and "channel_link_invites"."accepted_channel_link_id" is null and "channel_link_invites"."expired_at" is null and "channel_link_invites"."cancelled_at" is not null and "channel_link_invites"."superseded_at" is null)
        or ("channel_link_invites"."state" = 'superseded' and "channel_link_invites"."accepted_at" is null and "channel_link_invites"."accepted_user_id" is null and "channel_link_invites"."accepted_channel_link_id" is null and "channel_link_invites"."expired_at" is null and "channel_link_invites"."cancelled_at" is null and "channel_link_invites"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"channel_link_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revocation_reason" text,
	CONSTRAINT "channel_links_revocation_check" CHECK (("channel_links"."revoked_at" is null and "channel_links"."revoked_by" is null and "channel_links"."revocation_reason" is null)
        or ("channel_links"."revoked_at" is not null and "channel_links"."revoked_by" is not null and "channel_links"."revocation_reason" is not null and length(btrim("channel_links"."revoked_by")) > 0 and length(btrim("channel_links"."revocation_reason")) between 1 and 200))
);
--> statement-breakpoint
DROP TABLE "channel_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "registration_invitations" CASCADE;--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" ADD CONSTRAINT "channel_link_audit_events_invite_id_channel_link_invites_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."channel_link_invites"("invite_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" ADD CONSTRAINT "channel_link_audit_events_channel_link_id_channel_links_channel_link_id_fk" FOREIGN KEY ("channel_link_id") REFERENCES "public"."channel_links"("channel_link_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" ADD CONSTRAINT "channel_link_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_invites" ADD CONSTRAINT "channel_link_invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_invites" ADD CONSTRAINT "channel_link_invites_accepted_channel_link_id_channel_links_channel_link_id_fk" FOREIGN KEY ("accepted_channel_link_id") REFERENCES "public"."channel_links"("channel_link_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_link_audit_events_invite_index" ON "channel_link_audit_events" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "channel_link_audit_events_link_index" ON "channel_link_audit_events" USING btree ("channel_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_link_invites_pending_address_unique" ON "channel_link_invites" USING btree ("channel_id","author_id") WHERE "channel_link_invites"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "channel_link_invites_expiry_index" ON "channel_link_invites" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_active_address_unique" ON "channel_links" USING btree ("channel_id","author_id") WHERE "channel_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "channel_links_user_index" ON "channel_links" USING btree ("user_id");
