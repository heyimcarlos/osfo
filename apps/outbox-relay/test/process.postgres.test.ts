import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunWorker,
  OutboxRelay,
  RunnableDeliveryPublisher,
  makeAgentRunWorkerLayer,
  makeDeterministicModelCallExecutorLayer,
  makeOutboxRelayLayer,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import { MessageAdmission } from "@osfo/api";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Metric, Option, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeAgentRunRepositoryLayer, makeMessageAdmissionLayer } from "@osfo/db";
import { outboxRelayMetrics, runOutboxRelay } from "../src/relay.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const noisyPrincipalId = "ac24c64e-f42e-422d-8538-f3585486ed0e";
const quietPrincipalId = "cd739cd1-b88d-47f5-9453-68436dfd3a46";
const noisyToken = "automatic-drain-noisy-token";
const quietToken = "automatic-drain-quiet-token";
const noisyThreadIds = [
  "ca8bd335-caf1-45ea-a5f9-d83680b47f21",
  "bcaa991a-65e4-4d66-a061-5601d71dfba4",
  "b8209ae9-051c-4c81-b504-bb3ba6be55f3",
  "6b8a1af5-e6ee-47c3-98c6-d0ca20a78bb7",
  "7d944a22-ac06-4ff7-8184-330ccb59d0c9",
  "fa167658-109e-40e0-8c66-50a793558ccb",
  "e620da19-405f-46e2-be5e-eb453063f6b4",
  "9f117db5-5c2c-447b-b714-4929792dc397",
] as const;
const quietThreadId = "633b41d2-1aec-4374-81c8-e2f7bb9ad0aa";
const published: Array<RunnableAgentRunDelivery> = [];
let firstPublicationWave: Deferred.Deferred<void> | undefined;
let publicationGate: Deferred.Deferred<void> | undefined;

const databaseLayer = PgClient.layer({
  applicationName: "osfo-outbox-relay-process-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});
const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl, maxConnections: 8 });
const relayLayer = makeOutboxRelayLayer({
  relayId: "automatic-drain-relay",
  leaseDurationMs: 30_000,
  publicationWindowSize: 4,
}).pipe(
  Layer.provide(repositoryLayer),
  Layer.provide(
    Layer.succeed(RunnableDeliveryPublisher)(
      RunnableDeliveryPublisher.of({
        publish: (delivery) =>
          Effect.gen(function* () {
            published.push(delivery);
            if (published.length === 4 && firstPublicationWave !== undefined) {
              yield* Deferred.succeed(firstPublicationWave, undefined);
            }
            if (publicationGate !== undefined) yield* Deferred.await(publicationGate);
            return { providerMessageId: `drain-pubsub-${published.length}` };
          }),
      }),
    ),
  ),
);
const workerLayer = makeAgentRunWorkerLayer({
  executionProfileRef: "oz.deterministic.v1",
  workerId: "automatic-drain-worker",
  leaseDurationMs: 30_000,
}).pipe(
  Layer.provide(repositoryLayer),
  Layer.provide(
    makeDeterministicAgentRuntimeLayer({
      executionProfileRef: "oz.deterministic.v1",
      modelBinding: "oz.deterministic.echo.v1",
    }),
  ),
  Layer.provide(makeDeterministicModelCallExecutorLayer()),
);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    databaseLayer,
    relayLayer,
    workerLayer,
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.deterministic.v1",
      globalNonTerminalLimit: 16,
      maxConnections: 8,
      principalNonTerminalLimit: 8,
    }),
  ),
);

type TestServices = AgentRunWorker | MessageAdmission | OutboxRelay | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, TestServices>) => runtime.runPromise(effect);
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const accept = (authenticationToken: string, threadId: string, content: string) =>
  run(
    MessageAdmission.use((admission) =>
      admission.accept({
        protocolVersion: 1,
        authenticationToken,
        threadId,
        idempotencyKey: randomUUID(),
        message: { content },
      }),
    ),
  );

