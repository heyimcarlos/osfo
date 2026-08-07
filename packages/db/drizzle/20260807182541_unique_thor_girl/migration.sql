CREATE TABLE "action_approval_requests" (
	"approval_request_id" uuid PRIMARY KEY,
	"tool_call_id" text NOT NULL UNIQUE,
	"action_digest" text NOT NULL,
	"state" text NOT NULL,
	"decision_id" uuid UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_approval_requests_digest_check" CHECK ("action_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "action_approval_requests_state_check" CHECK ("state" IN ('pending', 'approved', 'denied', 'expired', 'canceled')),
	CONSTRAINT "action_approval_requests_decision_check" CHECK ((("state" = 'pending'
          AND "decision_id" IS NULL
          AND "decided_at" IS NULL)
        OR ("state" IN ('approved', 'denied')
          AND "decision_id" IS NOT NULL
          AND "decided_at" IS NOT NULL)
        OR ("state" IN ('expired', 'canceled')
          AND "decision_id" IS NULL
          AND "decided_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "action_attempts" (
	"action_attempt_id" uuid PRIMARY KEY,
	"tool_call_id" text NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claim_epoch" bigint NOT NULL,
	"authorization_revision" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "action_attempts_call_number_unique" UNIQUE("tool_call_id","attempt_number"),
	CONSTRAINT "action_attempts_number_check" CHECK ("attempt_number" > 0),
	CONSTRAINT "action_attempts_epoch_check" CHECK ("claim_epoch" > 0),
	CONSTRAINT "action_attempts_authorization_check" CHECK (length("authorization_revision") BETWEEN 1 AND 128),
	CONSTRAINT "action_attempts_state_check" CHECK ("state" IN ('dispatching', 'uncertain', 'applied', 'notApplied')),
	CONSTRAINT "action_attempts_finished_check" CHECK ((("state" = 'dispatching' AND "finished_at" IS NULL)
        OR ("state" <> 'dispatching' AND "finished_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "action_receipts" (
	"tool_call_id" text PRIMARY KEY,
	"agent_run_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_receipts_outcome_check" CHECK ("outcome" IN ('applied', 'notApplied', 'unresolved'))
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"tool_call_id" text PRIMARY KEY,
	"agent_run_id" uuid NOT NULL,
	"action_definition_ref" text NOT NULL,
	"action_digest" text NOT NULL,
	"subject" text NOT NULL,
	"presentation" jsonb NOT NULL,
	"success_boundary" jsonb NOT NULL,
	"effective_gate" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "actions_call_run_unique" UNIQUE("tool_call_id","agent_run_id"),
	CONSTRAINT "actions_call_digest_unique" UNIQUE("tool_call_id","action_digest"),
	CONSTRAINT "actions_definition_check" CHECK ("action_definition_ref" = 'sendDemoEmail.v1'),
	CONSTRAINT "actions_digest_check" CHECK ("action_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "actions_subject_check" CHECK (length("subject") BETWEEN 1 AND 120),
	CONSTRAINT "actions_presentation_check" CHECK ("presentation" = jsonb_build_object(
        'version', 1,
        'title', "presentation" ->> 'title',
        'description', "presentation" ->> 'description',
        'fields', jsonb_build_array(
          jsonb_build_object('label', 'Destination', 'value', 'Controlled development inbox'),
          jsonb_build_object(
            'label', 'Subject', 'value', "presentation" -> 'fields' -> 1 ->> 'value'
          )
        )
      )
      AND "presentation" ->> 'title' = 'Send demo email'
      AND "presentation" ->> 'description' =
        'Send one fixed-body message to the controlled development inbox.'
      AND "presentation" -> 'fields' -> 1 ->> 'value' = "subject"),
	CONSTRAINT "actions_success_boundary_check" CHECK ("success_boundary" = jsonb_build_object(
        'ref', 'mailpitMessageStored.v1',
        'description',
        'Applied means the controlled sink stored one message with this Action''s stable Message-ID. It does not prove delivery to a real recipient.'
      )),
	CONSTRAINT "actions_gate_check" CHECK ("effective_gate" IN ('deny', 'requireApproval', 'permit')),
	CONSTRAINT "actions_state_check" CHECK ("state" IN (
        'waitingApproval', 'ready', 'dispatching', 'reconcileRequired',
        'applied', 'notApplied', 'unresolved'
      )),
	CONSTRAINT "actions_terminal_check" CHECK ((("state" IN ('applied', 'notApplied', 'unresolved')) =
        ("terminal_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX "action_attempts_active_run_epoch_idx" ON "action_attempts" ("agent_run_id","claim_epoch") WHERE "state" IN ('dispatching', 'uncertain');--> statement-breakpoint
ALTER TABLE "action_approval_requests" ADD CONSTRAINT "action_approval_requests_tool_call_id_actions_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "actions"("tool_call_id");--> statement-breakpoint
ALTER TABLE "action_approval_requests" ADD CONSTRAINT "action_approval_requests_MQ8EZjgXdOFR_fkey" FOREIGN KEY ("tool_call_id","action_digest") REFERENCES "actions"("tool_call_id","action_digest");--> statement-breakpoint
ALTER TABLE "action_attempts" ADD CONSTRAINT "action_attempts_3YPjKnentOZj_fkey" FOREIGN KEY ("tool_call_id","agent_run_id") REFERENCES "actions"("tool_call_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "action_receipts" ADD CONSTRAINT "action_receipts_tool_call_id_actions_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "actions"("tool_call_id");--> statement-breakpoint
ALTER TABLE "action_receipts" ADD CONSTRAINT "action_receipts_3gAfvE5eveOi_fkey" FOREIGN KEY ("tool_call_id","agent_run_id") REFERENCES "actions"("tool_call_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tool_call_id_tool_calls_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "tool_calls"("tool_call_id");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_SMotqmjK38NI_fkey" FOREIGN KEY ("tool_call_id","agent_run_id") REFERENCES "tool_calls"("tool_call_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_event_type_check", ADD CONSTRAINT "thread_events_event_type_check" CHECK ("event_type" IN (
        'UserMessageAppended',
        'AssistantOutputAppended',
        'AssistantOutputCompleted',
        'AssistantOutputInterrupted',
        'AgentRunCancellationRequested',
        'AgentRunCanceled',
        'AgentRunSucceeded',
        'AgentRunFailed',
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
ALTER TABLE "tool_calls" DROP CONSTRAINT "tool_calls_execution_mode_check", ADD CONSTRAINT "tool_calls_execution_mode_check" CHECK ("execution_mode" IN ('nonAction', 'action'));
--> statement-breakpoint
CREATE FUNCTION reject_terminal_agent_run_with_open_actions() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.state IN ('succeeded', 'failed', 'canceled')
		AND OLD.state NOT IN ('succeeded', 'failed', 'canceled')
		AND EXISTS (
			SELECT 1 FROM actions
			WHERE agent_run_id = NEW.agent_run_id
				AND state NOT IN ('applied', 'notApplied', 'unresolved')
		)
	THEN
		RAISE EXCEPTION 'AgentRun cannot become terminal while an Action is nonterminal'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_runs_terminal_action_guard
BEFORE UPDATE OF state ON agent_runs
FOR EACH ROW EXECUTE FUNCTION reject_terminal_agent_run_with_open_actions();
