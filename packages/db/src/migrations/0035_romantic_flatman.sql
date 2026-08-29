CREATE TABLE "qualification_cohort_finalization_pages" (
	"cohort_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"first_participant_index" integer NOT NULL,
	"page_index" integer NOT NULL,
	"participant_count" integer NOT NULL,
	"plan" text NOT NULL,
	"receipt_checksum" text NOT NULL,
	"receipt_id" text PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qualification_cohort_finalization_pages_position_unique" UNIQUE("cohort_id","plan","page_index"),
	CONSTRAINT "qualification_cohort_finalization_pages_bounds_check" CHECK ("qualification_cohort_finalization_pages"."page_index" >= 0 and "qualification_cohort_finalization_pages"."first_participant_index" >= 0 and "qualification_cohort_finalization_pages"."participant_count" > 0 and "qualification_cohort_finalization_pages"."participant_count" <= 25)
);
--> statement-breakpoint
ALTER TABLE "qualification_cohort_finalization_pages" ADD CONSTRAINT "qualification_cohort_finalization_pages_cohort_fk" FOREIGN KEY ("cohort_id","execution_id") REFERENCES "public"."qualification_cohorts"("cohort_id","execution_id") ON DELETE restrict ON UPDATE no action;