beforeEach(async () => {
  published.length = 0;
  firstPublicationWave = undefined;
  publicationGate = undefined;
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE principals, admission_global_capacity,
        relay_dispatch_capacity CASCADE`;
      yield* sql`INSERT INTO principals (principal_id) VALUES
        (${noisyPrincipalId}::uuid), (${quietPrincipalId}::uuid)`;
      yield* sql`INSERT INTO authentication_sessions
        (session_id, principal_id, token_sha256, expires_at) VALUES
        (${randomUUID()}::uuid, ${noisyPrincipalId}::uuid,
          ${digest(noisyToken)}, now() + interval '1 hour'),
        (${randomUUID()}::uuid, ${quietPrincipalId}::uuid,
          ${digest(quietToken)}, now() + interval '1 hour')`;
      yield* sql`INSERT INTO threads (thread_id, principal_id) VALUES
        (${noisyThreadIds[0]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[1]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[2]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[3]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[4]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[5]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[6]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[7]}::uuid, ${noisyPrincipalId}::uuid),
        (${quietThreadId}::uuid, ${quietPrincipalId}::uuid)`;
      yield* sql`INSERT INTO admission_global_capacity (singleton, reserved_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO relay_dispatch_capacity (singleton, active_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count) VALUES
        (${noisyPrincipalId}::uuid, 0), (${quietPrincipalId}::uuid, 0)`;
    }),
  );
});

afterAll(() => runtime.dispose());

describe("production outbox relay composition", () => {
  it("drains committed noisy and quiet work through bounded publication and exact terminal budgets", async () => {
    firstPublicationWave = await run(Deferred.make<void>());
    publicationGate = await run(Deferred.make<void>());
    const [quietReceipt, ...noisyReceipts] = await Promise.all([
      accept(quietToken, quietThreadId, "quiet terminal"),
      ...noisyThreadIds.map((threadId, index) =>
        accept(noisyToken, threadId, `noisy terminal ${index + 1}`),
      ),
    ]);
    const relayProcess = runtime.runFork(
      runOutboxRelay({ publisherConcurrency: 4, safetyDrainIntervalMs: 1_000 }),
    );
    try {
      await run(
        Effect.gen(function* () {
          const firstWave = yield* Deferred.await(firstPublicationWave!).pipe(
            Effect.timeoutOption(1_000),
          );
          expect(Option.isSome(firstWave)).toBe(true);
          expect(published.slice(0, 4).map((delivery) => delivery.agentRunId)).toContain(
            quietReceipt.agentRunId,
          );

          const sql = yield* SqlClient.SqlClient;
          const [remaining] = yield* sql<{ readonly eligibleNoisy: number }>`SELECT
            count(*)::int AS "eligibleNoisy"
            FROM outbox_obligations obligation
            WHERE obligation.principal_id = ${noisyPrincipalId}::uuid
              AND obligation.published_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM relay_publication_tasks task
                WHERE task.outbox_id = obligation.outbox_id
              )`;
          expect(remaining).toEqual({ eligibleNoisy: 5 });
          yield* Deferred.succeed(publicationGate!, undefined);
        }),
      );

      const receipts = [quietReceipt, ...noisyReceipts];

      await run(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 100 && published.length < receipts.length; attempt += 1) {
            yield* Effect.sleep(10);
          }
          expect(published).toHaveLength(receipts.length);
          const outcomes = yield* AgentRunWorker.use((worker) =>
            Effect.forEach(published, (delivery) => worker.handle(delivery), {
              concurrency: 4,
            }),
          );
          expect(outcomes).toEqual(
            Array.from({ length: receipts.length }, () => ({
              type: "acknowledge",
              outcome: "succeeded",
            })),
          );
        }),
      );

      const authority = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            readonly activePublicationTasks: number;
            readonly dispatchActive: number;
            readonly globalReserved: number;
            readonly heldReservations: number;
            readonly nonterminalRuns: number;
            readonly principalReserved: ReadonlyArray<number>;
            readonly terminalRuns: number;
            readonly unpublished: number;
          }>`SELECT
            (SELECT count(*)::int FROM relay_publication_tasks)
              AS "activePublicationTasks",
            (SELECT active_count FROM relay_dispatch_capacity WHERE singleton = true)
              AS "dispatchActive",
            (SELECT reserved_count FROM admission_global_capacity WHERE singleton = true)
              AS "globalReserved",
            (SELECT count(*)::int FROM agent_run_capacity_reservations WHERE state = 'held')
              AS "heldReservations",
            (SELECT count(*)::int FROM agent_runs
              WHERE state NOT IN ('succeeded', 'failed', 'canceled')) AS "nonterminalRuns",
            ARRAY(SELECT reserved_count FROM admission_principal_capacity
              ORDER BY principal_id) AS "principalReserved",
            (SELECT count(*)::int FROM agent_runs
              WHERE state IN ('succeeded', 'failed', 'canceled')) AS "terminalRuns",
            (SELECT count(*)::int FROM outbox_obligations WHERE published_at IS NULL)
              AS unpublished`;
          return row;
        }),
      );

      expect(authority).toEqual({
        activePublicationTasks: 0,
        dispatchActive: 0,
        globalReserved: 0,
        heldReservations: 0,
        nonterminalRuns: 0,
        principalReserved: [0, 0],
        terminalRuns: 9,
        unpublished: 0,
      });
    } finally {
      await runtime.runPromise(Fiber.interrupt(relayProcess));
    }
  });

  it("recovers durable work when a replacement relay process starts", async () => {
    const receipt = await accept(noisyToken, noisyThreadIds[0], "replacement startup");
    expect(published).toEqual([]);

    const relayProcess = runtime.runFork(
      runOutboxRelay({ publisherConcurrency: 4, safetyDrainIntervalMs: 60_000 }),
    );
    try {
      await run(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 100 && published.length === 0; attempt += 1) {
            yield* Effect.sleep(10);
          }
          expect(published.map((delivery) => delivery.agentRunId)).toEqual([receipt.agentRunId]);
        }),
      );
    } finally {
      await runtime.runPromise(Fiber.interrupt(relayProcess));
    }
  });

  it("reconnects a terminated PostgreSQL listener and resumes notification-driven drain", async () => {
    const relayProcess = runtime.runFork(
      runOutboxRelay({ publisherConcurrency: 4, safetyDrainIntervalMs: 20 }),
    );
    try {
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          let initialPid: number | undefined;
          for (let attempt = 0; attempt < 100 && initialPid === undefined; attempt += 1) {
            const [listener] = yield* sql<{ readonly pid: number }>`SELECT pid
              FROM pg_stat_activity
              WHERE application_name = 'osfo-outbox-relay-wake'
                AND datname = current_database()`;
            initialPid = listener?.pid;
            if (initialPid === undefined) yield* Effect.sleep(10);
          }
          expect(initialPid).toBeDefined();
          const reconnectsBefore = yield* Metric.value(outboxRelayMetrics.reconnects);
          const [terminated] = yield* sql<{ readonly terminated: boolean }>`SELECT
            pg_terminate_backend(${initialPid!}) AS terminated`;
          expect(terminated).toEqual({ terminated: true });

          let replacementPid: number | undefined;
          for (let attempt = 0; attempt < 200 && replacementPid === undefined; attempt += 1) {
            const [listener] = yield* sql<{ readonly pid: number }>`SELECT pid
              FROM pg_stat_activity
              WHERE application_name = 'osfo-outbox-relay-wake'
                AND datname = current_database()
                AND pid <> ${initialPid!}`;
            replacementPid = listener?.pid;
            if (replacementPid === undefined) yield* Effect.sleep(10);
          }
          expect(replacementPid).toBeDefined();

          let reconnectsAfter = yield* Metric.value(outboxRelayMetrics.reconnects);
          for (
            let attempt = 0;
            attempt < 100 && reconnectsAfter.count <= reconnectsBefore.count;
            attempt += 1
          ) {
            yield* Effect.sleep(10);
            reconnectsAfter = yield* Metric.value(outboxRelayMetrics.reconnects);
          }
          expect(reconnectsAfter.count).toBeGreaterThan(reconnectsBefore.count);

          const notificationsBefore = yield* Metric.value(outboxRelayMetrics.notifications);
          const receipt = yield* MessageAdmission.use((admission) =>
            admission.accept({
              protocolVersion: 1,
              authenticationToken: noisyToken,
              threadId: noisyThreadIds[0],
              idempotencyKey: randomUUID(),
              message: { content: "listener reconnect" },
            }),
          );
          for (let attempt = 0; attempt < 100 && published.length === 0; attempt += 1) {
            yield* Effect.sleep(10);
          }
          const notificationsAfter = yield* Metric.value(outboxRelayMetrics.notifications);
          expect(notificationsAfter.count).toBeGreaterThan(notificationsBefore.count);
          expect(published.map((delivery) => delivery.agentRunId)).toEqual([receipt.agentRunId]);
        }),
      );
    } finally {
      await runtime.runPromise(Fiber.interrupt(relayProcess));
    }
  });
});
