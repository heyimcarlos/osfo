CREATE TABLE "qualification_cohorts" (
	"artifact_checksum" text NOT NULL,
	"artifact_id" text NOT NULL,
	"cohort_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_for_qualification" boolean NOT NULL,
	"execution_id" text NOT NULL,
	"expected_adventurer_participants" integer NOT NULL,
	"expected_free_participants" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"manifest_checksum" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"plan_checksum" text NOT NULL,
	"source_version" text NOT NULL,
	"state" text NOT NULL,
	"teardown_policy" text NOT NULL,
	CONSTRAINT "qualification_cohorts_execution_unique" UNIQUE("execution_id"),
	CONSTRAINT "qualification_cohorts_identity_unique" UNIQUE("cohort_id","execution_id"),
	CONSTRAINT "qualification_cohorts_qualification_only_check" CHECK ("qualification_cohorts"."created_for_qualification" and "qualification_cohorts"."teardown_policy" = 'permanentAccountDeletion'),
	CONSTRAINT "qualification_cohorts_time_bounds_check" CHECK ("qualification_cohorts"."created_at" <= "qualification_cohorts"."not_before" and "qualification_cohorts"."not_before" < "qualification_cohorts"."expires_at"),
	CONSTRAINT "qualification_cohorts_counts_check" CHECK ("qualification_cohorts"."expected_free_participants" > 0 and "qualification_cohorts"."expected_adventurer_participants" > 0)
);
--> statement-breakpoint
CREATE TABLE "qualification_participant_allocations" (
	"agent_id" text NOT NULL,
	"allocation_id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_for_qualification" boolean NOT NULL,
	"deleted_at" timestamp with time zone,
	"deletion_case_id" text,
	"deletion_receipt_checksum" text,
	"deletion_receipt_id" text,
	"deletion_requested_at" timestamp with time zone,
	"execution_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grant_checksum" text NOT NULL,
	"grant_id" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"participant_index" integer NOT NULL,
	"plan" text NOT NULL,
	"route_id" text NOT NULL,
	"session_id" text NOT NULL,
	"state" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "qualification_participant_allocations_position_unique" UNIQUE("cohort_id","plan","participant_index"),
	CONSTRAINT "qualification_participant_allocations_user_unique" UNIQUE("user_id"),
	CONSTRAINT "qualification_participant_allocations_agent_unique" UNIQUE("agent_id"),
	CONSTRAINT "qualification_participant_allocations_session_unique" UNIQUE("session_id"),
	CONSTRAINT "qualification_participant_allocations_grant_unique" UNIQUE("grant_id"),
	CONSTRAINT "qualification_participant_allocations_qualification_only_check" CHECK ("qualification_participant_allocations"."created_for_qualification"),
	CONSTRAINT "qualification_participant_allocations_time_bounds_check" CHECK ("qualification_participant_allocations"."created_at" <= "qualification_participant_allocations"."not_before" and "qualification_participant_allocations"."not_before" < "qualification_participant_allocations"."expires_at"),
	CONSTRAINT "qualification_participant_allocations_index_check" CHECK ("qualification_participant_allocations"."participant_index" >= 0),
	CONSTRAINT "qualification_participant_allocations_deletion_check" CHECK (("qualification_participant_allocations"."state" = 'ACTIVE' and "qualification_participant_allocations"."deletion_case_id" is null and "qualification_participant_allocations"."deletion_requested_at" is null and "qualification_participant_allocations"."deleted_at" is null and "qualification_participant_allocations"."deletion_receipt_id" is null and "qualification_participant_allocations"."deletion_receipt_checksum" is null)
        or ("qualification_participant_allocations"."state" = 'DELETION_REQUESTED' and "qualification_participant_allocations"."deletion_case_id" is not null and "qualification_participant_allocations"."deletion_requested_at" is not null and "qualification_participant_allocations"."deleted_at" is null and "qualification_participant_allocations"."deletion_receipt_id" is null and "qualification_participant_allocations"."deletion_receipt_checksum" is null)
        or ("qualification_participant_allocations"."state" = 'DELETED' and "qualification_participant_allocations"."deletion_case_id" is not null and "qualification_participant_allocations"."deletion_requested_at" is not null and "qualification_participant_allocations"."deleted_at" is not null and "qualification_participant_allocations"."deletion_receipt_id" is not null and "qualification_participant_allocations"."deletion_receipt_checksum" is not null))
);
--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" ADD CONSTRAINT "qualification_participant_allocations_cohort_fk" FOREIGN KEY ("cohort_id","execution_id") REFERENCES "public"."qualification_cohorts"("cohort_id","execution_id") ON DELETE restrict ON UPDATE no action;