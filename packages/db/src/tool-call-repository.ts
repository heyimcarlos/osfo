import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunCancellationObserved,
  AgentRunFenceRejected,
  AgentRunRepositoryUnavailable,
  ToolCallRepository,
  type AgentRunFence,
  type PreparedToolCall,
  type PreparedToolCallBatch,
  type ToolCallBatchState,
  type ToolCallOutcome,
  type ToolCallRepositoryService,
} from "@osfo/agent-run";
import {
  makeToolCallProgressRecorded,
  makeToolCallRequested,
  makeToolCallResultRecorded,
  type InvalidThreadEvent,
  type ThreadEvent,
} from "@osfo/session";
import { Effect, Layer, Predicate, Redacted } from "effect";
import type { AgentRunRepositoryDatabaseConfig } from "./agent-run-repository.js";

interface BatchRow {
  readonly agentRunId: string;
  readonly batchKey: string;
  readonly completedCount: number;
  readonly memberCount: number;
  readonly state: "pending" | "succeeded" | "failed" | "canceled";
  readonly toolCallBatchId: string;
}

interface CallRow {
  readonly agentRunId: string;
  readonly attemptLimit: number;
  readonly executionMode: "nonAction";
  readonly input: PreparedToolCall["input"];
  readonly memberIndex: number;
  readonly outcome: ToolCallOutcome | null;
  readonly state: "pending" | "running" | "succeeded" | "failed" | "canceled";
  readonly toolCallBatchId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface AgentRunAuthority {
  readonly agentRunId: string;
  readonly cancellationRequested: boolean;
  readonly principalId: string;
  readonly threadId: string;
  readonly userMessageId: string;
}

type ToolCallPresentation = Parameters<typeof makeToolCallRequested>[0]["presentation"];

type EventBuilder = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly threadPosition: string;
  readonly occurredAt: string;
  readonly agentRunId: string;
}) => Effect.Effect<ThreadEvent, InvalidThreadEvent>;

const presentationForTool = (toolName: string): ToolCallPresentation =>
  toolName === "echo"
    ? {
        version: 1,
        title: "Echo text",
        description: "Run the bounded local echo tool.",
      }
    : {
        version: 1,
        title: "Run tool",
        description: "Run a bounded non-Action tool.",
      };

const publicOutcome = (outcome: ToolCallOutcome) => {
  switch (outcome.type) {
    case "succeeded":
      return { type: "succeeded" as const };
    case "failed":
      return { type: "failed" as const, cause: outcome.cause };
    case "canceled":
      return { type: "canceled" as const };
  }
};

const toPreparedCall = (row: CallRow): PreparedToolCall => ({
  agentRunId: row.agentRunId,
  attemptLimit: row.attemptLimit,
  executionMode: row.executionMode,
  input: row.input,
  memberIndex: row.memberIndex,
  toolCallBatchId: row.toolCallBatchId,
  toolCallId: row.toolCallId,
  toolName: row.toolName,
});

const outcomesEqual = (left: ToolCallOutcome, right: ToolCallOutcome) => {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "canceled":
      return true;
    case "failed":
      return right.type === "failed" && left.cause === right.cause;
    case "succeeded":
      return (
        right.type === "succeeded" &&
        left.result.type === right.result.type &&
        left.result.text === right.result.text
      );
  }
};

