import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunRepository,
  AgentRunFenceSchema,
  AgentRunWorker,
  OutboxRelay,
  RunnableDeliveryPublisher,
  RunnableDeliveryPublisherUnavailable,
  makeAgentRunWorkerLayer,
  makeDeterministicModelCallExecutorLayer,
  makeOutboxRelayLayer,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { MessageAdmission, ThreadResume, type SubmitMessageCommand } from "@osfo/api";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeAgentRunRepositoryLayer,
  makeMessageAdmissionLayer,
  makeThreadResumeLayer,
} from "../src/index.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "alice-test-session-token";
const published: Array<RunnableAgentRunDelivery> = [];
let publicationAttempts = 0;

const databaseLayer = PgClient.layer({
  applicationName: "osfo-agent-run-journey-test",
  maxConnections: 12,
  url: Redacted.make(databaseUrl),
});

const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl });
const runtimeLayer = makeDeterministicAgentRuntimeLayer();
const executorLayer = makeDeterministicModelCallExecutorLayer();
const publisherLayer = Layer.succeed(RunnableDeliveryPublisher)(
  RunnableDeliveryPublisher.of({
    publish: (delivery) =>
      Effect.gen(function* () {
        publicationAttempts += 1;
        published.push(delivery);
        if (publicationAttempts === 1) {
          return yield* new RunnableDeliveryPublisherUnavailable({ cause: "confirmation lost" });
        }
      }),
  }),
);

const workerLayer = makeAgentRunWorkerLayer({
  workerId: "replacement-worker",
  leaseDurationMs: 30_000,
}).pipe(Layer.provide(repositoryLayer), Layer.provide(runtimeLayer), Layer.provide(executorLayer));

const relayLayer = makeOutboxRelayLayer({ relayId: "relay-a", leaseDurationMs: 100 }).pipe(
  Layer.provide(repositoryLayer),
  Layer.provide(publisherLayer),
);

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    databaseLayer,
    repositoryLayer,
    workerLayer,
    relayLayer,
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.deterministic.v1",
      globalNonTerminalLimit: 8,
      principalNonTerminalLimit: 8,
    }),
    makeThreadResumeLayer({
      databaseUrl,
      cursorSecret: "agent-run-journey-test-cursor-secret",
      pollIntervalMs: 5,
      replayEventLimit: 100,
      replayGuaranteedForMs: 30_000,
      snapshotTimelineLimit: 100,
    }),
  ),
);

type TestServices =
  | AgentRunRepository
  | AgentRunWorker
  | MessageAdmission
  | OutboxRelay
  | SqlClient.SqlClient
  | ThreadResume;

const run = <A, E>(effect: Effect.Effect<A, E, TestServices>) => runtime.runPromise(effect);

const ClaimedAgentRunSchema = Schema.Struct({
  type: Schema.Literal("claimed"),
  fence: AgentRunFenceSchema,
});

