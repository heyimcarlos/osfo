import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { AgentRunCancellation } from "@osfo/api";
import {
  ActionApplicationPolicy,
  ActionAuthorization,
  ActionDriver,
  ActionExternalAdapter,
  AgentRunRepository,
  ActionRepository,
  makeActionDriverLayer,
  type ActionExternalResult,
} from "@osfo/agent-run";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  ThreadEventSchema,
  applyThreadEvent,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
} from "@osfo/session";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeActionRepositoryLayer,
  makeAgentRunCancellationLayer,
  makeAgentRunRepositoryLayer,
} from "../src/index.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "c3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "8ef239bd-3f04-4c77-8976-1171e75ea0ab";
const userMessageId = "4ad4707e-a960-448b-ab7b-6edcc7ae213f";
const agentRunId = "56c2f4aa-dac1-42ab-8252-204629a33173";
const toolCallId = "tool_9ad4707e-a960-448b-ab7b-6edcc7ae213f";
const fence = { agentRunId, workerId: "action-worker-a", claimEpoch: "1" } as const;
const request = {
  agentRunId,
  runtimeGate: "permit",
  subject: "Development Action proof",
  toolCallId,
} as const;
const authenticationToken = "action-cancellation-test-token";

const databaseLayer = PgClient.layer({
  applicationName: "osfo-action-repository-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});
const repositoryLayer = makeActionRepositoryLayer({ databaseUrl, maxConnections: 8 });
const runtime = ManagedRuntime.make(Layer.mergeAll(databaseLayer, repositoryLayer));

type TestServices = SqlClient.SqlClient | ActionRepository;
const run = <A, E>(effect: Effect.Effect<A, E, TestServices>) => runtime.runPromise(effect);

const seedCancellationAuthority = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const input = yield* makeUserMessageAppended({
        agentRunId,
        content: "exercise one Action",
        eventId: "13fc192a-430a-4c04-bf83-562598e49e9b",
        occurredAt: "2026-08-07T18:00:00.000Z",
        threadId,
        threadPosition: "1",
        userMessageId,
      });
      yield* sql`INSERT INTO authentication_sessions (
          session_id, principal_id, token_sha256, expires_at
        ) VALUES (
          'c1b14fa8-70e5-4af7-83ec-b6094c2278b9'::uuid, ${principalId}::uuid,
          ${createHash("sha256").update(authenticationToken).digest("hex")},
          clock_timestamp() + interval '1 hour'
        )`;
      yield* sql`UPDATE admission_global_capacity SET reserved_count = 1 WHERE singleton = true`;
      yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count)
        VALUES (${principalId}::uuid, 1)`;
      yield* sql`INSERT INTO agent_run_capacity_reservations (
          agent_run_id, principal_id, state, reserved_at
        ) VALUES (
          ${agentRunId}::uuid, ${principalId}::uuid, 'held', transaction_timestamp()
        )`;
      yield* sql`UPDATE threads SET next_position = 2, state_revision = 1
        WHERE thread_id = ${threadId}::uuid`;
      yield* sql`INSERT INTO thread_events (
          thread_id, position, event_id, principal_id, user_message_id,
          agent_run_id, event_type, event_version, payload, occurred_at
        ) VALUES (
          ${threadId}::uuid, 1, ${input.eventId}::uuid, ${principalId}::uuid,
          ${userMessageId}::uuid, ${agentRunId}::uuid, ${input.eventType},
          ${input.eventVersion}, ${JSON.stringify(input.payload)}::jsonb,
          ${input.occurredAt}::timestamptz
        )`;
    }),
  );

const cancelAgentRun = () =>
  Effect.runPromise(
    AgentRunCancellation.use((cancellation) =>
      cancellation.cancel({
        agentRunId,
        authenticationToken,
        protocolVersion: 1,
        threadId,
      }),
    ).pipe(
      Effect.provide(makeAgentRunCancellationLayer({ databaseUrl, cleanupTimeoutMs: 30_000 })),
    ),
  );

const commitAgentRunCancellation = () =>
  Effect.runPromise(
    AgentRunRepository.use((repository) =>
      repository.commitCancellation(fence, {
        cleanupDisposition: { type: "completed" },
        externalWorkMayContinue: false,
      }),
    ).pipe(
      Effect.provide(makeAgentRunRepositoryLayer({ databaseUrl, maxConnections: 8 })),
      Effect.exit,
    ),
  );

const replayPublicEvents = async () => {
  const rows = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        readonly eventId: string;
        readonly eventType: string;
        readonly eventVersion: number;
        readonly occurredAt: string;
        readonly payload: unknown;
        readonly threadPosition: string;
      }>`SELECT event_id::text AS "eventId", event_type AS "eventType",
          event_version AS "eventVersion", occurred_at::text AS "occurredAt",
          payload, position::text AS "threadPosition"
        FROM thread_events WHERE thread_id = ${threadId}::uuid ORDER BY position`;
    }),
  );
  let snapshot = Effect.runSync(makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" }));
  for (const row of rows) {
    const event = Schema.decodeUnknownSync(ThreadEventSchema)({
      ...row,
      occurredAt: new Date(row.occurredAt).toISOString(),
      threadId,
    });
    snapshot = Effect.runSync(
      applyThreadEvent(snapshot, { ...event, cursor: `cursor-${row.threadPosition}` }),
    );
  }
  return snapshot;
};

beforeEach(() =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE principals CASCADE`;
      yield* sql`UPDATE admission_global_capacity SET reserved_count = 0 WHERE singleton = true`;
      yield* sql`INSERT INTO principals (principal_id) VALUES (${principalId}::uuid)`;
      yield* sql`INSERT INTO threads (thread_id, principal_id)
        VALUES (${threadId}::uuid, ${principalId}::uuid)`;
      yield* sql`INSERT INTO user_messages (
          user_message_id, thread_id, principal_id, content, created_at
        ) VALUES (
          ${userMessageId}::uuid, ${threadId}::uuid, ${principalId}::uuid,
          'exercise one Action', transaction_timestamp()
        )`;
      yield* sql`INSERT INTO agent_runs (
          agent_run_id, thread_id, principal_id, user_message_id, state,
          claim_epoch, claim_owner, lease_expires_at, execution_profile_ref, created_at
        ) VALUES (
          ${agentRunId}::uuid, ${threadId}::uuid, ${principalId}::uuid,
          ${userMessageId}::uuid, 'running', 1, ${fence.workerId},
          clock_timestamp() + interval '1 hour', 'oz.openrouter.minimax.v1',
          transaction_timestamp()
        )`;
    }),
  ),
);

