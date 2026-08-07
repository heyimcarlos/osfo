import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  ActionDriverError,
  ActionRepository,
  makeSendDemoEmailAction,
  type ActionApprovalDecision,
  type ActionAttempt,
  type ActionExternalResult,
  type ActionReceipt,
  type ActionRepositoryService,
  type AgentRunFence,
  type OperationGate,
  type SendDemoEmailAction,
} from "@osfo/agent-run";
import {
  makeActionApprovalRequested,
  makeActionReceiptRecorded,
  type InvalidThreadEvent,
  type ThreadEvent,
} from "@osfo/session";
import { Effect, Layer, Redacted } from "effect";
import type { AgentRunRepositoryDatabaseConfig } from "./agent-run-repository.js";

interface ActionAuthority {
  readonly agentRunId: string;
  readonly cancellationRequested: boolean;
  readonly principalId: string;
  readonly threadId: string;
  readonly userMessageId: string;
}

interface ActionRow {
  readonly actionDefinitionRef: "sendDemoEmail.v1";
  readonly actionDigest: string;
  readonly agentRunId: string;
  readonly effectiveGate: OperationGate;
  readonly presentation: SendDemoEmailAction["presentation"];
  readonly state:
    | "waitingApproval"
    | "ready"
    | "dispatching"
    | "reconcileRequired"
    | "applied"
    | "notApplied"
    | "unresolved";
  readonly subject: string;
  readonly successBoundary: SendDemoEmailAction["successBoundary"];
  readonly toolCallId: string;
}

interface ApprovalRow {
  readonly approvalRequestId: string;
  readonly actionDigest: string;
  readonly decisionId: string | null;
  readonly expiresAt: string;
  readonly isExpired: boolean;
  readonly state: "pending" | "approved" | "denied" | "expired" | "canceled";
  readonly toolCallId: string;
}

interface AttemptRow {
  readonly actionAttemptId: string;
  readonly attemptNumber: number;
  readonly authorizationRevision: string;
  readonly claimEpoch: string;
  readonly state: "dispatching" | "uncertain" | "applied" | "notApplied";
}

interface ReceiptRow extends ActionRow {
  readonly outcome: ActionReceipt["outcome"];
  readonly recordedAt: string;
}

type EventBuilder = (input: {
  readonly agentRunId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly threadId: string;
  readonly threadPosition: string;
}) => Effect.Effect<ThreadEvent, InvalidThreadEvent>;

const toAction = (row: ActionRow): SendDemoEmailAction => ({
  actionDefinitionRef: row.actionDefinitionRef,
  actionDigest: row.actionDigest,
  agentRunId: row.agentRunId,
  presentation: row.presentation,
  subject: row.subject,
  successBoundary: row.successBoundary,
  toolCallId: row.toolCallId,
});

const toReceipt = (row: ReceiptRow): ActionReceipt => ({
  ...toAction(row),
  outcome: row.outcome,
  recordedAt: new Date(row.recordedAt).toISOString(),
});

const publicActionDefinition = { name: "sendDemoEmail", version: 1 } as const;
const publicSuccessBoundary = {
  appliedMeans: "controlled sink stored one message with the Action stable Message-ID",
  doesNotProve: "delivery to a real recipient",
  name: "mailpitMessageStored",
  version: 1,
} as const;
const gateRank = { permit: 0, requireApproval: 1, deny: 2 } as const;