const seedAuthority = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE
        model_call_attempts,
        model_call_fragments,
        model_calls,
        assistant_outputs,
        outbox_obligations,
        agent_run_capacity_reservations,
        acceptance_receipts,
        thread_events,
        user_messages,
        agent_runs,
        admission_principal_capacity,
        authentication_sessions,
        threads,
        principals,
        admission_global_capacity
        CASCADE`;
      yield* sql`INSERT INTO principals (principal_id) VALUES (${principalId}::uuid)`;
      yield* sql`INSERT INTO authentication_sessions
        (session_id, principal_id, token_sha256, expires_at)
        VALUES (
          ${randomUUID()}::uuid,
          ${principalId}::uuid,
          ${createHash("sha256").update(authenticationToken).digest("hex")},
          now() + interval '1 hour'
        )`;
      yield* sql`INSERT INTO threads (thread_id, principal_id)
        VALUES (${threadId}::uuid, ${principalId}::uuid)`;
      yield* sql`INSERT INTO admission_global_capacity (singleton, reserved_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count)
        VALUES (${principalId}::uuid, 0)`;
    }),
  );

beforeEach(async () => {
  published.length = 0;
  publicationAttempts = 0;
  await seedAuthority();
});

afterAll(() => runtime.dispose());

describe("deterministic PostgreSQL AgentRun journey", () => {
  it("reconciles relay loss, worker replacement, and duplicate delivery", async () => {
    const command = {
      protocolVersion: 1,
      authenticationToken,
      threadId,
      idempotencyKey: randomUUID(),
      message: { content: "Hello, Oz" },
    } satisfies SubmitMessageCommand;
    const receipt = await run(MessageAdmission.use((admission) => admission.accept(command)));

    const lostConfirmation = await run(Effect.exit(OutboxRelay.use((relay) => relay.relayOnce())));
    expect(Exit.isFailure(lostConfirmation)).toBe(true);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE outbox_obligations
          SET publication_lease_expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );

    const relayed = await run(OutboxRelay.use((relay) => relay.relayOnce()));
    expect(relayed).toMatchObject({
      type: "published",
      delivery: { agentRunId: receipt.agentRunId },
    });
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);

    const delivery = published[1]!;
    const abandonedClaim = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, { workerId: "lost-worker", leaseDurationMs: 100 }),
      ),
    );
    expect(abandonedClaim).toMatchObject({
      type: "claimed",
      fence: { claimEpoch: "1", workerId: "lost-worker" },
    });
    const abandoned = await Effect.runPromise(
      Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(abandonedClaim),
    );
    const abandonedAttempt = await run(
      AgentRunRepository.use((repository) =>
        Effect.gen(function* () {
          const modelCall = yield* repository.ensureModelCall(abandoned.fence, {
            type: "startModelCall",
            modelBinding: "oz.deterministic.echo.v1",
            prompt: "Hello, Oz",
          });
          const attempt = yield* repository.beginModelCallAttempt(abandoned.fence, modelCall);
          yield* repository.appendModelOutput(abandoned.fence, attempt, {
            fragmentIndex: 0,
            text: "Echo: ",
          });
          return attempt;
        }),
      ),
    );
    expect(abandonedAttempt.attemptNumber).toBe(1);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs
          SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );

    const completed = await run(AgentRunWorker.use((worker) => worker.handle(delivery)));
    const duplicate = await run(AgentRunWorker.use((worker) => worker.handle(delivery)));
    expect(completed).toEqual({ type: "acknowledge", outcome: "succeeded" });
    expect(duplicate).toEqual({ type: "acknowledge", outcome: "alreadyTerminal" });

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly runState: string;
          readonly claimEpoch: string;
          readonly reservationState: string;
          readonly globalReserved: number;
          readonly principalReserved: number;
          readonly terminalEvents: string;
          readonly modelCalls: string;
          readonly modelCallAttempts: string;
          readonly startedAttempts: string;
        }>`SELECT
          run.state AS "runState",
          run.claim_epoch::text AS "claimEpoch",
          reservation.state AS "reservationState",
          global_capacity.reserved_count AS "globalReserved",
          principal_capacity.reserved_count AS "principalReserved",
          (SELECT count(*) FROM thread_events
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
              AND event_type IN ('AgentRunSucceeded', 'AgentRunFailed'))::text AS "terminalEvents",
          (SELECT count(*) FROM model_calls
            WHERE agent_run_id = ${receipt.agentRunId}::uuid)::text AS "modelCalls",
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = ${receipt.agentRunId}::uuid)::text AS "modelCallAttempts",
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
              AND state = 'started')::text AS "startedAttempts"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        CROSS JOIN admission_global_capacity global_capacity
        JOIN admission_principal_capacity principal_capacity
          ON principal_capacity.principal_id = run.principal_id
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
        const events = yield* sql<{
          readonly eventType: string;
          readonly position: string;
        }>`SELECT event_type AS "eventType", position::text AS position
          FROM thread_events
          WHERE agent_run_id = ${receipt.agentRunId}::uuid
          ORDER BY position`;
        return { row: rows[0], events };
      }),
    );

    expect(authority.row).toEqual({
      runState: "succeeded",
      claimEpoch: "2",
      reservationState: "released",
      globalReserved: 0,
      principalReserved: 0,
      terminalEvents: "1",
      modelCalls: "1",
      modelCallAttempts: "2",
      startedAttempts: "0",
    });
    expect(authority.events).toEqual([
      { eventType: "UserMessageAppended", position: "1" },
      { eventType: "AssistantOutputAppended", position: "2" },
      { eventType: "AssistantOutputAppended", position: "3" },
      { eventType: "AssistantOutputCompleted", position: "4" },
      { eventType: "AgentRunSucceeded", position: "5" },
    ]);

    const snapshot = await run(
      ThreadResume.use((resume) => resume.snapshot({ authenticationToken, threadId })),
    );
    expect(snapshot.timeline).toEqual([
      expect.objectContaining({ type: "userMessage", agentRunId: receipt.agentRunId }),
      expect.objectContaining({
        type: "assistantOutput",
        agentRunId: receipt.agentRunId,
        content: [
          { type: "text", text: "Echo: " },
          { type: "text", text: "Hello, Oz" },
        ],
        status: { type: "completed" },
      }),
    ]);
    expect(snapshot.activeState).toEqual([]);
    expect(snapshot.throughPosition).toBe("5");
  });
});