afterAll(() => runtime.dispose());

const driverLayer = (options: {
  readonly applicationGate?: () => Effect.Effect<"deny" | "requireApproval" | "permit">;
  readonly authorization?: () => Effect.Effect<{
    readonly authorized: boolean;
    readonly revision: string;
  }>;
  readonly authorized?: boolean;
  readonly dispatch: () => Effect.Effect<ActionExternalResult>;
  readonly reconcile: () => Effect.Effect<ActionExternalResult>;
}) =>
  makeActionDriverLayer().pipe(
    Layer.provideMerge(repositoryLayer),
    Layer.provideMerge(
      Layer.succeed(ActionApplicationPolicy)({
        gate: options.applicationGate ?? (() => Effect.succeed("requireApproval")),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ActionAuthorization)({
        current:
          options.authorization ??
          (() =>
            Effect.succeed({
              authorized: options.authorized ?? true,
              revision: "auth-revision-1",
            })),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ActionExternalAdapter)({
        dispatch: options.dispatch,
        reconcile: options.reconcile,
      }),
    ),
  );

describe("PostgreSQL Action authority", () => {
  it("binds approval to immutable intent and commits a fenced receipt after the attempt", async () => {
    let dispatchObservedDurableAttempt = false;
    const layer = driverLayer({
      dispatch: () =>
        Effect.promise(async () => {
          const rows = await run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count
                FROM action_attempts WHERE tool_call_id = ${toolCallId} AND state = 'dispatching'`;
            }),
          );
          dispatchObservedDurableAttempt = rows[0]?.count === 1;
          return { type: "applied" as const };
        }),
      reconcile: () => Effect.succeed({ type: "uncertain" }),
    });
    const first = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    expect(first.type).toBe("waitingApproval");
    if (first.type !== "waitingApproval") throw new Error("Expected approval request");

    const wrongAction = await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: first.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
          toolCallId: "tool_7ad4707e-a960-448b-ab7b-6edcc7ae213f",
        }),
      ).pipe(Effect.provide(layer), Effect.exit),
    );
    expect(Exit.isFailure(wrongAction)).toBe(true);

    const decision = {
      approvalRequestId: first.approvalRequest.approvalRequestId,
      decision: "approved" as const,
      decisionId: "269787db-071e-4478-806f-1d85d00b7337",
      toolCallId,
    };
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.decideApproval(decision)).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.decideApproval(decision)).pipe(Effect.provide(layer)),
    );
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const evidence = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly attempts: number;
          readonly events: number;
          readonly receipts: number;
          readonly toolCalls: number;
        }>`SELECT
            (SELECT count(*)::int FROM action_attempts) AS attempts,
            (SELECT count(*)::int FROM action_receipts) AS receipts,
            (SELECT count(*)::int FROM tool_calls WHERE execution_mode = 'action') AS "toolCalls",
            (SELECT count(*)::int FROM thread_events
              WHERE event_type IN ('ActionApprovalRequested', 'ActionReceiptRecorded')) AS events`;
        return rows[0];
      }),
    );

    expect(dispatchObservedDurableAttempt).toBe(true);
    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "applied" } });
    expect(evidence).toEqual({ attempts: 1, events: 2, receipts: 1, toolCalls: 1 });
    expect(JSON.stringify(terminal)).not.toMatch(
      /osfo-demo-(sender|recipient)|approval-gated demo email/u,
    );
    const weakerReplayLayer = driverLayer({
      applicationGate: () => Effect.succeed("permit"),
      dispatch: () => Effect.die("dispatch must not replay"),
      reconcile: () => Effect.die("reconcile must not replay"),
    });
    expect(
      await Effect.runPromise(
        ActionDriver.use((driver) => driver.drive(fence, request)).pipe(
          Effect.provide(weakerReplayLayer),
        ),
      ),
    ).toEqual(terminal);
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.decideApproval(decision)).pipe(Effect.provide(layer)),
    );
  });

  it("reconciles a lost acknowledgement without another dispatch or another effect", async () => {
    let dispatches = 0;
    let reconciliations = 0;
    const layer = driverLayer({
      dispatch: () => {
        dispatches += 1;
        return Effect.succeed({ type: "uncertain" });
      },
      reconcile: () => {
        reconciliations += 1;
        return Effect.succeed({ type: "applied" });
      },
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(
      await Effect.runPromise(
        ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
      ),
    ).toEqual({ type: "reconcileRequired" });
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const duplicate = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );

    expect(dispatches).toBe(1);
    expect(reconciliations).toBe(1);
    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "applied" } });
    expect(duplicate).toEqual(terminal);
  });

  it("reconciles an uncertain attempt even when policy later denies future dispatch", async () => {
    let gate: "deny" | "requireApproval" = "requireApproval";
    let dispatches = 0;
    let reconciliations = 0;
    const layer = driverLayer({
      applicationGate: () => Effect.succeed(gate),
      dispatch: () => {
        dispatches += 1;
        return Effect.succeed({ type: "uncertain" });
      },
      reconcile: () => {
        reconciliations += 1;
        return Effect.succeed({ type: "applied" });
      },
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(
      await Effect.runPromise(
        ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
      ),
    ).toEqual({ type: "reconcileRequired" });
    gate = "deny";
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );

    expect(dispatches).toBe(1);
    expect(reconciliations).toBe(1);
    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "applied" } });
  });

  it("reconciles an uncertain attempt after current authorization is revoked", async () => {
    let authorized = true;
    let reconciliations = 0;
    const layer = driverLayer({
      authorization: () => Effect.succeed({ authorized, revision: `auth-${authorized}` }),
      dispatch: () => Effect.succeed({ type: "uncertain" }),
      reconcile: () => {
        reconciliations += 1;
        return Effect.succeed({ type: "notApplied" });
      },
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    authorized = false;
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );

    expect(reconciliations).toBe(1);
    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
  });

  it("records unresolved only after reconciliation remains uncertain", async () => {
    const layer = driverLayer({
      dispatch: () => Effect.succeed({ type: "uncertain" }),
      reconcile: () => Effect.succeed({ type: "uncertain" }),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const unresolved = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );

    expect(unresolved).toMatchObject({
      type: "terminal",
      receipt: { outcome: "unresolved" },
    });
  });

  it("takes over a durable in-flight attempt through reconciliation without redispatch", async () => {
    let dispatches = 0;
    let reconciliations = 0;
    const layer = driverLayer({
      dispatch: () => {
        dispatches += 1;
        return Effect.succeed({ type: "applied" });
      },
      reconcile: () => {
        reconciliations += 1;
        return Effect.succeed({ type: "applied" });
      },
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    await run(
      ActionRepository.use((repository) =>
        repository.beginAttempt(fence, waiting.approvalRequest.action, "auth-revision-1"),
      ),
    );
    const replacementFence = {
      agentRunId,
      claimEpoch: "2",
      workerId: "action-worker-b",
    } as const;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs SET claim_owner = ${replacementFence.workerId},
            claim_epoch = ${replacementFence.claimEpoch}::bigint,
            lease_expires_at = clock_timestamp() + interval '1 hour'
          WHERE agent_run_id = ${agentRunId}::uuid`;
      }),
    );
    const result = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(replacementFence, request)).pipe(
        Effect.provide(layer),
      ),
    );

    expect(dispatches).toBe(0);
    expect(reconciliations).toBe(1);
    expect(result).toMatchObject({ type: "terminal", receipt: { outcome: "applied" } });
  });

  it("terminalizes a denied approval without creating an attempt", async () => {
    const layer = driverLayer({
      dispatch: () => Effect.die("dispatch must not run"),
      reconcile: () => Effect.die("reconcile must not run"),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    const decision = {
      approvalRequestId: waiting.approvalRequest.approvalRequestId,
      decision: "denied" as const,
      decisionId: "269787db-071e-4478-806f-1d85d00b7337",
      toolCallId,
    };
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.decideApproval(decision)).pipe(Effect.provide(layer)),
    );
    const result = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const counts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ readonly attempts: number; readonly receipts: number }>`SELECT
          (SELECT count(*)::int FROM action_attempts) AS attempts,
          (SELECT count(*)::int FROM action_receipts) AS receipts`)[0];
      }),
    );

    expect(result).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
    expect(counts).toEqual({ attempts: 0, receipts: 1 });
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.decideApproval(decision)).pipe(Effect.provide(layer)),
    );
  });

  it("terminalizes an expired approval without creating an attempt", async () => {
    const layer = driverLayer({
      dispatch: () => Effect.die("dispatch must not run"),
      reconcile: () => Effect.die("reconcile must not run"),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE action_approval_requests
          SET expires_at = clock_timestamp() - interval '1 second'
          WHERE approval_request_id = ${waiting.approvalRequest.approvalRequestId}::uuid`;
      }),
    );
    const result = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const attempts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count
          FROM action_attempts`)[0]?.count;
      }),
    );

    expect(result).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
    expect(attempts).toBe(0);
  });

  it("rejects a same-epoch duplicate while dispatch remains in flight", async () => {
    let dispatches = 0;
    let reconciliations = 0;
    const layer = driverLayer({
      dispatch: () => {
        dispatches += 1;
        return Effect.succeed({ type: "applied" });
      },
      reconcile: () => {
        reconciliations += 1;
        return Effect.succeed({ type: "applied" });
      },
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    await run(
      ActionRepository.use((repository) =>
        repository.beginAttempt(fence, waiting.approvalRequest.action, "auth-revision-1"),
      ),
    );
    const duplicate = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(
        Effect.provide(layer),
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(duplicate)).toBe(true);
    expect(dispatches).toBe(0);
    expect(reconciliations).toBe(0);
  });

  it("rejects stale caller Action data when recording an external result", async () => {
    const layer = driverLayer({
      dispatch: () => Effect.succeed({ type: "applied" }),
      reconcile: () => Effect.succeed({ type: "applied" }),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    const attempt = await run(
      ActionRepository.use((repository) =>
        repository.beginAttempt(fence, waiting.approvalRequest.action, "auth-revision-1"),
      ),
    );
    if (attempt.type !== "dispatch") throw new Error("Expected dispatch attempt");
    const rejected = await run(
      ActionRepository.use((repository) =>
        repository.recordExternalResult(
          fence,
          {
            ...attempt.attempt,
            action: { ...attempt.attempt.action, actionDigest: "f".repeat(64) },
          },
          { type: "applied" },
        ),
      ).pipe(Effect.exit),
    );

    expect(Exit.isFailure(rejected)).toBe(true);
  });

  it("lets a later stricter application deny terminalize an approved Action without dispatch", async () => {
    let gate: "deny" | "requireApproval" = "requireApproval";
    let dispatches = 0;
    const layer = driverLayer({
      applicationGate: () => Effect.succeed(gate),
      dispatch: () => {
        dispatches += 1;
        return Effect.succeed({ type: "applied" });
      },
      reconcile: () => Effect.succeed({ type: "uncertain" }),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    gate = "deny";
    const result = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );

    expect(dispatches).toBe(0);
    expect(result).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
  });

  it("creates an exact approval when a permit Action strengthens before dispatch", async () => {
    const initial = await run(
      ActionRepository.use((repository) => repository.ensureAction(fence, request, "permit")),
    );
    expect(initial.type).toBe("ready");
    const layer = driverLayer({
      applicationGate: () => Effect.succeed("requireApproval"),
      dispatch: () => Effect.die("dispatch must not run"),
      reconcile: () => Effect.die("reconcile must not run"),
    });
    const strengthened = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const evidence = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ readonly approvals: number; readonly attempts: number }>`SELECT
          (SELECT count(*)::int FROM action_approval_requests) AS approvals,
          (SELECT count(*)::int FROM action_attempts) AS attempts`)[0];
      }),
    );

    expect(strengthened.type).toBe("waitingApproval");
    expect(evidence).toEqual({ approvals: 1, attempts: 0 });
  });

  it("cancels a pending exact approval before recording policy denial", async () => {
    let gate: "deny" | "requireApproval" = "requireApproval";
    const layer = driverLayer({
      applicationGate: () => Effect.succeed(gate),
      dispatch: () => Effect.die("dispatch must not run"),
      reconcile: () => Effect.die("reconcile must not run"),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    gate = "deny";
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const evidence = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{
          readonly approvalState: string;
          readonly publicApproval: unknown;
        }>`SELECT
          (SELECT state FROM action_approval_requests) AS "approvalState",
          (SELECT payload -> 'approval' FROM thread_events
            WHERE event_type = 'ActionReceiptRecorded') AS "publicApproval"`)[0];
      }),
    );
    const lateDecision = await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer), Effect.exit),
    );

    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
    expect(evidence).toEqual({
      approvalState: "canceled",
      publicApproval: {
        approvalRequestId: waiting.approvalRequest.approvalRequestId,
        reason: "canceled",
        type: "notApproved",
      },
    });
    expect(Exit.isFailure(lateDecision)).toBe(true);
  });

  it("settles an uncontacted approval before accepting cancellation and replays cleanly", async () => {
    await seedCancellationAuthority();
    const layer = driverLayer({
      dispatch: () => Effect.die("dispatch must not run"),
      reconcile: () => Effect.die("reconcile must not run"),
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    const cancellation = await cancelAgentRun();
    const replay = await replayPublicEvents();
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );

    expect(cancellation.outcome).toBe("cancellationRequested");
    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "notApplied" } });
    expect(replay.timeline.at(-1)).toMatchObject({
      approval: { reason: "canceled", type: "notApproved" },
      outcome: "notApplied",
      type: "actionReceipt",
    });
    expect(replay.activeState.some((state) => state.type === "activeActionApproval")).toBe(false);
  });

  it("accepts cancellation after contact, preserves uncertainty, then reconciles", async () => {
    await seedCancellationAuthority();
    let reconciliations = 0;
    const layer = driverLayer({
      dispatch: () => Effect.succeed({ type: "uncertain" }),
      reconcile: () => {
        reconciliations += 1;
        return Effect.succeed({ type: "applied" });
      },
    });
    const waiting = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    if (waiting.type !== "waitingApproval") throw new Error("Expected approval request");
    await Effect.runPromise(
      ActionDriver.use((driver) =>
        driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "269787db-071e-4478-806f-1d85d00b7337",
          toolCallId,
        }),
      ).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const cancellation = await cancelAgentRun();
    const beforeReconcile = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{
          readonly canceledEvents: number;
          readonly receipts: number;
          readonly runState: string;
          readonly state: string;
        }>`SELECT
          (SELECT count(*)::int FROM action_receipts) AS receipts,
          (SELECT state FROM actions WHERE tool_call_id = ${toolCallId}) AS state,
          (SELECT state FROM agent_runs WHERE agent_run_id = ${agentRunId}::uuid) AS "runState",
          (SELECT count(*)::int FROM thread_events
            WHERE event_type = 'AgentRunCanceled') AS "canceledEvents"`)[0];
      }),
    );
    const blockedCancellation = await commitAgentRunCancellation();
    const terminal = await Effect.runPromise(
      ActionDriver.use((driver) => driver.drive(fence, request)).pipe(Effect.provide(layer)),
    );
    const replayBeforeCancellationCommit = await replayPublicEvents();
    const committedCancellation = await commitAgentRunCancellation();
    const replay = await replayPublicEvents();

    expect(cancellation.outcome).toBe("cancellationRequested");
    expect(beforeReconcile).toEqual({
      canceledEvents: 0,
      receipts: 0,
      runState: "running",
      state: "reconcileRequired",
    });
    expect(Exit.isFailure(blockedCancellation)).toBe(true);
    expect(reconciliations).toBe(1);
    expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "applied" } });
    expect(replayBeforeCancellationCommit.activeState).toEqual([
      expect.objectContaining({
        cancellation: { type: "requested" },
        phase: { type: "running" },
        type: "activeAgentRun",
      }),
    ]);
    expect(Exit.isSuccess(committedCancellation)).toBe(true);
    expect(replay.timeline.at(-1)).toMatchObject({ outcome: "applied", type: "actionReceipt" });
    expect(replay.activeState.some((state) => state.type === "activeActionApproval")).toBe(false);
    expect(replay.activeState.some((state) => state.type === "activeAgentRun")).toBe(false);
  });

  it("rejects stale caller Action data on a no-dispatch terminal path", async () => {
    const state = await run(
      ActionRepository.use((repository) => repository.ensureAction(fence, request, "permit")),
    );
    if (state.type !== "ready") throw new Error("Expected ready Action");
    const rejected = await run(
      ActionRepository.use((repository) =>
        repository.completeWithoutDispatch(
          fence,
          { ...state.action, actionDigest: "f".repeat(64) },
          "authorizationDenied",
        ),
      ).pipe(Effect.exit),
    );

    expect(Exit.isFailure(rejected)).toBe(true);
  });

  it.each(["permit", "requireApproval"] as const)(
    "prevents AgentRun terminal state while a %s Action remains open",
    async (gate) => {
      await run(
        ActionRepository.use((repository) => repository.ensureAction(fence, request, gate)),
      );
      const terminalUpdate = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE agent_runs
            SET state = 'succeeded', claim_owner = NULL, lease_expires_at = NULL
            WHERE agent_run_id = ${agentRunId}::uuid`;
        }).pipe(Effect.exit),
      );

      expect(Exit.isFailure(terminalUpdate)).toBe(true);
    },
  );
});
