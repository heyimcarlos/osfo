ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_event_version_check", ADD CONSTRAINT "thread_events_event_version_check" CHECK ((
        ("event_type" = 'AssistantOutputInterrupted' AND "event_version" IN (1, 2))
        OR ("event_type" <> 'AssistantOutputInterrupted' AND "event_version" = 1)
      ));--> statement-breakpoint
ALTER TABLE "thread_events" DISABLE TRIGGER "thread_events_immutable";--> statement-breakpoint
UPDATE "thread_events"
SET "event_version" = 2
WHERE "event_type" = 'AssistantOutputInterrupted'
  AND "event_version" = 1
  AND "payload" ->> 'cause' = 'agentRunCanceled';--> statement-breakpoint
ALTER TABLE "thread_events" ENABLE TRIGGER "thread_events_immutable";--> statement-breakpoint
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
