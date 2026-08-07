import { createHmac } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  AuthenticationRejected,
  CursorOutsideRetention,
  MessageAdmission,
  ThreadNotFound,
  ThreadResume,
  type SubmitMessageCommand,
} from "@osfo/api";
import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  ManagedRuntime,
  Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { makeMessageAdmissionLayer, makeThreadResumeLayer } from "../src/index";
import { makeThreadResumeTestLayer, prepareMessageAdmissionFixture } from "../src/testing";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "thread-resume-session";
const otherPrincipalId = "b70f0fdc-59ef-4d45-97cd-d832b9eb8838";
const otherThreadId = "bced01fd-1810-4c22-aac4-3586018966e3";
const otherAuthenticationToken = "other-thread-resume-session";
const cursorSecret = "test-only-cursor-secret-with-at-least-32-bytes";

const resumeConfig = {
  cursorSecret,
  databaseUrl,
  maxConnections: 12,
  pollIntervalMs: 10,
  replayEventLimit: 2,
  replayGuaranteedForMs: 30_000,
  snapshotTimelineLimit: 2,
};

const databaseLayer = PgClient.layer({
  applicationName: "osfo-thread-resume-test",
  maxConnections: 12,
  url: Redacted.make(databaseUrl),
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.thread-resume-test.v1",
      globalNonTerminalLimit: 20,
      maxConnections: 12,
      principalNonTerminalLimit: 20,
    }),
    makeThreadResumeLayer(resumeConfig),
    databaseLayer,
  ),
);

const run = <A, E, R extends MessageAdmission | ThreadResume>(effect: Effect.Effect<A, E, R>) =>
  runtime.runPromise(effect);

const command = (content: string): SubmitMessageCommand => ({
  protocolVersion: 1,
  authenticationToken,
  threadId,
  idempotencyKey: crypto.randomUUID(),
  message: { content },
});

const accept = (content: string) =>
  run(MessageAdmission.use((admission) => admission.accept(command(content))));

const setAgentRunState = (agentRunId: string, state: "running" | "waiting") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`UPDATE agent_runs
        SET state = ${state},
            claim_epoch = CASE WHEN ${state} = 'running' THEN claim_epoch + 1 ELSE claim_epoch END,
            claim_owner = CASE WHEN ${state} = 'running' THEN 'thread-resume-test' ELSE NULL END,
            lease_expires_at = CASE
              WHEN ${state} = 'running' THEN now() + interval '1 hour'
              ELSE NULL
            END
        WHERE agent_run_id = ${agentRunId}::uuid`;
    }).pipe(Effect.provide(databaseLayer)),
  );

const access = { authenticationToken, threadId };

const expireCursor = (cursor: string) => {
  const [encoded] = cursor.split(".");
  if (encoded === undefined) throw new Error("Expected a signed cursor");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as object;
  const expired = Buffer.from(JSON.stringify({ ...payload, issuedAtMs: 0 })).toString("base64url");
  const signature = createHmac("sha256", cursorSecret).update(expired).digest("base64url");
  return `${expired}.${signature}`;
};

beforeEach(() =>
  Effect.runPromise(
    prepareMessageAdmissionFixture(databaseUrl, {
      principals: [
        { principalId, authenticationToken, threadIds: [threadId] },
        {
          principalId: otherPrincipalId,
          authenticationToken: otherAuthenticationToken,
          threadIds: [otherThreadId],
        },
      ],
    }),
  ),
);
afterAll(() => runtime.dispose());

