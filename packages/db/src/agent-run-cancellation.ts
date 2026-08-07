import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunCancellation,
  AgentRunCancellationReceipt,
  AgentRunCancellationUnavailable,
  AuthenticationRejected,
  ThreadNotFound,
  type CancelAgentRunCommand,
} from "@osfo/api";
import { makeAgentRunCanceled, makeAgentRunCancellationRequested } from "@osfo/session";
import { Data, Effect, Layer, Redacted, Schema } from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const AgentRunCancellationDatabaseConfigSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  cleanupTimeoutMs: PositiveInteger,
});

export type AgentRunCancellationDatabaseConfig =
  typeof AgentRunCancellationDatabaseConfigSchema.Type;

export class InvalidAgentRunCancellationDatabaseConfig extends Data.TaggedError(
  "InvalidAgentRunCancellationDatabaseConfig",
)<{ readonly cause: unknown }> {}

interface AgentRunAuthority {
  readonly agentRunId: string;
  readonly threadId: string;
  readonly principalId: string;
  readonly userMessageId: string;
  readonly state: "pending" | "running" | "waiting" | "succeeded" | "failed" | "canceled";
  readonly cancellationRequestedAt: string | null;
}

type CancellationEvent =
  | { readonly type: "requested" }
  | {
      readonly type: "canceled";
      readonly cleanupDisposition: "completed" | "deadlineExceeded";
    };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const isCancellationError = Schema.is(
  Schema.Union([AuthenticationRejected, ThreadNotFound, AgentRunCancellationUnavailable]),
);

