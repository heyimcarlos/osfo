import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
  ThreadEventSchema,
  ThreadSnapshotSchema,
  applyThreadEvent,
  makeEmptyThreadSnapshot,
  type ThreadEventEnvelope,
} from "@osfo/session";
import {
  Data,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const threadEventsNotificationChannel = "osfo_thread_events";
const notificationListenerLivenessIntervalMs = 1_000;
const notificationListenerReconnectDelayMs = 100;
const notificationListenerHeartbeatTimeoutMs = 1_000;
const notificationListenerHeartbeatPrefix = "__osfo_listener_heartbeat__:";

export const ThreadResumeDatabaseConfigSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  cursorSecret: Schema.String.check(Schema.isMinLength(32)),
  maxConnections: PositiveInteger,
  pollIntervalMs: PositiveInteger,
  replayEventLimit: PositiveInteger,
  replayGuaranteedForMs: PositiveInteger,
  snapshotTimelineLimit: PositiveInteger,
});

export type ThreadResumeDatabaseConfig = typeof ThreadResumeDatabaseConfigSchema.Type;

export class InvalidThreadResumeDatabaseConfig extends Data.TaggedError(
  "InvalidThreadResumeDatabaseConfig",
)<{ readonly cause: unknown }> {}

export interface ThreadResumeTestHooks {
  readonly dropNotificationHint: (threadId: string) => Effect.Effect<boolean>;
  readonly onNotificationSubscription: (threadId: string) => Effect.Effect<void>;
}

const CursorPayloadSchema = Schema.Struct({
  eventId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  issuedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  position: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  threadId: Schema.String.check(Schema.isUUID()),
  version: Schema.Literal(1),
});

type CursorPayload = typeof CursorPayloadSchema.Type;

const CursorPayloadFromJson = Schema.fromJsonString(CursorPayloadSchema);

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

const decodeCursor = Effect.fn("DatabaseThreadResume.decodeCursor")(function* (
  secret: string,
  value: string,
) {
  const [encoded, signature, unexpected] = value.split(".");
  if (encoded === undefined || signature === undefined || unexpected !== undefined) {
    return yield* new InvalidCursor();
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return yield* new InvalidCursor();
  }
  return yield* Schema.decodeUnknownEffect(CursorPayloadFromJson)(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ).pipe(Effect.mapError(() => new InvalidCursor()));
});

