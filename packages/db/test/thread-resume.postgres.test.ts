import { createHmac } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  CursorOutsideRetention,
  MessageAdmission,
  ThreadResume,
  type SubmitMessageCommand,
} from "@osfo/api";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { makeMessageAdmissionLayer, makeThreadResumeLayer } from "../src/index";
import { prepareMessageAdmissionFixture } from "../src/testing";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "thread-resume-session";
const cursorSecret = "test-only-cursor-secret-with-at-least-32-bytes";

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
      principalNonTerminalLimit: 20,
    }),
    makeThreadResumeLayer({
      cursorSecret,
      databaseUrl,
      pollIntervalMs: 10,
      replayEventLimit: 2,
      replayGuaranteedForMs: 30_000,
      snapshotTimelineLimit: 2,
    }),
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
      principals: [{ principalId, authenticationToken, threadIds: [threadId] }],
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

  it("replays strictly after the cursor, cuts over, then observes live commits", async () => {
    await accept("Replay");
    const origin = await run(
      ThreadResume.use((resume) => resume.history({ ...access, afterPosition: "0", limit: 1 })),
    );
    const replayStream = await run(
      ThreadResume.use((resume) => resume.stream({ ...access, after: origin.events[0]!.cursor })),
    );

    await accept("Live");
    const delivered = await run(replayStream.pipe(Stream.take(2), Stream.runCollect));

    expect(Array.from(delivered)).toMatchObject([
      { event: "caught_up", data: { throughPosition: "1" } },
      {
        event: "thread_event",
        data: { threadPosition: "2", payload: { content: [{ type: "text", text: "Live" }] } },
      },
    ]);
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
