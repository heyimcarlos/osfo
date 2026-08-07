import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunCancellationObserved,
  AgentRunFenceRejected,
  AgentRunRepository,
  AgentRunRepositoryUnavailable,
  ModelCallObservationSchema,
  type AgentRunFence,
  type AgentRunRepositoryService,
  type ModelCallAttemptOutcome,
  type PreparedModelCall,
} from "@osfo/agent-run";
import {
  makeAgentRunCanceled,
  makeAgentRunFailed,
  makeAgentRunSucceeded,
  makeAssistantOutputAppended,
  makeAssistantOutputCompleted,
  makeAssistantOutputInterrupted,
  type InvalidThreadEvent,
  type ThreadEvent,
} from "@osfo/session";
import { Data, Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { ADMISSION_CAPACITY_LOCK_KEY } from "./admission-capacity.js";
import { OUTBOX_RELAY_SELECTOR_LOCK_ID, makeOutboxRelayWakeLayer } from "./outbox-relay-wake.js";

export const AgentRunRepositoryDatabaseConfigSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  maxConnections: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
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
  readonly cancellationRequestedAt: string | null;
  readonly cleanupDeadlineAt: string | null;
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
    maxConnections: config.maxConnections,
    url: Redacted.make(config.databaseUrl),
  });

  const repository = Layer.effect(
    AgentRunRepository,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const attemptOutcomeColumns = (outcome: ModelCallAttemptOutcome) => ({
        dispatchState:
          outcome.dispatchEvidence.type === "notDispatched"
            ? "not_dispatched"
            : outcome.dispatchEvidence.type,
        providerRequestId:
          outcome.dispatchEvidence.type === "confirmed"
            ? (outcome.dispatchEvidence.providerRequestId ?? null)
            : null,
        usageType: outcome.usage.type,
        inputUnits: outcome.usage.type === "unknown" ? null : outcome.usage.inputUnits,
        outputUnits: outcome.usage.type === "unknown" ? null : outcome.usage.outputUnits,
        reasoningUnits:
          outcome.usage.type === "unknown" ? null : (outcome.usage.reasoningUnits ?? null),
      });

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

      const requireFence = Effect.fn("AgentRunRepository.requireFence")(function* (
        fence: AgentRunFence,
      ) {
        const rows = yield* sql<AgentRunAuthority>`SELECT
            agent_run_id::text AS "agentRunId",
            thread_id::text AS "threadId",
            principal_id::text AS "principalId",
            user_message_id::text AS "userMessageId",
            cancellation_requested_at::text AS "cancellationRequestedAt",
            cleanup_deadline_at::text AS "cleanupDeadlineAt"
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

      const lockCapacityBeforeFence = Effect.fn("AgentRunRepository.lockCapacityBeforeFence")(
        function* (fence: AgentRunFence) {
          yield* sql`SELECT pg_advisory_xact_lock(
            hashtextextended(${ADMISSION_CAPACITY_LOCK_KEY}, 0)
          )`;
          const hints = yield* sql<{ readonly principalId: string }>`SELECT
            principal_id::text AS "principalId"
          FROM agent_runs
          WHERE agent_run_id = ${fence.agentRunId}::uuid`;
          const hint = hints[0];
          if (hint === undefined) return yield* new AgentRunFenceRejected();
          const global = yield* sql`SELECT reserved_count
          FROM admission_global_capacity
          WHERE singleton = true
          FOR UPDATE`;
          const principal = yield* sql`SELECT reserved_count
          FROM admission_principal_capacity
          WHERE principal_id = ${hint.principalId}::uuid
          FOR UPDATE`;
          if (global.length !== 1 || principal.length !== 1) {
            return yield* new AgentRunFenceRejected();
          }
          const authority = yield* requireFence(fence);
          if (authority.principalId !== hint.principalId) {
            return yield* new AgentRunFenceRejected();
          }
          return authority;
        },
      );

      const requireOpenFence = Effect.fn("AgentRunRepository.requireOpenFence")(function* (
        fence: AgentRunFence,
      ) {
        const authority = yield* requireFence(fence);
        if (authority.cancellationRequestedAt !== null) {
          return yield* new AgentRunCancellationObserved();
        }
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

      const releaseCapacity = Effect.fn("AgentRunRepository.releaseCapacity")(function* (
        authority: AgentRunAuthority,
      ) {
        const released = yield* sql<{ readonly principalId: string }>`UPDATE
            agent_run_capacity_reservations
          SET state = 'released', released_at = transaction_timestamp()
          WHERE agent_run_id = ${authority.agentRunId}::uuid
            AND state = 'held'
          RETURNING principal_id::text AS "principalId"`;
        if (released[0]?.principalId !== authority.principalId) {
          return yield* new AgentRunFenceRejected();
        }
        const global = yield* sql`UPDATE admission_global_capacity
          SET reserved_count = reserved_count - 1,
              revision = revision + 1
          WHERE singleton = true AND reserved_count > 0
          RETURNING reserved_count`;
        const principal = yield* sql`UPDATE admission_principal_capacity
          SET reserved_count = reserved_count - 1
          WHERE principal_id = ${authority.principalId}::uuid
            AND reserved_count > 0
          RETURNING reserved_count`;
        if (global.length !== 1 || principal.length !== 1) {
          return yield* new AgentRunFenceRejected();
        }
      });

      const selectPublication: AgentRunRepositoryService["selectPublication"] = Effect.fn(
        "AgentRunRepository.selectPublication",
      )(function* (request) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT pg_advisory_xact_lock(${OUTBOX_RELAY_SELECTOR_LOCK_ID})`;
              const capacities = yield* sql<{ readonly activeCount: number }>`SELECT
                    active_count AS "activeCount"
                  FROM relay_dispatch_capacity
                  WHERE singleton = true
                  FOR UPDATE`;
              const capacity = capacities[0];
              if (capacity === undefined) {
                return yield* new AgentRunRepositoryUnavailable({
                  cause: "Relay dispatch capacity is not initialized",
                });
              }
              const available = request.publicationWindowSize - capacity.activeCount;
              if (available <= 0) return { type: "none" as const };
              const selections = yield* sql<{
                readonly outboxId: string;
              }>`WITH eligible AS MATERIALIZED (
                    SELECT obligation.outbox_id,
                           obligation.principal_id,
                           obligation.thread_id,
                           principal.virtual_pass AS principal_pass,
                           row_number() OVER (
                             PARTITION BY obligation.principal_id
                             ORDER BY thread.virtual_pass, thread.thread_id,
                               receipt.thread_position, obligation.outbox_id
                           ) AS principal_rank
                    FROM outbox_obligations obligation
                    JOIN relay_principals principal
                      ON principal.principal_id = obligation.principal_id
                    JOIN relay_threads thread
                      ON thread.thread_id = obligation.thread_id
                     AND thread.principal_id = obligation.principal_id
                    JOIN acceptance_receipts receipt
                      ON receipt.agent_run_id = obligation.agent_run_id
                    LEFT JOIN outbox_obligations predecessor
                      ON predecessor.outbox_id = obligation.predecessor_outbox_id
                    WHERE obligation.published_at IS NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM relay_publication_tasks task
                        WHERE task.outbox_id = obligation.outbox_id
                      )
                      AND (
                        obligation.predecessor_outbox_id IS NULL
                        OR predecessor.published_at IS NOT NULL
                      )
                  ), chosen AS MATERIALIZED (
                    SELECT ranked.outbox_id,
                           ranked.principal_id,
                           ranked.thread_id,
                           ranked.principal_pass + ranked.principal_rank - 1
                             AS dispatch_pass,
                           ranked.principal_rank
                    FROM eligible ranked
                    ORDER BY
                      dispatch_pass,
                      ranked.principal_id,
                      ranked.principal_rank
                    LIMIT ${available}
                  ), selected AS (
                    INSERT INTO relay_publication_tasks (
                      outbox_id, publication_state, publication_epoch, created_at
                    )
                    SELECT chosen.outbox_id, 'pending', 0, transaction_timestamp()
                    FROM chosen
                    RETURNING outbox_id
                  ), selected_rows AS MATERIALIZED (
                    SELECT chosen.*
                    FROM chosen
                    JOIN selected USING (outbox_id)
                  ), principal_counts AS MATERIALIZED (
                    SELECT principal_id, count(*)::bigint AS selected_count
                    FROM selected_rows
                    GROUP BY principal_id
                  ), updated_principals AS (
                    UPDATE relay_principals principal
                    SET virtual_pass = principal.virtual_pass + counts.selected_count
                    FROM principal_counts counts
                    WHERE principal.principal_id = counts.principal_id
                    RETURNING principal.principal_id
                  ), updated_threads AS (
                    UPDATE relay_threads thread
                    SET virtual_pass = thread.virtual_pass + 1
                    FROM selected_rows selected
                    WHERE thread.thread_id = selected.thread_id
                    RETURNING thread.thread_id
                  ), updated_capacity AS (
                    UPDATE relay_dispatch_capacity dispatch
                    SET active_count = dispatch.active_count + selected_count.value
                    FROM (
                      SELECT count(*)::int AS value FROM selected_rows
                    ) selected_count
                    WHERE dispatch.singleton = true AND selected_count.value > 0
                    RETURNING dispatch.singleton
                  )
                  SELECT selected.outbox_id::text AS "outboxId"
                  FROM selected_rows selected
                  CROSS JOIN (SELECT count(*) FROM updated_principals) principal_updates
                  CROSS JOIN (SELECT count(*) FROM updated_threads) thread_updates
                  CROSS JOIN (SELECT count(*) FROM updated_capacity) capacity_updates
                  ORDER BY selected.dispatch_pass, selected.principal_id,
                    selected.principal_rank`;
              if (selections.length === 0) return { type: "none" as const };
              return {
                type: "selected" as const,
                outboxIds: selections.map((selection) => selection.outboxId),
              };
            }),
          ),
        );
      });

      const claimPublication: AgentRunRepositoryService["claimPublication"] = Effect.fn(
        "AgentRunRepository.claimPublication",
      )(function* (request) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const claims = yield* sql<{
                readonly agentRunId: string;
                readonly executionProfileRef: string;
                readonly outboxId: string;
                readonly publicationEpoch: string;
                readonly threadId: string;
              }>`WITH candidate AS (
                    SELECT task.outbox_id
                    FROM relay_publication_tasks task
                    WHERE task.publication_state = 'pending'
                       OR (
                         task.publication_state = 'publishing'
                         AND task.publication_lease_expires_at <= clock_timestamp()
                       )
                    ORDER BY task.created_at, task.outbox_id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                  ), claimed AS (
                    UPDATE relay_publication_tasks task
                    SET publication_state = 'publishing',
                        publication_epoch = task.publication_epoch + 1,
                        publication_owner = ${request.relayId},
                        publication_lease_expires_at = clock_timestamp()
                          + ${request.leaseDurationMs} * interval '1 millisecond'
                    FROM candidate
                    WHERE task.outbox_id = candidate.outbox_id
                    RETURNING task.outbox_id, task.publication_epoch
                  )
                  SELECT claimed.outbox_id::text AS "outboxId",
                         claimed.publication_epoch::text AS "publicationEpoch",
                         obligation.agent_run_id::text AS "agentRunId",
                         obligation.thread_id::text AS "threadId",
                         run.execution_profile_ref AS "executionProfileRef"
                  FROM claimed
                  JOIN outbox_obligations obligation USING (outbox_id)
                  JOIN agent_runs run USING (agent_run_id)`;
              const claim = claims[0];
              if (claim === undefined) return { type: "none" as const };
              yield* sql`UPDATE relay_publication_attempts
                SET state = 'expired', finished_at = transaction_timestamp()
                WHERE outbox_id = ${claim.outboxId}::uuid
                  AND state = 'started'
                  AND publication_epoch < ${claim.publicationEpoch}::bigint`;
              yield* sql`INSERT INTO relay_publication_attempts (
                  outbox_id, publication_epoch, publication_owner, state, started_at
                ) VALUES (
                  ${claim.outboxId}::uuid,
                  ${claim.publicationEpoch}::bigint,
                  ${request.relayId},
                  'started',
                  transaction_timestamp()
                )`;
              return {
                type: "claimed" as const,
                outboxId: claim.outboxId,
                publicationEpoch: claim.publicationEpoch,
                relayId: request.relayId,
                delivery: {
                  version: 1 as const,
                  deliveryId: claim.outboxId,
                  agentRunId: claim.agentRunId,
                  threadId: claim.threadId,
                  executionProfileRef: claim.executionProfileRef,
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
                  SET publication_evidence = ${JSON.stringify({
                    type: "pubsub",
                    providerMessageId: confirmation.providerMessageId,
                  })}::jsonb,
                      published_at = transaction_timestamp()
                  WHERE outbox_id = ${claim.outboxId}::uuid
                    AND published_at IS NULL
                    AND EXISTS (
                      SELECT 1 FROM relay_publication_tasks task
                      WHERE task.outbox_id = outbox_obligations.outbox_id
                        AND task.publication_state = 'publishing'
                        AND task.publication_owner = ${claim.relayId}
                        AND task.publication_epoch = ${claim.publicationEpoch}::bigint
                        AND task.publication_lease_expires_at > clock_timestamp()
                    )
                  RETURNING outbox_id::text AS "outboxId"`;
              if (confirmed[0] === undefined) return yield* new AgentRunFenceRejected();
              const recorded = yield* sql<{ readonly outboxId: string }>`UPDATE
                    relay_publication_attempts
                  SET state = 'confirmed',
                      provider_message_id = ${confirmation.providerMessageId},
                      finished_at = transaction_timestamp()
                  WHERE outbox_id = ${claim.outboxId}::uuid
                    AND publication_epoch = ${claim.publicationEpoch}::bigint
                    AND publication_owner = ${claim.relayId}
                    AND state = 'started'
                  RETURNING outbox_id::text AS "outboxId"`;
              if (recorded[0] === undefined) return yield* new AgentRunFenceRejected();
              const removed = yield* sql<{ readonly outboxId: string }>`DELETE
                  FROM relay_publication_tasks
                  WHERE outbox_id = ${claim.outboxId}::uuid
                    AND publication_state = 'publishing'
                    AND publication_owner = ${claim.relayId}
                    AND publication_epoch = ${claim.publicationEpoch}::bigint
                  RETURNING outbox_id::text AS "outboxId"`;
              if (removed[0] === undefined) return yield* new AgentRunFenceRejected();
              const releasedCapacity = yield* sql<{ readonly singleton: boolean }>`UPDATE
                    relay_dispatch_capacity
                SET active_count = active_count - 1
                WHERE singleton = true AND active_count > 0
                RETURNING singleton`;
              if (releasedCapacity[0] === undefined) {
                return yield* new AgentRunFenceRejected();
              }
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
                    AND run.thread_id = ${delivery.threadId}::uuid
                    AND EXISTS (
                      SELECT 1 FROM outbox_obligations obligation
                      WHERE obligation.outbox_id = ${delivery.deliveryId}::uuid
                        AND obligation.agent_run_id = run.agent_run_id
                        AND (
                          obligation.predecessor_outbox_id IS NULL
                          OR EXISTS (
                            SELECT 1
                            FROM outbox_obligations predecessor
                            JOIN agent_runs predecessor_run
                              ON predecessor_run.agent_run_id = predecessor.agent_run_id
                            WHERE predecessor.outbox_id = obligation.predecessor_outbox_id
                              AND predecessor_run.state IN ('succeeded', 'failed', 'canceled')
                          )
                        )
                    )
                    AND run.execution_profile_ref = ${delivery.executionProfileRef}
                    AND (
                      run.state = 'pending'
                      OR (run.state = 'running' AND run.lease_expires_at <= clock_timestamp())
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
                  FROM agent_runs run
                  JOIN outbox_obligations obligation
                    ON obligation.agent_run_id = run.agent_run_id
                  WHERE run.agent_run_id = ${delivery.agentRunId}::uuid
                    AND run.thread_id = ${delivery.threadId}::uuid
                    AND run.execution_profile_ref = ${delivery.executionProfileRef}
                    AND obligation.outbox_id = ${delivery.deliveryId}::uuid`;
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
              yield* requireOpenFence(fence);
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

      const renewLease: AgentRunRepositoryService["renewLease"] = Effect.fn(
        "AgentRunRepository.renewLease",
      )(function* (fence, leaseDurationMs) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* requireOpenFence(fence);
              const renewed = yield* sql`UPDATE agent_runs
                SET lease_expires_at = clock_timestamp()
                  + ${leaseDurationMs} * interval '1 millisecond'
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'running'
                  AND claim_owner = ${fence.workerId}
                  AND claim_epoch = ${fence.claimEpoch}::bigint
                  AND lease_expires_at > clock_timestamp()
                  AND cancellation_requested_at IS NULL
                RETURNING agent_run_id`;
              if (renewed.length !== 1) return yield* new AgentRunFenceRejected();
            }),
          ),
        );
      });

      const loadCancellation: AgentRunRepositoryService["loadCancellation"] = Effect.fn(
        "AgentRunRepository.loadCancellation",
      )(function* (fence) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireFence(fence);
              if (
                authority.cancellationRequestedAt === null ||
                authority.cleanupDeadlineAt === null
              ) {
                return yield* new AgentRunFenceRejected();
              }
              yield* sql`UPDATE agent_runs
                SET lease_expires_at = greatest(
                  lease_expires_at,
                  cleanup_deadline_at + interval '1 second'
                )
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'running'
                  AND claim_owner = ${fence.workerId}
                  AND claim_epoch = ${fence.claimEpoch}::bigint`;
              const attempts = yield* sql<{ readonly modelCallAttemptId: string }>`SELECT
                  model_call_attempt_id::text AS "modelCallAttemptId"
                FROM model_call_attempts
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'started'
                ORDER BY attempt_number`;
              return {
                cleanupDeadlineAtEpochMs: new Date(authority.cleanupDeadlineAt).getTime(),
                startedModelCallAttemptIds: attempts.map((attempt) => attempt.modelCallAttemptId),
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
              const authority = yield* requireOpenFence(fence);
              const existing = yield* sql<PreparedModelCall>`SELECT
                    model_call_id::text AS "modelCallId",
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
              const timestamps = yield* sql<{ readonly createdAt: string }>`SELECT
                  transaction_timestamp()::text AS "createdAt"`;
              const timestamp = timestamps[0];
              if (timestamp === undefined) {
                return yield* new AgentRunRepositoryUnavailable({ cause: "Timestamp unavailable" });
              }
              yield* sql`INSERT INTO model_calls (
                    model_call_id, agent_run_id, model_binding, prompt, state, created_at
                  ) VALUES (
                    ${modelCallId}::uuid,
                    ${authority.agentRunId}::uuid,
                    ${decision.modelBinding},
                    ${decision.prompt},
                    'pending',
                    ${timestamp.createdAt}::timestamptz
                  )`;
              return {
                modelCallId,
                modelBinding: decision.modelBinding,
                prompt: decision.prompt,
              };
            }),
          ),
        );
      });

      const beginModelCallAttempt: AgentRunRepositoryService["beginModelCallAttempt"] = Effect.fn(
        "AgentRunRepository.beginModelCallAttempt",
      )(function* (fence, modelCall, attemptLimit) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const authority = yield* requireOpenFence(fence);
              const preparedCalls = yield* sql<{
                readonly modelBinding: string;
                readonly prompt: string;
                readonly state: "pending" | "succeeded" | "failed" | "canceled";
              }>`SELECT model_binding AS "modelBinding", prompt, state
                  FROM model_calls
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                  FOR UPDATE`;
              const preparedCall = preparedCalls[0];
              if (
                preparedCall === undefined ||
                preparedCall.modelBinding !== modelCall.modelBinding ||
                preparedCall.prompt !== modelCall.prompt ||
                preparedCall.state !== "pending"
              ) {
                return yield* new AgentRunFenceRejected();
              }
              const abandoned = yield* sql<{
                readonly assistantOutputId: string;
                readonly attemptNumber: number;
                readonly cleanupDisposition: "completed" | "deadlineExceeded" | null;
                readonly externalWorkMayContinue: boolean | null;
                readonly modelCallAttemptId: string;
              }>`SELECT
                    assistant_output_id::text AS "assistantOutputId",
                    attempt_number AS "attemptNumber",
                    cleanup_disposition AS "cleanupDisposition",
                    external_work_may_continue AS "externalWorkMayContinue",
                    model_call_attempt_id::text AS "modelCallAttemptId"
                  FROM model_call_attempts
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'started'
                    AND claim_epoch < ${fence.claimEpoch}::bigint
                  ORDER BY attempt_number
                  FOR UPDATE`;
              const cleanupRequired = abandoned.find(
                (previous) => previous.cleanupDisposition === null,
              );
              if (cleanupRequired !== undefined) {
                return {
                  type: "cleanupRequired" as const,
                  attempt: {
                    ...modelCall,
                    assistantOutputId: cleanupRequired.assistantOutputId,
                    modelCallAttemptId: cleanupRequired.modelCallAttemptId,
                    attemptNumber: cleanupRequired.attemptNumber,
                    usage: { type: "unknown" as const },
                  },
                };
              }
              const uncertain = abandoned.some(
                (previous) => previous.externalWorkMayContinue === true,
              );
              yield* sql`UPDATE model_call_attempts
                  SET state = 'failed',
                      dispatch_state = CASE
                        WHEN EXISTS (
                          SELECT 1 FROM model_call_fragments fragment
                          WHERE fragment.model_call_attempt_id = model_call_attempts.model_call_attempt_id
                        ) THEN 'confirmed'
                        ELSE 'uncertain'
                      END,
                      finished_at = transaction_timestamp()
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'started'
                    AND claim_epoch < ${fence.claimEpoch}::bigint`;
              for (const previous of abandoned) {
                yield* sql`UPDATE assistant_outputs
                    SET state = 'interrupted',
                        interruption_cause = 'modelCallFailed',
                        terminated_at = transaction_timestamp()
                    WHERE assistant_output_id = ${previous.assistantOutputId}::uuid
                      AND agent_run_id = ${fence.agentRunId}::uuid
                      AND state = 'open'`;
                yield* appendThreadEvent(authority, (base) =>
                  makeAssistantOutputInterrupted({
                    ...base,
                    assistantOutputId: previous.assistantOutputId,
                    cause: "modelCallFailed",
                  }),
                );
              }
              const nextAttemptNumber =
                abandoned.reduce(
                  (maximum, previous) => Math.max(maximum, previous.attemptNumber),
                  0,
                ) + 1;
              if (uncertain || nextAttemptNumber > (attemptLimit ?? Number.MAX_SAFE_INTEGER)) {
                const failed = yield* sql`UPDATE model_calls
                  SET state = 'failed',
                      failure_cause = 'modelCallFailed',
                      completed_at = transaction_timestamp()
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'pending'
                  RETURNING model_call_id`;
                if (failed.length !== 1) return yield* new AgentRunFenceRejected();
                return { type: "recoveredInterruption" as const };
              }
              const numbers = yield* sql<{ readonly attemptNumber: number }>`SELECT
                    (coalesce(max(attempt_number), 0) + 1)::integer AS "attemptNumber"
                  FROM model_call_attempts
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid`;
              const attemptNumber = numbers[0]?.attemptNumber;
              if (attemptNumber === undefined) {
                return yield* new AgentRunRepositoryUnavailable({ cause: "Attempt unavailable" });
              }
              const modelCallAttemptId = randomUUID();
              const assistantOutputId = randomUUID();
              yield* sql`INSERT INTO assistant_outputs
                  (assistant_output_id, agent_run_id, state, created_at)
                  VALUES (
                    ${assistantOutputId}::uuid,
                    ${authority.agentRunId}::uuid,
                    'open',
                    transaction_timestamp()
                  )`;
              const inserted = yield* sql<{
                readonly modelCallAttemptId: string;
              }>`INSERT INTO model_call_attempts (
                    model_call_attempt_id, model_call_id, agent_run_id,
                    assistant_output_id, attempt_number, claim_epoch, model_binding,
                    dispatch_state, state, started_at
                  )
                  SELECT
                    ${modelCallAttemptId}::uuid,
                    model_call_id,
                    agent_run_id,
                    ${assistantOutputId}::uuid,
                    ${attemptNumber},
                    ${fence.claimEpoch}::bigint,
                    model_binding,
                    'prepared',
                    'started',
                    transaction_timestamp()
                  FROM model_calls
                  WHERE model_call_id = ${modelCall.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND model_binding = ${modelCall.modelBinding}
                    AND prompt = ${modelCall.prompt}
                    AND state = 'pending'
                  RETURNING model_call_attempt_id::text AS "modelCallAttemptId"`;
              if (inserted.length !== 1) return yield* new AgentRunFenceRejected();
              return {
                type: "started" as const,
                attempt: {
                  ...modelCall,
                  assistantOutputId,
                  modelCallAttemptId,
                  attemptNumber,
                  usage: { type: "unknown" as const },
                },
              };
            }),
          ),
        );
      });

      const recordModelCallCleanup: AgentRunRepositoryService["recordModelCallCleanup"] = Effect.fn(
        "AgentRunRepository.recordModelCallCleanup",
      )(function* (fence, attempt, cleanup) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* requireFence(fence);
              const rows = yield* sql<{
                readonly cleanupDisposition: "completed" | "deadlineExceeded" | null;
                readonly externalWorkMayContinue: boolean | null;
                readonly state: "started" | "succeeded" | "failed" | "canceled";
              }>`SELECT
                    cleanup_disposition AS "cleanupDisposition",
                    external_work_may_continue AS "externalWorkMayContinue",
                    state
                  FROM model_call_attempts
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND model_call_id = ${attempt.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND assistant_output_id = ${attempt.assistantOutputId}::uuid
                  FOR UPDATE`;
              const existing = rows[0];
              if (existing === undefined) {
                return yield* new AgentRunFenceRejected();
              }
              if (
                existing.cleanupDisposition === cleanup.cleanupDisposition.type &&
                existing.externalWorkMayContinue === cleanup.externalWorkMayContinue
              ) {
                return;
              }
              if (
                existing.cleanupDisposition !== null ||
                existing.externalWorkMayContinue !== null
              ) {
                return yield* new AgentRunFenceRejected();
              }
              if (existing.state !== "started") {
                return yield* new AgentRunFenceRejected();
              }
              const recorded = yield* sql`UPDATE model_call_attempts
                  SET cleanup_disposition = ${cleanup.cleanupDisposition.type},
                      external_work_may_continue = ${cleanup.externalWorkMayContinue}
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND model_call_id = ${attempt.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND cleanup_disposition IS NULL
                    AND external_work_may_continue IS NULL
                  RETURNING model_call_attempt_id`;
              if (recorded.length !== 1) {
                return yield* new AgentRunFenceRejected();
              }
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
              const decodedObservation = yield* Schema.decodeUnknownEffect(
                ModelCallObservationSchema,
              )(observation);
              const authority = yield* requireOpenFence(fence);
              const existing = yield* sql<{ readonly text: string }>`SELECT text
                  FROM model_call_fragments
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND fragment_index = ${decodedObservation.fragmentIndex}`;
              if (existing[0]?.text === decodedObservation.text) return;
              if (existing[0] !== undefined) {
                return yield* new AgentRunRepositoryUnavailable({
                  cause: "ModelCall fragment authority conflict",
                });
              }
              const event = yield* appendThreadEvent(authority, (base) =>
                makeAssistantOutputAppended({
                  ...base,
                  assistantOutputId: attempt.assistantOutputId,
                  content: decodedObservation.text,
                }),
              );
              yield* sql`INSERT INTO model_call_fragments (
                    model_call_id, fragment_index, model_call_attempt_id,
                    assistant_output_id, agent_run_id, text, thread_event_id, created_at
                  ) VALUES (
                    ${attempt.modelCallId}::uuid,
                    ${decodedObservation.fragmentIndex},
                    ${attempt.modelCallAttemptId}::uuid,
                    ${attempt.assistantOutputId}::uuid,
                    ${fence.agentRunId}::uuid,
                    ${decodedObservation.text},
                    ${event.eventId}::uuid,
                    ${event.occurredAt}::timestamptz
                  )`;
            }),
          ),
        );
      });

      const completeModelCall: AgentRunRepositoryService["completeModelCall"] = Effect.fn(
        "AgentRunRepository.completeModelCall",
      )(function* (fence, attempt, outcome) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const evidence = attemptOutcomeColumns(outcome);
              const authority = yield* requireOpenFence(fence);
              const completed = yield* sql<{ readonly modelCallId: string }>`UPDATE model_calls
                  SET state = 'succeeded', completed_at = transaction_timestamp()
                  WHERE model_call_id = ${attempt.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'pending'
                  RETURNING model_call_id::text AS "modelCallId"`;
              if (completed[0] === undefined) return yield* new AgentRunFenceRejected();
              const completedAttempt = yield* sql<{
                readonly modelCallAttemptId: string;
              }>`UPDATE model_call_attempts
                  SET state = 'succeeded',
                      dispatch_state = ${evidence.dispatchState},
                      provider_request_id = ${evidence.providerRequestId},
                      usage_type = ${evidence.usageType},
                      input_units = ${evidence.inputUnits},
                      output_units = ${evidence.outputUnits},
                      reasoning_units = ${evidence.reasoningUnits},
                      finished_at = transaction_timestamp()
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND model_call_id = ${attempt.modelCallId}::uuid
                    AND assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND claim_epoch = ${fence.claimEpoch}::bigint
                    AND state = 'started'
                  RETURNING model_call_attempt_id::text AS "modelCallAttemptId"`;
              if (completedAttempt.length !== 1) return yield* new AgentRunFenceRejected();
              const completedOutput = yield* sql<{
                readonly assistantOutputId: string;
              }>`UPDATE assistant_outputs
                  SET state = 'completed', terminated_at = transaction_timestamp()
                  WHERE assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'open'
                  RETURNING assistant_output_id::text AS "assistantOutputId"`;
              if (completedOutput.length !== 1) return yield* new AgentRunFenceRejected();
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
      )(function* (fence, attempt, cause, outcome) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const evidence = attemptOutcomeColumns(outcome);
              const authority = yield* requireOpenFence(fence);
              const interrupted = yield* sql<{ readonly modelCallId: string }>`UPDATE model_calls
                  SET state = 'failed',
                      failure_cause = ${cause},
                      completed_at = transaction_timestamp()
                  WHERE model_call_id = ${attempt.modelCallId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'pending'
                  RETURNING model_call_id::text AS "modelCallId"`;
              if (interrupted[0] === undefined) return yield* new AgentRunFenceRejected();
              const interruptedAttempt = yield* sql<{
                readonly modelCallAttemptId: string;
              }>`UPDATE model_call_attempts
                  SET state = 'failed',
                      dispatch_state = ${evidence.dispatchState},
                      provider_request_id = ${evidence.providerRequestId},
                      usage_type = ${evidence.usageType},
                      input_units = ${evidence.inputUnits},
                      output_units = ${evidence.outputUnits},
                      reasoning_units = ${evidence.reasoningUnits},
                      finished_at = transaction_timestamp()
                  WHERE model_call_attempt_id = ${attempt.modelCallAttemptId}::uuid
                    AND model_call_id = ${attempt.modelCallId}::uuid
                    AND assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND claim_epoch = ${fence.claimEpoch}::bigint
                    AND state = 'started'
                  RETURNING model_call_attempt_id::text AS "modelCallAttemptId"`;
              if (interruptedAttempt.length !== 1) return yield* new AgentRunFenceRejected();
              const interruptedOutput = yield* sql<{
                readonly assistantOutputId: string;
              }>`UPDATE assistant_outputs
                  SET state = 'interrupted',
                      interruption_cause = ${cause},
                      terminated_at = transaction_timestamp()
                  WHERE assistant_output_id = ${attempt.assistantOutputId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'open'
                  RETURNING assistant_output_id::text AS "assistantOutputId"`;
              if (interruptedOutput.length !== 1) return yield* new AgentRunFenceRejected();
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

      const commitCancellation: AgentRunRepositoryService["commitCancellation"] = Effect.fn(
        "AgentRunRepository.commitCancellation",
      )(function* (fence, _cleanup, canceledAttemptEvidence) {
        return yield* protect(
          sql.withTransaction(
            Effect.gen(function* () {
              const normalizedCanceledAttemptEvidence =
                canceledAttemptEvidence === undefined
                  ? undefined
                  : attemptOutcomeColumns(canceledAttemptEvidence.outcome);
              const authority = yield* lockCapacityBeforeFence(fence);
              if (
                authority.cancellationRequestedAt === null ||
                authority.cleanupDeadlineAt === null
              ) {
                return yield* new AgentRunFenceRejected();
              }
              const openOutputs = yield* sql<{
                readonly assistantOutputId: string;
              }>`SELECT
                  output.assistant_output_id::text AS "assistantOutputId"
                FROM assistant_outputs output
                JOIN model_call_attempts attempt
                  USING (assistant_output_id, agent_run_id)
                WHERE output.agent_run_id = ${fence.agentRunId}::uuid
                  AND output.state = 'open'
                  AND attempt.state = 'started'
                ORDER BY attempt.attempt_number
                FOR UPDATE OF output, attempt`;
              yield* sql`UPDATE model_calls
                SET state = 'canceled',
                    failure_cause = NULL,
                    completed_at = transaction_timestamp()
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'pending'`;
              for (const output of openOutputs) {
                const interrupted = yield* sql`UPDATE assistant_outputs
                  SET state = 'interrupted',
                      interruption_cause = 'agentRunCanceled',
                      terminated_at = transaction_timestamp()
                  WHERE assistant_output_id = ${output.assistantOutputId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'open'
                  RETURNING assistant_output_id`;
                if (interrupted.length !== 1) return yield* new AgentRunFenceRejected();
                yield* appendThreadEvent(authority, (base) =>
                  makeAssistantOutputInterrupted({
                    ...base,
                    assistantOutputId: output.assistantOutputId,
                    cause: "agentRunCanceled",
                  }),
                );
              }
              const terminal = yield* sql<{
                readonly cleanupDisposition: "completed" | "deadlineExceeded";
                readonly externalWorkMayContinue: boolean;
              }>`WITH cancellation_commit AS MATERIALIZED (
                  SELECT clock_timestamp() AS observed_at
                ), attempt_cleanup AS MATERIALIZED (
                  SELECT
                    coalesce(bool_and(
                      attempt.state <> 'started'
                        OR (
                          attempt.cleanup_disposition IS NOT NULL
                          AND attempt.external_work_may_continue IS NOT NULL
                        )
                    ), true) AS all_recorded,
                    coalesce(bool_or(
                      attempt.cleanup_disposition = 'deadlineExceeded'
                    ), false)
                      AS deadline_exceeded,
                    coalesce(bool_or(attempt.external_work_may_continue), false)
                      AS external_work_may_continue
                  FROM model_call_attempts attempt
                  WHERE attempt.agent_run_id = ${fence.agentRunId}::uuid
                )
                UPDATE agent_runs
                SET state = 'canceled',
                    claim_owner = NULL,
                    lease_expires_at = NULL,
                    cleanup_disposition = CASE
                      WHEN cleanup_deadline_at <= cancellation_commit.observed_at
                        OR attempt_cleanup.deadline_exceeded
                        THEN 'deadlineExceeded'
                      ELSE 'completed'
                    END,
                    external_work_may_continue = CASE
                      WHEN cleanup_deadline_at <= cancellation_commit.observed_at
                        OR attempt_cleanup.deadline_exceeded
                        THEN true
                      ELSE attempt_cleanup.external_work_may_continue
                    END
                FROM cancellation_commit, attempt_cleanup
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'running'
                  AND claim_owner = ${fence.workerId}
                  AND claim_epoch = ${fence.claimEpoch}::bigint
                  AND lease_expires_at > cancellation_commit.observed_at
                  AND cancellation_requested_at IS NOT NULL
                  AND cleanup_deadline_at IS NOT NULL
                  AND (
                    attempt_cleanup.all_recorded
                    OR cleanup_deadline_at <= cancellation_commit.observed_at
                  )
                RETURNING
                  agent_runs.cleanup_disposition AS "cleanupDisposition",
                  agent_runs.external_work_may_continue AS "externalWorkMayContinue"`;
              const result = terminal[0];
              if (result === undefined) return yield* new AgentRunFenceRejected();
              if (result.cleanupDisposition === "deadlineExceeded") {
                yield* sql`UPDATE model_call_attempts
                  SET cleanup_disposition = 'deadlineExceeded',
                      external_work_may_continue = true
                  WHERE agent_run_id = ${fence.agentRunId}::uuid
                    AND state = 'started'
                    AND cleanup_disposition IS NULL
                    AND external_work_may_continue IS NULL`;
              }
              if (
                canceledAttemptEvidence !== undefined &&
                normalizedCanceledAttemptEvidence !== undefined
              ) {
                const recordedEvidence = yield* sql`UPDATE model_call_attempts
                  SET state = 'canceled',
                      dispatch_state = ${normalizedCanceledAttemptEvidence.dispatchState},
                      provider_request_id = ${normalizedCanceledAttemptEvidence.providerRequestId},
                      usage_type = ${normalizedCanceledAttemptEvidence.usageType},
                      input_units = ${normalizedCanceledAttemptEvidence.inputUnits},
                      output_units = ${normalizedCanceledAttemptEvidence.outputUnits},
                      reasoning_units = ${normalizedCanceledAttemptEvidence.reasoningUnits},
                      finished_at = transaction_timestamp()
                  WHERE model_call_attempt_id = ${canceledAttemptEvidence.attempt.modelCallAttemptId}::uuid
                    AND model_call_id = ${canceledAttemptEvidence.attempt.modelCallId}::uuid
                    AND assistant_output_id = ${canceledAttemptEvidence.attempt.assistantOutputId}::uuid
                    AND agent_run_id = ${fence.agentRunId}::uuid
                    AND claim_epoch = ${fence.claimEpoch}::bigint
                    AND state = 'started'
                  RETURNING model_call_attempt_id`;
                if (recordedEvidence.length !== 1) return yield* new AgentRunFenceRejected();
              }
              yield* sql`UPDATE model_call_attempts
                SET state = 'canceled',
                    dispatch_state = CASE
                      WHEN EXISTS (
                        SELECT 1 FROM model_call_fragments fragment
                        WHERE fragment.model_call_attempt_id = model_call_attempts.model_call_attempt_id
                      ) THEN 'confirmed'
                      ELSE 'uncertain'
                    END,
                    finished_at = transaction_timestamp()
                WHERE agent_run_id = ${fence.agentRunId}::uuid
                  AND state = 'started'`;
              yield* appendThreadEvent(authority, (base) =>
                makeAgentRunCanceled({
                  ...base,
                  cleanupDisposition: { type: result.cleanupDisposition },
                  externalWorkMayContinue: result.externalWorkMayContinue,
                }),
              );
              yield* releaseCapacity(authority);
              return {
                cleanupDisposition: { type: result.cleanupDisposition },
                externalWorkMayContinue: result.externalWorkMayContinue,
              };
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
              const authority = yield* lockCapacityBeforeFence(fence);
              if (authority.cancellationRequestedAt !== null) {
                return yield* new AgentRunCancellationObserved();
              }
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
                      JOIN model_call_attempts attempt USING (model_call_id, agent_run_id)
                      JOIN assistant_outputs output USING (assistant_output_id, agent_run_id)
                      WHERE call.agent_run_id = run.agent_run_id
                        AND call.state = ${expectedCallState}
                        AND output.state = ${expectedOutputState}
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM assistant_outputs output
                      WHERE output.agent_run_id = run.agent_run_id
                        AND output.state = 'open'
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
              yield* releaseCapacity(authority);
            }),
          ),
        );
      });

      return AgentRunRepository.of({
        selectPublication,
        claimPublication,
        confirmPublication,
        claimAgentRun,
        loadRecordedState,
        renewLease,
        loadCancellation,
        ensureModelCall,
        beginModelCallAttempt,
        recordModelCallCleanup,
        appendModelOutput,
        completeModelCall,
        interruptModelCall,
        commitCancellation,
        commitTerminal,
      });
    }),
  );
  return Layer.merge(repository, makeOutboxRelayWakeLayer(config.databaseUrl)).pipe(
    Layer.provide(postgresLayer),
  );
};

export const makeAgentRunRepositoryLayer = (config: AgentRunRepositoryDatabaseConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(AgentRunRepositoryDatabaseConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidAgentRunRepositoryDatabaseConfig({ cause })),
      Effect.map(repositoryLayer),
    ),
  );