const threadResumeLayer = (config: ThreadResumeDatabaseConfig, hooks: ThreadResumeTestHooks) => {
  const applicationName = `osfo-thread-resume-${randomUUID().slice(0, 8)}`;
  const postgresLayer = PgClient.layer({
    applicationName,
    maxConnections: config.maxConnections,
    url: Redacted.make(config.databaseUrl),
  });
  return Layer.effect(
    ThreadResume,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const notificationHints = yield* PubSub.sliding<string>(1_024);
      const pendingHeartbeat = yield* Ref.make<
        Option.Option<{
          readonly observed: Deferred.Deferred<void>;
          readonly token: string;
        }>
      >(Option.none());
      const readListenerBackend = sql<{ readonly pid: string }>`SELECT pid::text AS pid
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND query LIKE 'LISTEN %'
        LIMIT 1`;
      const listenForNotificationHints = Effect.scoped(
        Effect.gen(function* () {
          yield* sql.listen(threadEventsNotificationChannel).pipe(
            Stream.runForEach((notifiedThreadId) =>
              Ref.get(pendingHeartbeat).pipe(
                Effect.flatMap((heartbeat) =>
                  Option.isSome(heartbeat) && heartbeat.value.token === notifiedThreadId
                    ? Deferred.succeed(heartbeat.value.observed, undefined)
                    : notifiedThreadId.startsWith(notificationListenerHeartbeatPrefix)
                      ? Effect.void
                      : hooks
                          .dropNotificationHint(notifiedThreadId)
                          .pipe(
                            Effect.flatMap((drop) =>
                              drop
                                ? Effect.void
                                : PubSub.publish(notificationHints, notifiedThreadId),
                            ),
                          ),
                ),
                Effect.asVoid,
              ),
            ),
            Effect.forkScoped,
          );
          yield* readListenerBackend.pipe(
            Effect.flatMap((rows) =>
              rows[0] === undefined ? Effect.fail(new ThreadResumeUnavailable()) : Effect.void,
            ),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
          );
          while (true) {
            yield* Effect.sleep(notificationListenerLivenessIntervalMs);
            const observed = yield* Deferred.make<void>();
            const token = `${notificationListenerHeartbeatPrefix}${randomUUID()}`;
            yield* Ref.set(pendingHeartbeat, Option.some({ observed, token }));
            yield* sql.notify(threadEventsNotificationChannel, token);
            yield* Deferred.await(observed).pipe(
              Effect.timeout(notificationListenerHeartbeatTimeoutMs),
            );
            yield* Ref.set(pendingHeartbeat, Option.none());
          }
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread event notification listener reconnecting", cause),
        ),
        Effect.andThen(Effect.sleep(notificationListenerReconnectDelayMs)),
      );
      yield* Effect.forever(listenForNotificationHints).pipe(Effect.forkScoped);

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
        const event = yield* Schema.decodeUnknownEffect(ThreadEventSchema)({
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

            const rows = yield* sql<EventRow>`WITH timeline_identities AS (
                SELECT
                  'userMessage'::text AS identity_type,
                  payload ->> 'userMessageId' AS identity_id,
                  position
                FROM thread_events
                WHERE thread_id = ${request.threadId}::uuid
                  AND position <= ${head.position}::bigint
                  AND event_type = 'UserMessageAppended'
                UNION ALL
                SELECT
                  'assistantOutput'::text AS identity_type,
                  payload ->> 'assistantOutputId' AS identity_id,
                  min(position) AS position
                FROM thread_events
                WHERE thread_id = ${request.threadId}::uuid
                  AND position <= ${head.position}::bigint
                  AND event_type IN (
                    'AssistantOutputAppended',
                    'AssistantOutputCompleted',
                    'AssistantOutputInterrupted'
                  )
                GROUP BY payload ->> 'assistantOutputId'
              ), retained_identities AS (
                SELECT identity_type, identity_id, position
                FROM timeline_identities
                ORDER BY position DESC
                LIMIT ${config.snapshotTimelineLimit}
              )
              SELECT
                event.event_id::text AS "eventId",
                event.event_type AS "eventType",
                event.event_version AS "eventVersion",
                event.occurred_at::text AS "occurredAt",
                event.payload,
                event.thread_id::text AS "threadId",
                event.position::text AS "threadPosition"
              FROM thread_events event
              WHERE event.thread_id = ${request.threadId}::uuid
                AND event.position <= ${head.position}::bigint
                AND (
                  (
                    event.event_type = 'UserMessageAppended'
                    AND EXISTS (
                      SELECT 1 FROM retained_identities retained
                      WHERE retained.identity_type = 'userMessage'
                        AND retained.identity_id = event.payload ->> 'userMessageId'
                    )
                  )
                  OR (
                    event.event_type IN (
                      'AssistantOutputAppended',
                      'AssistantOutputCompleted',
                      'AssistantOutputInterrupted'
                    )
                    AND EXISTS (
                      SELECT 1 FROM retained_identities retained
                      WHERE retained.identity_type = 'assistantOutput'
                        AND retained.identity_id = event.payload ->> 'assistantOutputId'
                    )
                  )
                )
              ORDER BY event.position ASC`;
            const events = yield* Effect.forEach(rows, toEnvelope);
            const activeRuns = yield* sql<ActiveRunRow>`SELECT
                run.agent_run_id::text AS "agentRunId",
                event.event_id::text AS "eventId",
                event.position::text AS position,
                event.occurred_at::text AS "occurredAt",
                run.state
              FROM agent_runs run
              JOIN thread_events event
                ON event.agent_run_id = run.agent_run_id
                AND event.event_type = 'UserMessageAppended'
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

            const empty = yield* makeEmptyThreadSnapshot({
              threadId: request.threadId,
              throughCursor: encodeCursor(config.cursorSecret, {
                eventId: null,
                issuedAtMs: Date.now(),
                position: historyBeforePosition,
                threadId: request.threadId,
                version: 1,
              }),
              replayGuaranteedForMs: config.replayGuaranteedForMs,
              timelineLimit: config.snapshotTimelineLimit,
            }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
            const base = { ...empty, throughPosition: historyBeforePosition };
            const folded = yield* Effect.reduce(
              events,
              () => base,
              (projection, event) =>
                applyThreadEvent(
                  {
                    ...projection,
                    throughPosition: String(BigInt(event.threadPosition) - 1n),
                  },
                  event,
                ),
            ).pipe(Effect.mapError(() => new SnapshotUnavailable()));

            return yield* Schema.decodeUnknownEffect(ThreadSnapshotSchema)({
              ...folded,
              throughPosition: head.position,
              throughCursor,
              lastEventId: head.eventId,
              stateRevision: head.stateRevision,
              historyBeforePosition,
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

        const notificationWakeups = Stream.unwrap(
          PubSub.subscribe(notificationHints).pipe(
            Effect.tap(() => hooks.onNotificationSubscription(request.threadId)),
            Effect.map(Stream.fromSubscription),
          ),
        ).pipe(
          Stream.filter((notifiedThreadId) => notifiedThreadId === request.threadId),
          Stream.map(() => undefined),
        );
        const pollingWakeups = Stream.fromEffect(Effect.sleep(config.pollIntervalMs)).pipe(
          Stream.repeat(Schedule.forever),
        );
        const live = Stream.merge(
          Stream.make(undefined),
          Stream.merge(notificationWakeups, pollingWakeups),
        ).pipe(
          Stream.mapAccumEffect(
            () => cut.head.position,
            (position) =>
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
                const events = yield* Effect.forEach(rows, toEnvelope);
                const nextPosition = events.at(-1)?.threadPosition ?? position;
                return [
                  nextPosition,
                  events.map((data) => ({ event: "thread_event" as const, data })),
                ] as const;
              }).pipe(Effect.mapError(() => new ThreadResumeUnavailable())),
          ),
        );

        return replay.pipe(Stream.concat(caughtUp), Stream.concat(live));
      });

      return ThreadResume.of({ history, snapshot, stream });
    }),
  ).pipe(Layer.provide(postgresLayer));
};

const makeLayer = (config: ThreadResumeDatabaseConfig, hooks: ThreadResumeTestHooks) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(ThreadResumeDatabaseConfigSchema)(config).pipe(
      Effect.mapError((cause) => new InvalidThreadResumeDatabaseConfig({ cause })),
      Effect.map((decoded) => threadResumeLayer(decoded, hooks)),
    ),
  );

export const makeThreadResumeLayer = (config: ThreadResumeDatabaseConfig) =>
  makeLayer(config, {
    dropNotificationHint: () => Effect.succeed(false),
    onNotificationSubscription: () => Effect.void,
  });

export const makeThreadResumeTestLayer = (
  config: ThreadResumeDatabaseConfig,
  hooks: ThreadResumeTestHooks,
) => makeLayer(config, hooks);
