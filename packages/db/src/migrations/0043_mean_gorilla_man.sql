UPDATE "qualification_cohorts" SET "state" = 'PRODUCT_DELETED' WHERE "state" = 'DELETED';--> statement-breakpoint
UPDATE "qualification_cohorts" SET "state" = 'ACTIVE' WHERE "state" = 'DELETING';--> statement-breakpoint
CREATE TABLE "qualification_cohort_scrub_pages" (
	"claim_token" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"cohort_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_artifact_count" integer,
	"deleted_artifacts_checksum" text,
	"deletion_receipts_checksum" text NOT NULL,
	"execution_id" text NOT NULL,
	"expected_artifact_count" integer NOT NULL,
	"expected_artifacts_checksum" text NOT NULL,
	"first_participant_index" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"page_checksum" text,
	"page_index" integer NOT NULL,
	"participant_count" integer NOT NULL,
	"plan" text NOT NULL,
	"previous_page_checksum" text NOT NULL,
	"scrub_page_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "qualification_cohort_scrub_pages_position_unique" UNIQUE("cohort_id","plan","page_index"),
	CONSTRAINT "qualification_cohort_scrub_pages_bounds_check" CHECK ("qualification_cohort_scrub_pages"."page_index" >= 0 and "qualification_cohort_scrub_pages"."first_participant_index" >= 0
        and "qualification_cohort_scrub_pages"."participant_count" > 0 and "qualification_cohort_scrub_pages"."participant_count" <= 25
        and "qualification_cohort_scrub_pages"."expected_artifact_count" > 0),
	CONSTRAINT "qualification_cohort_scrub_pages_time_check" CHECK ("qualification_cohort_scrub_pages"."claimed_at" < "qualification_cohort_scrub_pages"."lease_expires_at"
        and ("qualification_cohort_scrub_pages"."completed_at" is null or "qualification_cohort_scrub_pages"."completed_at" >= "qualification_cohort_scrub_pages"."claimed_at")),
	CONSTRAINT "qualification_cohort_scrub_pages_completion_check" CHECK (("qualification_cohort_scrub_pages"."completed_at" is null and "qualification_cohort_scrub_pages"."deleted_artifact_count" is null
          and "qualification_cohort_scrub_pages"."deleted_artifacts_checksum" is null and "qualification_cohort_scrub_pages"."page_checksum" is null)
        or ("qualification_cohort_scrub_pages"."completed_at" is not null and "qualification_cohort_scrub_pages"."deleted_artifact_count" is not null
          and "qualification_cohort_scrub_pages"."deleted_artifacts_checksum" is not null and "qualification_cohort_scrub_pages"."page_checksum" is not null))
);
--> statement-breakpoint
CREATE TABLE "qualification_cohort_scrub_roots" (
	"claim_token" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"cohort_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_artifact_count" integer,
	"deleted_artifacts_checksum" text,
	"execution_id" text NOT NULL,
	"expected_artifact_count" integer NOT NULL,
	"expected_artifacts_checksum" text NOT NULL,
	"expected_page_count" integer NOT NULL,
	"expected_participant_count" integer NOT NULL,
	"final_page_checksum" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"root_checksum" text,
	"scrub_root_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "qualification_cohort_scrub_roots_cohort_unique" UNIQUE("cohort_id","execution_id"),
	CONSTRAINT "qualification_cohort_scrub_roots_bounds_check" CHECK ("qualification_cohort_scrub_roots"."expected_artifact_count" > 0 and "qualification_cohort_scrub_roots"."expected_page_count" > 0
        and "qualification_cohort_scrub_roots"."expected_participant_count" > 0),
	CONSTRAINT "qualification_cohort_scrub_roots_time_check" CHECK ("qualification_cohort_scrub_roots"."claimed_at" < "qualification_cohort_scrub_roots"."lease_expires_at"
        and ("qualification_cohort_scrub_roots"."completed_at" is null or "qualification_cohort_scrub_roots"."completed_at" >= "qualification_cohort_scrub_roots"."claimed_at")),
	CONSTRAINT "qualification_cohort_scrub_roots_completion_check" CHECK (("qualification_cohort_scrub_roots"."completed_at" is null and "qualification_cohort_scrub_roots"."deleted_artifact_count" is null
          and "qualification_cohort_scrub_roots"."deleted_artifacts_checksum" is null and "qualification_cohort_scrub_roots"."root_checksum" is null)
        or ("qualification_cohort_scrub_roots"."completed_at" is not null and "qualification_cohort_scrub_roots"."deleted_artifact_count" is not null
          and "qualification_cohort_scrub_roots"."deleted_artifacts_checksum" is not null and "qualification_cohort_scrub_roots"."root_checksum" is not null))
);
--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_pages" ADD CONSTRAINT "qualification_cohort_scrub_pages_cohort_fk" FOREIGN KEY ("cohort_id","execution_id") REFERENCES "public"."qualification_cohorts"("cohort_id","execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_roots" ADD CONSTRAINT "qualification_cohort_scrub_roots_cohort_fk" FOREIGN KEY ("cohort_id","execution_id") REFERENCES "public"."qualification_cohorts"("cohort_id","execution_id") ON DELETE restrict ON UPDATE no action;
