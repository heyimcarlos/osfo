CREATE TABLE "relay_principals" (
	"principal_id" uuid PRIMARY KEY,
	"virtual_pass" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_principals_virtual_pass_check" CHECK ("virtual_pass" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_threads" (
	"thread_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"virtual_pass" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_threads_virtual_pass_check" CHECK ("virtual_pass" >= 0)
);
--> statement-breakpoint
INSERT INTO "relay_principals" ("principal_id")
SELECT "principal_id" FROM "principals";--> statement-breakpoint
INSERT INTO "relay_threads" ("thread_id", "principal_id")
SELECT "thread_id", "principal_id" FROM "threads";--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "usage_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "input_units" integer;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "output_units" integer;--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD COLUMN "publication_evidence" jsonb;--> statement-breakpoint
UPDATE "outbox_obligations"
SET "publication_evidence" = jsonb_build_object('type', 'legacyUnavailable')
WHERE "published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "relay_principals_selection_idx" ON "relay_principals" ("virtual_pass","principal_id");--> statement-breakpoint
CREATE INDEX "relay_threads_selection_idx" ON "relay_threads" ("principal_id","virtual_pass","thread_id");--> statement-breakpoint
ALTER TABLE "relay_principals" ADD CONSTRAINT "relay_principals_principal_id_principals_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id");--> statement-breakpoint
ALTER TABLE "relay_threads" ADD CONSTRAINT "relay_threads_NpEhHz2Z964X_fkey" FOREIGN KEY ("thread_id","principal_id") REFERENCES "threads"("thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "relay_threads" ADD CONSTRAINT "relay_threads_principal_id_relay_principals_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "relay_principals"("principal_id");--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_usage_check" CHECK ((
        ("usage_type" = 'unknown'
          AND "input_units" IS NULL
          AND "output_units" IS NULL)
        OR ("usage_type" IN ('reported', 'estimated')
          AND "input_units" >= 0
          AND "output_units" >= 0)
      ));--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_publication_evidence_check" CHECK ("publication_evidence" IS NULL
        OR "publication_evidence" = CASE "publication_evidence" ->> 'type'
          WHEN 'pubsub' THEN jsonb_build_object(
            'type', 'pubsub',
            'providerMessageId', "publication_evidence" ->> 'providerMessageId'
          )
          WHEN 'legacyUnavailable' THEN jsonb_build_object('type', 'legacyUnavailable')
          ELSE NULL
        END);--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP CONSTRAINT "outbox_obligations_publication_claim_check", ADD CONSTRAINT "outbox_obligations_publication_claim_check" CHECK ((
        ("publication_state" = 'pending'
          AND "publication_owner" IS NULL
          AND "publication_lease_expires_at" IS NULL
          AND "publication_evidence" IS NULL
          AND "published_at" IS NULL)
        OR ("publication_state" = 'publishing'
          AND "publication_epoch" > 0
          AND "publication_owner" IS NOT NULL
          AND "publication_lease_expires_at" IS NOT NULL
          AND "publication_evidence" IS NULL
          AND "published_at" IS NULL)
        OR ("publication_state" = 'published'
          AND "publication_owner" IS NULL
          AND "publication_lease_expires_at" IS NULL
          AND "publication_evidence" IS NOT NULL
          AND "published_at" IS NOT NULL)
      ));
