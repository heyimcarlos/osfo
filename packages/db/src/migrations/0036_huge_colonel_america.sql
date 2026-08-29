CREATE TABLE "qualification_root_attempts" (
	"admission_decision" text,
	"admission_fact_id" text,
	"admission_observed_at" timestamp with time zone,
	"agent_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"attempt_id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"journey" text NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"plan_checksum" text NOT NULL,
	"root_id" text NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"state" text NOT NULL,
	"submission_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "qualification_root_attempts_root_unique" UNIQUE("execution_id","root_id"),
	CONSTRAINT "qualification_root_attempts_submission_unique" UNIQUE("submission_id"),
	CONSTRAINT "qualification_root_attempts_state_check" CHECK (("qualification_root_attempts"."state" = 'OFFERED' and "qualification_root_attempts"."admission_decision" is null and "qualification_root_attempts"."admission_fact_id" is null and "qualification_root_attempts"."admission_observed_at" is null)
        or ("qualification_root_attempts"."state" = 'DECIDED' and "qualification_root_attempts"."admission_decision" is not null and "qualification_root_attempts"."admission_fact_id" is not null and "qualification_root_attempts"."admission_observed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "qualification_root_attempts" ADD CONSTRAINT "qualification_root_attempts_allocation_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."qualification_participant_allocations"("allocation_id") ON DELETE restrict ON UPDATE no action;