import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AuthenticationRejected,
  CursorOutsideRetention,
  InvalidCursor,
  SnapshotUnavailable,
  ThreadNotFound,
  ThreadResume,
  ThreadResumeUnavailable,
  isThreadResumeError,
  isThreadSnapshotError,
  type ThreadAccess,
  type ThreadHistoryPage,
  type ThreadHistoryRequest,
  type ThreadStreamRequest,
  type ThreadResumeError,
} from "@osfo/api";
import {
  ThreadSnapshotSchema,
  UserMessageAppendedSchema,
  type ThreadEventEnvelope,
} from "@osfo/session";
import { Data, Effect, Layer, Option, Redacted, Schema, Stream } from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const ThreadResumeDatabaseConfigSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  cursorSecret: Schema.String.check(Schema.isMinLength(32)),
  pollIntervalMs: PositiveInteger,
  replayEventLimit: PositiveInteger,
  replayGuaranteedForMs: PositiveInteger,
  snapshotTimelineLimit: PositiveInteger,
});

export type ThreadResumeDatabaseConfig = typeof ThreadResumeDatabaseConfigSchema.Type;

export class InvalidThreadResumeDatabaseConfig extends Data.TaggedError(
  "InvalidThreadResumeDatabaseConfig",
)<{ readonly cause: unknown }> {}

interface CursorPayload {
  readonly eventId: string | null;
  readonly issuedAtMs: number;
  readonly position: string;
  readonly threadId: string;
  readonly version: 1;
}

const CursorPayloadSchema = Schema.Struct({
  eventId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  issuedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  position: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  threadId: Schema.String.check(Schema.isUUID()),
  version: Schema.Literal(1),
});

interface EventRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly threadId: string;
  readonly threadPosition: string;
}

interface ActiveRunRow {
  readonly agentRunId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly position: string;
  readonly state: "pending" | "running" | "waiting";
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const encodeCursor = (secret: string, payload: CursorPayload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
};

const decodeCursor = (secret: string, value: string) =>
  Effect.gen(function* () {
    const [encoded, signature, unexpected] = value.split(".");
    if (encoded === undefined || signature === undefined || unexpected !== undefined) {
      return yield* new InvalidCursor();
    }
    const expected = createHmac("sha256", secret).update(encoded).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return yield* new InvalidCursor();
    }
    return yield* Schema.decodeUnknownEffect(CursorPayloadSchema)(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    ).pipe(Effect.mapError(() => new InvalidCursor()));
  }).pipe(Effect.catchDefect(() => Effect.fail(new InvalidCursor())));

