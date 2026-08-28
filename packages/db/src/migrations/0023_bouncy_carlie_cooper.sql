CREATE TABLE "document_build_notifications" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"think_submission_id" text,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "document_build_notifications_identity_check" CHECK (length(btrim("document_build_notifications"."notification_id")) > 0
        and "document_build_notifications"."kind" in ('previewReady', 'terminal')
        and (("document_build_notifications"."think_submission_id" is null) = ("document_build_notifications"."delivered_at" is null))
        and ("document_build_notifications"."think_submission_id" is null or (length("document_build_notifications"."think_submission_id") between 1 and 160 and position(':' in "document_build_notifications"."think_submission_id") = 0))
        and ("document_build_notifications"."delivered_at" is null or "document_build_notifications"."delivered_at" >= "document_build_notifications"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "document_builds" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"route_id" text NOT NULL,
	"session_id" text NOT NULL,
	"originating_authority_json" text NOT NULL,
	"input_digest" text NOT NULL,
	"request_json" text NOT NULL,
	"state" text NOT NULL,
	"allowance_period_id" text NOT NULL,
	"plan_policy_version" text NOT NULL,
	"capability_catalog_version" text NOT NULL,
	"model_access_policy_version" text NOT NULL,
	"model_route" text NOT NULL,
	"resource_price_version" text NOT NULL,
	"manifest_version" text,
	"cloudflare_instance_id" text NOT NULL,
	"cloudflare_timer_instance_id" text NOT NULL,
	"artifact_content_id" text,
	"cost_evidence_json" text,
	"safe_failure_code" text,
	"admitted_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"preview_stored_at" timestamp with time zone,
	"accounting_committed_at" timestamp with time zone,
	"publication_committed_at" timestamp with time zone,
	"artifact_accounted_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"milestone_claimed_at" timestamp with time zone,
	"milestone_followup_at" timestamp with time zone,
	"terminal_followup_claimed_at" timestamp with time zone,
	"terminal_followup_at" timestamp with time zone,
	"wakeup_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_builds_identity_check" CHECK (length(btrim("document_builds"."workflow_id")) > 0
        and length(btrim("document_builds"."action_id")) > 0
        and length(btrim("document_builds"."user_id")) > 0
        and length(btrim("document_builds"."agent_id")) > 0
        and length(btrim("document_builds"."route_id")) > 0
        and length(btrim("document_builds"."session_id")) > 0
        and "document_builds"."input_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("document_builds"."cloudflare_instance_id")) > 0
        and length(btrim("document_builds"."cloudflare_timer_instance_id")) > 0),
	CONSTRAINT "document_builds_policy_check" CHECK (length(btrim("document_builds"."plan_policy_version")) > 0
        and length(btrim("document_builds"."capability_catalog_version")) > 0
        and length(btrim("document_builds"."model_access_policy_version")) > 0
        and length(btrim("document_builds"."model_route")) > 0
        and length(btrim("document_builds"."resource_price_version")) > 0
        and ("document_builds"."manifest_version" is null or length(btrim("document_builds"."manifest_version")) > 0)),
	CONSTRAINT "document_builds_json_check" CHECK (jsonb_typeof("document_builds"."originating_authority_json"::jsonb) = 'object'
        and jsonb_typeof("document_builds"."request_json"::jsonb) = 'object'
        and ("document_builds"."cost_evidence_json" is null or jsonb_typeof("document_builds"."cost_evidence_json"::jsonb) = 'object')),
	CONSTRAINT "document_builds_state_check" CHECK ("document_builds"."state" in ('admitted', 'accepted', 'running', 'preview_stored', 'publication_committed', 'cancel_requested', 'success', 'failure', 'canceled')),
	CONSTRAINT "document_builds_lifecycle_check" CHECK ("document_builds"."deadline_at" > "document_builds"."admitted_at"
        and ("document_builds"."accepted_at" is null or "document_builds"."accepted_at" >= "document_builds"."admitted_at")
        and ("document_builds"."started_at" is null or ("document_builds"."accepted_at" is not null and "document_builds"."started_at" >= "document_builds"."admitted_at"))
        and ("document_builds"."preview_stored_at" is null or "document_builds"."preview_stored_at" >= "document_builds"."admitted_at")
        and ("document_builds"."accounting_committed_at" is null or "document_builds"."accounting_committed_at" >= "document_builds"."preview_stored_at")
        and ("document_builds"."publication_committed_at" is null or "document_builds"."publication_committed_at" >= "document_builds"."accounting_committed_at")
        and ("document_builds"."artifact_accounted_at" is null or "document_builds"."artifact_accounted_at" >= "document_builds"."publication_committed_at")
        and ("document_builds"."cancel_requested_at" is null or "document_builds"."cancel_requested_at" >= "document_builds"."admitted_at")
        and ("document_builds"."terminal_at" is null or "document_builds"."terminal_at" >= "document_builds"."admitted_at")
        and (("document_builds"."state" in ('success', 'failure', 'canceled')) = ("document_builds"."terminal_at" is not null))
        and (("document_builds"."state" in ('failure', 'canceled')) = ("document_builds"."safe_failure_code" is not null))
        and ("document_builds"."safe_failure_code" is null or (length(btrim("document_builds"."safe_failure_code")) between 1 and 120))
        and (("document_builds"."artifact_content_id" is null) = ("document_builds"."preview_stored_at" is null))
        and (("document_builds"."cost_evidence_json" is null) = ("document_builds"."accounting_committed_at" is null))
        and ("document_builds"."state" not in ('running', 'preview_stored', 'publication_committed', 'success', 'failure') or ("document_builds"."accepted_at" is not null and "document_builds"."started_at" is not null))
        and ("document_builds"."state" not in ('preview_stored', 'publication_committed', 'success') or ("document_builds"."artifact_content_id" is not null and "document_builds"."preview_stored_at" is not null))
        and ("document_builds"."state" not in ('publication_committed', 'success') or ("document_builds"."accounting_committed_at" is not null and "document_builds"."publication_committed_at" is not null))
        and ("document_builds"."state" <> 'success' or "document_builds"."artifact_accounted_at" is not null)
        and ("document_builds"."state" in ('publication_committed', 'success', 'canceled') or "document_builds"."publication_committed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "document_build_notifications" ADD CONSTRAINT "document_build_notifications_workflow_id_document_builds_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."document_builds"("workflow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_build_notifications" ADD CONSTRAINT "document_build_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_builds" ADD CONSTRAINT "document_builds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_builds" ADD CONSTRAINT "document_builds_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_build_notifications_workflow_kind_unique" ON "document_build_notifications" USING btree ("workflow_id","kind");--> statement-breakpoint
CREATE INDEX "document_build_notifications_user_claimed_index" ON "document_build_notifications" USING btree ("user_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_builds_instance_unique" ON "document_builds" USING btree ("cloudflare_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_builds_timer_instance_unique" ON "document_builds" USING btree ("cloudflare_timer_instance_id");--> statement-breakpoint
CREATE INDEX "document_builds_user_state_index" ON "document_builds" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "document_builds_deadline_index" ON "document_builds" USING btree ("state","deadline_at");