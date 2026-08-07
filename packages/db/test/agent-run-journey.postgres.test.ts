import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunCancellationObserved,
  AgentRunRepository,
  AgentRunFenceRejected,
  AgentRunFenceSchema,
  AgentRunWorker,
  ModelCallExecutor,
  OutboxRelay,
  RunnableDeliveryPublisher,
  RunnableDeliveryPublisherUnavailable,
  makeAgentRunWorkerLayer,
  makeDeterministicModelCallExecutorLayer,
  makeOutboxRelayLayer,
  type ModelCallAttempt,
  type ModelCallAttemptStart,
  type RunnableAgentRunDelivery,
} from "@osfo/agent-run";
import { makeDeterministicAgentRuntimeLayer } from "@osfo/agent-runtime";
import {
  CapacityRejected,
  AgentRunCancellation,
  MessageAdmission,
  ThreadResume,
  type SubmitMessageCommand,
} from "@osfo/api";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeAgentRunCancellationLayer,
  makeAgentRunRepositoryLayer,
  makeMessageAdmissionLayer,
  makeThreadResumeLayer,
} from "../src/index.js";
import { ADMISSION_CAPACITY_LOCK_KEY } from "../src/admission-capacity.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "alice-test-session-token";
const quietPrincipalId = "f3ef0861-2df7-4d2a-a195-fbc5ed75bc82";
const quietThreadId = "7ef239bd-3f04-4c77-8976-1171e75ea0ac";
const quietAuthenticationToken = "quiet-test-session-token";
const published: Array<RunnableAgentRunDelivery> = [];
let publicationAttempts = 0;
let failFirstPublication = true;

const databaseLayer = PgClient.layer({
  applicationName: "osfo-agent-run-journey-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});

const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl, maxConnections: 8 });
const runtimeLayer = makeDeterministicAgentRuntimeLayer({
  executionProfileRef: "oz.deterministic.v1",
  modelBinding: "oz.deterministic.echo.v1",
});
const executorLayer = makeDeterministicModelCallExecutorLayer();
const publisherLayer = Layer.succeed(RunnableDeliveryPublisher)(
  RunnableDeliveryPublisher.of({
    publish: (delivery) =>
      Effect.gen(function* () {
        publicationAttempts += 1;
        published.push(delivery);
        if (failFirstPublication && publicationAttempts === 1) {
          return yield* new RunnableDeliveryPublisherUnavailable({ cause: "confirmation lost" });
        }
        return { providerMessageId: `pubsub-message-${publicationAttempts}` };
      }),
  }),
);

const workerLayer = makeAgentRunWorkerLayer({
  executionProfileRef: "oz.deterministic.v1",
  workerId: "replacement-worker",
  leaseDurationMs: 30_000,
  leaseRenewalIntervalMs: 10_000,
  cancellationPollIntervalMs: 5,
}).pipe(Layer.provide(repositoryLayer), Layer.provide(runtimeLayer), Layer.provide(executorLayer));

const relayLayer = makeOutboxRelayLayer({
  relayId: "relay-a",
  leaseDurationMs: 100,
  publicationWindowSize: 32,
}).pipe(Layer.provide(repositoryLayer), Layer.provide(publisherLayer));

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    databaseLayer,
    repositoryLayer,
    workerLayer,
    relayLayer,
    makeAgentRunCancellationLayer({ databaseUrl, cleanupTimeoutMs: 30_000 }),
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.deterministic.v1",
      globalNonTerminalLimit: 8,
      maxConnections: 8,
      principalNonTerminalLimit: 8,
    }),
    makeThreadResumeLayer({
      databaseUrl,
      cursorSecret: "agent-run-journey-test-cursor-secret",
      maxConnections: 8,
      pollIntervalMs: 5,
      replayEventLimit: 100,
      replayGuaranteedForMs: 30_000,
      snapshotTimelineLimit: 100,
    }),
  ),
);

type TestServices =
  | AgentRunCancellation
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

const expectStartedAttempt = <E, R>(
  effect: Effect.Effect<ModelCallAttemptStart, E, R>,
): Effect.Effect<ModelCallAttempt, E, R> =>
  effect.pipe(
    Effect.flatMap((start) =>
      start.type === "started"
        ? Effect.succeed(start.attempt)
        : Effect.die("Expected a newly started ModelCallAttempt"),
    ),
  );

const seedAuthority = () =>
  run(
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
        admission_rejections,
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
      yield* sql`INSERT INTO relay_dispatch_capacity (singleton, active_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count)
        VALUES (${principalId}::uuid, 0)`;
    }),
  );

beforeEach(async () => {
  published.length = 0;
  publicationAttempts = 0;
  failFirstPublication = true;
  await seedAuthority();
});

afterAll(() => runtime.dispose());

