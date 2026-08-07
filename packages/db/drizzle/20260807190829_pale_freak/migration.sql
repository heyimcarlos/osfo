ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_event_type_check", ADD CONSTRAINT "thread_events_event_type_check" CHECK ("event_type" IN (
        'UserMessageAppended',
        'AssistantOutputAppended',
        'AssistantOutputCompleted',
        'AssistantOutputInterrupted',
        'AgentRunCancellationRequested',
        'AgentRunCanceled',
        'AgentRunSucceeded',
        'AgentRunFailed',
        'ToolCallRequested',
        'ToolCallProgressRecorded',
        'ToolCallResultRecorded',
        'ActionApprovalRequested',
        'ActionReceiptRecorded'
      ));--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_payload_shape_check", ADD CONSTRAINT "thread_events_payload_shape_check" CHECK ((CASE "event_type"
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
        WHEN 'ToolCallRequested' THEN
          "payload" = jsonb_build_object(
            'toolCallId', "payload" ->> 'toolCallId',
            'agentRunId', "payload" ->> 'agentRunId',
            'memberIndex', ("payload" ->> 'memberIndex')::integer,
            'presentation', "payload" -> 'presentation'
          )
          AND "payload" ->> 'toolCallId' ~ '^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND ("payload" ->> 'memberIndex')::integer >= 0
          AND "payload" -> 'presentation' = jsonb_build_object(
            'version', 1,
            'title', "payload" -> 'presentation' ->> 'title',
            'description', "payload" -> 'presentation' ->> 'description'
          )
          AND length("payload" -> 'presentation' ->> 'title') BETWEEN 1 AND 512
          AND length("payload" -> 'presentation' ->> 'description') BETWEEN 1 AND 512
        WHEN 'ToolCallProgressRecorded' THEN
          "payload" = jsonb_build_object(
            'toolCallId', "payload" ->> 'toolCallId',
            'agentRunId', "payload" ->> 'agentRunId',
            'presentation', "payload" -> 'presentation',
            'progress', "payload" -> 'progress'
          )
          AND "payload" ->> 'toolCallId' ~ '^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "payload" -> 'presentation' = jsonb_build_object(
            'version', 1,
            'title', "payload" -> 'presentation' ->> 'title',
            'description', "payload" -> 'presentation' ->> 'description'
          )
          AND length("payload" -> 'presentation' ->> 'title') BETWEEN 1 AND 512
          AND length("payload" -> 'presentation' ->> 'description') BETWEEN 1 AND 512
          AND "payload" -> 'progress' = jsonb_build_object(
            'message', "payload" -> 'progress' ->> 'message'
          )
          AND length("payload" -> 'progress' ->> 'message') BETWEEN 1 AND 512
        WHEN 'ToolCallResultRecorded' THEN
          "payload" = jsonb_build_object(
            'toolCallId', "payload" ->> 'toolCallId',
            'agentRunId', "payload" ->> 'agentRunId',
            'presentation', "payload" -> 'presentation',
            'outcome', "payload" -> 'outcome'
          )
          AND "payload" ->> 'toolCallId' ~ '^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "payload" -> 'presentation' = jsonb_build_object(
            'version', 1,
            'title', "payload" -> 'presentation' ->> 'title',
            'description', "payload" -> 'presentation' ->> 'description'
          )
          AND length("payload" -> 'presentation' ->> 'title') BETWEEN 1 AND 512
          AND length("payload" -> 'presentation' ->> 'description') BETWEEN 1 AND 512
          AND "payload" -> 'outcome' = CASE "payload" -> 'outcome' ->> 'type'
            WHEN 'succeeded' THEN jsonb_build_object('type', 'succeeded')
            WHEN 'failed' THEN jsonb_build_object(
              'type', 'failed',
              'cause', "payload" -> 'outcome' ->> 'cause'
            )
            WHEN 'canceled' THEN jsonb_build_object('type', 'canceled')
            ELSE NULL
          END
          AND (
            "payload" -> 'outcome' ->> 'type' <> 'failed'
            OR "payload" -> 'outcome' ->> 'cause' IN (
              'invalidInput', 'executionFailed', 'dependencyUnavailable'
            )
          )
        WHEN 'ActionApprovalRequested' THEN
          "payload" = jsonb_build_object(
            'approvalRequestId', "payload" ->> 'approvalRequestId',
            'toolCallId', "payload" ->> 'toolCallId',
            'agentRunId', "payload" ->> 'agentRunId',
            'expiresAt', "payload" ->> 'expiresAt',
            'actionDefinition', "payload" -> 'actionDefinition',
            'presentation', "payload" -> 'presentation'
          )
          AND ("payload" ->> 'approvalRequestId')::uuid IS NOT NULL
          AND ("payload" ->> 'expiresAt')::timestamptz IS NOT NULL
          AND "payload" ->> 'toolCallId' ~ '^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "payload" -> 'actionDefinition' = jsonb_build_object(
            'name', 'sendDemoEmail', 'version', 1
          )
          AND "payload" -> 'presentation' = jsonb_build_object(
            'version', 1,
            'title', "payload" -> 'presentation' ->> 'title',
            'description', "payload" -> 'presentation' ->> 'description',
            'fields', jsonb_build_array(
              jsonb_build_object('label', 'Destination', 'value', 'Controlled development inbox'),
              jsonb_build_object(
                'label', 'Subject',
                'value', "payload" -> 'presentation' -> 'fields' -> 1 ->> 'value'
              )
            )
          )
          AND length("payload" -> 'presentation' ->> 'title') BETWEEN 1 AND 256
          AND length("payload" -> 'presentation' ->> 'description') BETWEEN 1 AND 256
          AND length("payload" -> 'presentation' -> 'fields' -> 1 ->> 'value') BETWEEN 1 AND 256
        WHEN 'ActionReceiptRecorded' THEN
          "payload" = jsonb_build_object(
            'toolCallId', "payload" ->> 'toolCallId',
            'agentRunId', "payload" ->> 'agentRunId',
            'approval', "payload" -> 'approval',
            'actionDefinition', "payload" -> 'actionDefinition',
            'presentation', "payload" -> 'presentation',
            'successBoundary', "payload" -> 'successBoundary',
            'outcome', "payload" ->> 'outcome'
          )
          AND "payload" ->> 'toolCallId' ~ '^tool_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "payload" ->> 'outcome' IN ('applied', 'notApplied', 'unresolved')
          AND "payload" -> 'actionDefinition' = jsonb_build_object(
            'name', 'sendDemoEmail', 'version', 1
          )
          AND "payload" -> 'presentation' = jsonb_build_object(
            'version', 1,
            'title', "payload" -> 'presentation' ->> 'title',
            'description', "payload" -> 'presentation' ->> 'description',
            'fields', jsonb_build_array(
              jsonb_build_object('label', 'Destination', 'value', 'Controlled development inbox'),
              jsonb_build_object(
                'label', 'Subject',
                'value', "payload" -> 'presentation' -> 'fields' -> 1 ->> 'value'
              )
            )
          )
          AND length("payload" -> 'presentation' ->> 'title') BETWEEN 1 AND 256
          AND length("payload" -> 'presentation' ->> 'description') BETWEEN 1 AND 256
          AND length("payload" -> 'presentation' -> 'fields' -> 1 ->> 'value') BETWEEN 1 AND 256
          AND "payload" -> 'successBoundary' = jsonb_build_object(
            'name', 'mailpitMessageStored',
            'version', 1,
            'appliedMeans', 'controlled sink stored one message with the Action stable Message-ID',
            'doesNotProve', 'delivery to a real recipient'
          )
          AND (
            "payload" -> 'approval' = jsonb_build_object('type', 'notRequired')
            OR "payload" -> 'approval' = jsonb_build_object(
              'type', 'approved',
              'approvalRequestId', "payload" -> 'approval' ->> 'approvalRequestId'
            )
            OR (
              "payload" -> 'approval' = jsonb_build_object(
                'type', 'notApproved',
                'approvalRequestId', "payload" -> 'approval' ->> 'approvalRequestId',
                'reason', "payload" -> 'approval' ->> 'reason'
              )
              AND "payload" -> 'approval' ->> 'reason' IN ('denied', 'expired', 'canceled')
            )
            OR (
              "payload" -> 'approval' = jsonb_build_object(
                'type', 'approvalNotAuthorized',
                'approvalRequestId', "payload" -> 'approval' ->> 'approvalRequestId',
                'reason', 'currentAuthorizationDenied'
              )
            )
            OR (
              "payload" -> 'approval' = jsonb_build_object(
                'type', 'notAuthorized',
                'reason', "payload" -> 'approval' ->> 'reason'
              )
              AND "payload" -> 'approval' ->> 'reason' IN (
                'operationGateDenied', 'currentAuthorizationDenied'
              )
            )
          )
          AND (
            NOT ("payload" -> 'approval' ? 'approvalRequestId')
            OR ("payload" -> 'approval' ->> 'approvalRequestId')::uuid IS NOT NULL
          )
        ELSE false
      END) IS TRUE);--> statement-breakpoint
DROP TRIGGER "agent_runs_terminal_action_guard" ON "agent_runs";--> statement-breakpoint
DROP FUNCTION "reject_terminal_agent_run_with_open_actions"();--> statement-breakpoint
CREATE FUNCTION reject_terminal_agent_run_with_open_tool_calls() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.state IN ('succeeded', 'failed', 'canceled')
		AND OLD.state NOT IN ('succeeded', 'failed', 'canceled')
		AND EXISTS (
			SELECT 1 FROM tool_calls
			WHERE agent_run_id = NEW.agent_run_id
				AND state IN ('pending', 'running')
		)
	THEN
		RAISE EXCEPTION 'AgentRun cannot become terminal while a ToolCall is nonterminal'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER agent_runs_terminal_tool_call_guard
BEFORE UPDATE OF state ON agent_runs
FOR EACH ROW EXECUTE FUNCTION reject_terminal_agent_run_with_open_tool_calls();
