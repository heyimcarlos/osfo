CREATE TABLE "research_report_notifications" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "research_report_notifications_identity_check" CHECK (length(btrim("research_report_notifications"."notification_id")) > 0
        and "research_report_notifications"."kind" in ('sourcesCollected', 'terminal')
        and ("research_report_notifications"."delivered_at" is null or "research_report_notifications"."delivered_at" >= "research_report_notifications"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "research_report_provider_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"input_digest" text NOT NULL,
	"input_json" text NOT NULL,
	"state" text NOT NULL,
	"result_json" text,
	"safe_failure_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_report_provider_identity_check" CHECK (length(btrim("research_report_provider_operations"."operation_id")) > 0
        and "research_report_provider_operations"."sequence" >= 0
        and "research_report_provider_operations"."input_digest" ~ '^[0-9a-f]{64}$'
        and jsonb_typeof("research_report_provider_operations"."input_json"::jsonb) = 'object'
        and "research_report_provider_operations"."attempt_count" >= 0),
	CONSTRAINT "research_report_provider_state_check" CHECK ("research_report_provider_operations"."state" in ('pending', 'completed', 'unknown', 'failed', 'canceled')
        and ("research_report_provider_operations"."result_json" is null or jsonb_typeof("research_report_provider_operations"."result_json"::jsonb) = 'object')
        and ("research_report_provider_operations"."state" <> 'completed' or ("research_report_provider_operations"."result_json" is not null and "research_report_provider_operations"."completed_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "research_reports" (
	"workflow_id" text PRIMARY KEY NOT NULL,
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
	"source_manifest_key" text,
	"artifact_content_id" text,
	"safe_failure_code" text,
	"admitted_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"sources_committed_at" timestamp with time zone,
	"artifact_stored_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"milestone_claimed_at" timestamp with time zone,
	"milestone_followup_at" timestamp with time zone,
	"terminal_followup_claimed_at" timestamp with time zone,
	"terminal_followup_at" timestamp with time zone,
	"wakeup_requested_at" timestamp with time zone,
	"source_exposed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_reports_identity_check" CHECK (length(btrim("research_reports"."workflow_id")) > 0
        and length(btrim("research_reports"."user_id")) > 0
        and length(btrim("research_reports"."agent_id")) > 0
        and length(btrim("research_reports"."route_id")) > 0
        and length(btrim("research_reports"."session_id")) > 0
        and "research_reports"."input_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("research_reports"."cloudflare_instance_id")) > 0),
	CONSTRAINT "research_reports_policy_check" CHECK (length(btrim("research_reports"."plan_policy_version")) > 0
        and length(btrim("research_reports"."capability_catalog_version")) > 0
        and length(btrim("research_reports"."model_access_policy_version")) > 0
        and length(btrim("research_reports"."model_route")) > 0
        and length(btrim("research_reports"."resource_price_version")) > 0
        and ("research_reports"."manifest_version" is null or length(btrim("research_reports"."manifest_version")) > 0)),
	CONSTRAINT "research_reports_json_check" CHECK (jsonb_typeof("research_reports"."originating_authority_json"::jsonb) = 'object'
        and jsonb_typeof("research_reports"."request_json"::jsonb) = 'object'),
	CONSTRAINT "research_reports_state_check" CHECK ("research_reports"."state" in ('admitted', 'accepted', 'running', 'sources_committed', 'artifact_stored', 'cancel_requested', 'success', 'failure', 'canceled')),
	CONSTRAINT "research_reports_lifecycle_check" CHECK ("research_reports"."deadline_at" > "research_reports"."admitted_at"
        and ("research_reports"."accepted_at" is null or "research_reports"."accepted_at" >= "research_reports"."admitted_at")
        and ("research_reports"."started_at" is null or "research_reports"."started_at" >= "research_reports"."admitted_at")
        and ("research_reports"."sources_committed_at" is null or "research_reports"."sources_committed_at" >= "research_reports"."admitted_at")
        and ("research_reports"."artifact_stored_at" is null or "research_reports"."artifact_stored_at" >= "research_reports"."admitted_at")
        and ("research_reports"."cancel_requested_at" is null or "research_reports"."cancel_requested_at" >= "research_reports"."admitted_at")
        and ("research_reports"."terminal_at" is null or "research_reports"."terminal_at" >= "research_reports"."admitted_at")
        and (("research_reports"."state" in ('success', 'failure', 'canceled')) = ("research_reports"."terminal_at" is not null))
        and ("research_reports"."state" <> 'success' or ("research_reports"."source_manifest_key" is not null and "research_reports"."artifact_content_id" is not null)))
);
--> statement-breakpoint
ALTER TABLE "research_report_notifications" ADD CONSTRAINT "research_report_notifications_workflow_id_research_reports_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."research_reports"("workflow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_report_notifications" ADD CONSTRAINT "research_report_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_report_provider_operations" ADD CONSTRAINT "research_report_provider_operations_workflow_id_research_reports_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."research_reports"("workflow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_report_notifications_workflow_kind_unique" ON "research_report_notifications" USING btree ("workflow_id","kind");--> statement-breakpoint
CREATE INDEX "research_report_notifications_user_claimed_index" ON "research_report_notifications" USING btree ("user_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_report_provider_workflow_sequence_unique" ON "research_report_provider_operations" USING btree ("workflow_id","sequence");--> statement-breakpoint
CREATE INDEX "research_report_provider_workflow_state_index" ON "research_report_provider_operations" USING btree ("workflow_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "research_reports_instance_unique" ON "research_reports" USING btree ("cloudflare_instance_id");--> statement-breakpoint
CREATE INDEX "research_reports_user_state_index" ON "research_reports" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "research_reports_deadline_index" ON "research_reports" USING btree ("state","deadline_at");