CREATE TABLE "relay_dispatch_capacity" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"active_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_dispatch_capacity_singleton_check" CHECK ("singleton"),
	CONSTRAINT "relay_dispatch_capacity_active_count_check" CHECK ("active_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relay_publication_attempts" (
	"outbox_id" uuid NOT NULL,
	"publication_epoch" bigint NOT NULL,
	"publication_owner" text NOT NULL,
	"state" text NOT NULL,
	"provider_message_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "relay_publication_attempts_pkey" PRIMARY KEY("outbox_id","publication_epoch"),
	CONSTRAINT "relay_publication_attempts_epoch_check" CHECK ("publication_epoch" > 0),
	CONSTRAINT "relay_publication_attempts_owner_check" CHECK (length("publication_owner") BETWEEN 1 AND 255),
	CONSTRAINT "relay_publication_attempts_state_check" CHECK ("state" IN ('started', 'expired', 'confirmed')),
	CONSTRAINT "relay_publication_attempts_outcome_check" CHECK ((
        ("state" = 'started'
          AND "provider_message_id" IS NULL
          AND "finished_at" IS NULL)
        OR ("state" = 'expired'
          AND "provider_message_id" IS NULL
          AND "finished_at" IS NOT NULL)
        OR ("state" = 'confirmed'
          AND length("provider_message_id") BETWEEN 1 AND 255
          AND "finished_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "relay_publication_tasks" (
	"outbox_id" uuid PRIMARY KEY,
	"publication_state" text DEFAULT 'pending' NOT NULL,
	"publication_epoch" bigint DEFAULT 0 NOT NULL,
	"publication_owner" text,
	"publication_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "relay_publication_tasks_state_check" CHECK ("publication_state" IN ('pending', 'publishing')),
	CONSTRAINT "relay_publication_tasks_epoch_check" CHECK ("publication_epoch" >= 0),
	CONSTRAINT "relay_publication_tasks_claim_check" CHECK ((
        ("publication_state" = 'pending'
          AND "publication_owner" IS NULL
          AND "publication_lease_expires_at" IS NULL)
        OR ("publication_state" = 'publishing'
          AND "publication_epoch" > 0
          AND "publication_owner" IS NOT NULL
          AND "publication_lease_expires_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
INSERT INTO "relay_publication_tasks" (
	"outbox_id",
	"publication_state",
	"publication_epoch",
	"publication_owner",
	"publication_lease_expires_at",
	"created_at"
)
SELECT
	obligation."outbox_id",
	'publishing',
	obligation."publication_epoch",
	obligation."publication_owner",
	obligation."publication_lease_expires_at",
	obligation."created_at"
FROM "outbox_obligations" AS obligation
WHERE obligation."publication_state" = 'publishing';--> statement-breakpoint
INSERT INTO "relay_publication_attempts" (
	"outbox_id",
	"publication_epoch",
	"publication_owner",
	"state",
	"started_at"
)
SELECT
	obligation."outbox_id",
	obligation."publication_epoch",
	obligation."publication_owner",
	'started',
	obligation."created_at"
FROM "outbox_obligations" AS obligation
WHERE obligation."publication_state" = 'publishing';--> statement-breakpoint
INSERT INTO "relay_dispatch_capacity" ("singleton", "active_count")
SELECT true, count(*)::integer FROM "relay_publication_tasks";--> statement-breakpoint
ALTER TABLE "model_call_fragments" DROP CONSTRAINT "model_call_fragments_xcpfh5gecjmq_fkey";--> statement-breakpoint
ALTER TABLE "model_call_fragments" DROP CONSTRAINT "model_call_fragments_OjHiAJFBD5BY_fkey";--> statement-breakpoint
ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_4nEoMtAnEyXF_fkey";--> statement-breakpoint
ALTER TABLE "assistant_outputs" DROP CONSTRAINT "assistant_outputs_agent_run_id_key";--> statement-breakpoint
ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_call_output_run_unique";--> statement-breakpoint
ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_assistant_output_id_key";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP CONSTRAINT "outbox_obligations_publication_state_check";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP CONSTRAINT "outbox_obligations_publication_epoch_check";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP CONSTRAINT "outbox_obligations_publication_claim_check";--> statement-breakpoint
DROP INDEX "outbox_obligations_publication_idx";--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "assistant_output_id" uuid;--> statement-breakpoint
UPDATE "model_call_attempts" AS attempt
SET "assistant_output_id" = call."assistant_output_id"
FROM "model_calls" AS call
WHERE call."model_call_id" = attempt."model_call_id"
  AND call."agent_run_id" = attempt."agent_run_id";--> statement-breakpoint
ALTER TABLE "model_call_attempts" ALTER COLUMN "assistant_output_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_calls" DROP COLUMN "assistant_output_id";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP COLUMN "publication_state";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP COLUMN "publication_epoch";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP COLUMN "publication_owner";--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP COLUMN "publication_lease_expires_at";--> statement-breakpoint
ALTER TABLE "model_call_fragments" DROP CONSTRAINT "model_call_fragments_pkey";--> statement-breakpoint
ALTER TABLE "model_call_fragments" ADD PRIMARY KEY ("model_call_attempt_id","fragment_index");--> statement-breakpoint
ALTER TABLE "assistant_outputs" ADD CONSTRAINT "assistant_outputs_output_run_unique" UNIQUE("assistant_output_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_attempt_authority_unique" UNIQUE("model_call_attempt_id","model_call_id","assistant_output_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "outbox_obligations_unpublished_idx" ON "outbox_obligations" ("created_at","outbox_id") WHERE "published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "relay_publication_tasks_claim_idx" ON "relay_publication_tasks" ("publication_state","publication_lease_expires_at","created_at","outbox_id");--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_1wm6kLGoWOdz_fkey" FOREIGN KEY ("assistant_output_id","agent_run_id") REFERENCES "assistant_outputs"("assistant_output_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "model_call_fragments" ADD CONSTRAINT "model_call_fragments_cyXpceGKC2cG_fkey" FOREIGN KEY ("model_call_attempt_id","model_call_id","assistant_output_id","agent_run_id") REFERENCES "model_call_attempts"("model_call_attempt_id","model_call_id","assistant_output_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "relay_publication_attempts" ADD CONSTRAINT "relay_publication_attempts_uhoIdiDE8hP9_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_obligations"("outbox_id");--> statement-breakpoint
ALTER TABLE "relay_publication_tasks" ADD CONSTRAINT "relay_publication_tasks_Muo6sGTuNsgz_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_obligations"("outbox_id");--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_publication_check" CHECK ((
        ("publication_evidence" IS NULL AND "published_at" IS NULL)
        OR ("publication_evidence" IS NOT NULL AND "published_at" IS NOT NULL)
      ));
