CREATE TABLE "usage_event_components" (
	"activity" text NOT NULL,
	"allowance_period_id" text NOT NULL,
	"component_index" integer NOT NULL,
	"component_kind" text NOT NULL,
	"evidence_json" text NOT NULL,
	"rated_cost_usd_micros" bigint NOT NULL,
	"resource_price_version" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	CONSTRAINT "usage_event_components_pk" PRIMARY KEY("allowance_period_id","source_type","source_id","component_index"),
	CONSTRAINT "usage_event_components_positive_cost_check" CHECK ("usage_event_components"."rated_cost_usd_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_event_evidence_references" (
	"allowance_period_id" text NOT NULL,
	"reference" text NOT NULL,
	"reference_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	CONSTRAINT "usage_event_evidence_references_pk" PRIMARY KEY("allowance_period_id","source_type","source_id","reference_kind","reference")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"allowance_period_id" text NOT NULL,
	"capability_catalog_version" text NOT NULL,
	"facts_json" text NOT NULL,
	"manifest_version" text,
	"model_access_policy_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"plan_usage_micros" bigint,
	"rated_cost_usd_micros" bigint,
	"root_operation_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"usage_policy_version" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "usage_events_pk" PRIMARY KEY("allowance_period_id","source_type","source_id"),
	CONSTRAINT "usage_events_charge_consistency_check" CHECK ((
        "usage_events"."outcome" in ('completed', 'useful_partial')
        and "usage_events"."rated_cost_usd_micros" > 0
        and "usage_events"."plan_usage_micros" > 0
      ) or (
        "usage_events"."outcome" in ('failed', 'cancelled')
        and "usage_events"."rated_cost_usd_micros" is null
        and "usage_events"."plan_usage_micros" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "usage_event_components" ADD CONSTRAINT "usage_event_components_event_fk" FOREIGN KEY ("allowance_period_id","source_type","source_id") REFERENCES "public"."usage_events"("allowance_period_id","source_type","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event_evidence_references" ADD CONSTRAINT "usage_event_evidence_references_event_fk" FOREIGN KEY ("allowance_period_id","source_type","source_id") REFERENCES "public"."usage_events"("allowance_period_id","source_type","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_root_operation_index" ON "usage_events" USING btree ("user_id","root_operation_id");--> statement-breakpoint
CREATE INDEX "usage_events_period_outcome_index" ON "usage_events" USING btree ("allowance_period_id","outcome");