const repositoryLayer = (config: AgentRunRepositoryDatabaseConfig) => {
  const postgresLayer = PgClient.layer({
    applicationName: "osfo-action-repository",
    maxConnections: config.maxConnections,
    url: Redacted.make(config.databaseUrl),
  });

  const repository = Layer.effect(
    ActionRepository,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const protect = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.mapError((cause) => new ActionDriverError({ cause })));

      const requireFence = Effect.fn("ActionRepository.requireFence")(function* (
        fence: AgentRunFence,
      ) {
        const rows = yield* sql<ActionAuthority>`SELECT
            agent_run_id::text AS "agentRunId",
            thread_id::text AS "threadId",
            principal_id::text AS "principalId",
            user_message_id::text AS "userMessageId"
            , cancellation_requested_at IS NOT NULL AS "cancellationRequested"
          FROM agent_runs
          WHERE agent_run_id = ${fence.agentRunId}::uuid
            AND state = 'running'
            AND claim_owner = ${fence.workerId}
            AND claim_epoch = ${fence.claimEpoch}::bigint
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE`;
        const authority = rows[0];
        if (authority === undefined)
          return yield* new ActionDriverError({ cause: "Fence rejected" });
        return authority;
      });

      const loadAuthority = Effect.fn("ActionRepository.loadAuthority")(function* (
        agentRunId: string,
      ) {
        const rows = yield* sql<ActionAuthority>`SELECT
            agent_run_id::text AS "agentRunId", thread_id::text AS "threadId",
            principal_id::text AS "principalId", user_message_id::text AS "userMessageId",
            cancellation_requested_at IS NOT NULL AS "cancellationRequested"
          FROM agent_runs WHERE agent_run_id = ${agentRunId}::uuid FOR UPDATE`;
        const authority = rows[0];
        if (authority === undefined)
          return yield* new ActionDriverError({ cause: "Action authority missing" });
        return authority;
      });

      const appendThreadEvent = Effect.fn("ActionRepository.appendThreadEvent")(function* (
        authority: ActionAuthority,
        build: EventBuilder,
      ) {
        const positions = yield* sql<{ readonly position: string }>`UPDATE threads
          SET next_position = next_position + 1,
              state_revision = state_revision + 1
          WHERE thread_id = ${authority.threadId}::uuid
          RETURNING (next_position - 1)::text AS position`;
        const position = positions[0];
        if (position === undefined)
          return yield* new ActionDriverError({ cause: "Thread missing" });
        const timestamps = yield* sql<{ readonly occurredAt: string }>`SELECT
          transaction_timestamp()::text AS "occurredAt"`;
        const timestamp = timestamps[0];
        if (timestamp === undefined)
          return yield* new ActionDriverError({ cause: "Clock missing" });
        const event = yield* build({
          agentRunId: authority.agentRunId,
          eventId: randomUUID(),
          occurredAt: new Date(timestamp.occurredAt).toISOString(),
          threadId: authority.threadId,
          threadPosition: position.position,
        });
        yield* sql`INSERT INTO thread_events (
            thread_id, position, event_id, principal_id, user_message_id,
            agent_run_id, event_type, event_version, payload, occurred_at
          ) VALUES (
            ${event.threadId}::uuid, ${event.threadPosition}::bigint,
            ${event.eventId}::uuid, ${authority.principalId}::uuid,
            ${authority.userMessageId}::uuid, ${event.payload.agentRunId}::uuid,
            ${event.eventType}, ${event.eventVersion},
            ${JSON.stringify(event.payload)}::jsonb, ${event.occurredAt}::timestamptz
          )`;
      });

      const loadAction = (toolCallId: string) =>
        sql<ActionRow>`SELECT
            tool_call_id AS "toolCallId", agent_run_id::text AS "agentRunId",
            action_definition_ref AS "actionDefinitionRef", action_digest AS "actionDigest",
            subject, presentation, success_boundary AS "successBoundary",
            effective_gate AS "effectiveGate", state
          FROM actions WHERE tool_call_id = ${toolCallId} FOR UPDATE`;

      const loadReceipt = (toolCallId: string) =>
        sql<ReceiptRow>`SELECT
            r.tool_call_id AS "toolCallId", r.agent_run_id::text AS "agentRunId",
            a.action_definition_ref AS "actionDefinitionRef", a.action_digest AS "actionDigest",
            a.subject, a.presentation, a.success_boundary AS "successBoundary",
            a.effective_gate AS "effectiveGate", a.state,
            r.outcome, r.recorded_at::text AS "recordedAt"
          FROM action_receipts r JOIN actions a USING (tool_call_id)
          WHERE r.tool_call_id = ${toolCallId}`;

      const loadApproval = (toolCallId: string) =>
        sql<ApprovalRow>`SELECT approval_request_id::text AS "approvalRequestId",
            tool_call_id AS "toolCallId", action_digest AS "actionDigest", state,
            decision_id::text AS "decisionId", expires_at::text AS "expiresAt",
            expires_at <= clock_timestamp() AS "isExpired"
          FROM action_approval_requests WHERE tool_call_id = ${toolCallId} FOR UPDATE`;

      const receiptApproval = Effect.fn("ActionRepository.receiptApproval")(function* (
        toolCallId: string,
        cause?: "applicationDenied" | "authorizationDenied",
      ) {
        const approval = (yield* loadApproval(toolCallId))[0];
        if (approval?.state === "approved") {
          return cause === "authorizationDenied"
            ? ({
                approvalRequestId: approval.approvalRequestId,
                reason: "currentAuthorizationDenied",
                type: "approvalNotAuthorized",
              } as const)
            : ({ approvalRequestId: approval.approvalRequestId, type: "approved" } as const);
        }
        if (
          approval?.state === "denied" ||
          approval?.state === "expired" ||
          approval?.state === "canceled"
        ) {
          return {
            approvalRequestId: approval.approvalRequestId,
            reason: approval.state,
            type: "notApproved",
          } as const;
        }
        if (cause !== undefined) {
          return {
            reason:
              cause === "applicationDenied" ? "operationGateDenied" : "currentAuthorizationDenied",
            type: "notAuthorized",
          } as const;
        }
        return { type: "notRequired" } as const;
      });

      const terminalize = Effect.fn("ActionRepository.terminalize")(function* (
        authority: ActionAuthority,
        action: SendDemoEmailAction,
        outcome: ActionReceipt["outcome"],
        cause?: "applicationDenied" | "authorizationDenied",
      ) {
        const existing = (yield* loadReceipt(action.toolCallId))[0];
        if (existing !== undefined) return toReceipt(existing);
        const timestamps = yield* sql<{ readonly recordedAt: string }>`SELECT
          transaction_timestamp()::text AS "recordedAt"`;
        const timestamp = timestamps[0];
        if (timestamp === undefined)
          return yield* new ActionDriverError({ cause: "Clock missing" });
        const recordedAt = new Date(timestamp.recordedAt).toISOString();
        yield* sql`UPDATE actions SET state = ${outcome}, terminal_at = transaction_timestamp()
          WHERE tool_call_id = ${action.toolCallId}`;
        yield* sql`INSERT INTO action_receipts (
            tool_call_id, agent_run_id, outcome, recorded_at
          ) VALUES (
            ${action.toolCallId}, ${action.agentRunId}::uuid,
            ${outcome}, transaction_timestamp()
          )`;
        const toolOutcome = {
          result: { text: `ActionReceipt:${outcome}`, type: "text" },
          type: "succeeded",
        } as const;
        yield* sql`UPDATE tool_calls
          SET state = 'succeeded', outcome = ${JSON.stringify(toolOutcome)}::jsonb,
              completed_at = transaction_timestamp()
          WHERE tool_call_id = ${action.toolCallId}`;
        yield* sql`UPDATE tool_call_batches b
          SET state = 'succeeded', completed_count = 1,
              completed_at = transaction_timestamp()
          FROM tool_calls c
          WHERE c.tool_call_id = ${action.toolCallId}
            AND b.tool_call_batch_id = c.tool_call_batch_id`;
        const approval = yield* receiptApproval(action.toolCallId, cause);
        yield* appendThreadEvent(authority, (base) =>
          makeActionReceiptRecorded({
            ...base,
            actionDefinition: publicActionDefinition,
            approval,
            outcome,
            presentation: action.presentation as Parameters<
              typeof makeActionReceiptRecorded
            >[0]["presentation"],
            successBoundary: publicSuccessBoundary,
            toolCallId: action.toolCallId,
          }),
        );
        return { ...action, outcome, recordedAt };
      });

      const createApproval = Effect.fn("ActionRepository.createApproval")(function* (
        authority: ActionAuthority,
        action: SendDemoEmailAction,
      ) {
        const approvalRequestId = randomUUID();
        const expirations = yield* sql<{ readonly expiresAt: string }>`SELECT
          (transaction_timestamp() + interval '5 minutes')::text AS "expiresAt"`;
        const expiration = expirations[0];
        if (expiration === undefined)
          return yield* new ActionDriverError({ cause: "Clock missing" });
        const expiresAt = new Date(expiration.expiresAt).toISOString();
        yield* sql`INSERT INTO action_approval_requests (
            approval_request_id, tool_call_id, action_digest, state,
            expires_at, created_at
          ) VALUES (
            ${approvalRequestId}::uuid, ${action.toolCallId}, ${action.actionDigest},
            'pending', ${expiresAt}::timestamptz, transaction_timestamp()
          )`;
        yield* sql`UPDATE actions SET state = 'waitingApproval'
          WHERE tool_call_id = ${action.toolCallId}`;
        yield* appendThreadEvent(authority, (base) =>
          makeActionApprovalRequested({
            ...base,
            actionDefinition: publicActionDefinition,
            approvalRequestId,
            expiresAt,
            presentation: action.presentation as Parameters<
              typeof makeActionApprovalRequested
            >[0]["presentation"],
            toolCallId: action.toolCallId,
          }),
        );
        return {
          approvalRequest: { action, approvalRequestId, expiresAt },
          type: "waitingApproval" as const,
        };
      });

      const ensureAction: ActionRepositoryService["ensureAction"] = Effect.fn(
        "ActionRepository.ensureAction",
      )(function* (fence, request, effectiveGate) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const action = makeSendDemoEmailAction(request);
              const previous = (yield* loadAction(request.toolCallId))[0];
              if (previous !== undefined) {
                if (
                  previous.agentRunId !== request.agentRunId ||
                  previous.actionDigest !== action.actionDigest
                ) {
                  return yield* new ActionDriverError({ cause: "Immutable Action mismatch" });
                }
                const receipt = (yield* loadReceipt(action.toolCallId))[0];
                if (receipt !== undefined) {
                  return { receipt: toReceipt(receipt), type: "terminal" as const };
                }
                if (previous.state === "dispatching" || previous.state === "reconcileRequired") {
                  return { action, type: "reconcileRequired" as const };
                }
                if (gateRank[effectiveGate] < gateRank[previous.effectiveGate]) {
                  return yield* new ActionDriverError({
                    cause: "Operation gate cannot become looser",
                  });
                }
                if (gateRank[effectiveGate] > gateRank[previous.effectiveGate]) {
                  if (effectiveGate === "requireApproval") {
                    const attempts = yield* sql<{
                      readonly count: number;
                    }>`SELECT count(*)::int AS count
                      FROM action_attempts WHERE tool_call_id = ${action.toolCallId}`;
                    if (previous.state !== "ready" || attempts[0]?.count !== 0) {
                      return yield* new ActionDriverError({
                        cause: "Cannot strengthen an active Action",
                      });
                    }
                    yield* sql`UPDATE actions SET effective_gate = ${effectiveGate}
                      WHERE tool_call_id = ${action.toolCallId}`;
                    return yield* createApproval(authority, action);
                  }
                  yield* sql`UPDATE actions SET effective_gate = ${effectiveGate}
                    WHERE tool_call_id = ${action.toolCallId}`;
                }
                const approval = (yield* loadApproval(action.toolCallId))[0];
                if (approval?.state === "pending") {
                  if (effectiveGate === "deny") {
                    yield* sql`UPDATE action_approval_requests
                      SET state = 'canceled', decided_at = transaction_timestamp()
                      WHERE approval_request_id = ${approval.approvalRequestId}::uuid`;
                    yield* sql`UPDATE actions SET state = 'ready'
                      WHERE tool_call_id = ${action.toolCallId}`;
                    return { action, type: "ready" as const };
                  }
                  if (approval.isExpired) {
                    yield* sql`UPDATE action_approval_requests
                      SET state = 'expired', decided_at = transaction_timestamp()
                      WHERE approval_request_id = ${approval.approvalRequestId}::uuid`;
                    const terminal = yield* terminalize(authority, action, "notApplied");
                    return { receipt: terminal, type: "terminal" as const };
                  }
                  return {
                    approvalRequest: {
                      action,
                      approvalRequestId: approval.approvalRequestId,
                      expiresAt: new Date(approval.expiresAt).toISOString(),
                    },
                    type: "waitingApproval" as const,
                  };
                }
                if (
                  approval?.state === "denied" ||
                  approval?.state === "expired" ||
                  approval?.state === "canceled"
                ) {
                  const terminal = yield* terminalize(authority, action, "notApplied");
                  return { receipt: terminal, type: "terminal" as const };
                }
                return { action, type: "ready" as const };
              }

              if (authority.cancellationRequested) {
                return yield* new ActionDriverError({ cause: "AgentRun cancellation requested" });
              }

              const batchId = randomUUID();
              yield* sql`INSERT INTO tool_call_batches (
                  tool_call_batch_id, agent_run_id, batch_key, member_count,
                  completed_count, state, created_at
                ) VALUES (
                  ${batchId}::uuid, ${request.agentRunId}::uuid,
                  ${`action:${request.toolCallId}`}, 1, 0, 'pending', transaction_timestamp()
                )`;
              yield* sql`INSERT INTO tool_calls (
                  tool_call_id, tool_call_batch_id, agent_run_id, member_index,
                  execution_mode, tool_name, attempt_limit, input, state, created_at
                ) VALUES (
                  ${request.toolCallId}, ${batchId}::uuid, ${request.agentRunId}::uuid,
                  0, 'action', 'send_demo_email', 1,
                  ${JSON.stringify({ text: request.subject, type: "text" })}::jsonb,
                  'pending', transaction_timestamp()
                )`;
              const initialState =
                effectiveGate === "requireApproval" ? "waitingApproval" : "ready";
              yield* sql`INSERT INTO actions (
                  tool_call_id, agent_run_id, action_definition_ref, action_digest,
                  subject, presentation, success_boundary, effective_gate, state, created_at
                ) VALUES (
                  ${action.toolCallId}, ${action.agentRunId}::uuid, ${action.actionDefinitionRef},
                  ${action.actionDigest}, ${action.subject},
                  ${JSON.stringify(action.presentation)}::jsonb,
                  ${JSON.stringify(action.successBoundary)}::jsonb,
                  ${effectiveGate}, ${initialState}, transaction_timestamp()
                )`;
              if (effectiveGate !== "requireApproval") return { action, type: "ready" as const };

              return yield* createApproval(authority, action);
            }),
          ),
        );
      });

      const decideApproval: ActionRepositoryService["decideApproval"] = Effect.fn(
        "ActionRepository.decideApproval",
      )(function* (decision: ActionApprovalDecision) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const approvals = yield* sql<ApprovalRow>`SELECT
                  approval_request_id::text AS "approvalRequestId", tool_call_id AS "toolCallId",
                  action_digest AS "actionDigest", state,
                  decision_id::text AS "decisionId", expires_at::text AS "expiresAt",
                  expires_at <= clock_timestamp() AS "isExpired"
                FROM action_approval_requests
                WHERE approval_request_id = ${decision.approvalRequestId}::uuid FOR UPDATE`;
              const approval = approvals[0];
              if (approval === undefined || approval.toolCallId !== decision.toolCallId) {
                return yield* new ActionDriverError({ cause: "Approval binding rejected" });
              }
              if (approval.state !== "pending") {
                if (
                  approval.state === decision.decision &&
                  approval.decisionId === decision.decisionId
                )
                  return;
                return yield* new ActionDriverError({ cause: "Approval already terminal" });
              }
              const actionRow = (yield* loadAction(decision.toolCallId))[0];
              if (
                actionRow === undefined ||
                actionRow.state === "applied" ||
                actionRow.state === "notApplied" ||
                actionRow.state === "unresolved"
              ) {
                return yield* new ActionDriverError({ cause: "Action is already terminal" });
              }
              const updated = yield* sql<{
                readonly toolCallId: string;
              }>`UPDATE action_approval_requests
                SET state = ${decision.decision}, decision_id = ${decision.decisionId}::uuid,
                    decided_at = transaction_timestamp()
                WHERE approval_request_id = ${decision.approvalRequestId}::uuid
                  AND expires_at > clock_timestamp()
                RETURNING tool_call_id AS "toolCallId"`;
              if (updated.length !== 1) {
                yield* sql`UPDATE action_approval_requests
                  SET state = 'expired', decided_at = transaction_timestamp()
                  WHERE approval_request_id = ${decision.approvalRequestId}::uuid`;
                const actionRow = (yield* loadAction(decision.toolCallId))[0];
                if (actionRow === undefined)
                  return yield* new ActionDriverError({ cause: "Action missing" });
                const authority = yield* loadAuthority(actionRow.agentRunId);
                yield* terminalize(authority, toAction(actionRow), "notApplied");
                return;
              }
              if (decision.decision === "approved") {
                yield* sql`UPDATE actions SET state = 'ready'
                  WHERE tool_call_id = ${decision.toolCallId} AND state = 'waitingApproval'`;
              } else {
                const actionRow = (yield* loadAction(decision.toolCallId))[0];
                if (actionRow === undefined)
                  return yield* new ActionDriverError({ cause: "Action missing" });
                const authority = yield* loadAuthority(actionRow.agentRunId);
                yield* terminalize(authority, toAction(actionRow), "notApplied");
              }
            }),
          ),
        );
      });

      const beginAttempt: ActionRepositoryService["beginAttempt"] = Effect.fn(
        "ActionRepository.beginAttempt",
      )(function* (fence, action, authorizationRevision) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const current = (yield* loadAction(action.toolCallId))[0];
              if (
                current === undefined ||
                current.agentRunId !== action.agentRunId ||
                current.actionDigest !== action.actionDigest
              ) {
                return yield* new ActionDriverError({ cause: "Action binding rejected" });
              }
              const receipt = (yield* loadReceipt(action.toolCallId))[0];
              if (receipt !== undefined)
                return { receipt: toReceipt(receipt), type: "terminal" as const };
              const attempts = yield* sql<AttemptRow>`SELECT
                  action_attempt_id::text AS "actionAttemptId", attempt_number AS "attemptNumber",
                  claim_epoch::text AS "claimEpoch", authorization_revision AS "authorizationRevision",
                  state FROM action_attempts WHERE tool_call_id = ${action.toolCallId}
                  ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`;
              const previous = attempts[0];
              if (previous?.state === "dispatching") {
                if (BigInt(previous.claimEpoch) >= BigInt(fence.claimEpoch)) {
                  return yield* new ActionDriverError({
                    cause: "Action dispatch is already in flight",
                  });
                }
                yield* sql`UPDATE action_attempts SET state = 'uncertain',
                    finished_at = transaction_timestamp()
                  WHERE action_attempt_id = ${previous.actionAttemptId}::uuid`;
                yield* sql`UPDATE actions SET state = 'reconcileRequired'
                  WHERE tool_call_id = ${action.toolCallId}`;
                return {
                  attempt: { ...previous, action },
                  type: "reconcile" as const,
                };
              }
              if (previous?.state === "uncertain" || current.state === "reconcileRequired") {
                if (previous === undefined)
                  return yield* new ActionDriverError({ cause: "Attempt missing" });
                return { attempt: { ...previous, action }, type: "reconcile" as const };
              }
              if (current.state !== "ready" || previous !== undefined) {
                return yield* new ActionDriverError({ cause: "Action is not dispatchable" });
              }
              if (authority.cancellationRequested) {
                return yield* new ActionDriverError({ cause: "AgentRun cancellation requested" });
              }
              const attempt: ActionAttempt = {
                action,
                actionAttemptId: randomUUID(),
                attemptNumber: 1,
                authorizationRevision,
                claimEpoch: fence.claimEpoch,
              };
              yield* sql`INSERT INTO action_attempts (
                  action_attempt_id, tool_call_id, agent_run_id, attempt_number,
                  claim_epoch, authorization_revision, state, started_at
                ) VALUES (
                  ${attempt.actionAttemptId}::uuid, ${action.toolCallId},
                  ${action.agentRunId}::uuid, 1, ${fence.claimEpoch}::bigint,
                  ${authorizationRevision}, 'dispatching', transaction_timestamp()
                )`;
              yield* sql`UPDATE actions SET state = 'dispatching'
                WHERE tool_call_id = ${action.toolCallId}`;
              yield* sql`UPDATE tool_calls SET state = 'running'
                WHERE tool_call_id = ${action.toolCallId}`;
              return { attempt, type: "dispatch" as const };
            }),
          ),
        );
      });

      const completeWithoutDispatch: ActionRepositoryService["completeWithoutDispatch"] = Effect.fn(
        "ActionRepository.completeWithoutDispatch",
      )(function* (fence, action, cause) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const actionRow = (yield* loadAction(action.toolCallId))[0];
              if (
                actionRow === undefined ||
                actionRow.agentRunId !== action.agentRunId ||
                actionRow.actionDigest !== action.actionDigest
              ) {
                return yield* new ActionDriverError({ cause: "Persisted Action mismatch" });
              }
              const attempts = yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count
                  FROM action_attempts WHERE tool_call_id = ${action.toolCallId}`;
              if (actionRow.state !== "ready" || attempts[0]?.count !== 0) {
                return yield* new ActionDriverError({
                  cause: "Action with external contact cannot complete as not applied",
                });
              }
              return yield* terminalize(authority, toAction(actionRow), "notApplied", cause);
            }),
          ),
        );
      });

      const recordExternalResult: ActionRepositoryService["recordExternalResult"] = Effect.fn(
        "ActionRepository.recordExternalResult",
      )(function* (fence, attempt, result: ActionExternalResult) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const current = (yield* sql<AttemptRow>`SELECT
                  action_attempt_id::text AS "actionAttemptId", attempt_number AS "attemptNumber",
                  claim_epoch::text AS "claimEpoch", authorization_revision AS "authorizationRevision",
                  state FROM action_attempts
                WHERE action_attempt_id = ${attempt.actionAttemptId}::uuid
                  AND tool_call_id = ${attempt.action.toolCallId} FOR UPDATE`)[0];
              if (current === undefined)
                return yield* new ActionDriverError({ cause: "Attempt missing" });
              const actionRow = (yield* loadAction(attempt.action.toolCallId))[0];
              if (
                actionRow === undefined ||
                current.actionAttemptId !== attempt.actionAttemptId ||
                current.attemptNumber !== attempt.attemptNumber ||
                current.claimEpoch !== attempt.claimEpoch ||
                current.authorizationRevision !== attempt.authorizationRevision ||
                actionRow.agentRunId !== attempt.action.agentRunId ||
                actionRow.actionDigest !== attempt.action.actionDigest
              ) {
                return yield* new ActionDriverError({ cause: "Persisted Action attempt mismatch" });
              }
              const persistedAction = toAction(actionRow);
              const receipt = (yield* loadReceipt(attempt.action.toolCallId))[0];
              if (receipt !== undefined)
                return { receipt: toReceipt(receipt), type: "terminal" as const };
              if (result.type === "uncertain" && current.state === "dispatching") {
                yield* sql`UPDATE action_attempts SET state = 'uncertain',
                    finished_at = transaction_timestamp()
                  WHERE action_attempt_id = ${attempt.actionAttemptId}::uuid`;
                yield* sql`UPDATE actions SET state = 'reconcileRequired'
                  WHERE tool_call_id = ${attempt.action.toolCallId}`;
                return { type: "reconcileRequired" as const };
              }
              if (result.type === "uncertain") {
                const unresolved = yield* terminalize(authority, persistedAction, "unresolved");
                return { receipt: unresolved, type: "terminal" as const };
              }
              yield* sql`UPDATE action_attempts SET state = ${result.type},
                  finished_at = transaction_timestamp()
                WHERE action_attempt_id = ${attempt.actionAttemptId}::uuid`;
              const terminal = yield* terminalize(authority, persistedAction, result.type);
              return { receipt: terminal, type: "terminal" as const };
            }),
          ),
        );
      });

      return ActionRepository.of({
        beginAttempt,
        completeWithoutDispatch,
        decideApproval,
        ensureAction,
        recordExternalResult,
      });
    }),
  );
  return repository.pipe(Layer.provide(postgresLayer));
};

export const makeActionRepositoryLayer = repositoryLayer;
