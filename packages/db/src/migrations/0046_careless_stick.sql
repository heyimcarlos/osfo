CREATE TABLE "qualification_cohort_scrub_dispatches" (
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"cohort_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"last_observed_at" timestamp with time zone,
	"last_status" text,
	"last_status_checksum" text,
	"lease_expires_at" timestamp with time zone,
	"protocol_version" text NOT NULL,
	"restart_applied_at" timestamp with time zone,
	"restart_generation" integer DEFAULT 0 NOT NULL,
	"restart_intent_checksum" text,
	"restart_reserved_at" timestamp with time zone,
	"root_checksum" text,
	"root_instance_id" text NOT NULL,
	"settled_at" timestamp with time zone,
	"state" text NOT NULL,
	"terminal_failure_checksum" text,
	CONSTRAINT "qualification_cohort_scrub_dispatches_execution_unique" UNIQUE("execution_id"),
	CONSTRAINT "qualification_cohort_scrub_dispatches_instance_unique" UNIQUE("root_instance_id"),
	CONSTRAINT "qualification_cohort_scrub_dispatches_claim_check" CHECK (("qualification_cohort_scrub_dispatches"."claim_token" is null and "qualification_cohort_scrub_dispatches"."claimed_at" is null and "qualification_cohort_scrub_dispatches"."lease_expires_at" is null)
        or ("qualification_cohort_scrub_dispatches"."claim_token" is not null and "qualification_cohort_scrub_dispatches"."claimed_at" is not null
          and "qualification_cohort_scrub_dispatches"."lease_expires_at" is not null and "qualification_cohort_scrub_dispatches"."claimed_at" < "qualification_cohort_scrub_dispatches"."lease_expires_at")),
	CONSTRAINT "qualification_cohort_scrub_dispatches_restart_check" CHECK ("qualification_cohort_scrub_dispatches"."restart_generation" between 0 and 3
        and (("qualification_cohort_scrub_dispatches"."restart_intent_checksum" is null and "qualification_cohort_scrub_dispatches"."restart_reserved_at" is null
          and "qualification_cohort_scrub_dispatches"."restart_applied_at" is null)
          or ("qualification_cohort_scrub_dispatches"."restart_intent_checksum" is not null and "qualification_cohort_scrub_dispatches"."restart_reserved_at" is not null
            and ("qualification_cohort_scrub_dispatches"."restart_applied_at" is null or "qualification_cohort_scrub_dispatches"."restart_applied_at" >= "qualification_cohort_scrub_dispatches"."restart_reserved_at")))),
	CONSTRAINT "qualification_cohort_scrub_dispatches_terminal_check" CHECK (("qualification_cohort_scrub_dispatches"."state" = 'PENDING' and "qualification_cohort_scrub_dispatches"."settled_at" is null and "qualification_cohort_scrub_dispatches"."root_checksum" is null
          and "qualification_cohort_scrub_dispatches"."terminal_failure_checksum" is null)
        or ("qualification_cohort_scrub_dispatches"."state" = 'SETTLED' and "qualification_cohort_scrub_dispatches"."settled_at" is not null and "qualification_cohort_scrub_dispatches"."root_checksum" is not null
          and "qualification_cohort_scrub_dispatches"."terminal_failure_checksum" is null)
        or ("qualification_cohort_scrub_dispatches"."state" = 'CONFLICT' and "qualification_cohort_scrub_dispatches"."settled_at" is not null and "qualification_cohort_scrub_dispatches"."root_checksum" is null
          and "qualification_cohort_scrub_dispatches"."terminal_failure_checksum" is not null))
);
--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD CONSTRAINT "qualification_cohort_scrub_dispatches_cohort_fk" FOREIGN KEY ("cohort_id","execution_id") REFERENCES "public"."qualification_cohorts"("cohort_id","execution_id") ON DELETE restrict ON UPDATE no action;