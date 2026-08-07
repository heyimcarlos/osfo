ALTER TABLE "outbox_obligations" ADD COLUMN "predecessor_outbox_id" uuid;--> statement-breakpoint
WITH ordered AS (
	SELECT
		obligation."outbox_id",
		lag(obligation."outbox_id") OVER (
			PARTITION BY receipt."thread_id"
			ORDER BY receipt."thread_position"
		) AS "predecessor_outbox_id"
	FROM "outbox_obligations" AS obligation
	JOIN "acceptance_receipts" AS receipt
		ON receipt."agent_run_id" = obligation."agent_run_id"
)
UPDATE "outbox_obligations" AS obligation
SET "predecessor_outbox_id" = ordered."predecessor_outbox_id"
FROM ordered
WHERE ordered."outbox_id" = obligation."outbox_id";--> statement-breakpoint
CREATE INDEX "acceptance_receipts_thread_position_idx" ON "acceptance_receipts" ("thread_id","thread_position");--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_TBBaUC2FvaVr_fkey" FOREIGN KEY ("predecessor_outbox_id") REFERENCES "outbox_obligations"("outbox_id");--> statement-breakpoint
ALTER TABLE "agent_run_capacity_reservations" DROP CONSTRAINT "agent_run_capacity_reservations_release_check", ADD CONSTRAINT "agent_run_capacity_reservations_release_check" CHECK (((
        ("state" = 'held' AND "released_at" IS NULL)
        OR ("state" = 'released' AND "released_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_claim_check", ADD CONSTRAINT "agent_runs_claim_check" CHECK (((
        ("state" = 'running'
          AND "claim_epoch" > 0
          AND "claim_owner" IS NOT NULL
          AND "lease_expires_at" IS NOT NULL)
        OR ("state" <> 'running'
          AND "claim_owner" IS NULL
          AND "lease_expires_at" IS NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "assistant_outputs" DROP CONSTRAINT "assistant_outputs_terminal_check", ADD CONSTRAINT "assistant_outputs_terminal_check" CHECK (((
        ("state" = 'open'
          AND "interruption_cause" IS NULL
          AND "terminated_at" IS NULL)
        OR ("state" = 'completed'
          AND "interruption_cause" IS NULL
          AND "terminated_at" IS NOT NULL)
        OR ("state" = 'interrupted'
          AND "interruption_cause" = 'modelCallFailed'
          AND "terminated_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "model_call_attempts" DROP CONSTRAINT "model_call_attempts_usage_check", ADD CONSTRAINT "model_call_attempts_usage_check" CHECK (((
        ("usage_type" = 'unknown'
          AND "input_units" IS NULL
          AND "output_units" IS NULL)
        OR ("usage_type" IN ('reported', 'estimated')
          AND "input_units" >= 0
          AND "output_units" >= 0)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "model_call_attempts" DROP CONSTRAINT "model_call_attempts_finished_check", ADD CONSTRAINT "model_call_attempts_finished_check" CHECK (((
        ("state" = 'started' AND "finished_at" IS NULL)
        OR ("state" <> 'started' AND "finished_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_outcome_check", ADD CONSTRAINT "model_calls_outcome_check" CHECK (((
        ("state" = 'pending'
          AND "failure_cause" IS NULL
          AND "completed_at" IS NULL)
        OR ("state" = 'succeeded'
          AND "failure_cause" IS NULL
          AND "completed_at" IS NOT NULL)
        OR ("state" = 'failed'
          AND "failure_cause" = 'modelCallFailed'
          AND "completed_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "outbox_obligations" DROP CONSTRAINT "outbox_obligations_publication_check", ADD CONSTRAINT "outbox_obligations_publication_check" CHECK (((
        ("publication_evidence" IS NULL AND "published_at" IS NULL)
        OR ("publication_evidence" IS NOT NULL AND "published_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "relay_publication_attempts" DROP CONSTRAINT "relay_publication_attempts_outcome_check", ADD CONSTRAINT "relay_publication_attempts_outcome_check" CHECK (((
        ("state" = 'started'
          AND "provider_message_id" IS NULL
          AND "finished_at" IS NULL)
        OR ("state" = 'expired'
          AND "provider_message_id" IS NULL
          AND "finished_at" IS NOT NULL)
        OR ("state" = 'confirmed'
          AND length("provider_message_id") BETWEEN 1 AND 255
          AND "finished_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "relay_publication_tasks" DROP CONSTRAINT "relay_publication_tasks_claim_check", ADD CONSTRAINT "relay_publication_tasks_claim_check" CHECK (((
        ("publication_state" = 'pending'
          AND "publication_owner" IS NULL
          AND "publication_lease_expires_at" IS NULL)
        OR ("publication_state" = 'publishing'
          AND "publication_epoch" > 0
          AND "publication_owner" IS NOT NULL
          AND "publication_lease_expires_at" IS NOT NULL)
      )) IS TRUE);