describe("PostgreSQL Thread resume", () => {
  it("bootstraps a bounded complete projection from one logical read point", async () => {
    const first = await accept("First");
    const second = await accept("Second");
    await accept("Third");
    await setAgentRunState(first.agentRunId, "running");
    await setAgentRunState(second.agentRunId, "waiting");

    const snapshot = await run(ThreadResume.use((resume) => resume.snapshot(access)));

    expect(snapshot).toMatchObject({
      threadId,
      throughPosition: "3",
      stateRevision: 3,
      historyBeforePosition: "1",
    });
    expect(snapshot.timeline.map((item) => item.type)).toEqual(["userMessage", "userMessage"]);
    expect(
      snapshot.timeline.flatMap((item) =>
        item.type === "userMessage" ? [item.content[0]?.text] : [],
      ),
    ).toEqual(["Second", "Third"]);
    expect(snapshot.activeState).toHaveLength(3);
    expect(
      snapshot.activeState.flatMap((item) =>
        item.type === "activeAgentRun" ? [item.phase.type] : [],
      ),
    ).toEqual(["running", "waiting", "pending"]);
    expect(snapshot.throughCursor).toEqual(expect.any(String));
  });

  it("retains complete logical histories without fetching omitted output tails", async () => {
    const first = await accept("First");
    const omittedOutputId = crypto.randomUUID();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO thread_events (
            thread_id, position, event_id, principal_id, user_message_id, agent_run_id,
            event_type, event_version, payload, occurred_at
          ) VALUES (
            ${threadId}::uuid, 2, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${first.userMessageId}::uuid, ${first.agentRunId}::uuid,
            'AssistantOutputAppended', 1,
            ${JSON.stringify({
              assistantOutputId: omittedOutputId,
              agentRunId: first.agentRunId,
              content: [{ type: "text", text: "omitted-start" }],
            })}::jsonb,
            transaction_timestamp()
          )`;
        yield* sql`UPDATE threads SET next_position = 3, state_revision = 2
          WHERE thread_id = ${threadId}::uuid`;
      }).pipe(Effect.provide(databaseLayer)),
    );
    const retainedMessage = await accept("Retained");
    const zeroFragmentOutputId = crypto.randomUUID();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO thread_events (
            thread_id, position, event_id, principal_id, user_message_id, agent_run_id,
            event_type, event_version, payload, occurred_at
          ) VALUES
          (
            ${threadId}::uuid, 4, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${retainedMessage.userMessageId}::uuid, ${retainedMessage.agentRunId}::uuid,
            'AssistantOutputCompleted', 1,
            ${JSON.stringify({
              assistantOutputId: zeroFragmentOutputId,
              agentRunId: retainedMessage.agentRunId,
            })}::jsonb,
            transaction_timestamp()
          ),
          (
            ${threadId}::uuid, 5, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${first.userMessageId}::uuid, ${first.agentRunId}::uuid,
            'AssistantOutputAppended', 1,
            ${JSON.stringify({
              assistantOutputId: omittedOutputId,
              agentRunId: first.agentRunId,
              content: [{ type: "text", text: "omitted-tail" }],
            })}::jsonb,
            transaction_timestamp()
          ),
          (
            ${threadId}::uuid, 6, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${first.userMessageId}::uuid, ${first.agentRunId}::uuid,
            'AssistantOutputCompleted', 1,
            ${JSON.stringify({
              assistantOutputId: omittedOutputId,
              agentRunId: first.agentRunId,
            })}::jsonb,
            transaction_timestamp()
          )`;
        yield* sql`UPDATE threads SET next_position = 7, state_revision = 6
          WHERE thread_id = ${threadId}::uuid`;
      }).pipe(Effect.provide(databaseLayer)),
    );

    const snapshot = await run(ThreadResume.use((resume) => resume.snapshot(access)));

    expect(snapshot.timeline).toEqual([
      expect.objectContaining({
        type: "userMessage",
        userMessageId: retainedMessage.userMessageId,
        content: [{ type: "text", text: "Retained" }],
      }),
      expect.objectContaining({
        type: "assistantOutput",
        assistantOutputId: zeroFragmentOutputId,
        content: [],
        status: { type: "completed" },
      }),
    ]);
    expect(snapshot.historyBeforePosition).toBe("2");
    expect(snapshot.throughPosition).toBe("6");
  });

  it("retains cancellation authority for a bounded canceled assistant output", async () => {
    const receipt = await accept("Cancel after output");
    const assistantOutputId = crypto.randomUUID();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`UPDATE agent_runs
          SET state = 'canceled',
              cancellation_requested_at = transaction_timestamp(),
              cleanup_deadline_at = transaction_timestamp() + interval '30 seconds',
              cleanup_disposition = 'completed',
              external_work_may_continue = false
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
        yield* sql`UPDATE agent_run_capacity_reservations
          SET state = 'released', released_at = transaction_timestamp()
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
        yield* sql`UPDATE admission_global_capacity
          SET reserved_count = reserved_count - 1, revision = revision + 1
          WHERE singleton = true`;
        yield* sql`UPDATE admission_principal_capacity
          SET reserved_count = reserved_count - 1
          WHERE principal_id = ${principalId}::uuid`;
        yield* sql`INSERT INTO assistant_outputs (
            assistant_output_id, agent_run_id, state, interruption_cause, created_at, terminated_at
          ) VALUES (
            ${assistantOutputId}::uuid, ${receipt.agentRunId}::uuid,
            'interrupted', 'agentRunCanceled', transaction_timestamp(), transaction_timestamp()
          )`;
        yield* sql`INSERT INTO thread_events (
            thread_id, position, event_id, principal_id, user_message_id, agent_run_id,
            event_type, event_version, payload, occurred_at
          ) VALUES
          (
            ${threadId}::uuid, 2, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${receipt.userMessageId}::uuid, ${receipt.agentRunId}::uuid,
            'AssistantOutputAppended', 1,
            ${JSON.stringify({
              assistantOutputId,
              agentRunId: receipt.agentRunId,
              content: [{ type: "text", text: "Partial" }],
            })}::jsonb,
            transaction_timestamp()
          ),
          (
            ${threadId}::uuid, 3, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${receipt.userMessageId}::uuid, ${receipt.agentRunId}::uuid,
            'AgentRunCancellationRequested', 1,
            ${JSON.stringify({ agentRunId: receipt.agentRunId })}::jsonb,
            transaction_timestamp()
          ),
          (
            ${threadId}::uuid, 4, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${receipt.userMessageId}::uuid, ${receipt.agentRunId}::uuid,
            'AssistantOutputInterrupted', 2,
            ${JSON.stringify({
              assistantOutputId,
              agentRunId: receipt.agentRunId,
              cause: "agentRunCanceled",
            })}::jsonb,
            transaction_timestamp()
          ),
          (
            ${threadId}::uuid, 5, ${crypto.randomUUID()}::uuid, ${principalId}::uuid,
            ${receipt.userMessageId}::uuid, ${receipt.agentRunId}::uuid,
            'AgentRunCanceled', 1,
            ${JSON.stringify({
              agentRunId: receipt.agentRunId,
              cleanupDisposition: { type: "completed" },
              externalWorkMayContinue: false,
            })}::jsonb,
            transaction_timestamp()
          )`;
        yield* sql`UPDATE threads SET next_position = 6, state_revision = 5
          WHERE thread_id = ${threadId}::uuid`;
      }).pipe(Effect.provide(databaseLayer)),
    );

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            makeThreadResumeLayer({ ...resumeConfig, snapshotTimelineLimit: 1 }),
          );
          return yield* Context.get(services, ThreadResume).snapshot(access);
        }),
      ),
    );

    expect(snapshot.timeline).toEqual([
      expect.objectContaining({
        type: "assistantOutput",
        assistantOutputId,
        content: [{ type: "text", text: "Partial" }],
        status: { type: "interrupted", cause: "agentRunCanceled" },
      }),
    ]);
    expect(snapshot.activeState).toEqual([]);
    expect(snapshot.historyBeforePosition).toBe("1");
    expect(snapshot.throughPosition).toBe("5");
  });

  it("keeps pagination gap-free through the first page's frozen head", async () => {
    await accept("First");
    await accept("Second");

    const first = await run(
      ThreadResume.use((resume) => resume.history({ ...access, afterPosition: "0", limit: 1 })),
    );
    await accept("Later than the frozen head");
    const second = await run(
      ThreadResume.use((resume) =>
        resume.history({
          ...access,
          afterPosition: first.nextAfterPosition,
          throughPosition: first.throughPosition,
          limit: 1,
        }),
      ),
    );

    expect(first.events.map((candidate) => candidate.threadPosition)).toEqual(["1"]);
    expect(first).toMatchObject({ throughPosition: "2", hasMore: true });
    expect(second.events.map((candidate) => candidate.threadPosition)).toEqual(["2"]);
    expect(second).toMatchObject({ throughPosition: "2", hasMore: false });
  });

  it("reconciles a dropped PostgreSQL notification across the replay-to-live cut", async () => {
    const origin = (await run(ThreadResume.use((resume) => resume.snapshot(access)))).throughCursor;
    await accept("Replay one");
    await accept("Replay two");
    const delivered = await Effect.runPromise(
      Effect.gen(function* () {
        const dropFirstHint = yield* Ref.make(true);
        const notificationDropped = yield* Latch.make();
        const notificationSubscribed = yield* Latch.make();
        return yield* Effect.gen(function* () {
          const resume = yield* ThreadResume;
          const lostHintRecovered = yield* Latch.make();
          const replayStream = yield* resume.stream({ ...access, after: origin });
          const collector = yield* replayStream.pipe(
            Stream.tap((event) => {
              if (event.event === "caught_up") {
                return Effect.promise(() => accept("Committed while its hint is dropped")).pipe(
                  Effect.asVoid,
                );
              }
              return event.data.threadPosition === "3" ? lostHintRecovered.open : Effect.void;
            }),
            Stream.take(5),
            Stream.runCollect,
            Effect.forkChild,
          );

          yield* notificationDropped.await;
          yield* lostHintRecovered.await;
          yield* notificationSubscribed.await;
          yield* Effect.promise(() => accept("Delivered by notification hint"));
          return yield* Fiber.join(collector).pipe(Effect.timeout("2 seconds"));
        }).pipe(
          Effect.provide(
            makeThreadResumeTestLayer(
              { ...resumeConfig, pollIntervalMs: 60_000 },
              {
                dropNotificationHint: (notifiedThreadId) =>
                  notifiedThreadId === threadId
                    ? Ref.getAndSet(dropFirstHint, false).pipe(
                        Effect.tap((drop) => (drop ? notificationDropped.open : Effect.void)),
                      )
                    : Effect.succeed(false),
                onNotificationSubscription: (subscribedThreadId) =>
                  subscribedThreadId === threadId ? notificationSubscribed.open : Effect.void,
              },
            ),
          ),
        );
      }),
    );

    expect(Array.from(delivered).map((message) => message.event)).toEqual([
      "thread_event",
      "thread_event",
      "caught_up",
      "thread_event",
      "thread_event",
    ]);
    expect(
      Array.from(delivered).flatMap((message) =>
        message.event === "thread_event" ? [message.data.threadPosition] : [],
      ),
    ).toEqual(["1", "2", "3", "4"]);
    expect(delivered[2]).toMatchObject({
      event: "caught_up",
      data: { throughPosition: "2" },
    });
  });

  it("keeps the configured query slot available while PostgreSQL notifications are listening", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const countListeners = sql<{ readonly count: string }>`SELECT count(*)::text AS count
            FROM pg_stat_activity
            WHERE application_name LIKE 'osfo-thread-resume-%'
              AND query LIKE 'LISTEN %'`;
          const baseline = Number((yield* countListeners)[0]?.count ?? "0");
          const services = yield* Layer.build(
            makeThreadResumeLayer({ ...resumeConfig, maxConnections: 1 }),
          );
          const resume = Context.get(services, ThreadResume);
          const listener = yield* countListeners.pipe(
            Effect.filterOrFail(
              (rows) => Number(rows[0]?.count ?? "0") === baseline + 1,
              () => "listener not ready",
            ),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
            Effect.timeout("2 seconds"),
          );
          expect(Number(listener[0]?.count)).toBe(baseline + 1);

          const snapshot = yield* resume.snapshot(access).pipe(Effect.timeout("2 seconds"));
          expect(snapshot.threadId).toBe(threadId);
        }),
      ).pipe(Effect.provide(databaseLayer)),
    );
  });

  it("reconnects a terminated PostgreSQL notification backend without waiting for polling", async () => {
    const origin = (await run(ThreadResume.use((resume) => resume.snapshot(access)))).throughCursor;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const listenerPids = sql<{ readonly pid: string }>`SELECT pid::text AS pid
            FROM pg_stat_activity
            WHERE application_name LIKE 'osfo-thread-resume-%'
              AND query LIKE 'LISTEN %'`;
          const baseline = new Set((yield* listenerPids).map((row) => row.pid));
          const allowReconnect = yield* Latch.make();
          const reconnectBlocked = yield* Latch.make();
          const listenerCycle = yield* Ref.make(0);
          const services = yield* Layer.build(
            makeThreadResumeTestLayer(
              { ...resumeConfig, maxConnections: 1, pollIntervalMs: 60_000 },
              {
                beforeNotificationListenerConnect: Ref.getAndUpdate(
                  listenerCycle,
                  (cycle) => cycle + 1,
                ).pipe(
                  Effect.flatMap((cycle) =>
                    cycle === 0
                      ? Effect.void
                      : reconnectBlocked.open.pipe(Effect.andThen(allowReconnect.await)),
                  ),
                ),
                dropNotificationHint: () => Effect.succeed(false),
                onNotificationSubscription: () => Effect.void,
              },
            ),
          );
          const resume = Context.get(services, ThreadResume);
          const initialListenerPid = yield* listenerPids.pipe(
            Effect.flatMap((rows) => {
              const pid = rows.find((row) => !baseline.has(row.pid))?.pid;
              return pid === undefined ? Effect.fail("listener not ready") : Effect.succeed(pid);
            }),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
            Effect.timeout("3 seconds"),
          );
          const caughtUp = yield* Latch.make();
          const stream = yield* resume.stream({ ...access, after: origin });
          const collector = yield* stream.pipe(
            Stream.tap((event) =>
              event.event === "caught_up" ? caughtUp.open.pipe(Effect.asVoid) : Effect.void,
            ),
            Stream.take(3),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* caughtUp.await;

          const terminated = yield* sql<{ readonly terminated: boolean }>`SELECT
            pg_terminate_backend(${initialListenerPid}::integer) AS terminated`;
          expect(terminated[0]?.terminated).toBe(true);
          yield* reconnectBlocked.await;
          yield* listenerPids.pipe(
            Effect.filterOrFail(
              (rows) => rows.every((row) => row.pid !== initialListenerPid),
              () => "terminated notification listener is still present",
            ),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
            Effect.timeout("3 seconds"),
          );
          yield* Effect.promise(() => accept("Committed while listener is unavailable"));
          yield* allowReconnect.open;
          yield* listenerPids.pipe(
            Effect.filterOrFail(
              (rows) =>
                rows.some((row) => row.pid !== initialListenerPid && !baseline.has(row.pid)),
              () => "notification listener has not reconnected",
            ),
            Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }),
            Effect.timeout("6 seconds"),
          );
          yield* Effect.promise(() => accept("Delivered after listener reconnect"));

          const delivered = Array.from(
            yield* Fiber.join(collector).pipe(Effect.timeout("3 seconds")),
          );
          expect(
            delivered.flatMap((event) =>
              event.event === "thread_event" ? [event.data.threadPosition] : [],
            ),
          ).toEqual(["1", "2"]);
        }),
      ).pipe(Effect.provide(databaseLayer)),
    );
  }, 15_000);

  it("forces a blackholed notification listener closed before reconnecting", async () => {
    const origin = (await run(ThreadResume.use((resume) => resume.snapshot(access)))).throughCursor;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const listenerPids = sql<{ readonly pid: string }>`SELECT pid::text AS pid
            FROM pg_stat_activity
            WHERE application_name LIKE 'osfo-thread-resume-%'
              AND query LIKE 'LISTEN %'`;
          const baseline = new Set((yield* listenerPids).map((row) => row.pid));
          const dropFirstHeartbeat = yield* Ref.make(true);
          const heartbeatDropped = yield* Latch.make();
          const gracefulCloseStarted = yield* Latch.make();
          const services = yield* Layer.build(
            makeThreadResumeTestLayer(
              { ...resumeConfig, maxConnections: 1, pollIntervalMs: 60_000 },
              {
                beforeNotificationListenerGracefulClose: gracefulCloseStarted.open.pipe(
                  Effect.andThen(Effect.never),
                ),
                dropNotificationHeartbeat: () =>
                  Ref.getAndSet(dropFirstHeartbeat, false).pipe(
                    Effect.tap((drop) => (drop ? heartbeatDropped.open : Effect.void)),
                  ),
                dropNotificationHint: () => Effect.succeed(false),
                onNotificationSubscription: () => Effect.void,
              },
            ),
          );
          const resume = Context.get(services, ThreadResume);
          const initialListenerPid = yield* listenerPids.pipe(
            Effect.flatMap((rows) => {
              const pid = rows.find((row) => !baseline.has(row.pid))?.pid;
              return pid === undefined ? Effect.fail("listener not ready") : Effect.succeed(pid);
            }),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
            Effect.timeout("3 seconds"),
          );
          const caughtUp = yield* Latch.make();
          const stream = yield* resume.stream({ ...access, after: origin });
          const collector = yield* stream.pipe(
            Stream.tap((event) =>
              event.event === "caught_up" ? caughtUp.open.pipe(Effect.asVoid) : Effect.void,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* caughtUp.await;
          yield* heartbeatDropped.await;
          yield* gracefulCloseStarted.await;
          yield* listenerPids.pipe(
            Effect.filterOrFail(
              (rows) =>
                rows.some((row) => row.pid !== initialListenerPid && !baseline.has(row.pid)),
              () => "blackholed notification listener has not been replaced",
            ),
            Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }),
            Effect.timeout("6 seconds"),
          );
          yield* Effect.promise(() => accept("Delivered after forced listener replacement"));

          const delivered = Array.from(
            yield* Fiber.join(collector).pipe(Effect.timeout("3 seconds")),
          );
          expect(
            delivered.flatMap((event) =>
              event.event === "thread_event" ? [event.data.threadPosition] : [],
            ),
          ).toEqual(["1"]);
        }),
      ).pipe(Effect.provide(databaseLayer)),
    );
  }, 20_000);

  it("bounds queued notification hints and reconnects after overflow starves heartbeats", async () => {
    const origin = (await run(ThreadResume.use((resume) => resume.snapshot(access)))).throughCursor;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const listenerPids = sql<{ readonly pid: string }>`SELECT pid::text AS pid
            FROM pg_stat_activity
            WHERE application_name LIKE 'osfo-thread-resume-%'
              AND query LIKE 'LISTEN %'`;
          const baseline = new Set((yield* listenerPids).map((row) => row.pid));
          const firstConsumerBlocked = yield* Latch.make();
          const allowFirstConsumer = yield* Latch.make();
          const secondConsumerBlocked = yield* Latch.make();
          const lastSlidingHintObserved = yield* Latch.make();
          const observedSlidingHints = yield* Ref.make(0);
          const services = yield* Layer.build(
            makeThreadResumeTestLayer(
              { ...resumeConfig, maxConnections: 1, pollIntervalMs: 60_000 },
              {
                dropNotificationHint: (payload) => {
                  if (payload === "block-first-notification-consumer") {
                    return firstConsumerBlocked.open.pipe(
                      Effect.andThen(allowFirstConsumer.await),
                      Effect.as(true),
                    );
                  }
                  if (payload === "block-second-notification-consumer") {
                    return secondConsumerBlocked.open.pipe(
                      Effect.andThen(Effect.never),
                      Effect.as(true),
                    );
                  }
                  if (payload.startsWith("overflow-one-") || payload === "overflow-one-last") {
                    return Ref.update(observedSlidingHints, (count) => count + 1).pipe(
                      Effect.andThen(
                        payload === "overflow-one-last"
                          ? lastSlidingHintObserved.open
                          : Effect.void,
                      ),
                      Effect.as(true),
                    );
                  }
                  return Effect.succeed(false);
                },
                onNotificationSubscription: () => Effect.void,
              },
            ),
          );
          const resume = Context.get(services, ThreadResume);
          yield* listenerPids.pipe(
            Effect.flatMap((rows) => {
              const pid = rows.find((row) => !baseline.has(row.pid))?.pid;
              return pid === undefined ? Effect.fail("listener not ready") : Effect.void;
            }),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
            Effect.timeout("3 seconds"),
          );

          yield* sql`SELECT pg_notify(
            'osfo_thread_events',
            'block-first-notification-consumer'
          )`;
          yield* firstConsumerBlocked.await;
          yield* sql`SELECT pg_notify(
            'osfo_thread_events',
            'overflow-one-' || value::text
          ) FROM generate_series(1, 2048) AS value`;
          yield* sql`SELECT pg_notify('osfo_thread_events', 'overflow-one-last')`;
          yield* allowFirstConsumer.open;
          yield* lastSlidingHintObserved.await.pipe(Effect.timeout("3 seconds"));
          expect(yield* Ref.get(observedSlidingHints)).toBeLessThan(2_049);
          const listenerBeforeStarvation = yield* listenerPids.pipe(
            Effect.flatMap((rows) => {
              const pid = rows.find((row) => !baseline.has(row.pid))?.pid;
              return pid === undefined
                ? Effect.fail("listener unavailable before overflow starvation")
                : Effect.succeed(pid);
            }),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
            Effect.timeout("3 seconds"),
          );

          const caughtUp = yield* Latch.make();
          const stream = yield* resume.stream({ ...access, after: origin });
          const collector = yield* stream.pipe(
            Stream.tap((event) =>
              event.event === "caught_up" ? caughtUp.open.pipe(Effect.asVoid) : Effect.void,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* caughtUp.await;
          yield* sql`SELECT pg_notify(
            'osfo_thread_events',
            'block-second-notification-consumer'
          )`;
          yield* secondConsumerBlocked.await;
          yield* sql`SELECT pg_notify(
            'osfo_thread_events',
            'overflow-two-' || value::text
          ) FROM generate_series(1, 2048) AS value`;
          yield* listenerPids.pipe(
            Effect.filterOrFail(
              (rows) =>
                rows.some((row) => row.pid !== listenerBeforeStarvation && !baseline.has(row.pid)),
              () => "notification listener did not reconnect after overflow",
            ),
            Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 240 }),
            Effect.timeout("7 seconds"),
          );
          yield* Effect.promise(() => accept("Delivered after notification queue overflow"));

          const delivered = Array.from(
            yield* Fiber.join(collector).pipe(Effect.timeout("3 seconds")),
          );
          expect(
            delivered.flatMap((event) =>
              event.event === "thread_event" ? [event.data.threadPosition] : [],
            ),
          ).toEqual(["1"]);
        }),
      ).pipe(Effect.provide(databaseLayer)),
    );
  }, 20_000);

  it("keeps unknown and unauthorized Threads indistinguishable", async () => {
    const unauthorized = await run(
      Effect.flip(
        ThreadResume.use((resume) =>
          resume.snapshot({ authenticationToken, threadId: otherThreadId }),
        ),
      ),
    );
    const unknown = await run(
      Effect.flip(
        ThreadResume.use((resume) =>
          resume.snapshot({
            authenticationToken,
            threadId: "a297d198-0412-45fe-9252-0a03add1cc40",
          }),
        ),
      ),
    );

    expect(unauthorized).toEqual(new ThreadNotFound());
    expect(unknown).toEqual(unauthorized);
  });

  it("rejects expired and revoked Authentication Sessions without resource disclosure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`UPDATE authentication_sessions
          SET expires_at = now() - interval '1 second'
          WHERE principal_id = ${principalId}::uuid`;
      }).pipe(Effect.provide(databaseLayer)),
    );
    const expired = await run(Effect.flip(ThreadResume.use((resume) => resume.snapshot(access))));
    expect(expired).toEqual(new AuthenticationRejected());

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`UPDATE authentication_sessions
          SET expires_at = now() + interval '1 hour', revoked_at = now()
          WHERE principal_id = ${principalId}::uuid`;
      }).pipe(Effect.provide(databaseLayer)),
    );
    const revoked = await run(
      Effect.flip(
        ThreadResume.use((resume) => resume.history({ ...access, afterPosition: "0", limit: 1 })),
      ),
    );
    expect(revoked).toEqual(expired);
  });

  it("resumes a durable cursor after the Osfo API runtime is replaced", async () => {
    await accept("Before replacement");
    const snapshot = await run(ThreadResume.use((resume) => resume.snapshot(access)));
    await accept("During replacement");

    const replacement = ManagedRuntime.make(makeThreadResumeLayer(resumeConfig));
    try {
      const stream = await replacement.runPromise(
        ThreadResume.use((resume) => resume.stream({ ...access, after: snapshot.throughCursor })),
      );
      const delivered = Array.from(
        await replacement.runPromise(stream.pipe(Stream.take(2), Stream.runCollect)),
      );

      expect(delivered).toMatchObject([
        { event: "thread_event", data: { threadPosition: "2" } },
        { event: "caught_up", data: { throughPosition: "2" } },
      ]);
    } finally {
      await replacement.dispose();
    }
  });

  it("honors the replay time guarantee beyond the normal event-count bound", async () => {
    const origin = (await run(ThreadResume.use((resume) => resume.snapshot(access)))).throughCursor;
    await accept("First");
    await accept("Second");
    await accept("Third");
    await accept("Fourth");
    await accept("Fifth");

    const replay = await run(
      ThreadResume.use((resume) => resume.stream({ ...access, after: origin })),
    );
    const delivered = await run(replay.pipe(Stream.take(6), Stream.runCollect));

    expect(Array.from(delivered).map((message) => message.event)).toEqual([
      "thread_event",
      "thread_event",
      "thread_event",
      "thread_event",
      "thread_event",
      "caught_up",
    ]);
  });

  it("rejects an expired cursor beyond bounded replay retention", async () => {
    const origin = (await run(ThreadResume.use((resume) => resume.snapshot(access)))).throughCursor;
    await accept("First");
    await accept("Second");
    await accept("Third");

    const error = await run(
      Effect.flip(
        ThreadResume.use((resume) => resume.stream({ ...access, after: expireCursor(origin) })),
      ),
    );

    expect(error).toEqual(new CursorOutsideRetention());
  });
});
