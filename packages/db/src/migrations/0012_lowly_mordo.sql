CREATE TABLE "whatsapp_wakeups" (
	"wakeup_id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_link_id" text NOT NULL,
	"endpoint_fingerprint" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_committed_at" timestamp with time zone NOT NULL,
	"locale" text NOT NULL,
	"template_policy_version" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider_outcome" text,
	"provider_message_id_hash" text,
	"safe_failure_class" text,
	"trace_id" text NOT NULL,
	"lease_id" text,
	"lease_expires_at" timestamp with time zone,
	"requested_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"consume_requested_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_wakeups_identity_check" CHECK (length(btrim("whatsapp_wakeups"."wakeup_id")) > 0
        and "whatsapp_wakeups"."fingerprint" ~ '^[0-9a-f]{64}$'
        and "whatsapp_wakeups"."endpoint_fingerprint" ~ '^[0-9a-f]{64}$'
        and length(btrim("whatsapp_wakeups"."source_identity")) > 0
        and length(btrim("whatsapp_wakeups"."template_policy_version")) > 0
        and length(btrim("whatsapp_wakeups"."trace_id")) > 0),
	CONSTRAINT "whatsapp_wakeups_source_kind_check" CHECK ("whatsapp_wakeups"."source_kind" in ('reminder', 'researchReport', 'documentBuild', 'scheduledEmail')),
	CONSTRAINT "whatsapp_wakeups_locale_check" CHECK ("whatsapp_wakeups"."locale" in ('en', 'es')),
	CONSTRAINT "whatsapp_wakeups_state_check" CHECK ("whatsapp_wakeups"."state" in ('pending', 'requested', 'accepted', 'rejected', 'ambiguous', 'consumed', 'canceled')),
	CONSTRAINT "whatsapp_wakeups_provider_outcome_check" CHECK ("whatsapp_wakeups"."provider_outcome" is null or "whatsapp_wakeups"."provider_outcome" in ('accepted', 'rejected', 'ambiguous')),
	CONSTRAINT "whatsapp_wakeups_failure_class_check" CHECK ("whatsapp_wakeups"."safe_failure_class" is null or "whatsapp_wakeups"."safe_failure_class" in ('providerRejected', 'providerTimeout', 'connectionLost', 'malformedSuccess', 'authorityLost', 'sourceCanceled', 'endpointSuspended', 'accountDeletion', 'inboundBeforeSend')),
	CONSTRAINT "whatsapp_wakeups_lease_check" CHECK (("whatsapp_wakeups"."lease_id" is null and "whatsapp_wakeups"."lease_expires_at" is null)
        or ("whatsapp_wakeups"."state" = 'pending' and "whatsapp_wakeups"."lease_id" is not null and length(btrim("whatsapp_wakeups"."lease_id")) > 0 and "whatsapp_wakeups"."lease_expires_at" is not null)),
	CONSTRAINT "whatsapp_wakeups_lifecycle_check" CHECK (("whatsapp_wakeups"."state" = 'pending'
          and "whatsapp_wakeups"."provider_outcome" is null and "whatsapp_wakeups"."requested_at" is null
          and "whatsapp_wakeups"."settled_at" is null and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" = 'requested'
          and "whatsapp_wakeups"."provider_outcome" is null and "whatsapp_wakeups"."requested_at" is not null
          and "whatsapp_wakeups"."settled_at" is null and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" in ('accepted', 'ambiguous')
          and "whatsapp_wakeups"."provider_outcome" = "whatsapp_wakeups"."state" and "whatsapp_wakeups"."requested_at" is not null
          and "whatsapp_wakeups"."settled_at" is not null and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" = 'rejected'
          and "whatsapp_wakeups"."provider_outcome" = 'rejected' and "whatsapp_wakeups"."safe_failure_class" = 'providerRejected'
          and "whatsapp_wakeups"."requested_at" is not null and "whatsapp_wakeups"."settled_at" is not null
          and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" = 'consumed'
          and "whatsapp_wakeups"."consumed_at" is not null and "whatsapp_wakeups"."canceled_at" is null
          and ("whatsapp_wakeups"."provider_outcome" is null or "whatsapp_wakeups"."provider_outcome" in ('accepted', 'ambiguous')))
        or ("whatsapp_wakeups"."state" = 'canceled'
          and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is not null
          and ("whatsapp_wakeups"."provider_outcome" is null or "whatsapp_wakeups"."provider_outcome" in ('accepted', 'ambiguous'))))
);
--> statement-breakpoint
ALTER TABLE "account_deletion_actions" DROP CONSTRAINT "account_deletion_actions_lifecycle_check";--> statement-breakpoint
ALTER TABLE "whatsapp_wakeups" ADD CONSTRAINT "whatsapp_wakeups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_wakeups" ADD CONSTRAINT "whatsapp_wakeups_channel_link_id_channel_links_channel_link_id_fk" FOREIGN KEY ("channel_link_id") REFERENCES "public"."channel_links"("channel_link_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_wakeups_active_user_unique" ON "whatsapp_wakeups" USING btree ("user_id") WHERE "whatsapp_wakeups"."state" in ('pending', 'requested', 'accepted', 'ambiguous');--> statement-breakpoint
CREATE INDEX "whatsapp_wakeups_pending_lease_index" ON "whatsapp_wakeups" USING btree ("state","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_wakeups_channel_link_index" ON "whatsapp_wakeups" USING btree ("channel_link_id","state");--> statement-breakpoint
ALTER TABLE "account_deletion_actions" ADD CONSTRAINT "account_deletion_actions_lifecycle_check" CHECK ("account_deletion_actions"."expires_at" > "account_deletion_actions"."created_at"
        and ("account_deletion_actions"."consumed_at" is null or "account_deletion_actions"."consumed_at" >= "account_deletion_actions"."created_at")
        and ("account_deletion_actions"."invalidated_at" is null or "account_deletion_actions"."invalidated_at" >= "account_deletion_actions"."created_at")
        and ("account_deletion_actions"."consumed_at" is null or "account_deletion_actions"."invalidated_at" is null)
        and (("account_deletion_actions"."consumed_at" is null and "account_deletion_actions"."deletion_case_id" is null)
          or ("account_deletion_actions"."consumed_at" is not null and "account_deletion_actions"."deletion_case_id" is not null and length(btrim("account_deletion_actions"."deletion_case_id")) > 0)));