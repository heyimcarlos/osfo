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
    expect(snapshot.timeline.map((item) => item.content[0]?.text)).toEqual(["Second", "Third"]);
    expect(snapshot.activeState).toHaveLength(3);
    expect(snapshot.activeState.map((item) => item.phase.type)).toEqual([
      "running",
      "waiting",
      "pending",
    ]);
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
            WHERE application_name = 'osfo-thread-resume'
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
