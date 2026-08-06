CREATE TABLE "assistant_outputs" (
	"assistant_output_id" uuid PRIMARY KEY,
	"agent_run_id" uuid NOT NULL UNIQUE,
	"state" text NOT NULL,
	"interruption_cause" text,
	"created_at" timestamp with time zone NOT NULL,
	"terminated_at" timestamp with time zone,
	CONSTRAINT "assistant_outputs_state_check" CHECK ("state" IN ('open', 'completed', 'interrupted')),
	CONSTRAINT "assistant_outputs_terminal_check" CHECK ((
        ("state" = 'open'
          AND "interruption_cause" IS NULL
          AND "terminated_at" IS NULL)
        OR ("state" = 'completed'
          AND "interruption_cause" IS NULL
          AND "terminated_at" IS NOT NULL)
        OR ("state" = 'interrupted'
          AND "interruption_cause" = 'modelCallFailed'
          AND "terminated_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "model_call_attempts" (
	"model_call_attempt_id" uuid PRIMARY KEY,
	"model_call_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claim_epoch" bigint NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "model_call_attempts_call_number_unique" UNIQUE("model_call_id","attempt_number"),
	CONSTRAINT "model_call_attempts_number_check" CHECK ("attempt_number" > 0),
	CONSTRAINT "model_call_attempts_epoch_check" CHECK ("claim_epoch" > 0),
	CONSTRAINT "model_call_attempts_state_check" CHECK ("state" IN ('started', 'succeeded', 'failed')),
	CONSTRAINT "model_call_attempts_finished_check" CHECK ((
        ("state" = 'started' AND "finished_at" IS NULL)
        OR ("state" <> 'started' AND "finished_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "model_call_fragments" (
	"model_call_id" uuid,
	"fragment_index" integer,
	"model_call_attempt_id" uuid NOT NULL,
	"assistant_output_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"text" text NOT NULL,
	"thread_event_id" uuid NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_call_fragments_pkey" PRIMARY KEY("model_call_id","fragment_index"),
	CONSTRAINT "model_call_fragments_index_check" CHECK ("fragment_index" >= 0),
	CONSTRAINT "model_call_fragments_text_check" CHECK (length("text") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"model_call_id" uuid PRIMARY KEY,
	"agent_run_id" uuid NOT NULL UNIQUE,
	"assistant_output_id" uuid NOT NULL UNIQUE,
	"model_binding" text NOT NULL,
	"prompt" text NOT NULL,
	"state" text NOT NULL,
	"failure_cause" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_calls_call_run_unique" UNIQUE("model_call_id","agent_run_id"),
	CONSTRAINT "model_calls_call_output_run_unique" UNIQUE("model_call_id","assistant_output_id","agent_run_id"),
	CONSTRAINT "model_calls_binding_check" CHECK (length("model_binding") BETWEEN 1 AND 255),
	CONSTRAINT "model_calls_prompt_check" CHECK (length("prompt") BETWEEN 1 AND 16384),
	CONSTRAINT "model_calls_state_check" CHECK ("state" IN ('pending', 'succeeded', 'failed')),
	CONSTRAINT "model_calls_outcome_check" CHECK ((
        ("state" = 'pending'
          AND "failure_cause" IS NULL
          AND "completed_at" IS NULL)
        OR ("state" = 'succeeded'
          AND "failure_cause" IS NULL
          AND "completed_at" IS NOT NULL)
        OR ("state" = 'failed'
          AND "failure_cause" = 'modelCallFailed'
          AND "completed_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_payload_message_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "claim_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "claim_owner" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD COLUMN "publication_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD COLUMN "publication_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD COLUMN "publication_owner" text;--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD COLUMN "publication_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_runs_expired_claim_idx" ON "agent_runs" ("lease_expires_at") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "outbox_obligations_publication_idx" ON "outbox_obligations" ("publication_state","publication_lease_expires_at","created_at","outbox_id") WHERE "published_at" IS NULL;--> statement-breakpoint
ALTER TABLE "assistant_outputs" ADD CONSTRAINT "assistant_outputs_agent_run_id_agent_runs_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("agent_run_id");--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_HI98vM6hhqyP_fkey" FOREIGN KEY ("model_call_id","agent_run_id") REFERENCES "model_calls"("model_call_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "model_call_fragments" ADD CONSTRAINT "model_call_fragments_xcpfh5gecjmq_fkey" FOREIGN KEY ("model_call_attempt_id") REFERENCES "model_call_attempts"("model_call_attempt_id");--> statement-breakpoint
ALTER TABLE "model_call_fragments" ADD CONSTRAINT "model_call_fragments_6WKF0fMR31c4_fkey" FOREIGN KEY ("thread_event_id") REFERENCES "thread_events"("event_id");--> statement-breakpoint
ALTER TABLE "model_call_fragments" ADD CONSTRAINT "model_call_fragments_OjHiAJFBD5BY_fkey" FOREIGN KEY ("model_call_id","assistant_output_id","agent_run_id") REFERENCES "model_calls"("model_call_id","assistant_output_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_agent_run_id_agent_runs_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("agent_run_id");--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_4nEoMtAnEyXF_fkey" FOREIGN KEY ("assistant_output_id") REFERENCES "assistant_outputs"("assistant_output_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_claim_epoch_check" CHECK ("claim_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_claim_check" CHECK ((
        ("state" = 'running'
          AND "claim_epoch" > 0
          AND "claim_owner" IS NOT NULL
          AND "lease_expires_at" IS NOT NULL)
        OR ("state" <> 'running'
          AND "claim_owner" IS NULL
          AND "lease_expires_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_publication_state_check" CHECK ("publication_state" IN ('pending', 'publishing', 'published'));--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_publication_epoch_check" CHECK ("publication_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_publication_claim_check" CHECK ((
        ("publication_state" = 'pending'
          AND "publication_owner" IS NULL
          AND "publication_lease_expires_at" IS NULL
          AND "published_at" IS NULL)
        OR ("publication_state" = 'publishing'
          AND "publication_epoch" > 0
          AND "publication_owner" IS NOT NULL
          AND "publication_lease_expires_at" IS NOT NULL
          AND "published_at" IS NULL)
        OR ("publication_state" = 'published'
          AND "publication_owner" IS NULL
          AND "publication_lease_expires_at" IS NULL
          AND "published_at" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_event_type_check", ADD CONSTRAINT "thread_events_event_type_check" CHECK ("event_type" IN (
        'UserMessageAppended',
        'AssistantOutputAppended',
        'AssistantOutputCompleted',
        'AssistantOutputInterrupted',
        'AgentRunSucceeded',
        'AgentRunFailed'
      ));--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_payload_shape_check", ADD CONSTRAINT "thread_events_payload_shape_check" CHECK (CASE "event_type"
        WHEN 'UserMessageAppended' THEN
          "payload" = jsonb_build_object(
            'userMessageId', "payload" ->> 'userMessageId',
            'agentRunId', "payload" ->> 'agentRunId',
            'content', "payload" -> 'content'
          )
          AND ("payload" ->> 'userMessageId')::uuid = "user_message_id"
        WHEN 'AssistantOutputAppended' THEN
          "payload" = jsonb_build_object(
            'assistantOutputId', "payload" ->> 'assistantOutputId',
            'agentRunId', "payload" ->> 'agentRunId',
            'content', "payload" -> 'content'
          )
        WHEN 'AssistantOutputCompleted' THEN
          "payload" = jsonb_build_object(
            'assistantOutputId', "payload" ->> 'assistantOutputId',
            'agentRunId', "payload" ->> 'agentRunId'
          )
        WHEN 'AssistantOutputInterrupted' THEN
          "payload" = jsonb_build_object(
            'assistantOutputId', "payload" ->> 'assistantOutputId',
            'agentRunId', "payload" ->> 'agentRunId',
            'cause', 'modelCallFailed'
          )
        WHEN 'AgentRunSucceeded' THEN
          "payload" = jsonb_build_object('agentRunId', "payload" ->> 'agentRunId')
        WHEN 'AgentRunFailed' THEN
          "payload" = jsonb_build_object(
            'agentRunId', "payload" ->> 'agentRunId',
            'cause', 'modelCallFailed'
          )
        ELSE false
      END);--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_payload_content_check", ADD CONSTRAINT "thread_events_payload_content_check" CHECK ("event_type" NOT IN ('UserMessageAppended', 'AssistantOutputAppended')
        OR (
          jsonb_typeof("payload" -> 'content') = 'array'
          AND jsonb_array_length("payload" -> 'content') = 1
          AND ("payload" -> 'content' -> 0) = jsonb_build_object(
            'type', 'text',
            'text', "payload" -> 'content' -> 0 ->> 'text'
          )
          AND length("payload" -> 'content' -> 0 ->> 'text') BETWEEN 1 AND 16384
        ));