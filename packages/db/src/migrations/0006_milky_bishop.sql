ALTER TABLE "deletion_cases" DROP CONSTRAINT "deletion_cases_actor_check";--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" DROP CONSTRAINT "channel_link_audit_events_invite_id_channel_link_invites_invite_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" DROP CONSTRAINT "channel_link_audit_events_channel_link_id_channel_links_channel_link_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" DROP CONSTRAINT "channel_link_audit_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_link_invites" DROP CONSTRAINT "channel_link_invites_accepted_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_link_invites" DROP CONSTRAINT "channel_link_invites_accepted_channel_link_id_channel_links_channel_link_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_links" DROP CONSTRAINT "channel_links_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "deletion_cases" ALTER COLUMN "requested_by_admin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" ADD CONSTRAINT "channel_link_audit_events_invite_id_channel_link_invites_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."channel_link_invites"("invite_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" ADD CONSTRAINT "channel_link_audit_events_channel_link_id_channel_links_channel_link_id_fk" FOREIGN KEY ("channel_link_id") REFERENCES "public"."channel_links"("channel_link_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_audit_events" ADD CONSTRAINT "channel_link_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_invites" ADD CONSTRAINT "channel_link_invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_invites" ADD CONSTRAINT "channel_link_invites_accepted_channel_link_id_channel_links_channel_link_id_fk" FOREIGN KEY ("accepted_channel_link_id") REFERENCES "public"."channel_links"("channel_link_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_actor_check" CHECK (("deletion_cases"."requested_by_admin_id" is not null and length(btrim("deletion_cases"."requested_by_admin_id")) > 0 and "deletion_cases"."requested_by_user_id" is null)
        or ("deletion_cases"."requested_by_admin_id" is null and "deletion_cases"."requested_by_user_id" = "deletion_cases"."user_id"));