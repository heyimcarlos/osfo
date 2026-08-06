import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunFenceRejected,
  AgentRunRepository,
  AgentRunRepositoryUnavailable,
  type AgentRunFence,
  type AgentRunRepositoryService,
  type PreparedModelCall,
} from "@osfo/agent-run";
import {
  makeAgentRunFailed,
  makeAgentRunSucceeded,
  makeAssistantOutputAppended,
  makeAssistantOutputCompleted,
  makeAssistantOutputInterrupted,
  type InvalidThreadEvent,
  type ThreadEvent,
} from "@osfo/session";
import { Data, Effect, Layer, Predicate, Redacted, Schema } from "effect";

export const AgentRunRepositoryDatabaseConfigSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
});

export type AgentRunRepositoryDatabaseConfig = typeof AgentRunRepositoryDatabaseConfigSchema.Type;

export class InvalidAgentRunRepositoryDatabaseConfig extends Data.TaggedError(
  "InvalidAgentRunRepositoryDatabaseConfig",
)<{ readonly cause: unknown }> {}

interface AgentRunAuthority {
  readonly agentRunId: string;
  readonly threadId: string;
  readonly principalId: string;
  readonly userMessageId: string;
}

interface RecordedStateRow extends AgentRunAuthority {
  readonly executionProfileRef: string;
  readonly userMessage: string;
  readonly modelCallId: string | null;
  readonly modelCallState: "pending" | "succeeded" | "failed" | null;
  readonly prompt: string | null;
  readonly failureCause: "modelCallFailed" | null;
}

type EventBuilder = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly threadPosition: string;
  readonly occurredAt: string;
  readonly agentRunId: string;
}) => Effect.Effect<ThreadEvent, InvalidThreadEvent>;

