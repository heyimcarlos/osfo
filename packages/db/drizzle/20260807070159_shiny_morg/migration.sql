ALTER TABLE "model_call_attempts" ADD COLUMN "cleanup_disposition" text;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "external_work_may_continue" boolean;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_cleanup_check" CHECK (((("cleanup_disposition" IS NULL AND "external_work_may_continue" IS NULL)
        OR (
          "cleanup_disposition" IN ('completed', 'deadlineExceeded')
          AND "external_work_may_continue" IS NOT NULL
        ))) IS TRUE);
