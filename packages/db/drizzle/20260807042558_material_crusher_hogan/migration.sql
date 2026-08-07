ALTER TABLE "agent_runs" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cleanup_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cleanup_disposition" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "external_work_may_continue" boolean;--> statement-breakpoint
UPDATE "agent_runs"
SET "cancellation_requested_at" = "created_at",
    "cleanup_deadline_at" = "created_at",
    "cleanup_disposition" = 'unknown',
    "external_work_may_continue" = true
WHERE "state" = 'canceled';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_cancellation_request_check" CHECK ((("cancellation_requested_at" IS NULL) = ("cleanup_deadline_at" IS NULL)));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_cleanup_check" CHECK (((
        ("state" = 'canceled'
          AND "cancellation_requested_at" IS NOT NULL
          AND "cleanup_deadline_at" IS NOT NULL
          AND (
            "cleanup_disposition" IN ('completed', 'deadlineExceeded')
            OR (
              "cleanup_disposition" = 'unknown'
              AND "external_work_may_continue" = true
            )
          )
          AND "external_work_may_continue" IS NOT NULL)
        OR ("state" <> 'canceled'
          AND "cleanup_disposition" IS NULL
          AND "external_work_may_continue" IS NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "assistant_outputs" DROP CONSTRAINT "assistant_outputs_terminal_check", ADD CONSTRAINT "assistant_outputs_terminal_check" CHECK (((
        ("state" = 'open'
          AND "interruption_cause" IS NULL
          AND "terminated_at" IS NULL)
        OR ("state" = 'completed'
          AND "interruption_cause" IS NULL
          AND "terminated_at" IS NOT NULL)
        OR ("state" = 'interrupted'
          AND "interruption_cause" IN ('modelCallFailed', 'agentRunCanceled')
          AND "terminated_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "model_call_attempts" DROP CONSTRAINT "model_call_attempts_state_check", ADD CONSTRAINT "model_call_attempts_state_check" CHECK ("state" IN ('started', 'succeeded', 'failed', 'canceled'));--> statement-breakpoint
ALTER TABLE "model_calls" DROP CONSTRAINT "model_calls_state_check", ADD CONSTRAINT "model_calls_state_check" CHECK ("state" IN ('pending', 'succeeded', 'failed', 'canceled'));--> statement-breakpoint
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
        OR ("state" = 'canceled'
          AND "failure_cause" IS NULL
          AND "completed_at" IS NOT NULL)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_event_type_check", ADD CONSTRAINT "thread_events_event_type_check" CHECK ("event_type" IN (
        'UserMessageAppended',
        'AssistantOutputAppended',
        'AssistantOutputCompleted',
        'AssistantOutputInterrupted',
        'AgentRunCancellationRequested',
        'AgentRunCanceled',
        'AgentRunSucceeded',
        'AgentRunFailed'
      ));--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_event_version_check", ADD CONSTRAINT "thread_events_event_version_check" CHECK ((
        ("event_type" = 'AssistantOutputInterrupted' AND "event_version" IN (1, 2))
        OR ("event_type" <> 'AssistantOutputInterrupted' AND "event_version" = 1)
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
            'cause', "payload" ->> 'cause'
          )
          AND (
            ("event_version" = 1 AND "payload" ->> 'cause' = 'modelCallFailed')
            OR ("event_version" = 2 AND "payload" ->> 'cause' = 'agentRunCanceled')
          )
        WHEN 'AgentRunCancellationRequested' THEN
          "payload" = jsonb_build_object('agentRunId', "payload" ->> 'agentRunId')
        WHEN 'AgentRunCanceled' THEN
          "payload" = jsonb_build_object(
            'agentRunId', "payload" ->> 'agentRunId',
            'cleanupDisposition', "payload" -> 'cleanupDisposition',
            'externalWorkMayContinue', "payload" -> 'externalWorkMayContinue'
          )
          AND "payload" -> 'cleanupDisposition' IN (
            jsonb_build_object('type', 'completed'),
            jsonb_build_object('type', 'deadlineExceeded')
          )
          AND jsonb_typeof("payload" -> 'externalWorkMayContinue') = 'boolean'
        WHEN 'AgentRunSucceeded' THEN
          "payload" = jsonb_build_object('agentRunId', "payload" ->> 'agentRunId')
        WHEN 'AgentRunFailed' THEN
          "payload" = jsonb_build_object(
            'agentRunId', "payload" ->> 'agentRunId',
            'cause', 'modelCallFailed'
          )
        ELSE false
      END);