const repositoryLayer = (config: AgentRunRepositoryDatabaseConfig) => {
  const postgresLayer = PgClient.layer({
    applicationName: "osfo-agent-run-repository",
    url: Redacted.make(config.databaseUrl),
  });

  return Layer.effect(
    AgentRunRepository,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const isFenceRejected = Predicate.isTagged("AgentRunFenceRejected");
      const protect = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isFenceRejected(cause)
              ? new AgentRunFenceRejected()
              : new AgentRunRepositoryUnavailable({ cause }),
          ),
        );

      const requireFence = Effect.fn("AgentRunRepository.requireFence")(function* (
        fence: AgentRunFence,
      ) {
        const rows = yield* sql<AgentRunAuthority>`SELECT
            agent_run_id::text AS "agentRunId",
            thread_id::text AS "threadId",
            principal_id::text AS "principalId",
            user_message_id::text AS "userMessageId"
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

      const appendThreadEvent = Effect.fn("AgentRunRepository.appendThreadEvent")(function* (
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

      const claimPublication: AgentRunRepositoryService["claimPublication"] = Effect.fn(
        "AgentRunRepository.claimPublication",
      )(function* (request) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const claims = yield* sql<{
                readonly agentRunId: string;
                readonly outboxId: string;
                readonly principalId: string;
                readonly publicationEpoch: string;
                readonly threadId: string;
              }>`WITH candidate AS (
                    SELECT obligation.outbox_id
                    FROM outbox_obligations obligation
                    JOIN relay_principals principal
                      ON principal.principal_id = obligation.principal_id
                    JOIN relay_threads thread
                      ON thread.thread_id = obligation.thread_id
                     AND thread.principal_id = obligation.principal_id
                    WHERE obligation.published_at IS NULL
                      AND (
                        obligation.publication_state = 'pending'
                        OR (
                          obligation.publication_state = 'publishing'
                          AND obligation.publication_lease_expires_at <= clock_timestamp()
                        )
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM outbox_obligations predecessor
                        WHERE predecessor.thread_id = obligation.thread_id
                          AND predecessor.published_at IS NULL
                          AND (predecessor.created_at, predecessor.outbox_id)
                            < (obligation.created_at, obligation.outbox_id)
                      )
                    ORDER BY
                      principal.virtual_pass,
                      principal.principal_id,
                      thread.virtual_pass,
                      thread.thread_id,
                      obligation.created_at,
                      obligation.outbox_id
                    FOR UPDATE OF obligation SKIP LOCKED
                    LIMIT 1
                  )
                  UPDATE outbox_obligations obligation
                  SET publication_state = 'publishing',
                      publication_epoch = obligation.publication_epoch + 1,
                      publication_owner = ${request.relayId},
                      publication_lease_expires_at = clock_timestamp()
                        + ${request.leaseDurationMs} * interval '1 millisecond'
                  FROM candidate
                  WHERE obligation.outbox_id = candidate.outbox_id
                  RETURNING
                    obligation.outbox_id::text AS "outboxId",
                    obligation.agent_run_id::text AS "agentRunId",
                    obligation.principal_id::text AS "principalId",
                    obligation.thread_id::text AS "threadId",
                    obligation.publication_epoch::text AS "publicationEpoch"`;
              const claim = claims[0];
              if (claim === undefined) return { type: "none" as const };
              yield* sql`UPDATE relay_principals
                SET virtual_pass = virtual_pass + 1
                WHERE principal_id = ${claim.principalId}::uuid`;
              yield* sql`UPDATE relay_threads
                SET virtual_pass = virtual_pass + 1
                WHERE thread_id = ${claim.threadId}::uuid`;
              return {
                type: "claimed" as const,
                outboxId: claim.outboxId,
                publicationEpoch: claim.publicationEpoch,
                relayId: request.relayId,
                delivery: {
                  version: 1 as const,
                  deliveryId: claim.outboxId,
                  agentRunId: claim.agentRunId,
                },
              };
            }),
          ),
        );
      });

      const confirmPublication: AgentRunRepositoryService["confirmPublication"] = Effect.fn(
        "AgentRunRepository.confirmPublication",
      )(function* (claim, confirmation) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const confirmed = yield* sql<{ readonly outboxId: string }>`UPDATE outbox_obligations
                  SET publication_state = 'published',
                      publication_owner = NULL,
                      publication_lease_expires_at = NULL,
                      publication_evidence = ${JSON.stringify({
                        type: "pubsub",
                        providerMessageId: confirmation.providerMessageId,
                      })}::jsonb,
                      published_at = transaction_timestamp()
                  WHERE outbox_id = ${claim.outboxId}::uuid
                    AND publication_state = 'publishing'
                    AND publication_owner = ${claim.relayId}
                    AND publication_epoch = ${claim.publicationEpoch}::bigint
                    AND publication_lease_expires_at > clock_timestamp()
                  RETURNING outbox_id::text AS "outboxId"`;
              if (confirmed[0] === undefined) return yield* new AgentRunFenceRejected();
            }),
          ),
        );
      });

      const claimAgentRun: AgentRunRepositoryService["claimAgentRun"] = Effect.fn(
        "AgentRunRepository.claimAgentRun",
      )(function* (delivery, request) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const claims = yield* sql<{
                readonly agentRunId: string;
                readonly claimEpoch: string;
              }>`UPDATE agent_runs run
                  SET state = 'running',
                      claim_epoch = run.claim_epoch + 1,
                      claim_owner = ${request.workerId},
                      lease_expires_at = clock_timestamp()
                        + ${request.leaseDurationMs} * interval '1 millisecond'
                  WHERE run.agent_run_id = ${delivery.agentRunId}::uuid
                    AND EXISTS (
                      SELECT 1 FROM outbox_obligations obligation
                      WHERE obligation.outbox_id = ${delivery.deliveryId}::uuid
                        AND obligation.agent_run_id = run.agent_run_id
                    )
                    AND (
                      run.state = 'pending'
                      OR (run.state = 'running' AND run.lease_expires_at <= clock_timestamp())
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM acceptance_receipts current_receipt
                      JOIN acceptance_receipts earlier_receipt
                        ON earlier_receipt.thread_id = current_receipt.thread_id
                        AND earlier_receipt.thread_position < current_receipt.thread_position
                      JOIN agent_runs earlier_run
                        ON earlier_run.agent_run_id = earlier_receipt.agent_run_id
                      WHERE current_receipt.agent_run_id = run.agent_run_id
                        AND earlier_run.state NOT IN ('succeeded', 'failed', 'canceled')
                    )
                  RETURNING run.agent_run_id::text AS "agentRunId",
                    run.claim_epoch::text AS "claimEpoch"`;
              const claim = claims[0];
              if (claim !== undefined) {
                return {
                  type: "claimed" as const,
                  fence: {
                    agentRunId: claim.agentRunId,
                    workerId: request.workerId,
                    claimEpoch: claim.claimEpoch,
                  },
                };
              }
              const states = yield* sql<{
                readonly state:
                  | "pending"
                  | "running"
                  | "waiting"
                  | "succeeded"
                  | "failed"
                  | "canceled";
              }>`SELECT state
                  FROM agent_runs
                  WHERE agent_run_id = ${delivery.agentRunId}::uuid`;
              const state = states[0]?.state;
              if (state === "succeeded" || state === "failed" || state === "canceled") {
                return { type: "terminal" as const, outcome: state };
              }
              return { type: "busy" as const };
            }),
          ),
        );
      });

      const loadRecordedState: AgentRunRepositoryService["loadRecordedState"] = Effect.fn(
        "AgentRunRepository.loadRecordedState",
      )(function* (fence) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* requireFence(fence);
              const rows = yield* sql<RecordedStateRow>`SELECT
                    run.agent_run_id::text AS "agentRunId",
                    run.thread_id::text AS "threadId",
                    run.principal_id::text AS "principalId",
                    run.user_message_id::text AS "userMessageId",
                    run.execution_profile_ref AS "executionProfileRef",
                    message.content AS "userMessage",
                    call.model_call_id::text AS "modelCallId",
                    call.state AS "modelCallState",
                    call.prompt,
                    call.failure_cause AS "failureCause"
                  FROM agent_runs run
                  JOIN user_messages message USING (user_message_id)
                  LEFT JOIN model_calls call USING (agent_run_id)
                  WHERE run.agent_run_id = ${fence.agentRunId}::uuid`;
              const row = rows[0];
              if (row === undefined) return yield* new AgentRunFenceRejected();
              const modelCall = yield* Effect.gen(function* () {
                if (row.modelCallId === null && row.modelCallState === null) {
                  return { type: "notStarted" } as const;
                }
                if (row.modelCallId === null || row.modelCallState === null) {
                  return yield* new AgentRunRepositoryUnavailable({
                    cause: "Persisted ModelCall identity and state disagree",
                  });
                }
                if (row.modelCallState === "pending") {
                  if (row.prompt === null) {
                    return yield* new AgentRunRepositoryUnavailable({
                      cause: "Pending ModelCall is missing its prompt",
                    });
                  }
                  return {
                    type: "pending",
                    modelCallId: row.modelCallId,
                    prompt: row.prompt,
                  } as const;
                }
                if (row.modelCallState === "succeeded") {
                  return { type: "succeeded", modelCallId: row.modelCallId } as const;
                }
                if (row.failureCause === null) {
                  return yield* new AgentRunRepositoryUnavailable({
                    cause: "Failed ModelCall is missing its failure cause",
                  });
                }
                return {
                  type: "failed",
                  modelCallId: row.modelCallId,
                  cause: row.failureCause,
                } as const;
              });
              return {
                agentRunId: row.agentRunId,
                executionProfileRef: row.executionProfileRef,
                userMessage: row.userMessage,
                modelCall,
              };
            }),
          ),
        );
      });

      const ensureModelCall: AgentRunRepositoryService["ensureModelCall"] = Effect.fn(
        "AgentRunRepository.ensureModelCall",
      )(function* (fence, decision) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const existing = yield* sql<PreparedModelCall>`SELECT
                    model_call_id::text AS "modelCallId",
                    assistant_output_id::text AS "assistantOutputId",
                    model_binding AS "modelBinding",
                    prompt
                  FROM model_calls
                  WHERE agent_run_id = ${fence.agentRunId}::uuid
                  FOR UPDATE`;
              const prepared = existing[0];
              if (prepared !== undefined) {
                if (
                  decision.type === "resumeModelCall" &&
                  decision.modelCallId !== prepared.modelCallId
                ) {
                  return yield* new AgentRunFenceRejected();
                }
                return prepared;
              }
              if (decision.type === "resumeModelCall") {
                return yield* new AgentRunFenceRejected();
              }
              const modelCallId = randomUUID();
              const assistantOutputId = randomUUID();
              const timestamps = yield* sql<{ readonly createdAt: string }>`SELECT
                  transaction_timestamp()::text AS "createdAt"`;
              const timestamp = timestamps[0];
              if (timestamp === undefined) {
                return yield* new AgentRunRepositoryUnavailable({ cause: "Timestamp unavailable" });
              }
              yield* sql`INSERT INTO assistant_outputs
                  (assistant_output_id, agent_run_id, state, created_at)
                  VALUES (
                    ${assistantOutputId}::uuid,
                    ${authority.agentRunId}::uuid,
                    'open',
                    ${timestamp.createdAt}::timestamptz
                  )`;
              yield* sql`INSERT INTO model_calls (
                    model_call_id, agent_run_id, assistant_output_id,
                    model_binding, prompt, state, created_at
                  ) VALUES (
                    ${modelCallId}::uuid,
                    ${authority.agentRunId}::uuid,
                    ${assistantOutputId}::uuid,
                    ${decision.modelBinding},
                    ${decision.prompt},
                    'pending',
                    ${timestamp.createdAt}::timestamptz
                  )`;
              return {
                modelCallId,
                assistantOutputId,
                modelBinding: decision.modelBinding,
                prompt: decision.prompt,
              };
            }),
          ),
        );
      });

      const beginModelCallAttempt: AgentRunRepositoryService["beginModelCallAttempt"] = Effect.fn(
        "AgentRunRepository.beginModelCallAttempt",
      )(function* (fence, modelCall) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* requireFence(fence);
              yield* sql`UPDATE model_call_attempts
                  SET state = 'failed', finished_at = transaction_timestamp()
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND state = 'started'
                    AND claim_epoch < ${fence.claimEpoch}::bigint`;
              const numbers = yield* sql<{ readonly attemptNumber: number }>`SELECT
                    (coalesce(max(attempt_number), 0) + 1)::integer AS "attemptNumber"
                  FROM model_call_attempts
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid`;
              const attemptNumber = numbers[0]?.attemptNumber;
              if (attemptNumber === undefined) {
                return yield* new AgentRunRepositoryUnavailable({ cause: "Attempt unavailable" });
              }
              const modelCallAttemptId = randomUUID();
              yield* sql`INSERT INTO model_call_attempts (
                    model_call_attempt_id, model_call_id, agent_run_id,
                    attempt_number, claim_epoch, state, started_at
                  )
                  SELECT
                    ${modelCallAttemptId}::uuid,
                    model_call_id,
                    agent_run_id,
                    ${attemptNumber},
                    ${fence.claimEpoch}::bigint,
                    'started',
                    transaction_timestamp()
                  FROM model_calls
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'pending'`;
              return {
                ...modelCall,
                modelCallAttemptId,
                attemptNumber,
                usage: { type: "unknown" as const },
              };
            }),
          ),
        );
      });

      const appendModelOutput: AgentRunRepositoryService["appendModelOutput"] = Effect.fn(
        "AgentRunRepository.appendModelOutput",
      )(function* (fence, attempt, observation) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const existing = yield* sql<{ readonly text: string }>`SELECT text
                  FROM model_call_fragments
                  WHERE model_call_id = ${attempt.modelCallId}::uuid
                    AND fragment_index = ${observation.fragmentIndex}`;
              if (existing[0]?.text === observation.text) return;
              if (existing[0] !== undefined) {
                return yield* new AgentRunRepositoryUnavailable({
                  cause: "ModelCall fragment authority conflict",
                });
              }
              const event = yield* appendThreadEvent(authority, (base) =>
                makeAssistantOutputAppended({
                  ...base,
                  assistantOutputId: attempt.assistantOutputId,
                  content: observation.text,
                }),
              );
              yield* sql`INSERT INTO model_call_fragments (
                    model_call_id, fragment_index, model_call_attempt_id,
                    assistant_output_id, agent_run_id, text, thread_event_id, created_at
                  ) VALUES (
                    ${attempt.modelCallId}::uuid,
                    ${observation.fragmentIndex},
                    ${attempt.modelCallAttemptId}::uuid,
                    ${attempt.assistantOutputId}::uuid,
                    ${fence.agentRunId}::uuid,
                    ${observation.text},
                    ${event.eventId}::uuid,
                    ${event.occurredAt}::timestamptz
                  )`;
            }),
          ),
        );
      });

      const completeModelCall: AgentRunRepositoryService["completeModelCall"] = Effect.fn(
        "AgentRunRepository.completeModelCall",
      )(function* (fence, attempt) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const completed = yield* sql<{ readonly modelCallId: string }>`UPDATE model_calls
                  SET state = 'succeeded', completed_at = transaction_timestamp()
                  WHERE model_call_id = ${attempt.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'pending'
                  RETURNING model_call_id::text AS "modelCallId"`;
              if (completed[0] === undefined) return yield* new AgentRunFenceRejected();
              yield* sql`UPDATE model_call_attempts
                  SET state = 'succeeded', finished_at = transaction_timestamp()
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND state = 'started'`;
              yield* sql`UPDATE assistant_outputs
                  SET state = 'completed', terminated_at = transaction_timestamp()
                  WHERE assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND state = 'open'`;
              yield* appendThreadEvent(authority, (base) =>
                makeAssistantOutputCompleted({
                  ...base,
                  assistantOutputId: attempt.assistantOutputId,
                }),
              );
            }),
          ),
        );
      });

      const interruptModelCall: AgentRunRepositoryService["interruptModelCall"] = Effect.fn(
        "AgentRunRepository.interruptModelCall",
      )(function* (fence, attempt, cause) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const interrupted = yield* sql<{ readonly modelCallId: string }>`UPDATE model_calls
                  SET state = 'failed',
                      failure_cause = ${cause},
                      completed_at = transaction_timestamp()
                  WHERE model_call_id = ${attempt.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'pending'
                  RETURNING model_call_id::text AS "modelCallId"`;
              if (interrupted[0] === undefined) return yield* new AgentRunFenceRejected();
              yield* sql`UPDATE model_call_attempts
                  SET state = 'failed', finished_at = transaction_timestamp()
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND state = 'started'`;
              yield* sql`UPDATE assistant_outputs
                  SET state = 'interrupted',
                      interruption_cause = ${cause},
                      terminated_at = transaction_timestamp()
                  WHERE assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND state = 'open'`;
              yield* appendThreadEvent(authority, (base) =>
                makeAssistantOutputInterrupted({
                  ...base,
                  assistantOutputId: attempt.assistantOutputId,
                  cause,
                }),
              );
            }),
          ),
        );
      });

      const commitTerminal: AgentRunRepositoryService["commitTerminal"] = Effect.fn(
        "AgentRunRepository.commitTerminal",
      )(function* (fence, decision) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              const expectedCallState = decision.type === "succeed" ? "succeeded" : "failed";
              const expectedOutputState = decision.type === "succeed" ? "completed" : "interrupted";
              const terminalState = decision.type === "succeed" ? "succeeded" : "failed";
              const terminal = yield* sql<{ readonly agentRunId: string }>`UPDATE agent_runs run
                  SET state = ${terminalState},
                      claim_owner = NULL,
                      lease_expires_at = NULL
                  WHERE run.agent_run_id = ${fence.agentRunId}::uuid
                    AND run.state = 'running'
                    AND run.claim_owner = ${fence.workerId}
                    AND run.claim_epoch = ${fence.claimEpoch}::bigint
                    AND run.lease_expires_at > clock_timestamp()
                    AND EXISTS (
                      SELECT 1
                      FROM model_calls call
                      JOIN assistant_outputs output USING (assistant_output_id, agent_run_id)
                      WHERE call.agent_run_id = run.agent_run_id
                        AND call.state = ${expectedCallState}
                        AND output.state = ${expectedOutputState}
                    )
                  RETURNING run.agent_run_id::text AS "agentRunId"`;
              if (terminal[0] === undefined) return yield* new AgentRunFenceRejected();
              if (decision.type === "succeed") {
                yield* appendThreadEvent(authority, makeAgentRunSucceeded);
              } else {
                yield* appendThreadEvent(authority, (base) =>
                  makeAgentRunFailed({ ...base, cause: decision.cause }),
                );
              }
              const released = yield* sql<{ readonly principalId: string }>`UPDATE
                    agent_run_capacity_reservations
                  SET state = 'released', released_at = transaction_timestamp()
                  WHERE agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'held'
                  RETURNING principal_id::text AS "principalId"`;
              const reservation = released[0];
              if (reservation === undefined) return yield* new AgentRunFenceRejected();
              yield* sql`UPDATE admission_global_capacity
                  SET reserved_count = reserved_count - 1
                  WHERE singleton = true AND reserved_count > 0`;
              yield* sql`UPDATE admission_principal_capacity
                  SET reserved_count = reserved_count - 1
                  WHERE principal_id = ${reservation.principalId}::uuid
                    AND reserved_count > 0`;
            }),
          ),
        );
      });

      return AgentRunRepository.of({
        claimPublication,
        confirmPublication,
        claimAgentRun,
        loadRecordedState,
        ensureModelCall,
        beginModelCallAttempt,
        appendModelOutput,
        completeModelCall,
        interruptModelCall,
        commitTerminal,
      });
    }),
  ).pipe(Layer.provide(postgresLayer));
};

export const makeAgentRunRepositoryLayer = (config: AgentRunRepositoryDatabaseConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(AgentRunRepositoryDatabaseConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidAgentRunRepositoryDatabaseConfig({ cause })),
      Effect.map(repositoryLayer),
    ),
  );
