ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_artifact_checksum" text;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_attempt_count" integer;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_claim_token" text;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_conflict_checksum" text;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_input_checksum" text;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD COLUMN "publication_state" text;--> statement-breakpoint
UPDATE "qualification_cohort_scrub_dispatches"
SET "publication_attempt_count" = 0,
    "publication_next_attempt_at" = coalesce("settled_at", clock_timestamp()),
    "publication_state" = 'PENDING'
WHERE "state" IN ('SETTLED', 'CONFLICT');--> statement-breakpoint
CREATE INDEX "qualification_cohort_scrub_dispatches_publication_due_idx" ON "qualification_cohort_scrub_dispatches" USING btree ("publication_state","publication_next_attempt_at","created_at");--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD CONSTRAINT "qualification_cohort_scrub_dispatches_publication_check" CHECK (("qualification_cohort_scrub_dispatches"."state" = 'PENDING' and "qualification_cohort_scrub_dispatches"."publication_state" is null
          and "qualification_cohort_scrub_dispatches"."publication_attempt_count" is null and "qualification_cohort_scrub_dispatches"."publication_next_attempt_at" is null)
        or ("qualification_cohort_scrub_dispatches"."state" in ('SETTLED', 'CONFLICT') and "qualification_cohort_scrub_dispatches"."publication_state" = 'PENDING'
          and "qualification_cohort_scrub_dispatches"."publication_attempt_count" >= 0 and "qualification_cohort_scrub_dispatches"."publication_next_attempt_at" is not null
          and "qualification_cohort_scrub_dispatches"."publication_claim_token" is null and "qualification_cohort_scrub_dispatches"."publication_lease_expires_at" is null
          and "qualification_cohort_scrub_dispatches"."publication_settled_at" is null and "qualification_cohort_scrub_dispatches"."publication_artifact_checksum" is null
          and "qualification_cohort_scrub_dispatches"."publication_conflict_checksum" is null)
        or ("qualification_cohort_scrub_dispatches"."state" in ('SETTLED', 'CONFLICT') and "qualification_cohort_scrub_dispatches"."publication_state" = 'CLAIMED'
          and "qualification_cohort_scrub_dispatches"."publication_attempt_count" > 0 and "qualification_cohort_scrub_dispatches"."publication_next_attempt_at" is not null
          and "qualification_cohort_scrub_dispatches"."publication_claim_token" is not null and "qualification_cohort_scrub_dispatches"."publication_lease_expires_at" is not null
          and "qualification_cohort_scrub_dispatches"."publication_settled_at" is null and "qualification_cohort_scrub_dispatches"."publication_artifact_checksum" is null
          and "qualification_cohort_scrub_dispatches"."publication_conflict_checksum" is null)
        or ("qualification_cohort_scrub_dispatches"."state" in ('SETTLED', 'CONFLICT') and "qualification_cohort_scrub_dispatches"."publication_state" in ('PUBLISHED', 'INELIGIBLE')
          and "qualification_cohort_scrub_dispatches"."publication_attempt_count" >= 0 and "qualification_cohort_scrub_dispatches"."publication_input_checksum" is not null
          and "qualification_cohort_scrub_dispatches"."publication_next_attempt_at" is null
          and "qualification_cohort_scrub_dispatches"."publication_settled_at" is not null and "qualification_cohort_scrub_dispatches"."publication_artifact_checksum" is not null
          and "qualification_cohort_scrub_dispatches"."publication_claim_token" is null and "qualification_cohort_scrub_dispatches"."publication_lease_expires_at" is null
          and "qualification_cohort_scrub_dispatches"."publication_conflict_checksum" is null)
        or ("qualification_cohort_scrub_dispatches"."state" in ('SETTLED', 'CONFLICT') and "qualification_cohort_scrub_dispatches"."publication_state" = 'CONFLICT'
          and "qualification_cohort_scrub_dispatches"."publication_attempt_count" >= 0 and "qualification_cohort_scrub_dispatches"."publication_input_checksum" is not null
          and "qualification_cohort_scrub_dispatches"."publication_next_attempt_at" is null
          and "qualification_cohort_scrub_dispatches"."publication_settled_at" is not null and "qualification_cohort_scrub_dispatches"."publication_artifact_checksum" is null
          and "qualification_cohort_scrub_dispatches"."publication_claim_token" is null and "qualification_cohort_scrub_dispatches"."publication_lease_expires_at" is null
          and "qualification_cohort_scrub_dispatches"."publication_conflict_checksum" is not null));--> statement-breakpoint
ALTER TABLE "qualification_cohort_scrub_dispatches" ADD CONSTRAINT "qualification_cohort_scrub_dispatches_publication_lease_check" CHECK ("qualification_cohort_scrub_dispatches"."publication_lease_expires_at" is null or "qualification_cohort_scrub_dispatches"."publication_next_attempt_at" < "qualification_cohort_scrub_dispatches"."publication_lease_expires_at");