const repositoryLayer = (config: AgentRunRepositoryDatabaseConfig) => {
  const postgresLayer = PgClient.layer({
    applicationName: "osfo-tool-call-repository",
    maxConnections: config.maxConnections,
    url: Redacted.make(config.databaseUrl),
  });

  const repository = Layer.effect(
    ToolCallRepository,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const isFenceRejected = Predicate.isTagged("AgentRunFenceRejected");
      const isCancellationObserved = Predicate.isTagged("AgentRunCancellationObserved");
      const protect = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isFenceRejected(cause)
              ? new AgentRunFenceRejected()
              : isCancellationObserved(cause)
                ? new AgentRunCancellationObserved()
                : new AgentRunRepositoryUnavailable({ cause }),
          ),
        );

      const requireFence = Effect.fn("ToolCallRepository.requireFence")(function* (
        fence: AgentRunFence,
      ) {
        const rows = yield* sql<AgentRunAuthority>`SELECT
            agent_run_id::text AS "agentRunId",
            thread_id::text AS "threadId",
            principal_id::text AS "principalId",
            user_message_id::text AS "userMessageId",
            cancellation_requested_at IS NOT NULL AS "cancellationRequested"
          FROM agent_runs
          WHERE agent_run_id = ${fence.agentRunId}::uuid
            AND state = 'running'
            AND claim_owner = ${fence.workerId}
            AND claim_epoch = ${fence.claimEpoch}::bigint
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE`;
        const authority = rows[0];
        if (authority === undefined) return yield* new AgentRunFenceRejected();
        return authority;
      });

      const requireOpenFence = Effect.fn("ToolCallRepository.requireOpenFence")(function* (
        fence: AgentRunFence,
      ) {
        const authority = yield* requireFence(fence);
        if (authority.cancellationRequested) return yield* new AgentRunCancellationObserved();
        return authority;
      });

      const appendThreadEvent = Effect.fn("ToolCallRepository.appendThreadEvent")(function* (
        authority: AgentRunAuthority,
        build: EventBuilder,
      ) {
        const positions = yield* sql<{ readonly position: string }>`UPDATE threads
          SET next_position = next_position + 1,
              state_revision = state_revision + 1
          WHERE thread_id = ${authority.threadId}::uuid
          RETURNING (next_position - 1)::text AS position`;
        const position = positions[0];
        if (position === undefined) {
          return yield* new AgentRunRepositoryUnavailable({ cause: "Thread authority missing" });
        }
        const timestamps = yield* sql<{ readonly occurredAt: string }>`SELECT
          transaction_timestamp()::text AS "occurredAt"`;
        const timestamp = timestamps[0];
        if (timestamp === undefined) {
          return yield* new AgentRunRepositoryUnavailable({ cause: "Timestamp unavailable" });
        }
        const event = yield* build({
          eventId: randomUUID(),
          threadId: authority.threadId,
          threadPosition: position.position,
          occurredAt: new Date(timestamp.occurredAt).toISOString(),
          agentRunId: authority.agentRunId,
        });
        yield* sql`INSERT INTO thread_events (
            thread_id, position, event_id, principal_id, user_message_id,
            agent_run_id, event_type, event_version, payload, occurred_at
          ) VALUES (
            ${event.threadId}::uuid,
            ${event.threadPosition}::bigint,
            ${event.eventId}::uuid,
            ${authority.principalId}::uuid,
            ${authority.userMessageId}::uuid,
            ${event.payload.agentRunId}::uuid,
            ${event.eventType},
            ${event.eventVersion},
            ${JSON.stringify(event.payload)}::jsonb,
            ${event.occurredAt}::timestamptz
          )`;
        return event;
      });

      const appendResultEvent = (
        authority: AgentRunAuthority,
        call: Pick<CallRow, "toolCallId" | "toolName">,
        outcome: ToolCallOutcome,
      ) =>
        appendThreadEvent(authority, (base) =>
          makeToolCallResultRecorded({
            ...base,
            toolCallId: call.toolCallId,
            presentation: presentationForTool(call.toolName),
            outcome: publicOutcome(outcome),
          }),
        );

      const loadCalls = (batchId: string, agentRunId: string) =>
        sql<CallRow>`SELECT
            tool_call_id::text AS "toolCallId",
            tool_call_batch_id::text AS "toolCallBatchId",
            agent_run_id::text AS "agentRunId",
            member_index AS "memberIndex",
            execution_mode AS "executionMode",
            tool_name AS "toolName",
            attempt_limit AS "attemptLimit",
            input,
            state,
            outcome
          FROM tool_calls
          WHERE tool_call_batch_id = ${batchId}::uuid
            AND agent_run_id = ${agentRunId}::uuid
          ORDER BY member_index`;

      const requireBatch = Effect.fn("ToolCallRepository.requireBatch")(function* (
        fence: AgentRunFence,
        batch: PreparedToolCallBatch,
      ) {
        if (batch.agentRunId !== fence.agentRunId) return yield* new AgentRunFenceRejected();
        const rows = yield* sql<BatchRow>`SELECT
            tool_call_batch_id::text AS "toolCallBatchId",
            agent_run_id::text AS "agentRunId",
            batch_key AS "batchKey",
            member_count AS "memberCount",
            completed_count AS "completedCount",
            state
          FROM tool_call_batches
          WHERE tool_call_batch_id = ${batch.toolCallBatchId}::uuid
            AND agent_run_id = ${fence.agentRunId}::uuid
          FOR UPDATE`;
        const row = rows[0];
        if (row === undefined || row.batchKey !== batch.batchKey) {
          return yield* new AgentRunFenceRejected();
        }
        return row;
      });

      const commitBatch: ToolCallRepositoryService["commitBatch"] = Effect.fn(
        "ToolCallRepository.commitBatch",
      )(function* (fence, request) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireOpenFence(fence);
              const existing = yield* sql<BatchRow>`SELECT
                  tool_call_batch_id::text AS "toolCallBatchId",
                  agent_run_id::text AS "agentRunId",
                  batch_key AS "batchKey",
                  member_count AS "memberCount",
                  completed_count AS "completedCount",
                  state
                FROM tool_call_batches
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND batch_key = ${request.batchKey}
                FOR UPDATE`;
              const previous = existing[0];
              if (previous !== undefined) {
                const previousCalls = yield* loadCalls(previous.toolCallBatchId, fence.agentRunId);
                if (
                  previousCalls.length !== request.requests.length ||
                  previousCalls.some((call, index) => {
                    const requested = request.requests[index];
                    return (
                      requested === undefined ||
                      call.toolName !== requested.toolName ||
                      call.executionMode !== requested.executionMode ||
                      call.input.type !== requested.input.type ||
                      call.input.text !== requested.input.text
                    );
                  }) ||
                  previousCalls.some((call) => call.attemptLimit !== request.attemptLimit)
                ) {
                  return yield* new AgentRunFenceRejected();
                }
                return {
                  agentRunId: fence.agentRunId,
                  batchKey: previous.batchKey,
                  toolCallBatchId: previous.toolCallBatchId,
                  calls: previousCalls.map(toPreparedCall),
                };
              }

              const toolCallBatchId = randomUUID();
              yield* sql`INSERT INTO tool_call_batches (
                  tool_call_batch_id, agent_run_id, batch_key, member_count,
                  completed_count, state, created_at
                ) VALUES (
                  ${toolCallBatchId}::uuid, ${fence.agentRunId}::uuid, ${request.batchKey},
                  ${request.requests.length}, 0, 'pending', transaction_timestamp()
                )`;
              const calls: Array<PreparedToolCall> = [];
              for (const [memberIndex, member] of request.requests.entries()) {
                const toolCallId = `tool_${randomUUID()}`;
                yield* sql`INSERT INTO tool_calls (
                    tool_call_id, tool_call_batch_id, agent_run_id, member_index,
                    execution_mode, tool_name, attempt_limit, input, state, created_at
                  ) VALUES (
                    ${toolCallId}, ${toolCallBatchId}::uuid,
                    ${fence.agentRunId}::uuid, ${memberIndex}, ${member.executionMode},
                    ${member.toolName},
                    ${request.attemptLimit},
                    ${JSON.stringify(member.input)}::jsonb, 'pending', transaction_timestamp()
                  )`;
                calls.push({
                  agentRunId: fence.agentRunId,
                  attemptLimit: request.attemptLimit,
                  executionMode: member.executionMode,
                  input: member.input,
                  memberIndex,
                  toolCallBatchId,
                  toolCallId,
                  toolName: member.toolName,
                });
                yield* appendThreadEvent(authority, (base) =>
                  makeToolCallRequested({
                    ...base,
                    memberIndex,
                    presentation: presentationForTool(member.toolName),
                    toolCallId,
                  }),
                );
              }
              return {
                agentRunId: fence.agentRunId,
                batchKey: request.batchKey,
                calls,
                toolCallBatchId,
              };
            }),
          ),
        );
      });

      const claimNextAttempt: ToolCallRepositoryService["claimNextAttempt"] = Effect.fn(
        "ToolCallRepository.claimNextAttempt",
      )(function* (fence, batch) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireOpenFence(fence);
              const persistedBatch = yield* requireBatch(fence, batch);
              if (persistedBatch.state !== "pending") return { type: "terminal" as const };

              const active = yield* sql`SELECT tool_call_attempt_id
                FROM tool_call_attempts
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'started'
                  AND claim_epoch = ${fence.claimEpoch}::bigint
                FOR UPDATE`;
              if (active.length > 0) return { type: "busy" as const };

              const staleCalls = yield* sql<{ readonly toolCallId: string }>`UPDATE
                  tool_call_attempts
                SET state = 'stale', finished_at = transaction_timestamp()
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'started'
                  AND claim_epoch < ${fence.claimEpoch}::bigint
                RETURNING tool_call_id::text AS "toolCallId"`;
              for (const stale of staleCalls) {
                yield* sql`UPDATE tool_calls
                  SET state = 'pending', current_progress = NULL
                  WHERE tool_call_id = ${stale.toolCallId}
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'running'`;
              }

              const candidates = yield* sql<CallRow>`SELECT
                  tool_call_id::text AS "toolCallId",
                  tool_call_batch_id::text AS "toolCallBatchId",
                  agent_run_id::text AS "agentRunId",
                  member_index AS "memberIndex",
                  execution_mode AS "executionMode",
                  tool_name AS "toolName",
                  attempt_limit AS "attemptLimit",
                  input,
                  state,
                  outcome
                FROM tool_calls
                WHERE tool_call_batch_id = ${batch.toolCallBatchId}::uuid
                  AND agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'pending'
                ORDER BY member_index
                FOR UPDATE SKIP LOCKED
                LIMIT 1`;
              const call = candidates[0];
              if (call === undefined) return { type: "none" as const };

              const counts = yield* sql<{
                readonly attemptCount: number;
                readonly retryableCount: number;
              }>`SELECT
                  count(*)::int AS "attemptCount",
                  count(*) FILTER (WHERE state = 'retryable')::int AS "retryableCount"
                FROM tool_call_attempts
                WHERE tool_call_id = ${call.toolCallId}`;
              const attemptNumber = (counts[0]?.attemptCount ?? 0) + 1;
              if ((counts[0]?.retryableCount ?? 0) >= call.attemptLimit) {
                const outcome = {
                  type: "failed" as const,
                  cause: "dependencyUnavailable" as const,
                };
                const failed = yield* sql`UPDATE tool_calls
                  SET state = 'failed', outcome = ${JSON.stringify(outcome)}::jsonb,
                      current_progress = NULL, completed_at = transaction_timestamp()
                  WHERE tool_call_id = ${call.toolCallId} AND state = 'pending'
                  RETURNING tool_call_id`;
                if (failed.length !== 1) return yield* new AgentRunFenceRejected();
                yield* appendResultEvent(authority, call, outcome);
                const canceledOutcome = JSON.stringify({ type: "canceled" });
                const canceledCalls = yield* sql<{
                  readonly toolCallId: string;
                  readonly toolName: string;
                }>`UPDATE tool_calls
                  SET state = 'canceled', outcome = ${canceledOutcome}::jsonb,
                      current_progress = NULL, completed_at = transaction_timestamp()
                  WHERE tool_call_batch_id = ${batch.toolCallBatchId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND tool_call_id <> ${call.toolCallId}
                    AND state IN ('pending', 'running')
                  RETURNING tool_call_id AS "toolCallId", tool_name AS "toolName"`;
                for (const canceled of canceledCalls) {
                  yield* appendResultEvent(authority, canceled, { type: "canceled" });
                }
                yield* sql`UPDATE tool_call_batches
                  SET state = 'failed', completed_at = transaction_timestamp()
                  WHERE tool_call_batch_id = ${batch.toolCallBatchId}::uuid AND state = 'pending'`;
                return { type: "terminal" as const };
              }

              const toolCallAttemptId = randomUUID();
              yield* sql`INSERT INTO tool_call_attempts (
                  tool_call_attempt_id, tool_call_id, agent_run_id, attempt_number,
                  claim_epoch, state, started_at
                ) VALUES (
                  ${toolCallAttemptId}::uuid, ${call.toolCallId},
                  ${fence.agentRunId}::uuid, ${attemptNumber},
                  ${fence.claimEpoch}::bigint, 'started', transaction_timestamp()
                )`;
              const started = yield* sql`UPDATE tool_calls SET state = 'running'
                WHERE tool_call_id = ${call.toolCallId} AND state = 'pending'
                RETURNING tool_call_id`;
              if (started.length !== 1) return yield* new AgentRunFenceRejected();
              return {
                type: "started" as const,
                attempt: {
                  ...toPreparedCall(call),
                  attemptNumber,
                  toolCallAttemptId,
                },
              };
            }),
          ),
        );
      });

      const appendProgress: ToolCallRepositoryService["appendProgress"] = Effect.fn(
        "ToolCallRepository.appendProgress",
      )(function* (fence, attempt, progress) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireOpenFence(fence);
              const inserted = yield* sql`INSERT INTO tool_call_progress_events (
                  tool_call_id, observation_index, tool_call_attempt_id, agent_run_id,
                  message, created_at
                ) SELECT
                  ${attempt.toolCallId}, ${progress.observationIndex},
                  ${attempt.toolCallAttemptId}::uuid, ${fence.agentRunId}::uuid,
                  ${progress.message}, transaction_timestamp()
                FROM tool_call_attempts
                WHERE tool_call_attempt_id = ${attempt.toolCallAttemptId}::uuid
                  AND tool_call_id = ${attempt.toolCallId}
                  AND agent_run_id = ${fence.agentRunId}::uuid
                  AND claim_epoch = ${fence.claimEpoch}::bigint
                  AND state = 'started'
                ON CONFLICT (tool_call_attempt_id, observation_index) DO NOTHING
                RETURNING observation_index`;
              if (inserted.length === 0) {
                const duplicate = yield* sql<{ readonly message: string }>`SELECT message
                  FROM tool_call_progress_events
                  WHERE tool_call_attempt_id = ${attempt.toolCallAttemptId}::uuid
                    AND observation_index = ${progress.observationIndex}`;
                if (duplicate[0]?.message !== progress.message) {
                  return yield* new AgentRunFenceRejected();
                }
                return;
              }
              const updated = yield* sql`UPDATE tool_calls
                SET current_progress = ${JSON.stringify(progress)}::jsonb
                WHERE tool_call_id = ${attempt.toolCallId}
                  AND agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'running'
                  AND (
                    current_progress IS NULL
                    OR (current_progress ->> 'observationIndex')::integer
                      < ${progress.observationIndex}
                  )
                RETURNING tool_call_id`;
              if (updated.length === 0) {
                const current = yield* sql<{
                  readonly observationIndex: number | null;
                  readonly state: string;
                }>`SELECT
                    (current_progress ->> 'observationIndex')::integer AS "observationIndex",
                    state
                  FROM tool_calls
                  WHERE tool_call_id = ${attempt.toolCallId}
                    AND agent_run_id = ${fence.agentRunId}::uuid`;
                if (
                  current[0]?.state !== "running" ||
                  current[0].observationIndex === null ||
                  current[0].observationIndex < progress.observationIndex
                ) {
                  return yield* new AgentRunFenceRejected();
                }
                return;
              }
              yield* appendThreadEvent(authority, (base) =>
                makeToolCallProgressRecorded({
                  ...base,
                  toolCallId: attempt.toolCallId,
                  presentation: presentationForTool(attempt.toolName),
                  progress: { message: progress.message },
                }),
              );
            }),
          ),
        );
      });

      const completeAttempt: ToolCallRepositoryService["completeAttempt"] = Effect.fn(
        "ToolCallRepository.completeAttempt",
      )(function* (fence, attempt, outcome) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireOpenFence(fence);
              const calls = yield* sql<CallRow>`SELECT
                  tool_call_id::text AS "toolCallId", tool_call_batch_id::text AS "toolCallBatchId",
                  agent_run_id::text AS "agentRunId", member_index AS "memberIndex",
                  execution_mode AS "executionMode", tool_name AS "toolName",
                  attempt_limit AS "attemptLimit", input, state, outcome
                FROM tool_calls
                WHERE tool_call_id = ${attempt.toolCallId}
                  AND agent_run_id = ${fence.agentRunId}::uuid
                FOR UPDATE`;
              const call = calls[0];
              if (call === undefined) return yield* new AgentRunFenceRejected();
              if (call.toolCallBatchId !== attempt.toolCallBatchId) {
                return yield* new AgentRunFenceRejected();
              }
              if (call.outcome !== null) {
                if (!outcomesEqual(call.outcome, outcome)) {
                  return yield* new AgentRunFenceRejected();
                }
                return;
              }
              const finished = yield* sql`UPDATE tool_call_attempts
                SET state = ${outcome.type === "succeeded" ? "succeeded" : outcome.type},
                    finished_at = transaction_timestamp()
                WHERE tool_call_attempt_id = ${attempt.toolCallAttemptId}::uuid
                  AND tool_call_id = ${attempt.toolCallId}
                  AND agent_run_id = ${fence.agentRunId}::uuid
                  AND claim_epoch = ${fence.claimEpoch}::bigint
                  AND state = 'started'
                RETURNING tool_call_attempt_id`;
              if (finished.length !== 1) return yield* new AgentRunFenceRejected();
              const terminalState = outcome.type;
              const completed = yield* sql`UPDATE tool_calls
                SET state = ${terminalState}, outcome = ${JSON.stringify(outcome)}::jsonb,
                    current_progress = NULL, completed_at = transaction_timestamp()
                WHERE tool_call_id = ${attempt.toolCallId} AND state = 'running'
                RETURNING tool_call_id`;
              if (completed.length !== 1) return yield* new AgentRunFenceRejected();
              yield* appendResultEvent(authority, call, outcome);
              if (outcome.type !== "succeeded") {
                yield* sql`UPDATE tool_call_attempts attempt
                  SET state = 'canceled', finished_at = transaction_timestamp()
                  FROM tool_calls sibling
                  WHERE sibling.tool_call_batch_id = ${call.toolCallBatchId}::uuid
                    AND sibling.agent_run_id = ${fence.agentRunId}::uuid
                    AND attempt.tool_call_id = sibling.tool_call_id
                    AND attempt.agent_run_id = sibling.agent_run_id
                    AND attempt.state = 'started'`;
                const canceledOutcome = JSON.stringify({ type: "canceled" });
                const canceledCalls = yield* sql<{
                  readonly toolCallId: string;
                  readonly toolName: string;
                }>`UPDATE tool_calls
                  SET state = 'canceled', outcome = ${canceledOutcome}::jsonb,
                      current_progress = NULL, completed_at = transaction_timestamp()
                  WHERE tool_call_batch_id = ${call.toolCallBatchId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state IN ('pending', 'running')
                  RETURNING tool_call_id AS "toolCallId", tool_name AS "toolName"`;
                for (const canceled of canceledCalls) {
                  yield* appendResultEvent(authority, canceled, { type: "canceled" });
                }
                yield* sql`UPDATE tool_call_batches
                  SET state = ${terminalState}, completed_at = transaction_timestamp()
                  WHERE tool_call_batch_id = ${call.toolCallBatchId}::uuid AND state = 'pending'`;
                return;
              }
              yield* sql`UPDATE tool_call_batches
                SET completed_count = completed_count + 1,
                    state = CASE WHEN completed_count + 1 = member_count THEN 'succeeded' ELSE state END,
                    completed_at = CASE
                      WHEN completed_count + 1 = member_count THEN transaction_timestamp()
                      ELSE completed_at
                    END
                WHERE tool_call_batch_id = ${call.toolCallBatchId}::uuid AND state = 'pending'`;
            }),
          ),
        );
      });

      const retryAttempt: ToolCallRepositoryService["retryAttempt"] = Effect.fn(
        "ToolCallRepository.retryAttempt",
      )(function* (fence, attempt) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* requireOpenFence(fence);
              const finished = yield* sql`UPDATE tool_call_attempts
                SET state = 'retryable', finished_at = transaction_timestamp()
                WHERE tool_call_attempt_id = ${attempt.toolCallAttemptId}::uuid
                  AND tool_call_id = ${attempt.toolCallId}
                  AND agent_run_id = ${fence.agentRunId}::uuid
                  AND claim_epoch = ${fence.claimEpoch}::bigint
                  AND state = 'started'
                RETURNING tool_call_attempt_id`;
              if (finished.length !== 1) return yield* new AgentRunFenceRejected();
              const pending = yield* sql`UPDATE tool_calls
                SET state = 'pending', current_progress = NULL
                WHERE tool_call_id = ${attempt.toolCallId}
                  AND agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'running'
                RETURNING tool_call_id`;
              if (pending.length !== 1) return yield* new AgentRunFenceRejected();
            }),
          ),
        );
      });

      const cancelBatch: ToolCallRepositoryService["cancelBatch"] = Effect.fn(
        "ToolCallRepository.cancelBatch",
      )(function* (fence, batch) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const persisted = yield* requireBatch(fence, batch);
              if (persisted.state === "canceled") return;
              if (persisted.state !== "pending") return yield* new AgentRunFenceRejected();
              yield* sql`UPDATE tool_call_attempts attempt
                SET state = 'canceled', finished_at = transaction_timestamp()
                FROM tool_calls call
                WHERE call.tool_call_batch_id = ${batch.toolCallBatchId}::uuid
                  AND call.agent_run_id = ${fence.agentRunId}::uuid
                  AND attempt.tool_call_id = call.tool_call_id
                  AND attempt.agent_run_id = call.agent_run_id
                  AND attempt.state = 'started'`;
              const outcome = JSON.stringify({ type: "canceled" });
              const canceledCalls = yield* sql<{
                readonly toolCallId: string;
                readonly toolName: string;
              }>`UPDATE tool_calls
                SET state = 'canceled', outcome = ${outcome}::jsonb,
                    current_progress = NULL, completed_at = transaction_timestamp()
                WHERE tool_call_batch_id = ${batch.toolCallBatchId}::uuid
                  AND state IN ('pending', 'running')
                RETURNING tool_call_id AS "toolCallId", tool_name AS "toolName"`;
              for (const canceled of canceledCalls) {
                yield* appendResultEvent(authority, canceled, { type: "canceled" });
              }
              yield* sql`UPDATE tool_call_batches
                SET state = 'canceled', completed_at = transaction_timestamp()
                WHERE tool_call_batch_id = ${batch.toolCallBatchId}::uuid AND state = 'pending'`;
            }),
          ),
        );
      });

      const loadBatchState: ToolCallRepositoryService["loadBatchState"] = Effect.fn(
        "ToolCallRepository.loadBatchState",
      )(function* (fence, batch) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* requireFence(fence);
              const persisted = yield* requireBatch(fence, batch);
              const calls = yield* loadCalls(batch.toolCallBatchId, fence.agentRunId);
              if (persisted.state === "pending") {
                return {
                  type: "pending" as const,
                  calls: calls.map(toPreparedCall),
                } satisfies ToolCallBatchState;
              }
              if (persisted.state !== "succeeded") {
                return { type: persisted.state } satisfies ToolCallBatchState;
              }
              const outcomes = calls.map((call) => ({
                toolCallId: call.toolCallId,
                outcome: call.outcome,
              }));
              if (outcomes.some((item) => item.outcome === null)) {
                return yield* new AgentRunRepositoryUnavailable({
                  cause: "Succeeded ToolCall batch is missing an outcome",
                });
              }
              return {
                type: "succeeded",
                outcomes: outcomes.map((item) => ({
                  toolCallId: item.toolCallId,
                  outcome: item.outcome!,
                })),
              } satisfies ToolCallBatchState;
            }),
          ),
        );
      });

      return ToolCallRepository.of({
        appendProgress,
        cancelBatch,
        claimNextAttempt,
        commitBatch,
        completeAttempt,
        loadBatchState,
        retryAttempt,
      });
    }),
  );

  return repository.pipe(Layer.provide(postgresLayer));
};

export const makeToolCallRepositoryLayer = (config: AgentRunRepositoryDatabaseConfig) =>
  repositoryLayer(config);
