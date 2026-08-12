import { PgClient } from "@effect/sql-pg";
import {
  ToolCallRepository,
  executeNonActionToolCallBatch,
  makeDeterministicTextToolCallExecutorLayer,
  type ToolCallBatchRequest,
} from "@osfo/agent-run";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeToolCallRepositoryLayer } from "../src/index.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const principalId = "c3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const threadId = "8ef239bd-3f04-4c77-8976-1171e75ea0ab";
const userMessageId = "4ad4707e-a960-448b-ab7b-6edcc7ae213f";
const agentRunId = "56c2f4aa-dac1-42ab-8252-204629a33173";
const fence = { agentRunId, workerId: "tool-worker-a", claimEpoch: "1" } as const;

const request = {
  batchKey: "model-call-1:tools",
  attemptLimit: 2,
  requests: [
    {
      executionMode: "nonAction",
      toolName: "echo",
      input: { type: "text", text: "first" },
    },
    {
      executionMode: "nonAction",
      toolName: "echo",
      input: { type: "text", text: "second" },
    },
  ],
} as const satisfies ToolCallBatchRequest;

const databaseLayer = PgClient.layer({
  applicationName: "osfo-tool-call-repository-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});
const repositoryLayer = makeToolCallRepositoryLayer({ databaseUrl, maxConnections: 8 });
const runtime = ManagedRuntime.make(Layer.mergeAll(databaseLayer, repositoryLayer));

type TestServices = SqlClient.SqlClient | ToolCallRepository;
const run = <A, E>(effect: Effect.Effect<A, E, TestServices>) => runtime.runPromise(effect);

beforeEach(() =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE principals CASCADE`;
      yield* sql`INSERT INTO principals (principal_id) VALUES (${principalId}::uuid)`;
      yield* sql`INSERT INTO threads (thread_id, principal_id)
        VALUES (${threadId}::uuid, ${principalId}::uuid)`;
      yield* sql`INSERT INTO user_messages (
          user_message_id, thread_id, principal_id, content, created_at
        ) VALUES (
          ${userMessageId}::uuid, ${threadId}::uuid, ${principalId}::uuid,
          'exercise tools', transaction_timestamp()
        )`;
      yield* sql`INSERT INTO agent_runs (
          agent_run_id, thread_id, principal_id, user_message_id, state,
          claim_epoch, claim_owner, lease_expires_at, execution_profile_ref, created_at
        ) VALUES (
          ${agentRunId}::uuid, ${threadId}::uuid, ${principalId}::uuid,
          ${userMessageId}::uuid, 'running', 1, ${fence.workerId},
          clock_timestamp() + interval '1 hour', 'oz.deterministic.v1',
          transaction_timestamp()
        )`;
    }),
  ),
);

afterAll(() => runtime.dispose());

describe("PostgreSQL non-Action ToolCall authority", () => {
  it("commits complete stable batch membership before any attempt can start", async () => {
    const first = await run(
      ToolCallRepository.use((repository) => repository.commitBatch(fence, request)),
    );
    const recovered = await run(
      ToolCallRepository.use((repository) => repository.commitBatch(fence, request)),
    );
    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly attempts: number;
          readonly calls: number;
          readonly members: number;
          readonly state: string;
        }>`SELECT batch.member_count AS members, batch.state,
            count(DISTINCT call.tool_call_id)::int AS calls,
            count(DISTINCT attempt.tool_call_attempt_id)::int AS attempts
          FROM tool_call_batches batch
          JOIN tool_calls call USING (tool_call_batch_id, agent_run_id)
          LEFT JOIN tool_call_attempts attempt USING (tool_call_id, agent_run_id)
          WHERE batch.tool_call_batch_id = ${first.toolCallBatchId}::uuid
          GROUP BY batch.member_count, batch.state`;
        return rows[0];
      }),
    );

    expect(recovered).toEqual(first);
    expect(first.calls.every((call) => call.toolCallId.startsWith("tool_"))).toBe(true);
    expect(authority).toEqual({ attempts: 0, calls: 2, members: 2, state: "pending" });

    const changedIntent = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, {
          ...request,
          requests: [
            {
              executionMode: "nonAction",
              toolName: "echo",
              input: { type: "text", text: "changed" },
            },
          ],
        }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isFailure(changedIntent)).toBe(true);
  });

  it("executes the committed batch and returns typed ordered terminal outcomes", async () => {
    const state = await run(
      executeNonActionToolCallBatch(fence, request).pipe(
        Effect.provide(makeDeterministicTextToolCallExecutorLayer()),
      ),
    );
    const evidence = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly progress: number; readonly terminal: number }>`SELECT
            (SELECT count(*)::int FROM tool_call_progress_events) AS progress,
            (SELECT count(*)::int FROM tool_calls WHERE outcome IS NOT NULL) AS terminal`;
        return rows[0];
      }),
    );

    expect(state.type).toBe("succeeded");
    const outcomes = state.type === "succeeded" ? state.outcomes.map((item) => item.outcome) : [];
    expect(outcomes).toEqual([
      { type: "succeeded", result: { type: "text", text: "first" } },
      { type: "succeeded", result: { type: "text", text: "second" } },
    ]);
    expect(evidence).toEqual({ progress: 4, terminal: 2 });
  });

  it("deduplicates progress and terminal observations without rewriting history", async () => {
    const batch = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, { ...request, requests: [request.requests[0]] }),
      ),
    );
    const claim = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, batch)),
    );
    if (claim.type !== "started") throw new Error("Expected ToolCall attempt");
    const progress = { observationIndex: 0, message: "started" } as const;
    await run(
      ToolCallRepository.use((repository) =>
        Effect.all([
          repository.appendProgress(fence, claim.attempt, progress),
          repository.appendProgress(fence, claim.attempt, progress),
        ]),
      ),
    );
    await run(
      ToolCallRepository.use((repository) =>
        repository.appendProgress(fence, claim.attempt, {
          observationIndex: 2,
          message: "newest",
        }),
      ),
    );
    await run(
      ToolCallRepository.use((repository) =>
        repository.appendProgress(fence, claim.attempt, {
          observationIndex: 1,
          message: "delayed",
        }),
      ),
    );
    const activeProgress = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly observationIndex: number;
          readonly message: string;
        }>`SELECT
            (current_progress ->> 'observationIndex')::integer AS "observationIndex",
            current_progress ->> 'message' AS message
          FROM tool_calls WHERE tool_call_id = ${claim.attempt.toolCallId}`;
        return rows[0];
      }),
    );
    const outcome = {
      type: "succeeded" as const,
      result: { type: "text" as const, text: "first" },
    };
    await run(
      ToolCallRepository.use((repository) =>
        repository.completeAttempt(fence, claim.attempt, outcome),
      ),
    );
    await run(
      ToolCallRepository.use((repository) =>
        repository.completeAttempt(fence, claim.attempt, outcome),
      ),
    );
    const conflict = await run(
      ToolCallRepository.use((repository) =>
        repository.completeAttempt(fence, claim.attempt, {
          type: "failed",
          cause: "executionFailed",
        }),
      ).pipe(Effect.exit),
    );
    const progressRows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly message: string }>`SELECT message
          FROM tool_call_progress_events ORDER BY observation_index`;
      }),
    );

    expect(activeProgress).toEqual({ observationIndex: 2, message: "newest" });
    expect(progressRows).toEqual([
      { message: "started" },
      { message: "delayed" },
      { message: "newest" },
    ]);
    expect(Exit.isFailure(conflict)).toBe(true);
  });

  it("bounds retries under the persisted policy", async () => {
    const batch = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, {
          ...request,
          attemptLimit: 1,
        }),
      ),
    );
    const first = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, batch)),
    );
    if (first.type !== "started") throw new Error("Expected ToolCall attempt");
    await run(
      ToolCallRepository.use((repository) => repository.retryAttempt(fence, first.attempt)),
    );
    expect(
      await run(ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, batch))),
    ).toEqual({ type: "terminal" });
    expect(
      await run(ToolCallRepository.use((repository) => repository.loadBatchState(fence, batch))),
    ).toEqual({ type: "failed" });
    const calls = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly outcomeType: string; readonly state: string }>`SELECT
            state, outcome ->> 'type' AS "outcomeType"
          FROM tool_calls ORDER BY member_index`;
      }),
    );
    expect(calls).toEqual([
      { outcomeType: "failed", state: "failed" },
      { outcomeType: "canceled", state: "canceled" },
    ]);
  });

  it("settles sibling calls when one member fails", async () => {
    const batch = await run(
      ToolCallRepository.use((repository) => repository.commitBatch(fence, request)),
    );
    const first = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, batch)),
    );
    if (first.type !== "started") throw new Error("Expected ToolCall attempt");
    await run(
      ToolCallRepository.use((repository) =>
        repository.completeAttempt(fence, first.attempt, {
          type: "failed",
          cause: "executionFailed",
        }),
      ),
    );
    const calls = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly outcomeType: string; readonly state: string }>`SELECT
            state, outcome ->> 'type' AS "outcomeType"
          FROM tool_calls ORDER BY member_index`;
      }),
    );
    expect(
      await run(ToolCallRepository.use((repository) => repository.loadBatchState(fence, batch))),
    ).toEqual({ type: "failed" });
    expect(calls).toEqual([
      { outcomeType: "failed", state: "failed" },
      { outcomeType: "canceled", state: "canceled" },
    ]);
  });

  it("cancels only the requested batch", async () => {
    const activeBatch = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, {
          ...request,
          batchKey: "active-batch",
          requests: [request.requests[0]],
        }),
      ),
    );
    const active = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, activeBatch)),
    );
    if (active.type !== "started") throw new Error("Expected ToolCall attempt");
    const canceledBatch = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, {
          ...request,
          batchKey: "canceled-batch",
          requests: [request.requests[1]],
        }),
      ),
    );
    await run(ToolCallRepository.use((repository) => repository.cancelBatch(fence, canceledBatch)));
    const evidence = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly attemptState: string;
          readonly callState: string;
        }>`SELECT
            attempt.state AS "attemptState", call.state AS "callState"
          FROM tool_call_attempts attempt
          JOIN tool_calls call USING (tool_call_id, agent_run_id)
          WHERE attempt.tool_call_attempt_id = ${active.attempt.toolCallAttemptId}::uuid`;
        return rows[0];
      }),
    );
    expect(evidence).toEqual({ attemptState: "started", callState: "running" });
  });

  it("replaces a stale attempt without consuming the retry budget", async () => {
    const batch = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, {
          ...request,
          attemptLimit: 1,
          requests: [request.requests[0]],
        }),
      ),
    );
    const first = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, batch)),
    );
    if (first.type !== "started") throw new Error("Expected ToolCall attempt");
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs
          SET claim_epoch = 2, claim_owner = 'tool-worker-b',
              lease_expires_at = clock_timestamp() + interval '1 hour'
          WHERE agent_run_id = ${agentRunId}::uuid`;
      }),
    );
    const staleProgress = await run(
      ToolCallRepository.use((repository) =>
        repository.appendProgress(fence, first.attempt, {
          observationIndex: 0,
          message: "late",
        }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isFailure(staleProgress)).toBe(true);

    const replacementFence = {
      agentRunId,
      workerId: "tool-worker-b",
      claimEpoch: "2",
    } as const;
    const replacement = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(replacementFence, batch)),
    );
    if (replacement.type !== "started") throw new Error("Expected replacement attempt");
    expect(replacement.attempt.toolCallId).toBe(first.attempt.toolCallId);
    expect(replacement.attempt.toolCallAttemptId).not.toBe(first.attempt.toolCallAttemptId);
    expect(replacement.attempt.attemptNumber).toBe(2);

    await run(
      ToolCallRepository.use((repository) =>
        repository.completeAttempt(replacementFence, replacement.attempt, {
          type: "succeeded",
          result: { type: "text", text: "replacement completed" },
        }),
      ),
    );
    expect(
      await run(
        ToolCallRepository.use((repository) => repository.loadBatchState(replacementFence, batch)),
      ),
    ).toEqual({
      type: "succeeded",
      outcomes: [
        {
          toolCallId: first.attempt.toolCallId,
          outcome: {
            type: "succeeded",
            result: { type: "text", text: "replacement completed" },
          },
        },
      ],
    });
  });

  it("lets requested cancellation win one terminal outcome", async () => {
    const batch = await run(
      ToolCallRepository.use((repository) =>
        repository.commitBatch(fence, { ...request, requests: [request.requests[0]] }),
      ),
    );
    const claim = await run(
      ToolCallRepository.use((repository) => repository.claimNextAttempt(fence, batch)),
    );
    if (claim.type !== "started") throw new Error("Expected ToolCall attempt");

    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_runs
          SET cancellation_requested_at = transaction_timestamp(),
              cleanup_deadline_at = clock_timestamp() + interval '1 minute'
          WHERE agent_run_id = ${agentRunId}::uuid`;
      }),
    );

    await run(ToolCallRepository.use((repository) => repository.cancelBatch(fence, batch)));
    const lateSuccess = await run(
      ToolCallRepository.use((repository) =>
        repository.completeAttempt(fence, claim.attempt, {
          type: "succeeded",
          result: { type: "text", text: "too late" },
        }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isFailure(lateSuccess)).toBe(true);
    expect(
      await run(ToolCallRepository.use((repository) => repository.loadBatchState(fence, batch))),
    ).toEqual({ type: "canceled" });
  });
});