const threadResumeLayer = (config: ThreadResumeDatabaseConfig) => {
  const postgresLayer = PgClient.layer({
    applicationName: "osfo-thread-resume",
    url: Redacted.make(config.databaseUrl),
  });

  return Layer.effect(
    ThreadResume,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const authorize = Effect.fn("DatabaseThreadResume.authorize")(function* (
        request: ThreadAccess,
      ) {
        const sessions = yield* sql<{
          readonly principalId: string;
        }>`SELECT principal_id::text AS "principalId"
          FROM authentication_sessions
          WHERE token_sha256 = ${sha256(request.authenticationToken)}
            AND revoked_at IS NULL
            AND expires_at > transaction_timestamp()
          LIMIT 1`;
        const session = sessions[0];
        if (session === undefined) return yield* new AuthenticationRejected();

        const owned = yield* sql<{ readonly threadId: string }>`SELECT thread_id::text AS "threadId"
          FROM threads
          WHERE thread_id = ${request.threadId}::uuid
            AND principal_id = ${session.principalId}::uuid
          LIMIT 1`;
        if (owned[0] === undefined) return yield* new ThreadNotFound();
        return session.principalId;
      });

      const toEnvelope = Effect.fn("DatabaseThreadResume.toEnvelope")(function* (row: EventRow) {
        const event = yield* Schema.decodeUnknownEffect(UserMessageAppendedSchema)({
          eventId: row.eventId,
          eventType: row.eventType,
          eventVersion: row.eventVersion,
          threadId: row.threadId,
          threadPosition: row.threadPosition,
          occurredAt: new Date(row.occurredAt).toISOString(),
          payload: row.payload,
        }).pipe(Effect.mapError(() => new ThreadResumeUnavailable()));
        return {
          ...event,
          cursor: encodeCursor(config.cursorSecret, {
            eventId: event.eventId,
            issuedAtMs: Date.now(),
            position: event.threadPosition,
            threadId: event.threadId,
            version: 1,
          }),
        } satisfies ThreadEventEnvelope;
      });

      const readHead = (threadId: string) =>
        sql<{
          readonly eventId: string | null;
          readonly position: string;
          readonly stateRevision: number;
        }>`SELECT
            event.event_id::text AS "eventId",
            (thread.next_position - 1)::text AS position,
            thread.state_revision AS "stateRevision"
          FROM threads thread
          LEFT JOIN thread_events event
            ON event.thread_id = thread.thread_id
            AND event.position = thread.next_position - 1
          WHERE thread.thread_id = ${threadId}::uuid`;

      const readEvents = (
        threadId: string,
        afterPosition: string,
        throughPosition: string,
        limit: number,
      ) =>
        sql<EventRow>`SELECT
            event_id::text AS "eventId",
            event_type AS "eventType",
            event_version AS "eventVersion",
            occurred_at::text AS "occurredAt",
            payload,
            thread_id::text AS "threadId",
            position::text AS "threadPosition"
          FROM thread_events
          WHERE thread_id = ${threadId}::uuid
            AND position > ${afterPosition}::bigint
            AND position <= ${throughPosition}::bigint
          ORDER BY position ASC
          LIMIT ${limit}`;

      const snapshot = Effect.fn("DatabaseThreadResume.snapshot")(function* (
        request: ThreadAccess,
      ) {
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            yield* authorize(request);
            const head = (yield* readHead(request.threadId))[0];
            if (head === undefined) return yield* new ThreadNotFound();

            const rows = yield* sql<EventRow>`SELECT * FROM (
                SELECT
                  event_id::text AS "eventId",
                  event_type AS "eventType",
                  event_version AS "eventVersion",
                  occurred_at::text AS "occurredAt",
                  payload,
                  thread_id::text AS "threadId",
                  position::text AS "threadPosition"
                FROM thread_events
                WHERE thread_id = ${request.threadId}::uuid
                  AND position <= ${head.position}::bigint
                ORDER BY position DESC
                LIMIT ${config.snapshotTimelineLimit}
              ) suffix
              ORDER BY "threadPosition"::bigint ASC`;
            const events = yield* Effect.forEach(rows, toEnvelope);
            const activeRuns = yield* sql<ActiveRunRow>`SELECT
                run.agent_run_id::text AS "agentRunId",
                event.event_id::text AS "eventId",
                event.position::text AS position,
                event.occurred_at::text AS "occurredAt",
                run.state
              FROM agent_runs run
              JOIN thread_events event ON event.agent_run_id = run.agent_run_id
              WHERE run.thread_id = ${request.threadId}::uuid
                AND run.state IN ('pending', 'running', 'waiting')
                AND event.position <= ${head.position}::bigint
              ORDER BY event.position ASC, run.agent_run_id ASC`;

            const firstPosition = events[0]?.threadPosition;
            const historyBeforePosition =
              firstPosition === undefined ? "0" : String(BigInt(firstPosition) - 1n);
            const throughCursor = encodeCursor(config.cursorSecret, {
              eventId: head.eventId,
              issuedAtMs: Date.now(),
              position: head.position,
              threadId: request.threadId,
              version: 1,
            });

            return yield* Schema.decodeUnknownEffect(ThreadSnapshotSchema)({
              projection: "nativeThread",
              schemaVersion: 1,
              threadId: request.threadId,
              throughPosition: head.position,
              throughCursor,
              stateRevision: head.stateRevision,
              replayGuaranteedForMs: config.replayGuaranteedForMs,
              timelineLimit: config.snapshotTimelineLimit,
              historyBeforePosition,
              timeline: events.map((event) => ({
                type: "userMessage",
                userMessageId: event.payload.userMessageId,
                agentRunId: event.payload.agentRunId,
                source: {
                  firstEventId: event.eventId,
                  firstPosition: event.threadPosition,
                  firstOccurredAt: event.occurredAt,
                  lastEventId: event.eventId,
                  lastPosition: event.threadPosition,
                  lastOccurredAt: event.occurredAt,
                },
                content: event.payload.content,
              })),
              activeState: activeRuns.map((run) => ({
                type: "activeAgentRun",
                agentRunId: run.agentRunId,
                introducedBy: {
                  eventId: run.eventId,
                  position: run.position,
                  occurredAt: new Date(run.occurredAt).toISOString(),
                },
                phase: { type: run.state },
              })),
            }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
          }),
        );

        return yield* transaction.pipe(
          Effect.mapError((error) =>
            isThreadSnapshotError(error) ? error : new SnapshotUnavailable(),
          ),
        );
      });

      const history = Effect.fn("DatabaseThreadResume.history")(function* (
        request: ThreadHistoryRequest,
      ) {
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            yield* authorize(request);
            const head = (yield* readHead(request.threadId))[0];
            if (head === undefined) return yield* new ThreadNotFound();
            const throughPosition = request.throughPosition ?? head.position;
            if (BigInt(throughPosition) > BigInt(head.position)) {
              return yield* new ThreadResumeUnavailable();
            }
            const limit = Math.min(request.limit, 1_000);
            const rows = yield* readEvents(
              request.threadId,
              request.afterPosition,
              throughPosition,
              limit + 1,
            );
            const hasMore = rows.length > limit;
            const events = yield* Effect.forEach(rows.slice(0, limit), toEnvelope);
            return {
              threadId: request.threadId,
              afterPosition: request.afterPosition,
              throughPosition,
              events,
              nextAfterPosition: events.at(-1)?.threadPosition ?? request.afterPosition,
              hasMore,
            } satisfies ThreadHistoryPage;
          }),
        );
        return yield* transaction.pipe(
          Effect.mapError((error) =>
            error instanceof AuthenticationRejected || error instanceof ThreadNotFound
              ? error
              : new ThreadResumeUnavailable(),
          ),
        );
      });

      const stream = Effect.fn("DatabaseThreadResume.stream")(function* (
        request: ThreadStreamRequest,
      ) {
        const initial = sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            yield* authorize(request);
            const cursor = yield* decodeCursor(config.cursorSecret, request.after);
            if (cursor.threadId !== request.threadId) return yield* new InvalidCursor();
            const head = (yield* readHead(request.threadId))[0];
            if (head === undefined) return yield* new ThreadNotFound();
            if (BigInt(cursor.position) > BigInt(head.position)) return yield* new InvalidCursor();

            if (cursor.position !== "0") {
              const cursored = yield* sql<{
                readonly eventId: string;
              }>`SELECT event_id::text AS "eventId"
                FROM thread_events
                WHERE thread_id = ${request.threadId}::uuid
                  AND position = ${cursor.position}::bigint`;
              if (cursored[0]?.eventId !== cursor.eventId) return yield* new InvalidCursor();
            } else if (cursor.eventId !== null) {
              return yield* new InvalidCursor();
            }

            const replayFloor = BigInt(head.position) - BigInt(config.replayEventLimit);
            const now = Date.now();
            if (cursor.issuedAtMs > now) return yield* new InvalidCursor();
            const withinReplayGuarantee = now - cursor.issuedAtMs <= config.replayGuaranteedForMs;
            if (
              !withinReplayGuarantee &&
              BigInt(cursor.position) < (replayFloor > 0n ? replayFloor : 0n)
            ) {
              return yield* new CursorOutsideRetention();
            }
            const throughCursor = encodeCursor(config.cursorSecret, {
              eventId: head.eventId,
              issuedAtMs: Date.now(),
              position: head.position,
              threadId: request.threadId,
              version: 1,
            });
            return { cursor, head, throughCursor };
          }),
        );

        const cut = yield* initial.pipe(
          Effect.mapError(
            (error): ThreadResumeError =>
              isThreadResumeError(error) ? error : new ThreadResumeUnavailable(),
          ),
        );
        const replay = Stream.paginate(cut.cursor.position, (position) =>
          Effect.gen(function* () {
            yield* authorize(request);
            const rows = yield* readEvents(
              request.threadId,
              position,
              cut.head.position,
              config.replayEventLimit,
            );
            if (rows.length === 0) return [[], Option.none()] as const;
            const events = yield* Effect.forEach(rows, toEnvelope);
            const nextPosition = events.at(-1)!.threadPosition;
            return [
              events.map((data) => ({ event: "thread_event" as const, data })),
              BigInt(nextPosition) < BigInt(cut.head.position)
                ? Option.some(nextPosition)
                : Option.none(),
            ] as const;
          }).pipe(Effect.mapError(() => new ThreadResumeUnavailable())),
        );

        const caughtUp = Stream.make({
          event: "caught_up" as const,
          data: { throughPosition: cut.head.position, throughCursor: cut.throughCursor },
        });

        const live = Stream.paginate(cut.head.position, (position) =>
          Effect.gen(function* () {
            yield* authorize(request);
            const currentHead = (yield* readHead(request.threadId))[0];
            if (currentHead === undefined) return yield* new ThreadResumeUnavailable();
            const rows = yield* readEvents(
              request.threadId,
              position,
              currentHead.position,
              config.replayEventLimit,
            );
            if (rows.length === 0) {
              yield* Effect.sleep(config.pollIntervalMs);
              return [[], Option.some(position)] as const;
            }
            const events = yield* Effect.forEach(rows, toEnvelope);
            return [
              events.map((data) => ({ event: "thread_event" as const, data })),
              Option.some(events.at(-1)!.threadPosition),
            ] as const;
          }).pipe(Effect.mapError(() => new ThreadResumeUnavailable())),
        );

        return replay.pipe(Stream.concat(caughtUp), Stream.concat(live));
      });

      return ThreadResume.of({ history, snapshot, stream });
    }),
  ).pipe(Layer.provide(postgresLayer));
};

export const makeThreadResumeLayer = (config: ThreadResumeDatabaseConfig) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(ThreadResumeDatabaseConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidThreadResumeDatabaseConfig({ cause })),
      Effect.map(threadResumeLayer),
    ),
  );
