CREATE TABLE "research_report_synthesis_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"state" text NOT NULL,
	"model_route" text NOT NULL,
	"model_access_policy_version" text NOT NULL,
	"resource_price_version" text NOT NULL,
	"result_key" text,
	"result_digest" text,
	"company_cost_json" text,
	"safe_failure_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_report_synthesis_identity_check" CHECK (length(btrim("research_report_synthesis_operations"."operation_id")) > 0
        and "research_report_synthesis_operations"."input_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("research_report_synthesis_operations"."model_route")) > 0
        and length(btrim("research_report_synthesis_operations"."model_access_policy_version")) > 0
        and length(btrim("research_report_synthesis_operations"."resource_price_version")) > 0
        and "research_report_synthesis_operations"."attempt_count" >= 0),
	CONSTRAINT "research_report_synthesis_state_check" CHECK ("research_report_synthesis_operations"."state" in ('pending', 'completed', 'unknown', 'failed', 'canceled')
        and ("research_report_synthesis_operations"."company_cost_json" is null or jsonb_typeof("research_report_synthesis_operations"."company_cost_json"::jsonb) = 'object')
        and ("research_report_synthesis_operations"."state" <> 'completed' or ("research_report_synthesis_operations"."result_key" is not null
          and "research_report_synthesis_operations"."result_digest" ~ '^[0-9a-f]{64}$'
          and "research_report_synthesis_operations"."company_cost_json" is not null
          and "research_report_synthesis_operations"."completed_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "research_report_synthesis_operations" ADD CONSTRAINT "research_report_synthesis_operations_workflow_id_research_reports_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."research_reports"("workflow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_report_synthesis_workflow_unique" ON "research_report_synthesis_operations" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "research_report_synthesis_workflow_state_index" ON "research_report_synthesis_operations" USING btree ("workflow_id","state");