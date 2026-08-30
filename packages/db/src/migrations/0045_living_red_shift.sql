ALTER TABLE "qualification_cohort_scrub_pages" DROP CONSTRAINT "qualification_cohort_scrub_pages_completion_check";--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_roots" DROP CONSTRAINT "qualification_cohort_scrub_roots_completion_check";--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_pages" ADD COLUMN "artifact_authority_proof_checksum" text;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_roots" ADD COLUMN "artifact_authority_proof_checksum" text;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_pages" ADD CONSTRAINT "qualification_cohort_scrub_pages_completion_check" CHECK (("qualification_cohort_scrub_pages"."completed_at" is null and "qualification_cohort_scrub_pages"."deleted_artifact_count" is null
          and "qualification_cohort_scrub_pages"."deleted_artifacts_checksum" is null and "qualification_cohort_scrub_pages"."page_checksum" is null
          and "qualification_cohort_scrub_pages"."artifact_authority_proof_checksum" is null)
        or ("qualification_cohort_scrub_pages"."completed_at" is not null and "qualification_cohort_scrub_pages"."deleted_artifact_count" is not null
          and "qualification_cohort_scrub_pages"."deleted_artifacts_checksum" is not null and "qualification_cohort_scrub_pages"."page_checksum" is not null
          and "qualification_cohort_scrub_pages"."artifact_authority_proof_checksum" is not null));--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_roots" ADD CONSTRAINT "qualification_cohort_scrub_roots_completion_check" CHECK (("qualification_cohort_scrub_roots"."completed_at" is null and "qualification_cohort_scrub_roots"."deleted_artifact_count" is null
          and "qualification_cohort_scrub_roots"."deleted_artifacts_checksum" is null and "qualification_cohort_scrub_roots"."root_checksum" is null
          and "qualification_cohort_scrub_roots"."artifact_authority_proof_checksum" is null)
        or ("qualification_cohort_scrub_roots"."completed_at" is not null and "qualification_cohort_scrub_roots"."deleted_artifact_count" is not null
          and "qualification_cohort_scrub_roots"."deleted_artifacts_checksum" is not null and "qualification_cohort_scrub_roots"."root_checksum" is not null
          and "qualification_cohort_scrub_roots"."artifact_authority_proof_checksum" is not null));
