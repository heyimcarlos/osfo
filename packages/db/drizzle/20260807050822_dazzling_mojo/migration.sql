CREATE TABLE "admission_rejections" (
	"principal_id" uuid,
	"idempotency_key" uuid,
	"thread_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"rejected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admission_rejections_pkey" PRIMARY KEY("principal_id","idempotency_key"),
	CONSTRAINT "admission_rejections_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "admission_rejections" ADD CONSTRAINT "admission_rejections_C2cl8xSJMfpS_fkey" FOREIGN KEY ("thread_id","principal_id") REFERENCES "threads"("thread_id","principal_id");--> statement-breakpoint
CREATE TRIGGER admission_rejections_immutable
BEFORE UPDATE OR DELETE ON admission_rejections
FOR EACH ROW EXECUTE FUNCTION reject_immutable_authority_mutation();
