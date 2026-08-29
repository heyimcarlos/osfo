CREATE TABLE "allowance_zero_usage_evidence" (
	"allowance_period_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"resource_price_version" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "allowance_zero_usage_evidence_pk" PRIMARY KEY("allowance_period_id","source_type","source_id"),
	CONSTRAINT "allowance_zero_usage_evidence_identity_check" CHECK ("allowance_zero_usage_evidence"."reason" = 'provenNoUse' and length(btrim("allowance_zero_usage_evidence"."source_id")) > 0 and length(btrim("allowance_zero_usage_evidence"."source_type")) > 0)
);
--> statement-breakpoint
ALTER TABLE "allowance_usage" ADD COLUMN "resource_price_version" text;--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" ADD COLUMN "allowance_period_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "allowance_zero_usage_evidence" ADD CONSTRAINT "allowance_zero_usage_evidence_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" ADD CONSTRAINT "qualification_root_attempts_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE restrict ON UPDATE no action;