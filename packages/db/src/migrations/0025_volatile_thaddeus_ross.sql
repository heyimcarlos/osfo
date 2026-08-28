CREATE TABLE "scheduled_email_notifications" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"route_id" text NOT NULL,
	"origin_session_id" text NOT NULL,
	"delivery_session_id" text,
	"plan_policy_version" text NOT NULL,
	"model_access_policy_version" text NOT NULL,
	"model_route" text NOT NULL,
	"resource_price_version" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"think_submission_id" text,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "scheduled_email_notifications_identity_check" CHECK (length(btrim("scheduled_email_notifications"."notification_id")) > 0
        and length(btrim("scheduled_email_notifications"."agent_id")) > 0
        and length(btrim("scheduled_email_notifications"."route_id")) > 0
        and length(btrim("scheduled_email_notifications"."origin_session_id")) > 0
        and ("scheduled_email_notifications"."delivery_session_id" is null or length(btrim("scheduled_email_notifications"."delivery_session_id")) > 0)
        and (("scheduled_email_notifications"."think_submission_id" is null) = ("scheduled_email_notifications"."accepted_at" is null))
        and ("scheduled_email_notifications"."think_submission_id" is null or (length("scheduled_email_notifications"."think_submission_id") between 1 and 160 and position(':' in "scheduled_email_notifications"."think_submission_id") = 0))
        and ("scheduled_email_notifications"."accepted_at" is null or "scheduled_email_notifications"."accepted_at" >= "scheduled_email_notifications"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "scheduled_emails" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"route_id" text NOT NULL,
	"session_id" text NOT NULL,
	"originating_authority_json" text NOT NULL,
	"approval_presentation" text NOT NULL,
	"input_digest" text NOT NULL,
	"request_json" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"allowance_period_id" text NOT NULL,
	"plan_policy_version" text NOT NULL,
	"capability_catalog_version" text NOT NULL,
	"model_access_policy_version" text NOT NULL,
	"model_route" text NOT NULL,
	"resource_price_version" text NOT NULL,
	"manifest_version" text NOT NULL,
	"cloudflare_instance_id" text NOT NULL,
	"provider_log_id" text,
	"provider_resource_id" text,
	"send_outcome" text,
	"safe_failure_code" text,
	"admitted_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"waiting_at" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"send_outcome_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_emails_identity_check" CHECK (length(btrim("scheduled_emails"."workflow_id")) > 0
        and length(btrim("scheduled_emails"."action_id")) > 0
        and length(btrim("scheduled_emails"."user_id")) > 0
        and length(btrim("scheduled_emails"."agent_id")) > 0
        and length(btrim("scheduled_emails"."route_id")) > 0
        and length(btrim("scheduled_emails"."session_id")) > 0
        and "scheduled_emails"."input_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("scheduled_emails"."cloudflare_instance_id")) > 0
        and length("scheduled_emails"."approval_presentation") > 0),
	CONSTRAINT "scheduled_emails_policy_check" CHECK (length(btrim("scheduled_emails"."plan_policy_version")) > 0
        and length(btrim("scheduled_emails"."capability_catalog_version")) > 0
        and length(btrim("scheduled_emails"."model_access_policy_version")) > 0
        and length(btrim("scheduled_emails"."model_route")) > 0
        and length(btrim("scheduled_emails"."resource_price_version")) > 0
        and length(btrim("scheduled_emails"."manifest_version")) > 0),
	CONSTRAINT "scheduled_emails_json_check" CHECK (jsonb_typeof("scheduled_emails"."originating_authority_json"::jsonb) = 'object'
        and jsonb_typeof("scheduled_emails"."approval_presentation"::jsonb) = 'object'
        and jsonb_typeof("scheduled_emails"."request_json"::jsonb) = 'object'),
	CONSTRAINT "scheduled_emails_state_check" CHECK ("scheduled_emails"."state" in ('admitted', 'accepted', 'waiting', 'sending', 'send_pending_reconciliation', 'success', 'failure', 'canceled')),
	CONSTRAINT "scheduled_emails_lifecycle_check" CHECK ("scheduled_emails"."due_at" > "scheduled_emails"."admitted_at"
        and ("scheduled_emails"."accepted_at" is null or "scheduled_emails"."accepted_at" >= "scheduled_emails"."admitted_at")
        and ("scheduled_emails"."waiting_at" is null or "scheduled_emails"."accepted_at" is not null)
        and ("scheduled_emails"."send_started_at" is null or "scheduled_emails"."send_started_at" >= "scheduled_emails"."due_at")
        and ("scheduled_emails"."send_outcome_at" is null or "scheduled_emails"."send_started_at" is not null)
        and ("scheduled_emails"."cancel_requested_at" is null or "scheduled_emails"."cancel_requested_at" >= "scheduled_emails"."admitted_at")
        and (("scheduled_emails"."state" in ('success', 'failure', 'canceled')) = ("scheduled_emails"."terminal_at" is not null))
        and ("scheduled_emails"."state" <> 'send_pending_reconciliation' or ("scheduled_emails"."send_outcome" = 'ambiguous' and "scheduled_emails"."terminal_at" is null))
        and ("scheduled_emails"."state" not in ('sending', 'send_pending_reconciliation', 'success', 'failure') or "scheduled_emails"."send_started_at" is not null)
        and ("scheduled_emails"."state" <> 'success' or ("scheduled_emails"."send_outcome" = 'applied' and "scheduled_emails"."provider_log_id" is not null and "scheduled_emails"."provider_resource_id" is not null))
        and ("scheduled_emails"."safe_failure_code" is null or length(btrim("scheduled_emails"."safe_failure_code")) between 1 and 120))
);
--> statement-breakpoint
ALTER TABLE "scheduled_email_notifications" ADD CONSTRAINT "scheduled_email_notifications_workflow_id_scheduled_emails_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."scheduled_emails"("workflow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_email_notifications" ADD CONSTRAINT "scheduled_email_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_email_notifications_workflow_unique" ON "scheduled_email_notifications" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "scheduled_email_notifications_user_claimed_index" ON "scheduled_email_notifications" USING btree ("user_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_emails_instance_unique" ON "scheduled_emails" USING btree ("cloudflare_instance_id");--> statement-breakpoint
CREATE INDEX "scheduled_emails_user_state_index" ON "scheduled_emails" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "scheduled_emails_due_index" ON "scheduled_emails" USING btree ("state","due_at");