describe("deterministic PostgreSQL AgentRun journey", () => {
  it("cancels pending work once and releases its execution capacity", async () => {
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "cancel before claim" },
        }),
      ),
    );

    const canceled = await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );
    const duplicate = await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );

    expect(canceled).toMatchObject({ outcome: "canceled" });
    expect(duplicate).toMatchObject({ outcome: "alreadyTerminal" });

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly state: string;
          readonly cleanupDisposition: string;
          readonly externalWorkMayContinue: boolean;
          readonly reservationState: string;
          readonly globalReserved: number;
          readonly principalReserved: number;
        }>`SELECT
          run.state,
          run.cleanup_disposition AS "cleanupDisposition",
          run.external_work_may_continue AS "externalWorkMayContinue",
          reservation.state AS "reservationState",
          global_capacity.reserved_count AS "globalReserved",
          principal_capacity.reserved_count AS "principalReserved"
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
        return { row: rows[0], events };
      }),
    );

    expect(authority.row).toEqual({
      state: "canceled",
      cleanupDisposition: "completed",
      externalWorkMayContinue: false,
      reservationState: "released",
      globalReserved: 0,
      principalReserved: 0,
    });
    expect(authority.events).toEqual([
      { eventType: "UserMessageAppended" },
      { eventType: "AgentRunCancellationRequested" },
      { eventType: "AgentRunCanceled" },
    ]);
    const snapshot = await run(
      ThreadResume.use((resume) => resume.snapshot({ authenticationToken, threadId })),
    );
    expect(snapshot.activeState).toEqual([]);
    expect(snapshot.throughPosition).toBe("3");
  });

  it("cancels waiting work and releases nonterminal admission capacity once", async () => {
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "cancel while waiting" },
        }),
      ),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(
              hashtextextended(${ADMISSION_CAPACITY_LOCK_KEY}, 0)
            )`;
            yield* sql`UPDATE agent_runs
              SET state = 'waiting'
              WHERE agent_run_id = ${receipt.agentRunId}::uuid
                AND state = 'pending'`;
          }),
        );
      }),
    );
    expect(await run(MessageAdmission.use((admission) => admission.reconcileCapacity()))).toEqual({
      expectedNonTerminalCount: 1,
      globalReservedBefore: 1,
      globalReservedAfter: 1,
      principalMismatchCountBefore: 0,
      principalMismatchCountAfter: 0,
      reservationMismatchCountBefore: 0,
      reservationMismatchCountAfter: 0,
      repaired: false,
      sweepComplete: true,
    });

    const canceled = await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );
    const duplicate = await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );

    expect(canceled).toMatchObject({ outcome: "canceled" });
    expect(duplicate).toMatchObject({ outcome: "alreadyTerminal" });
    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly state: string;
          readonly reservationState: string;
          readonly globalReserved: number;
          readonly principalReserved: number;
          readonly canceledEvents: string;
          readonly globalRevision: string;
        }>`SELECT
          run.state,
          reservation.state AS "reservationState",
          global_capacity.reserved_count AS "globalReserved",
          global_capacity.revision::text AS "globalRevision",
          principal_capacity.reserved_count AS "principalReserved",
          (SELECT count(*) FROM thread_events event
            WHERE event.agent_run_id = run.agent_run_id
              AND event.event_type = 'AgentRunCanceled')::text AS "canceledEvents"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        CROSS JOIN admission_global_capacity global_capacity
        JOIN admission_principal_capacity principal_capacity
          ON principal_capacity.principal_id = run.principal_id
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
        return rows[0];
      }),
    );
    expect(authority).toEqual({
      state: "canceled",
      reservationState: "released",
      globalReserved: 0,
      globalRevision: "2",
      principalReserved: 0,
      canceledEvents: "1",
    });
  });

  it("samples the pending cancellation deadline at its terminal update", async () => {
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "cross the pending cleanup deadline" },
        }),
      ),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE FUNCTION test_delay_pending_cleanup() RETURNS trigger
          LANGUAGE plpgsql AS $function$
          BEGIN
            UPDATE agent_runs
            SET cleanup_deadline_at = clock_timestamp() + interval '10 milliseconds'
            WHERE agent_run_id = NEW.agent_run_id;
            PERFORM pg_sleep(0.05);
            RETURN NEW;
          END
          $function$`;
        yield* sql`CREATE TRIGGER test_delay_pending_cleanup
          AFTER INSERT ON thread_events
          FOR EACH ROW
          WHEN (NEW.event_type = 'AgentRunCancellationRequested')
          EXECUTE FUNCTION test_delay_pending_cleanup()`;
      }),
    );

    await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER test_delay_pending_cleanup ON thread_events`;
            yield* sql`DROP FUNCTION test_delay_pending_cleanup()`;
          }).pipe(Effect.orDie),
        ),
      ),
    );

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly cleanupDisposition: string;
          readonly payloadDisposition: string;
        }>`SELECT
          run.cleanup_disposition AS "cleanupDisposition",
          event.payload -> 'cleanupDisposition' ->> 'type' AS "payloadDisposition"
        FROM agent_runs run
        JOIN thread_events event USING (agent_run_id)
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid
          AND event.event_type = 'AgentRunCanceled'`;
        return rows[0];
      }),
    );
    expect(authority).toEqual({
      cleanupDisposition: "deadlineExceeded",
      payloadDisposition: "deadlineExceeded",
    });
  });

  it("does not disclose whether a requested AgentRun exists outside owned authority", async () => {
    const unknownRun = await run(
      Effect.flip(
        AgentRunCancellation.use((cancellation) =>
          cancellation.cancel({
            protocolVersion: 1,
            authenticationToken,
            threadId,
            agentRunId: randomUUID(),
          }),
        ),
      ),
    );
    const unknownThread = await run(
      Effect.flip(
        AgentRunCancellation.use((cancellation) =>
          cancellation.cancel({
            protocolVersion: 1,
            authenticationToken,
            threadId: randomUUID(),
            agentRunId: randomUUID(),
          }),
        ),
      ),
    );

    expect(unknownRun._tag).toBe("ThreadNotFound");
    expect(unknownThread._tag).toBe("ThreadNotFound");
  });

  it("serializes concurrent admission and cancellation without a lock-order deadlock", async () => {
    const canceling = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "cancel concurrently" },
        }),
      ),
    );

    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE FUNCTION test_delay_capacity_release() RETURNS trigger
          LANGUAGE plpgsql AS 'BEGIN PERFORM pg_advisory_xact_lock(620062); RETURN NEW; END'`;
        yield* sql`CREATE TRIGGER test_delay_capacity_release
          BEFORE UPDATE ON agent_run_capacity_reservations
          FOR EACH ROW EXECUTE FUNCTION test_delay_capacity_release()`;

        return yield* Effect.gen(function* () {
          const fibers = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT pg_advisory_xact_lock(620062)`;
              const cancellation = yield* Effect.forkChild(
                AgentRunCancellation.use((service) =>
                  service.cancel({
                    protocolVersion: 1,
                    authenticationToken,
                    threadId,
                    agentRunId: canceling.agentRunId,
                  }),
                ),
              );
              for (let attempt = 0; attempt < 200; attempt += 1) {
                const waiting = yield* sql<{ readonly observed: boolean }>`SELECT EXISTS (
                  SELECT 1 FROM pg_locks
                  WHERE locktype = 'advisory' AND granted = false
                ) AS observed`;
                if (waiting[0]?.observed === true) break;
                if (attempt === 199) {
                  return yield* Effect.die("Cancellation did not reach the capacity barrier");
                }
                yield* Effect.sleep(10);
              }
              const admission = yield* Effect.forkChild(
                MessageAdmission.use((service) =>
                  service.accept({
                    protocolVersion: 1,
                    authenticationToken,
                    threadId,
                    idempotencyKey: randomUUID(),
                    message: { content: "admit concurrently" },
                  }),
                ),
              );
              for (let attempt = 0; attempt < 200; attempt += 1) {
                const waiting = yield* sql<{ readonly observed: boolean }>`SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE application_name = 'osfo-api'
                    AND wait_event = 'advisory'
                ) AS observed`;
                if (waiting[0]?.observed === true) break;
                if (attempt === 199) {
                  return yield* Effect.die("Admission did not contend on cancellation locks");
                }
                yield* Effect.sleep(10);
              }
              return { admission, cancellation };
            }),
          );
          const canceled = yield* Fiber.join(fibers.cancellation);
          const accepted = yield* Fiber.join(fibers.admission);
          return { accepted, canceled };
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* sql`DROP TRIGGER test_delay_capacity_release
                ON agent_run_capacity_reservations`;
              yield* sql`DROP FUNCTION test_delay_capacity_release()`;
            }).pipe(Effect.orDie),
          ),
        );
      }),
    );

    expect(result.canceled.outcome).toBe("canceled");
    expect(result.accepted.agentRunId).not.toBe(canceling.agentRunId);
    const capacity = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly globalReserved: number;
          readonly principalReserved: number;
        }>`SELECT
          global_capacity.reserved_count AS "globalReserved",
          principal_capacity.reserved_count AS "principalReserved"
        FROM admission_global_capacity global_capacity
        JOIN admission_principal_capacity principal_capacity
          ON principal_capacity.principal_id = ${principalId}::uuid
        WHERE global_capacity.singleton = true`;
        return rows[0];
      }),
    );
    expect(capacity).toEqual({ globalReserved: 1, principalReserved: 1 });
  });

  it("lets cancellation win an active output race and closes ordinary completion", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "cancel active output" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    const claimed = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, {
          workerId: "active-cancel-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    ).then((claim) => Effect.runPromise(Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim)));
    const attempt = await run(
      AgentRunRepository.use((repository) =>
        Effect.gen(function* () {
          const modelCall = yield* repository.ensureModelCall(claimed.fence, {
            type: "startModelCall",
            modelBinding: "oz.deterministic.echo.v1",
            prompt: "cancel active output",
          });
          const started = yield* expectStartedAttempt(
            repository.beginModelCallAttempt(claimed.fence, modelCall),
          );
          yield* repository.appendModelOutput(claimed.fence, started, {
            fragmentIndex: 0,
            text: "Partial",
          });
          return started;
        }),
      ),
    );
    await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );

    const ordinaryWrite = await run(
      Effect.flip(
        AgentRunRepository.use((repository) =>
          repository.appendModelOutput(claimed.fence, attempt, {
            fragmentIndex: 1,
            text: "must not commit",
          }),
        ),
      ),
    );
    const ordinaryTerminal = await run(
      Effect.flip(
        AgentRunRepository.use((repository) =>
          repository.commitTerminal(claimed.fence, { type: "succeed" }),
        ),
      ),
    );
    expect(ordinaryWrite).toBeInstanceOf(AgentRunCancellationObserved);
    expect(ordinaryTerminal).toBeInstanceOf(AgentRunCancellationObserved);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE FUNCTION test_delay_output_cleanup() RETURNS trigger
          LANGUAGE plpgsql AS 'BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END'`;
        yield* sql`CREATE TRIGGER test_delay_output_cleanup
          BEFORE UPDATE ON assistant_outputs
          FOR EACH ROW EXECUTE FUNCTION test_delay_output_cleanup()`;
        yield* sql`UPDATE agent_runs
          SET cleanup_deadline_at = clock_timestamp() + interval '10 milliseconds'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );
    await run(
      AgentRunRepository.use((repository) =>
        repository.recordModelCallCleanup(claimed.fence, attempt, {
          cleanupDisposition: { type: "completed" },
          externalWorkMayContinue: false,
        }),
      ),
    );

    const disposition = await run(
      AgentRunRepository.use((repository) =>
        repository.commitCancellation(claimed.fence, {
          cleanupDisposition: { type: "completed" },
          externalWorkMayContinue: false,
        }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER test_delay_output_cleanup ON assistant_outputs`;
            yield* sql`DROP FUNCTION test_delay_output_cleanup()`;
          }).pipe(Effect.orDie),
        ),
      ),
    );
    expect(disposition).toEqual({
      cleanupDisposition: { type: "deadlineExceeded" },
      externalWorkMayContinue: true,
    });
    const duplicate = await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );
    expect(duplicate).toMatchObject({ outcome: "alreadyTerminal" });
    expect(await run(AgentRunWorker.use((worker) => worker.handle(delivery)))).toEqual({
      type: "acknowledge",
      outcome: "alreadyTerminal",
    });

    const snapshot = await run(
      ThreadResume.use((resume) => resume.snapshot({ authenticationToken, threadId })),
    );
    expect(snapshot.timeline.at(-1)).toMatchObject({
      type: "assistantOutput",
      content: [{ type: "text", text: "Partial" }],
      status: { type: "interrupted", cause: "agentRunCanceled" },
    });
    expect(snapshot.activeState).toEqual([]);
    expect(snapshot.throughPosition).toBe("5");
  });

  it("derives AgentRun cancellation truth from durable attempt cleanup", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "durable cleanup truth" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    const claimed = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, {
          workerId: "durable-cleanup-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    ).then((claim) => Effect.runPromise(Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim)));
    const attempt = await run(
      AgentRunRepository.use((repository) =>
        Effect.gen(function* () {
          const modelCall = yield* repository.ensureModelCall(claimed.fence, {
            type: "startModelCall",
            modelBinding: "oz.deterministic.echo.v1",
            prompt: "durable cleanup truth",
          });
          return yield* expectStartedAttempt(
            repository.beginModelCallAttempt(claimed.fence, modelCall),
          );
        }),
      ),
    );
    await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );
    await run(
      AgentRunRepository.use((repository) =>
        repository.recordModelCallCleanup(claimed.fence, attempt, {
          cleanupDisposition: { type: "deadlineExceeded" },
          externalWorkMayContinue: true,
        }),
      ),
    );

    const disposition = await run(
      AgentRunRepository.use((repository) =>
        repository.commitCancellation(claimed.fence, {
          cleanupDisposition: { type: "completed" },
          externalWorkMayContinue: false,
        }),
      ),
    );
    expect(disposition).toEqual({
      cleanupDisposition: { type: "deadlineExceeded" },
      externalWorkMayContinue: true,
    });
    const event = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly payload: unknown }>`SELECT payload
          FROM thread_events
          WHERE agent_run_id = ${receipt.agentRunId}::uuid
            AND event_type = 'AgentRunCanceled'`;
        return rows[0];
      }),
    );
    expect(event).toEqual({
      payload: {
        agentRunId: receipt.agentRunId,
        cleanupDisposition: { type: "deadlineExceeded" },
        externalWorkMayContinue: true,
      },
    });
  });

  it("rejects malformed non-null publication evidence", async () => {
    const accepted = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "invalid publication evidence" },
        }),
      ),
    );

    await expect(
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE outbox_obligations
            SET publication_evidence = ${JSON.stringify({ type: "unknown" })}::jsonb,
                published_at = now()
            WHERE agent_run_id = ${accepted.agentRunId}::uuid`;
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("rejects cleanup evidence from a different fenced AgentRun", async () => {
    failFirstPublication = false;
    const otherThreadId = randomUUID();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO threads (thread_id, principal_id)
          VALUES (${otherThreadId}::uuid, ${principalId}::uuid)`;
      }),
    );
    const accept = (targetThreadId: string, content: string) =>
      run(
        MessageAdmission.use((admission) =>
          admission.accept({
            protocolVersion: 1,
            authenticationToken,
            threadId: targetThreadId,
            idempotencyKey: randomUUID(),
            message: { content },
          }),
        ),
      );
    const first = await accept(threadId, "first fenced cleanup");
    const second = await accept(otherThreadId, "second fenced cleanup");
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const firstDelivery = published.find((delivery) => delivery.agentRunId === first.agentRunId)!;
    const secondDelivery = published.find((delivery) => delivery.agentRunId === second.agentRunId)!;
    const firstClaim = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(firstDelivery, {
          workerId: "first-cleanup-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    ).then((claim) => Effect.runPromise(Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim)));
    const secondAttempt = await run(
      AgentRunRepository.use((repository) =>
        Effect.gen(function* () {
          const secondClaimResult = yield* repository.claimAgentRun(secondDelivery, {
            workerId: "second-cleanup-worker",
            leaseDurationMs: 30_000,
          });
          const secondClaim =
            yield* Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(secondClaimResult);
          const modelCall = yield* repository.ensureModelCall(secondClaim.fence, {
            type: "startModelCall",
            modelBinding: "oz.deterministic.echo.v1",
            prompt: "second fenced cleanup",
          });
          return yield* expectStartedAttempt(
            repository.beginModelCallAttempt(secondClaim.fence, modelCall),
          );
        }),
      ),
    );

    const mismatch = await run(
      Effect.flip(
        AgentRunRepository.use((repository) =>
          repository.recordModelCallCleanup(firstClaim.fence, secondAttempt, {
            cleanupDisposition: { type: "completed" },
            externalWorkMayContinue: false,
          }),
        ),
      ),
    );
    expect(mismatch).toBeInstanceOf(AgentRunFenceRejected);
    const cleanup = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly cleanupDisposition: string | null;
          readonly externalWorkMayContinue: boolean | null;
        }>`SELECT
            cleanup_disposition AS "cleanupDisposition",
            external_work_may_continue AS "externalWorkMayContinue"
          FROM model_call_attempts
          WHERE model_call_attempt_id = ${secondAttempt.modelCallAttemptId}::uuid`;
        return rows[0];
      }),
    );
    expect(cleanup).toEqual({
      cleanupDisposition: null,
      externalWorkMayContinue: null,
    });
  });

  it("publishes same-Thread work in authoritative ThreadPosition order", async () => {
    failFirstPublication = false;
    const accept = (content: string) =>
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
    const first = await accept("first");
    const second = await accept("second");
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE outbox_obligations
          SET created_at = CASE agent_run_id
            WHEN ${first.agentRunId}::uuid THEN now() + interval '1 hour'
            WHEN ${second.agentRunId}::uuid THEN now() - interval '1 hour'
          END
          WHERE agent_run_id IN (${first.agentRunId}::uuid, ${second.agentRunId}::uuid)`;
      }),
    );

    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));

    expect(published.map((delivery) => delivery.agentRunId)).toEqual([first.agentRunId]);
  });

  it("sustains bounded PostgreSQL overload, drains accepted work, and recovers", async () => {
    failFirstPublication = false;
    const baselineHeapBytes = process.memoryUsage().heapUsed;
    const maxima = {
      connectionsPerPool: 0,
      globalReserved: 0,
      heapGrowthBytes: 0,
      heldReservations: 0,
      nonTerminalRuns: 0,
      oldestWorkAgeMs: 0,
      principalReserved: 0,
      workerRetryVolume: 0,
      totalConnections: 0,
    };
    const sample = () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            readonly connectionsPerPool: number;
            readonly globalReserved: number;
            readonly heldReservations: number;
            readonly nonTerminalRuns: number;
            readonly oldestWorkAgeMs: number;
            readonly principalReserved: number;
            readonly totalConnections: number;
          }>`SELECT
            (SELECT count(*)::int FROM agent_runs
              WHERE state NOT IN ('succeeded', 'failed', 'canceled')) AS "nonTerminalRuns",
            (SELECT count(*)::int FROM agent_run_capacity_reservations
              WHERE state = 'held') AS "heldReservations",
            (SELECT reserved_count FROM admission_global_capacity
              WHERE singleton = true) AS "globalReserved",
            (SELECT coalesce(max(reserved_count), 0)::int
              FROM admission_principal_capacity) AS "principalReserved",
            (SELECT coalesce(extract(epoch FROM (
                clock_timestamp() - min(created_at)
              )) * 1000, 0)::float8
              FROM agent_runs
              WHERE state NOT IN ('succeeded', 'failed', 'canceled')) AS "oldestWorkAgeMs",
            (SELECT coalesce(max(connection_count), 0)::int FROM (
              SELECT application_name, count(*)::int AS connection_count
              FROM pg_stat_activity
              WHERE datname = current_database()
                AND application_name LIKE 'osfo-%'
              GROUP BY application_name
            ) pools) AS "connectionsPerPool",
            (SELECT count(*)::int FROM pg_stat_activity
              WHERE datname = current_database()
                AND application_name LIKE 'osfo-%') AS "totalConnections"`;
          return row!;
        }),
      );
    const recordSample = async () => {
      const observed = await sample();
      maxima.connectionsPerPool = Math.max(maxima.connectionsPerPool, observed.connectionsPerPool);
      maxima.globalReserved = Math.max(maxima.globalReserved, observed.globalReserved);
      maxima.heldReservations = Math.max(maxima.heldReservations, observed.heldReservations);
      maxima.nonTerminalRuns = Math.max(maxima.nonTerminalRuns, observed.nonTerminalRuns);
      maxima.oldestWorkAgeMs = Math.max(maxima.oldestWorkAgeMs, observed.oldestWorkAgeMs);
      maxima.principalReserved = Math.max(maxima.principalReserved, observed.principalReserved);
      maxima.totalConnections = Math.max(maxima.totalConnections, observed.totalConnections);
      maxima.heapGrowthBytes = Math.max(
        maxima.heapGrowthBytes,
        process.memoryUsage().heapUsed - baselineHeapBytes,
      );
    };

    let acceptedCount = 0;
    let rejectedCount = 0;
    const offerBurst = (round: number, lane: string) =>
      Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          run(
            Effect.exit(
              MessageAdmission.use((admission) =>
                admission.accept({
                  protocolVersion: 1,
                  authenticationToken,
                  threadId,
                  idempotencyKey: randomUUID(),
                  message: { content: `pressure ${round}:${lane}:${index}` },
                }),
              ),
            ),
          ),
        ),
      );
    const recordOutcomes = (outcomes: ReadonlyArray<Exit.Exit<unknown, unknown>>) => {
      const accepted = outcomes.filter(Exit.isSuccess).length;
      const rejected = outcomes.filter(Exit.isFailure);
      acceptedCount += accepted;
      rejectedCount += rejected.length;
      for (const outcome of rejected) {
        const error = Option.getOrThrow(Cause.findErrorOption(outcome.cause));
        expect(error).toEqual(new CapacityRejected({ scope: "global" }));
      }
      return accepted;
    };
    const drainAccepted = async (count: number) => {
      for (let accepted = 0; accepted < count; accepted += 1) {
        await run(OutboxRelay.use((relay) => relay.selectOnce()));
        await run(OutboxRelay.use((relay) => relay.publishOnce()));
        const delivery = published.at(-1)!;
        const result = await run(AgentRunWorker.use((worker) => worker.handle(delivery)));
        if (result.type === "retry") maxima.workerRetryVolume += 1;
        expect(result).toEqual({ type: "acknowledge", outcome: "succeeded" });
      }
    };
    const samplingFiber = Effect.runFork(
      Effect.forever(Effect.promise(recordSample).pipe(Effect.andThen(Effect.sleep(5)))),
    );
    for (let round = 0; round < 8; round += 1) {
      const initialAccepted = recordOutcomes(await offerBurst(round, "initial"));
      expect(initialAccepted).toBe(8);
      const [, duringDrain] = await Promise.all([
        drainAccepted(initialAccepted),
        offerBurst(round, "during-drain"),
      ]);
      await drainAccepted(recordOutcomes(duringDrain));
    }
    await Effect.runPromise(Fiber.interrupt(samplingFiber));
    await recordSample();

    await Effect.runPromise(Effect.logInfo("bounded overload maxima", maxima));
    expect(acceptedCount + rejectedCount).toBe(256);
    expect(acceptedCount).toBeGreaterThanOrEqual(64);
    expect(rejectedCount).toBeGreaterThan(0);
    expect(maxima.nonTerminalRuns).toBeLessThanOrEqual(8);
    expect(maxima.heldReservations).toBeLessThanOrEqual(8);
    expect(maxima.globalReserved).toBeLessThanOrEqual(8);
    expect(maxima.principalReserved).toBeLessThanOrEqual(8);
    expect(maxima.connectionsPerPool).toBeLessThanOrEqual(8);
    expect(maxima.totalConnections).toBeLessThanOrEqual(32);
    expect(maxima.heapGrowthBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(maxima.oldestWorkAgeMs).toBeLessThanOrEqual(30_000);
    expect(maxima.workerRetryVolume).toBe(0);
    expect(await sample()).toMatchObject({
      globalReserved: 0,
      heldReservations: 0,
      nonTerminalRuns: 0,
      oldestWorkAgeMs: 0,
      principalReserved: 0,
    });
  });

  it("selects one eligible Thread head from each lowest-pass Principal", async () => {
    failFirstPublication = false;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO principals (principal_id) VALUES (${quietPrincipalId}::uuid)`;
        yield* sql`INSERT INTO authentication_sessions
          (session_id, principal_id, token_sha256, expires_at)
          VALUES (
            ${randomUUID()}::uuid,
            ${quietPrincipalId}::uuid,
            ${createHash("sha256").update(quietAuthenticationToken).digest("hex")},
            now() + interval '1 hour'
          )`;
        yield* sql`INSERT INTO threads (thread_id, principal_id)
          VALUES (${quietThreadId}::uuid, ${quietPrincipalId}::uuid)`;
        yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count)
          VALUES (${quietPrincipalId}::uuid, 0)`;
      }),
    );

    const accept = (token: string, targetThreadId: string, content: string) =>
      run(
        MessageAdmission.use((admission) =>
          admission.accept({
            protocolVersion: 1,
            authenticationToken: token,
            threadId: targetThreadId,
            idempotencyKey: randomUUID(),
            message: { content },
          }),
        ),
      );
    const noisyFirst = await accept(authenticationToken, threadId, "noisy first");
    await accept(authenticationToken, threadId, "noisy second");
    const quiet = await accept(quietAuthenticationToken, quietThreadId, "quiet first");

    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));

    expect(new Set(published.map((delivery) => delivery.agentRunId))).toEqual(
      new Set([noisyFirst.agentRunId, quiet.agentRunId]),
    );
  });

  it("recovers a claim-boundary process loss before external work starts", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "crash after claim" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, {
          workerId: "claim-cut-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs
          SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );

    expect(await run(AgentRunWorker.use((worker) => worker.handle(delivery)))).toEqual({
      type: "acknowledge",
      outcome: "succeeded",
    });
    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly attempts: string;
          readonly claimEpoch: string;
          readonly globalReserved: number;
          readonly outputs: string;
          readonly principalReserved: number;
          readonly reservationState: string;
          readonly startedAttempts: string;
          readonly state: string;
          readonly terminalEvents: string;
        }>`SELECT
          run.state,
          run.claim_epoch::text AS "claimEpoch",
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = run.agent_run_id)::text AS attempts,
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = run.agent_run_id AND state = 'started')::text
            AS "startedAttempts",
          (SELECT count(*) FROM assistant_outputs
            WHERE agent_run_id = run.agent_run_id)::text AS outputs,
          (SELECT count(*) FROM thread_events
            WHERE agent_run_id = run.agent_run_id
              AND event_type IN ('AgentRunSucceeded', 'AgentRunFailed', 'AgentRunCanceled'))::text
            AS "terminalEvents",
          (SELECT reserved_count FROM admission_global_capacity WHERE singleton = true)
            AS "globalReserved",
          (SELECT reserved_count FROM admission_principal_capacity
            WHERE principal_id = run.principal_id) AS "principalReserved",
          reservation.state AS "reservationState"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
        return rows[0];
      }),
    );
    expect(authority).toEqual({
      state: "succeeded",
      claimEpoch: "2",
      attempts: "1",
      globalReserved: 0,
      outputs: "1",
      principalReserved: 0,
      reservationState: "released",
      startedAttempts: "0",
      terminalEvents: "1",
    });
  });

  it("renews a healthy long-running claim before its original lease expires", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "slow healthy execution" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    const executionStarted = Effect.runSync(Deferred.make<void>());
    const releaseExecution = Effect.runSync(Deferred.make<void>());
    const postOriginalDeadlineRenewed = Effect.runSync(Deferred.make<void>());
    let originalDeadlinePassed = false;
    const slowExecutor = Layer.succeed(ModelCallExecutor)(
      ModelCallExecutor.of({
        execute: () =>
          Effect.succeed(
            Stream.fromEffect(
              Deferred.succeed(executionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseExecution)),
              ),
            ).pipe(Stream.map(() => ({ fragmentIndex: 0, text: "slow but healthy" }))),
          ),
        cancel: () => Effect.succeed({ type: "confirmedStopped" }),
        terminate: () => Effect.void,
      }),
    );
    const observingRepositoryLayer = Layer.effect(
      AgentRunRepository,
      AgentRunRepository.use((repository) =>
        Effect.succeed(
          AgentRunRepository.of({
            ...repository,
            renewLease: (fence, leaseDurationMs) =>
              repository
                .renewLease(fence, leaseDurationMs)
                .pipe(
                  Effect.tap(() =>
                    originalDeadlinePassed
                      ? Deferred.succeed(postOriginalDeadlineRenewed, undefined)
                      : Effect.void,
                  ),
                ),
          }),
        ),
      ),
    ).pipe(Layer.provide(repositoryLayer));
    const slowWorker = makeAgentRunWorkerLayer({
      executionProfileRef: "oz.deterministic.v1",
      workerId: "slow-worker",
      leaseDurationMs: 300,
      leaseRenewalIntervalMs: 50,
      cancellationPollIntervalMs: 5,
    }).pipe(
      Layer.provide(observingRepositoryLayer),
      Layer.provide(runtimeLayer),
      Layer.provide(slowExecutor),
    );
    const slowRuntime = ManagedRuntime.make(
      Layer.mergeAll(databaseLayer, repositoryLayer, slowWorker),
    );

    try {
      const result = await slowRuntime.runPromise(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            AgentRunWorker.use((worker) => worker.handle(delivery)),
          );
          yield* Deferred.await(executionStarted);
          const sql = yield* SqlClient.SqlClient;
          const originalRows = yield* sql<{ readonly leaseExpiresAtEpochMs: number }>`SELECT
            extract(epoch FROM lease_expires_at) * 1000 AS "leaseExpiresAtEpochMs"
          FROM agent_runs
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
          const originalLeaseExpiresAt = originalRows[0]!.leaseExpiresAtEpochMs;
          let observedOriginalDeadline = false;
          for (let poll = 0; poll < 100; poll += 1) {
            const rows = yield* sql<{ readonly passed: boolean }>`SELECT
              extract(epoch FROM clock_timestamp()) * 1000
                > ${originalLeaseExpiresAt}::float8 AS passed`;
            if (rows[0]?.passed === true) {
              observedOriginalDeadline = true;
              break;
            }
            yield* Effect.sleep(10);
          }
          if (!observedOriginalDeadline) {
            return yield* Effect.die("Original AgentRun lease did not pass within test safety");
          }
          originalDeadlinePassed = true;
          yield* Deferred.await(postOriginalDeadlineRenewed).pipe(Effect.timeout("2 seconds"));
          const competingClaim = yield* AgentRunRepository.use((repository) =>
            repository.claimAgentRun(delivery, {
              workerId: "competing-worker",
              leaseDurationMs: 300,
            }),
          );
          yield* Deferred.succeed(releaseExecution, undefined);
          const completed = yield* Fiber.join(running);
          return { competingClaim, completed };
        }),
      );

      expect(result.competingClaim).toEqual({ type: "busy" });
      expect(result.completed).toEqual({ type: "acknowledge", outcome: "succeeded" });
    } finally {
      await slowRuntime.dispose();
    }

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly state: string; readonly claimEpoch: string }>`SELECT
          state,
          claim_epoch::text AS "claimEpoch"
        FROM agent_runs
        WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
        return rows[0];
      }),
    );
    expect(authority).toEqual({ state: "succeeded", claimEpoch: "1" });
  });

  it.each([
    { cut: "intent", expectedAttempts: "1", expectedOutputs: "1", expectedInterrupted: "0" },
    { cut: "attempt", expectedAttempts: "2", expectedOutputs: "2", expectedInterrupted: "1" },
    {
      cut: "completedOutput",
      expectedAttempts: "1",
      expectedOutputs: "1",
      expectedInterrupted: "0",
    },
  ] as const)(
    "recovers the $cut crash cut without duplicate authority or leaked capacity",
    async ({ cut, expectedAttempts, expectedOutputs, expectedInterrupted }) => {
      failFirstPublication = false;
      const receipt = await run(
        MessageAdmission.use((admission) =>
          admission.accept({
            protocolVersion: 1,
            authenticationToken,
            threadId,
            idempotencyKey: randomUUID(),
            message: { content: `crash after ${cut}` },
          }),
        ),
      );
      await run(OutboxRelay.use((relay) => relay.selectOnce()));
      await run(OutboxRelay.use((relay) => relay.publishOnce()));
      const delivery = published[0]!;
      const abandoned = await run(
        AgentRunRepository.use((repository) =>
          repository.claimAgentRun(delivery, {
            workerId: `${cut}-cut-worker`,
            leaseDurationMs: 30_000,
          }),
        ),
      ).then((claim) =>
        Effect.runPromise(Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim)),
      );

      await run(
        AgentRunRepository.use((repository) =>
          Effect.gen(function* () {
            const modelCall = yield* repository.ensureModelCall(abandoned.fence, {
              type: "startModelCall",
              modelBinding: "oz.deterministic.echo.v1",
              prompt: `crash after ${cut}`,
            });
            if (cut === "intent") return;
            const attempt = yield* expectStartedAttempt(
              repository.beginModelCallAttempt(abandoned.fence, modelCall),
            );
            if (cut === "completedOutput") {
              yield* repository.completeModelCall(abandoned.fence, attempt);
            }
          }),
        ),
      );
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE agent_runs
            SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
            WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
        }),
      );

      expect(await run(AgentRunWorker.use((worker) => worker.handle(delivery)))).toEqual({
        type: "acknowledge",
        outcome: "succeeded",
      });

      const authority = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly state: string;
            readonly claimEpoch: string;
            readonly attempts: string;
            readonly outputs: string;
            readonly interruptedOutputs: string;
            readonly startedAttempts: string;
            readonly terminalEvents: string;
            readonly reservationState: string;
            readonly globalReserved: number;
            readonly principalReserved: number;
          }>`SELECT
            run.state,
            run.claim_epoch::text AS "claimEpoch",
            (SELECT count(*) FROM model_call_attempts
              WHERE agent_run_id = run.agent_run_id)::text AS attempts,
            (SELECT count(*) FROM assistant_outputs
              WHERE agent_run_id = run.agent_run_id)::text AS outputs,
            (SELECT count(*) FROM assistant_outputs
              WHERE agent_run_id = run.agent_run_id
                AND state = 'interrupted')::text AS "interruptedOutputs",
            (SELECT count(*) FROM model_call_attempts
              WHERE agent_run_id = run.agent_run_id
                AND state = 'started')::text AS "startedAttempts",
            (SELECT count(*) FROM thread_events
              WHERE agent_run_id = run.agent_run_id
                AND event_type IN ('AgentRunSucceeded', 'AgentRunFailed'))::text
              AS "terminalEvents",
            reservation.state AS "reservationState",
            global_capacity.reserved_count AS "globalReserved",
            principal_capacity.reserved_count AS "principalReserved"
          FROM agent_runs run
          JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
          CROSS JOIN admission_global_capacity global_capacity
          JOIN admission_principal_capacity principal_capacity
            ON principal_capacity.principal_id = run.principal_id
          WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
          return rows[0];
        }),
      );

      expect(authority).toEqual({
        state: "succeeded",
        claimEpoch: "2",
        attempts: expectedAttempts,
        outputs: expectedOutputs,
        interruptedOutputs: expectedInterrupted,
        startedAttempts: "0",
        terminalEvents: "1",
        reservationState: "released",
        globalReserved: 0,
        principalReserved: 0,
      });
    },
  );

  it("fails takeover without duplicating external work when cleanup remains uncertain", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "uncertain cleanup takeover" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    const abandoned = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, {
          workerId: "uncertain-cleanup-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    ).then((claim) => Effect.runPromise(Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim)));

    await run(
      AgentRunRepository.use((repository) =>
        Effect.gen(function* () {
          const modelCall = yield* repository.ensureModelCall(abandoned.fence, {
            type: "startModelCall",
            modelBinding: "oz.deterministic.echo.v1",
            prompt: "uncertain cleanup takeover",
          });
          const attempt = yield* expectStartedAttempt(
            repository.beginModelCallAttempt(abandoned.fence, modelCall),
          );
          yield* repository.appendModelOutput(abandoned.fence, attempt, {
            fragmentIndex: 0,
            text: "Possibly still running",
          });
          yield* repository.recordModelCallCleanup(abandoned.fence, attempt, {
            cleanupDisposition: { type: "deadlineExceeded" },
            externalWorkMayContinue: true,
          });
        }),
      ),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs
          SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );

    expect(await run(AgentRunWorker.use((worker) => worker.handle(delivery)))).toEqual({
      type: "acknowledge",
      outcome: "failed",
    });

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly attempts: string;
          readonly cleanupDisposition: string;
          readonly externalWorkMayContinue: boolean;
          readonly globalReserved: number;
          readonly principalReserved: number;
          readonly reservationState: string;
          readonly runState: string;
          readonly startedAttempts: string;
        }>`SELECT
          run.state AS "runState",
          reservation.state AS "reservationState",
          global_capacity.reserved_count AS "globalReserved",
          principal_capacity.reserved_count AS "principalReserved",
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = run.agent_run_id)::text AS attempts,
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = run.agent_run_id AND state = 'started')::text
            AS "startedAttempts",
          attempt.cleanup_disposition AS "cleanupDisposition",
          attempt.external_work_may_continue AS "externalWorkMayContinue"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        CROSS JOIN admission_global_capacity global_capacity
        JOIN admission_principal_capacity principal_capacity
          ON principal_capacity.principal_id = run.principal_id
        JOIN model_call_attempts attempt USING (agent_run_id)
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
        const events = yield* sql<{ readonly eventType: string }>`SELECT
          event_type AS "eventType"
        FROM thread_events
        WHERE agent_run_id = ${receipt.agentRunId}::uuid
        ORDER BY position`;
        return { row: rows[0], events };
      }),
    );

    expect(authority.row).toEqual({
      runState: "failed",
      reservationState: "released",
      globalReserved: 0,
      principalReserved: 0,
      attempts: "1",
      startedAttempts: "0",
      cleanupDisposition: "deadlineExceeded",
      externalWorkMayContinue: true,
    });
    expect(authority.events).toEqual([
      { eventType: "UserMessageAppended" },
      { eventType: "AssistantOutputAppended" },
      { eventType: "AssistantOutputInterrupted" },
      { eventType: "AgentRunFailed" },
    ]);
  });

  it("recovers relay, output, and terminal-ack crash cuts without duplicate authority", async () => {
    const command = {
      protocolVersion: 1,
      authenticationToken,
      threadId,
      idempotencyKey: randomUUID(),
      message: { content: "Hello, Oz" },
    } satisfies SubmitMessageCommand;
    const receipt = await run(MessageAdmission.use((admission) => admission.accept(command)));

    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    const lostConfirmation = await run(
      Effect.exit(OutboxRelay.use((relay) => relay.publishOnce())),
    );
    expect(Exit.isFailure(lostConfirmation)).toBe(true);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE relay_publication_tasks
          SET publication_lease_expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE outbox_id = (
            SELECT outbox_id FROM outbox_obligations
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
          )`;
      }),
    );

    const relayed = await run(OutboxRelay.use((relay) => relay.publishOnce()));
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
          const attempt = yield* expectStartedAttempt(
            repository.beginModelCallAttempt(abandoned.fence, modelCall),
          );
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
    const wrongDurableTuple = await run(
      AgentRunWorker.use((worker) => worker.handle({ ...delivery, deliveryId: randomUUID() })),
    );
    expect(wrongDurableTuple).toEqual({ type: "retry" });

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
          readonly assistantOutputs: string;
          readonly modelCallFragments: string;
          readonly publicationEvidence: unknown;
          readonly relayActiveCount: number;
          readonly activePublicationTasks: string;
          readonly publicationAttemptStates: ReadonlyArray<string>;
          readonly startedAttempts: string;
          readonly usageTypes: ReadonlyArray<string>;
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
          (SELECT count(*) FROM assistant_outputs
            WHERE agent_run_id = ${receipt.agentRunId}::uuid)::text AS "assistantOutputs",
          (SELECT count(*) FROM model_call_fragments
            WHERE agent_run_id = ${receipt.agentRunId}::uuid)::text AS "modelCallFragments",
          (SELECT publication_evidence FROM outbox_obligations
            WHERE agent_run_id = ${receipt.agentRunId}::uuid) AS "publicationEvidence",
          (SELECT active_count FROM relay_dispatch_capacity
            WHERE singleton = true) AS "relayActiveCount",
          (SELECT count(*) FROM relay_publication_tasks)::text AS "activePublicationTasks",
          ARRAY(SELECT state FROM relay_publication_attempts
            WHERE outbox_id = (
              SELECT outbox_id FROM outbox_obligations
              WHERE agent_run_id = ${receipt.agentRunId}::uuid
            )
            ORDER BY publication_epoch) AS "publicationAttemptStates",
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
              AND state = 'started')::text AS "startedAttempts",
          ARRAY(SELECT usage_type FROM model_call_attempts
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
            ORDER BY attempt_number) AS "usageTypes"
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
      assistantOutputs: "2",
      modelCallFragments: "3",
      publicationEvidence: { type: "pubsub", providerMessageId: "pubsub-message-2" },
      relayActiveCount: 0,
      activePublicationTasks: "0",
      publicationAttemptStates: ["expired", "confirmed"],
      startedAttempts: "0",
      usageTypes: ["unknown", "unknown"],
    });
    expect(authority.events).toEqual([
      { eventType: "UserMessageAppended", position: "1" },
      { eventType: "AssistantOutputAppended", position: "2" },
      { eventType: "AssistantOutputInterrupted", position: "3" },
      { eventType: "AssistantOutputAppended", position: "4" },
      { eventType: "AssistantOutputAppended", position: "5" },
      { eventType: "AssistantOutputCompleted", position: "6" },
      { eventType: "AgentRunSucceeded", position: "7" },
    ]);

    const snapshot = await run(
      ThreadResume.use((resume) => resume.snapshot({ authenticationToken, threadId })),
    );
    expect(snapshot.timeline).toEqual([
      expect.objectContaining({ type: "userMessage", agentRunId: receipt.agentRunId }),
      expect.objectContaining({
        type: "assistantOutput",
        agentRunId: receipt.agentRunId,
        content: [{ type: "text", text: "Echo: " }],
        status: { type: "interrupted", cause: "modelCallFailed" },
      }),
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
    expect(snapshot.throughPosition).toBe("7");
  });

  it("rolls back terminal authority when capacity cannot release exactly once", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "recover capacity release" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE admission_principal_capacity
          SET reserved_count = 0
          WHERE principal_id = ${principalId}::uuid`;
      }),
    );

    const inconsistentRelease = await run(AgentRunWorker.use((worker) => worker.handle(delivery)));
    expect(inconsistentRelease).toEqual({ type: "retry" });
    const retained = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly globalReserved: number;
          readonly principalReserved: number;
          readonly reservationState: string;
          readonly runState: string;
          readonly terminalEvents: string;
        }>`SELECT
          run.state AS "runState",
          reservation.state AS "reservationState",
          global_capacity.reserved_count AS "globalReserved",
          principal_capacity.reserved_count AS "principalReserved",
          (SELECT count(*) FROM thread_events
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
              AND event_type IN ('AgentRunSucceeded', 'AgentRunFailed'))::text AS "terminalEvents"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        CROSS JOIN admission_global_capacity global_capacity
        JOIN admission_principal_capacity principal_capacity
          ON principal_capacity.principal_id = run.principal_id
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );
    expect(retained[0]).toEqual({
      runState: "running",
      reservationState: "held",
      globalReserved: 1,
      principalReserved: 0,
      terminalEvents: "0",
    });

    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE admission_principal_capacity
          SET reserved_count = 1
          WHERE principal_id = ${principalId}::uuid`;
        yield* sql`UPDATE admission_global_capacity SET reserved_count = 2
          WHERE singleton = true`;
        yield* sql`UPDATE agent_runs
          SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );

    const { recovered, reconciliation } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const releaseLock = yield* Deferred.make<void>();
        const lockHeld = yield* Deferred.make<void>();
        const lockFiber = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT pg_advisory_xact_lock(
                hashtextextended(${ADMISSION_CAPACITY_LOCK_KEY}, 0)
              )`;
              yield* Deferred.succeed(lockHeld, undefined);
              yield* Deferred.await(releaseLock);
            }),
          ),
        );
        yield* Deferred.await(lockHeld);

        const waitForBlockedPool = Effect.fn("waitForBlockedPool")(function* (
          applicationName: string,
        ) {
          let observed = 0;
          for (let attempt = 0; attempt < 50 && observed === 0; attempt += 1) {
            const [row] = yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count
              FROM pg_stat_activity
              WHERE application_name = ${applicationName}
                AND wait_event = 'advisory'`;
            observed = row?.count ?? 0;
            if (observed === 0) yield* Effect.sleep(10);
          }
          expect(observed).toBeGreaterThan(0);
        });

        const reconciliationFiber = yield* Effect.forkChild(
          MessageAdmission.use((admission) => admission.reconcileCapacity()),
        );
        yield* waitForBlockedPool("osfo-api");
        const workerFiber = yield* Effect.forkChild(
          AgentRunWorker.use((worker) => worker.handle(delivery)),
        );
        yield* waitForBlockedPool("osfo-agent-run-repository");
        yield* Deferred.succeed(releaseLock, undefined);

        const reconciliation = yield* Fiber.join(reconciliationFiber);
        const recovered = yield* Fiber.join(workerFiber);
        yield* Fiber.join(lockFiber);
        return { recovered, reconciliation };
      }),
    );
    const duplicate = await run(AgentRunWorker.use((worker) => worker.handle(delivery)));
    expect(reconciliation).toMatchObject({
      globalReservedBefore: 2,
      globalReservedAfter: 1,
      repaired: true,
    });
    expect(recovered).toEqual({ type: "acknowledge", outcome: "succeeded" });
    expect(duplicate).toEqual({ type: "acknowledge", outcome: "alreadyTerminal" });

    const reconciled = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly globalReserved: number;
          readonly principalReserved: number;
          readonly reservationState: string;
          readonly runState: string;
          readonly terminalEvents: string;
        }>`SELECT
          run.state AS "runState",
          reservation.state AS "reservationState",
          global_capacity.reserved_count AS "globalReserved",
          principal_capacity.reserved_count AS "principalReserved",
          (SELECT count(*) FROM thread_events
            WHERE agent_run_id = ${receipt.agentRunId}::uuid
              AND event_type IN ('AgentRunSucceeded', 'AgentRunFailed'))::text AS "terminalEvents"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        CROSS JOIN admission_global_capacity global_capacity
        JOIN admission_principal_capacity principal_capacity
          ON principal_capacity.principal_id = run.principal_id
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );
    expect(reconciled[0]).toEqual({
      runState: "succeeded",
      reservationState: "released",
      globalReserved: 0,
      principalReserved: 0,
      terminalEvents: "1",
    });
  });

  it("takes over cancellation after process loss and rejects the stale fence", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "cancel after worker loss" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    const abandoned = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, {
          workerId: "lost-cancel-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    ).then((claim) => Effect.runPromise(Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim)));
    const abandonedAttempt = await run(
      AgentRunRepository.use((repository) =>
        Effect.gen(function* () {
          const modelCall = yield* repository.ensureModelCall(abandoned.fence, {
            type: "startModelCall",
            modelBinding: "oz.deterministic.echo.v1",
            prompt: "cancel after worker loss",
          });
          const attempt = yield* expectStartedAttempt(
            repository.beginModelCallAttempt(abandoned.fence, modelCall),
          );
          yield* repository.appendModelOutput(abandoned.fence, attempt, {
            fragmentIndex: 0,
            text: "Working",
          });
          return attempt;
        }),
      ),
    );

    const requested = await run(
      AgentRunCancellation.use((cancellation) =>
        cancellation.cancel({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          agentRunId: receipt.agentRunId,
        }),
      ),
    );
    expect(requested).toMatchObject({ outcome: "cancellationRequested" });
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs
          SET lease_expires_at = clock_timestamp() - interval '1 millisecond',
              cleanup_deadline_at = clock_timestamp() - interval '1 millisecond'
          WHERE agent_run_id = ${receipt.agentRunId}::uuid`;
      }),
    );
    const replacement = await run(AgentRunWorker.use((worker) => worker.handle(delivery)));
    expect(replacement).toEqual({ type: "acknowledge", outcome: "canceled" });

    const staleErrors = await run(
      AgentRunRepository.use((repository) =>
        Effect.forEach(
          [
            repository.loadRecordedState(abandoned.fence),
            repository.ensureModelCall(abandoned.fence, {
              type: "resumeModelCall",
              modelCallId: abandonedAttempt.modelCallId,
              prompt: abandonedAttempt.prompt,
            }),
            repository.beginModelCallAttempt(abandoned.fence, abandonedAttempt),
            repository.appendModelOutput(abandoned.fence, abandonedAttempt, {
              fragmentIndex: 1,
              text: "stale output",
            }),
            repository.completeModelCall(abandoned.fence, abandonedAttempt),
            repository.interruptModelCall(abandoned.fence, abandonedAttempt, "modelCallFailed"),
            repository.recordModelCallCleanup(abandoned.fence, abandonedAttempt, {
              cleanupDisposition: { type: "completed" },
              externalWorkMayContinue: false,
            }),
            repository.commitTerminal(abandoned.fence, { type: "succeed" }),
            repository.commitCancellation(abandoned.fence, {
              cleanupDisposition: { type: "completed" },
              externalWorkMayContinue: true,
            }),
          ],
          Effect.flip,
        ),
      ),
    );
    expect(staleErrors.map((error) => error._tag)).toEqual(
      Array.from({ length: 9 }, () => "AgentRunFenceRejected"),
    );

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly state: string;
          readonly claimEpoch: string;
          readonly cleanupDisposition: string;
          readonly externalWorkMayContinue: boolean;
          readonly reservationState: string;
          readonly startedAttempts: string;
          readonly attemptCleanupDisposition: string;
          readonly attemptExternalWorkMayContinue: boolean;
        }>`SELECT
          run.state,
          run.claim_epoch::text AS "claimEpoch",
          run.cleanup_disposition AS "cleanupDisposition",
          run.external_work_may_continue AS "externalWorkMayContinue",
          reservation.state AS "reservationState",
          (SELECT cleanup_disposition FROM model_call_attempts
            WHERE model_call_attempt_id = ${abandonedAttempt.modelCallAttemptId}::uuid)
            AS "attemptCleanupDisposition",
          (SELECT external_work_may_continue FROM model_call_attempts
            WHERE model_call_attempt_id = ${abandonedAttempt.modelCallAttemptId}::uuid)
            AS "attemptExternalWorkMayContinue",
          (SELECT count(*) FROM model_call_attempts
            WHERE agent_run_id = run.agent_run_id AND state = 'started')::text AS "startedAttempts"
        FROM agent_runs run
        JOIN agent_run_capacity_reservations reservation USING (agent_run_id)
        WHERE run.agent_run_id = ${receipt.agentRunId}::uuid`;
        const events = yield* sql<{
          readonly eventType: string;
          readonly eventVersion: number;
          readonly payload: unknown;
        }>`SELECT event_type AS "eventType", event_version AS "eventVersion", payload
          FROM thread_events
          WHERE agent_run_id = ${receipt.agentRunId}::uuid
          ORDER BY position`;
        return { row: rows[0], events };
      }),
    );
    expect(authority.row).toEqual({
      state: "canceled",
      claimEpoch: "2",
      cleanupDisposition: "deadlineExceeded",
      externalWorkMayContinue: true,
      reservationState: "released",
      startedAttempts: "0",
      attemptCleanupDisposition: "deadlineExceeded",
      attemptExternalWorkMayContinue: true,
    });
    expect(authority.events).toEqual([
      expect.objectContaining({ eventType: "UserMessageAppended", eventVersion: 1 }),
      expect.objectContaining({ eventType: "AssistantOutputAppended", eventVersion: 1 }),
      expect.objectContaining({ eventType: "AgentRunCancellationRequested", eventVersion: 1 }),
      {
        eventType: "AssistantOutputInterrupted",
        eventVersion: 2,
        payload: {
          assistantOutputId: abandonedAttempt.assistantOutputId,
          agentRunId: receipt.agentRunId,
          cause: "agentRunCanceled",
        },
      },
      {
        eventType: "AgentRunCanceled",
        eventVersion: 1,
        payload: {
          agentRunId: receipt.agentRunId,
          cleanupDisposition: { type: "deadlineExceeded" },
          externalWorkMayContinue: true,
        },
      },
    ]);
  });

  it("rejects beginning an attempt unless its ModelCall transition affects exactly one row", async () => {
    failFirstPublication = false;
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept({
          protocolVersion: 1,
          authenticationToken,
          threadId,
          idempotencyKey: randomUUID(),
          message: { content: "begin fence" },
        }),
      ),
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));
    const delivery = published[0]!;
    const claim = await run(
      AgentRunRepository.use((repository) =>
        repository.claimAgentRun(delivery, {
          workerId: "row-count-worker",
          leaseDurationMs: 30_000,
        }),
      ),
    );
    const claimed = await Effect.runPromise(
      Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim),
    );

    const error = await run(
      Effect.flip(
        AgentRunRepository.use((repository) =>
          repository.beginModelCallAttempt(claimed.fence, {
            modelCallId: randomUUID(),
            modelBinding: "oz.deterministic.echo.v1",
            prompt: `missing ${receipt.agentRunId}`,
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(AgentRunFenceRejected);
  });

  it.each(["complete", "interrupt"] as const)(
    "rejects %s unless every attempt transition affects exactly one row",
    async (operation) => {
      failFirstPublication = false;
      await run(
        MessageAdmission.use((admission) =>
          admission.accept({
            protocolVersion: 1,
            authenticationToken,
            threadId,
            idempotencyKey: randomUUID(),
            message: { content: `${operation} fence` },
          }),
        ),
      );
      await run(OutboxRelay.use((relay) => relay.selectOnce()));
      await run(OutboxRelay.use((relay) => relay.publishOnce()));
      const delivery = published[0]!;
      const claim = await run(
        AgentRunRepository.use((repository) =>
          repository.claimAgentRun(delivery, {
            workerId: "row-count-worker",
            leaseDurationMs: 30_000,
          }),
        ),
      );
      const claimed = await Effect.runPromise(
        Schema.decodeUnknownEffect(ClaimedAgentRunSchema)(claim),
      );
      const attempt = await run(
        AgentRunRepository.use((repository) =>
          Effect.gen(function* () {
            const modelCall = yield* repository.ensureModelCall(claimed.fence, {
              type: "startModelCall",
              modelBinding: "oz.deterministic.echo.v1",
              prompt: `${operation} fence`,
            });
            return yield* expectStartedAttempt(
              repository.beginModelCallAttempt(claimed.fence, modelCall),
            );
          }),
        ),
      );
      const wrongAttempt = { ...attempt, modelCallAttemptId: randomUUID() };
      const transition = AgentRunRepository.use((repository) =>
        operation === "complete"
          ? repository.completeModelCall(claimed.fence, wrongAttempt)
          : repository.interruptModelCall(claimed.fence, wrongAttempt, "modelCallFailed"),
      );

      const error = await run(Effect.flip(transition));

      expect(error).toBeInstanceOf(AgentRunFenceRejected);
    },
  );
});
