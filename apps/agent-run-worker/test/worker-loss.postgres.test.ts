import { NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  OutboxRelay,
  RunnableDeliveryPublisher,
  makeOutboxRelayLayer,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import { AgentRunCancellation, MessageAdmission } from "@osfo/api";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  makeAgentRunCancellationLayer,
  makeAgentRunRepositoryLayer,
  makeMessageAdmissionLayer,
} from "@osfo/db";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess } from "effect/unstable/process";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for worker-loss acceptance");
}

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "worker-loss-session-token";
const published: Array<RunnableAgentRunDelivery> = [];
const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl });
const publisherLayer = Layer.succeed(RunnableDeliveryPublisher)(
  RunnableDeliveryPublisher.of({
    publish: (delivery) =>
      Effect.sync(() => {
        published.push(delivery);
        return { providerMessageId: `worker-loss-${delivery.deliveryId}` };
      }),
  }),
);
const relayLayer = makeOutboxRelayLayer({
  relayId: "worker-loss-relay",
  leaseDurationMs: 1_000,
  publicationWindowSize: 4,
}).pipe(Layer.provide(repositoryLayer), Layer.provide(publisherLayer));
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    NodeServices.layer,
    PgClient.layer({
      applicationName: "osfo-worker-loss-acceptance",
      maxConnections: 8,
      url: Redacted.make(databaseUrl),
    }),
    repositoryLayer,
    relayLayer,
    makeAgentRunCancellationLayer({ databaseUrl, cleanupTimeoutMs: 150 }),
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.deterministic.v1",
      globalNonTerminalLimit: 8,
      principalNonTerminalLimit: 8,
    }),
  ),
);

const run = runtime.runPromise;

beforeEach(async () => {
  published.length = 0;
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE
        model_call_attempts,
        model_call_fragments,
        model_calls,
        assistant_outputs,
        relay_publication_attempts,
        relay_publication_tasks,
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
        relay_dispatch_capacity,
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
      yield* sql`INSERT INTO relay_dispatch_capacity (singleton, active_count)
        VALUES (true, 0)`;
    }),
  );
});

afterAll(() => runtime.dispose());

const spawnWorker = (delivery: RunnableAgentRunDelivery, behavior: "lost" | "replacement") =>
  ChildProcess.make(process.execPath, ["test/fixtures/worker-process.mjs"], {
    cwd: packageDirectory,
    env: {
      OSFO_AGENT_RUN_CANCELLATION_POLL_INTERVAL_MS: behavior === "lost" ? "1000" : "10",
      OSFO_AGENT_RUN_LEASE_DURATION_MS: "300",
      OSFO_AGENT_RUN_LEASE_RENEWAL_INTERVAL_MS: "100",
      OSFO_AGENT_RUN_WORKER_ID: `${behavior}-process-worker`,
      OSFO_DATABASE_URL: databaseUrl,
      OSFO_FIXTURE_BEHAVIOR: behavior,
      OSFO_FIXTURE_DELIVERY: JSON.stringify(delivery),
    },
    extendEnv: true,
    stdin: "ignore",
    forceKillAfter: "1 second",
  });

const awaitPartialOutput = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = yield* sql<{ readonly fragments: string }>`SELECT count(*)::text AS fragments
      FROM model_call_fragments`;
    if (rows[0]?.fragments === "1") return;
    yield* Effect.sleep(10);
  }
  return yield* Effect.die("Worker did not commit partial output before the acceptance deadline");
});

const awaitTakeoverWindow = (agentRunId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = yield* sql<{ readonly ready: boolean }>`SELECT
        lease_expires_at <= clock_timestamp()
          AND cleanup_deadline_at <= clock_timestamp() AS ready
        FROM agent_runs
        WHERE agent_run_id = ${agentRunId}::uuid`;
      if (rows[0]?.ready === true) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die("Worker claim did not expire before the takeover deadline");
  });

describe("compiled AgentRun worker process loss", () => {
  it("recovers cancellation after the claimed worker is killed mid-output", async () => {
    await run(
      Effect.gen(function* () {
        const receipt = yield* MessageAdmission.use((admission) =>
          admission.accept({
            protocolVersion: 1,
            authenticationToken,
            threadId,
            idempotencyKey: randomUUID(),
            message: { content: "cancel after real worker loss" },
          }),
        );
        yield* OutboxRelay.use((relay) => relay.selectOnce());
        yield* OutboxRelay.use((relay) => relay.publishOnce());
        const delivery = published[0]!;
        const lost = yield* spawnWorker(delivery, "lost");

        yield* Effect.gen(function* () {
          yield* awaitPartialOutput;
          const requested = yield* AgentRunCancellation.use((cancellation) =>
            cancellation.cancel({
              protocolVersion: 1,
              authenticationToken,
              threadId,
              agentRunId: receipt.agentRunId,
            }),
          );
          expect(requested.outcome).toBe("cancellationRequested");
          yield* lost.kill({ killSignal: "SIGKILL" });
          yield* lost.exitCode.pipe(Effect.ignore);
        }).pipe(Effect.ensuring(lost.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)));

        yield* awaitTakeoverWindow(receipt.agentRunId);
        const replacement = yield* spawnWorker(delivery, "replacement");
        const exitCode = yield* replacement.exitCode.pipe(Effect.timeout("5 seconds"));
        expect(exitCode).toBe(0);

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly state: string;
          readonly claimEpoch: string;
          readonly cleanupDisposition: string;
          readonly externalWorkMayContinue: boolean;
          readonly globalReserved: number;
          readonly principalReserved: number;
          readonly reservationState: string;
        }>`SELECT
        run.state,
        run.claim_epoch::text AS "claimEpoch",
        run.cleanup_disposition AS "cleanupDisposition",
        run.external_work_may_continue AS "externalWorkMayContinue",
        global_capacity.reserved_count AS "globalReserved",
        principal_capacity.reserved_count AS "principalReserved",
        reservation.state AS "reservationState"
      FROM agent_runs run
      JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
      CROSS JOIN admission_global_capacity global_capacity
      JOIN admission_principal_capacity principal_capacity
        ON principal_capacity.principal_id = run.principal_id
      WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
        const events = yield* sql<{ readonly eventType: string }>`SELECT
        event_type AS "eventType"
      FROM thread_events
      WHERE agent_run_id = ${receipt.agentRunId}::uuid
      ORDER BY position`;

        expect(rows[0]).toEqual({
          state: "canceled",
          claimEpoch: "2",
          cleanupDisposition: "deadlineExceeded",
          externalWorkMayContinue: true,
          globalReserved: 0,
          principalReserved: 0,
          reservationState: "released",
        });
        expect(events).toEqual([
          { eventType: "UserMessageAppended" },
          { eventType: "AssistantOutputAppended" },
          { eventType: "AgentRunCancellationRequested" },
          { eventType: "AssistantOutputInterrupted" },
          { eventType: "AgentRunCanceled" },
        ]);
      }).pipe(Effect.scoped),
    );
  });
});