const cancellationLayer = (config: AgentRunCancellationDatabaseConfig) => {
  const postgresLayer = PgClient.layer({
    applicationName: "osfo-agent-run-cancellation",
    url: Redacted.make(config.databaseUrl),
  });

  return Layer.effect(
    AgentRunCancellation,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const appendEvent = Effect.fn("DatabaseAgentRunCancellation.appendEvent")(function* (
        authority: AgentRunAuthority,
        eventInput: CancellationEvent,
      ) {
        const positions = yield* sql<{ readonly position: string }>`UPDATE threads
          SET next_position = next_position + 1,
              state_revision = state_revision + 1
          WHERE thread_id = ${authority.threadId}::uuid
          RETURNING (next_position - 1)::text AS position`;
        const position = positions[0];
        if (position === undefined) return yield* new ThreadNotFound();
        const timestamps = yield* sql<{ readonly occurredAt: string }>`SELECT
          transaction_timestamp()::text AS "occurredAt"`;
        const timestamp = timestamps[0];
        if (timestamp === undefined) return yield* new AgentRunCancellationUnavailable();
        const base = {
          eventId: randomUUID(),
          threadId: authority.threadId,
          threadPosition: position.position,
          occurredAt: new Date(timestamp.occurredAt).toISOString(),
          agentRunId: authority.agentRunId,
        };
        const event =
          eventInput.type === "requested"
            ? yield* makeAgentRunCancellationRequested(base)
            : yield* makeAgentRunCanceled({
                ...base,
                cleanupDisposition: { type: eventInput.cleanupDisposition },
                externalWorkMayContinue: false,
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
      });

      const releaseCapacity = Effect.fn("DatabaseAgentRunCancellation.releaseCapacity")(function* (
        authority: AgentRunAuthority,
      ) {
        const released = yield* sql<{ readonly principalId: string }>`UPDATE
            agent_run_capacity_reservations
          SET state = 'released', released_at = transaction_timestamp()
          WHERE agent_run_id = ${authority.agentRunId}::uuid
            AND state = 'held'
          RETURNING principal_id::text AS "principalId"`;
        const reservation = released[0];
        if (reservation === undefined) return yield* new AgentRunCancellationUnavailable();
        const global = yield* sql`UPDATE admission_global_capacity
          SET reserved_count = reserved_count - 1
          WHERE singleton = true AND reserved_count > 0
          RETURNING reserved_count`;
        const principal = yield* sql`UPDATE admission_principal_capacity
          SET reserved_count = reserved_count - 1
          WHERE principal_id = ${authority.principalId}::uuid
            AND reserved_count > 0
          RETURNING reserved_count`;
        if (global.length !== 1 || principal.length !== 1) {
          return yield* new AgentRunCancellationUnavailable();
        }
      });

      const cancel = Effect.fn("DatabaseAgentRunCancellation.cancel")(function* (
        command: CancelAgentRunCommand,
      ) {
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            const sessions = yield* sql<{ readonly principalId: string }>`SELECT
                principal_id::text AS "principalId"
              FROM authentication_sessions
              WHERE token_sha256 = ${sha256(command.authenticationToken)}
                AND revoked_at IS NULL
                AND expires_at > transaction_timestamp()
              LIMIT 1`;
            const session = sessions[0];
            if (session === undefined) return yield* new AuthenticationRejected();
            const owned = yield* sql`SELECT thread_id
              FROM threads
              WHERE thread_id = ${command.threadId}::uuid
                AND principal_id = ${session.principalId}::uuid`;
            if (owned[0] === undefined) return yield* new ThreadNotFound();
            const globalCapacity = yield* sql`SELECT reserved_count
              FROM admission_global_capacity
              WHERE singleton = true
              FOR UPDATE`;
            const principalCapacity = yield* sql`SELECT reserved_count
              FROM admission_principal_capacity
              WHERE principal_id = ${session.principalId}::uuid
              FOR UPDATE`;
            if (globalCapacity.length !== 1 || principalCapacity.length !== 1) {
              return yield* new AgentRunCancellationUnavailable();
            }
            const rows = yield* sql<AgentRunAuthority>`SELECT
                agent_run_id::text AS "agentRunId",
                thread_id::text AS "threadId",
                principal_id::text AS "principalId",
                user_message_id::text AS "userMessageId",
                state,
                cancellation_requested_at::text AS "cancellationRequestedAt"
              FROM agent_runs
              WHERE agent_run_id = ${command.agentRunId}::uuid
                AND thread_id = ${command.threadId}::uuid
                AND principal_id = ${session.principalId}::uuid
              FOR UPDATE`;
            const authority = rows[0];
            if (authority === undefined) return yield* new ThreadNotFound();
            if (
              authority.state === "succeeded" ||
              authority.state === "failed" ||
              authority.state === "canceled"
            ) {
              return new AgentRunCancellationReceipt({
                protocolVersion: 1,
                agentRunId: authority.agentRunId,
                outcome: "alreadyTerminal",
              });
            }
            if (authority.cancellationRequestedAt !== null) {
              return new AgentRunCancellationReceipt({
                protocolVersion: 1,
                agentRunId: authority.agentRunId,
                outcome: "cancellationRequested",
              });
            }
            const requested = yield* sql`UPDATE agent_runs
              SET cancellation_requested_at = transaction_timestamp(),
                  cleanup_deadline_at = clock_timestamp()
                    + ${config.cleanupTimeoutMs} * interval '1 millisecond'
              WHERE agent_run_id = ${authority.agentRunId}::uuid
                AND state IN ('pending', 'running', 'waiting')
                AND cancellation_requested_at IS NULL
              RETURNING agent_run_id`;
            if (requested.length !== 1) return yield* new AgentRunCancellationUnavailable();
            yield* appendEvent(authority, { type: "requested" });
            if (authority.state === "running") {
              return new AgentRunCancellationReceipt({
                protocolVersion: 1,
                agentRunId: authority.agentRunId,
                outcome: "cancellationRequested",
              });
            }
            const canceled = yield* sql<{
              readonly cleanupDisposition: "completed" | "deadlineExceeded";
            }>`UPDATE agent_runs
              SET state = 'canceled',
                  claim_owner = NULL,
                  lease_expires_at = NULL,
                  cleanup_disposition = CASE
                    WHEN cleanup_deadline_at <= clock_timestamp() THEN 'deadlineExceeded'
                    ELSE 'completed'
                  END,
                  external_work_may_continue = false
              WHERE agent_run_id = ${authority.agentRunId}::uuid
                AND state IN ('pending', 'waiting')
                AND cancellation_requested_at IS NOT NULL
              RETURNING cleanup_disposition AS "cleanupDisposition"`;
            const result = canceled[0];
            if (result === undefined) return yield* new AgentRunCancellationUnavailable();
            yield* appendEvent(authority, {
              type: "canceled",
              cleanupDisposition: result.cleanupDisposition,
            });
            yield* releaseCapacity(authority);
            return new AgentRunCancellationReceipt({
              protocolVersion: 1,
              agentRunId: authority.agentRunId,
              outcome: "canceled",
            });
          }),
        );

        return yield* transaction.pipe(
          Effect.mapError((error) =>
            isCancellationError(error) ? error : new AgentRunCancellationUnavailable(),
          ),
        );
      });

      return AgentRunCancellation.of({ cancel });
    }),
  ).pipe(Layer.provide(postgresLayer));
};

export const makeAgentRunCancellationLayer = (config: AgentRunCancellationDatabaseConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(AgentRunCancellationDatabaseConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidAgentRunCancellationDatabaseConfig({ cause })),
      Effect.map(cancellationLayer),
    ),
  );
