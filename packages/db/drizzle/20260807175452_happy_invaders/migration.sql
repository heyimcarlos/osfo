CREATE TABLE "tool_call_attempts" (
	"tool_call_attempt_id" uuid PRIMARY KEY,
	"tool_call_id" text NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claim_epoch" bigint NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tool_call_attempts_call_number_unique" UNIQUE("tool_call_id","attempt_number"),
	CONSTRAINT "tool_call_attempts_attempt_authority_unique" UNIQUE("tool_call_attempt_id","tool_call_id","agent_run_id"),
	CONSTRAINT "tool_call_attempts_number_check" CHECK ("attempt_number" > 0),
	CONSTRAINT "tool_call_attempts_epoch_check" CHECK ("claim_epoch" > 0),
	CONSTRAINT "tool_call_attempts_state_check" CHECK ("state" IN ('started', 'succeeded', 'retryable', 'failed', 'canceled', 'stale')),
	CONSTRAINT "tool_call_attempts_finished_check" CHECK ((("state" = 'started' AND "finished_at" IS NULL)
        OR ("state" <> 'started' AND "finished_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "tool_call_batches" (
	"tool_call_batch_id" uuid PRIMARY KEY,
	"agent_run_id" uuid NOT NULL,
	"batch_key" text NOT NULL,
	"member_count" integer NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tool_call_batches_batch_run_unique" UNIQUE("tool_call_batch_id","agent_run_id"),
	CONSTRAINT "tool_call_batches_run_key_unique" UNIQUE("agent_run_id","batch_key"),
	CONSTRAINT "tool_call_batches_key_check" CHECK (length("batch_key") BETWEEN 1 AND 128),
	CONSTRAINT "tool_call_batches_members_check" CHECK ("member_count" BETWEEN 1 AND 8),
	CONSTRAINT "tool_call_batches_completed_count_check" CHECK ("completed_count" BETWEEN 0 AND "member_count"),
	CONSTRAINT "tool_call_batches_state_check" CHECK ("state" IN ('pending', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "tool_call_batches_terminal_check" CHECK ((("state" = 'pending' AND "completed_at" IS NULL)
        OR ("state" <> 'pending' AND "completed_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "tool_call_progress_events" (
	"tool_call_id" text NOT NULL,
	"observation_index" integer,
	"tool_call_attempt_id" uuid,
	"agent_run_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_call_progress_events_pkey" PRIMARY KEY("tool_call_attempt_id","observation_index"),
	CONSTRAINT "tool_call_progress_events_index_check" CHECK ("observation_index" >= 0),
	CONSTRAINT "tool_call_progress_events_message_check" CHECK (length("message") BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"tool_call_id" text PRIMARY KEY,
	"tool_call_batch_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"member_index" integer NOT NULL,
	"execution_mode" text NOT NULL,
	"tool_name" text NOT NULL,
	"attempt_limit" integer NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"current_progress" jsonb,
	"outcome" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tool_calls_batch_member_unique" UNIQUE("tool_call_batch_id","member_index"),
	CONSTRAINT "tool_calls_call_run_unique" UNIQUE("tool_call_id","agent_run_id"),
	CONSTRAINT "tool_calls_id_check" CHECK ("tool_call_id" ~ '^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "tool_calls_member_index_check" CHECK ("member_index" >= 0),
	CONSTRAINT "tool_calls_execution_mode_check" CHECK ("execution_mode" = 'nonAction'),
	CONSTRAINT "tool_calls_name_check" CHECK (length("tool_name") BETWEEN 1 AND 128),
	CONSTRAINT "tool_calls_attempt_limit_check" CHECK ("attempt_limit" BETWEEN 1 AND 5),
	CONSTRAINT "tool_calls_input_check" CHECK ("input" = jsonb_build_object(
          'type', 'text',
          'text', "input" ->> 'text'
        )
        AND length("input" ->> 'text') BETWEEN 1 AND 16384),
	CONSTRAINT "tool_calls_state_check" CHECK ("state" IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "tool_calls_progress_check" CHECK ("current_progress" IS NULL OR (
        "state" = 'running'
        AND "current_progress" = jsonb_build_object(
          'observationIndex', ("current_progress" ->> 'observationIndex')::integer,
          'message', "current_progress" ->> 'message'
        )
        AND ("current_progress" ->> 'observationIndex')::integer >= 0
        AND length("current_progress" ->> 'message') BETWEEN 1 AND 512
      )),
	CONSTRAINT "tool_calls_terminal_check" CHECK ((("state" IN ('pending', 'running')
          AND "outcome" IS NULL
          AND "completed_at" IS NULL)
        OR ("state" IN ('succeeded', 'failed', 'canceled')
          AND "outcome" IS NOT NULL
          AND "completed_at" IS NOT NULL))),
	CONSTRAINT "tool_calls_outcome_check" CHECK ("outcome" IS NULL OR (
        "outcome" = CASE "outcome" ->> 'type'
          WHEN 'succeeded' THEN jsonb_build_object(
            'type', 'succeeded',
            'result', jsonb_build_object(
              'type', 'text',
              'text', "outcome" -> 'result' ->> 'text'
            )
          )
          WHEN 'failed' THEN jsonb_build_object(
            'type', 'failed',
            'cause', "outcome" ->> 'cause'
          )
          WHEN 'canceled' THEN jsonb_build_object('type', 'canceled')
          ELSE NULL
        END
        AND CASE "outcome" ->> 'type'
          WHEN 'succeeded' THEN
            length("outcome" -> 'result' ->> 'text')
              BETWEEN 1 AND 16384
          WHEN 'failed' THEN "outcome" ->> 'cause' IN (
            'invalidInput', 'executionFailed', 'dependencyUnavailable'
          )
          WHEN 'canceled' THEN true
          ELSE false
        END
      ))
);
--> statement-breakpoint
CREATE INDEX "tool_call_attempts_active_run_epoch_idx" ON "tool_call_attempts" ("agent_run_id","claim_epoch") WHERE "state" = 'started';--> statement-breakpoint
ALTER TABLE "tool_call_attempts" ADD CONSTRAINT "tool_call_attempts_jnEhM8cRioYb_fkey" FOREIGN KEY ("tool_call_id","agent_run_id") REFERENCES "tool_calls"("tool_call_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "tool_call_batches" ADD CONSTRAINT "tool_call_batches_agent_run_id_agent_runs_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("agent_run_id");--> statement-breakpoint
ALTER TABLE "tool_call_progress_events" ADD CONSTRAINT "tool_call_progress_events_PQiHgjb5TRdm_fkey" FOREIGN KEY ("tool_call_attempt_id","tool_call_id","agent_run_id") REFERENCES "tool_call_attempts"("tool_call_attempt_id","tool_call_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_uvTQRzi4kvrz_fkey" FOREIGN KEY ("tool_call_batch_id","agent_run_id") REFERENCES "tool_call_batches"("tool_call_batch_id","agent_run_id");