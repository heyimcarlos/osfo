import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MessageAdmission, type SubmitMessageCommand } from "@osfo/api";
import { makeMessageAdmissionLayer } from "../src/index";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const alicePrincipalId = "b3ef0861-2df7-4d2a-a195-fbc5ed75bc81";
const bobPrincipalId = "74227584-94f3-49a3-a10d-38400ee8d50f";
const aliceThreadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const aliceSecondThreadId = "3ca8360d-5bf0-44a4-ae10-75b736329eb7";
const bobThreadId = "6351d55b-e29a-44c0-9d07-527312f9a04f";
const unknownThreadId = "a7980d86-58d3-4cf1-8dda-ae8d3cbb64e2";
const aliceToken = "alice-test-session-token";
const bobToken = "bob-test-session-token";
const executionProfileRef = "oz.test-profile.v1";

const databaseLayer = PgClient.layer({
  applicationName: "osfo-message-admission-test",
  maxConnections: 12,
  url: Redacted.make(databaseUrl),
});

const runtime = ManagedRuntime.make(
  Layer.merge(
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef,
      globalNonTerminalLimit: 2,
      principalNonTerminalLimit: 1,
    }),
    databaseLayer,
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, MessageAdmission | SqlClient.SqlClient>) =>
  runtime.runPromise(effect);

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

const seedAuthority = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE
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
      yield* sql`INSERT INTO principals (principal_id) VALUES
        (${alicePrincipalId}::uuid),
        (${bobPrincipalId}::uuid)`;
      yield* sql`INSERT INTO authentication_sessions
        (session_id, principal_id, token_sha256, expires_at)
        VALUES
        (${crypto.randomUUID()}::uuid, ${alicePrincipalId}::uuid, ${tokenHash(aliceToken)}, now() + interval '1 hour'),
        (${crypto.randomUUID()}::uuid, ${bobPrincipalId}::uuid, ${tokenHash(bobToken)}, now() + interval '1 hour')`;
      yield* sql`INSERT INTO threads (thread_id, principal_id) VALUES
        (${aliceThreadId}::uuid, ${alicePrincipalId}::uuid),
        (${aliceSecondThreadId}::uuid, ${alicePrincipalId}::uuid),
        (${bobThreadId}::uuid, ${bobPrincipalId}::uuid)`;
      yield* sql`INSERT INTO admission_global_capacity (singleton, reserved_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count) VALUES
        (${alicePrincipalId}::uuid, 0),
        (${bobPrincipalId}::uuid, 0)`;
    }),
  );

const messageCommand = (
  options: {
    readonly content?: string;
    readonly idempotencyKey?: string;
    readonly threadId?: string;
    readonly token?: string;
  } = {},
) =>
  ({
    protocolVersion: 1,
    authenticationToken: options.token ?? aliceToken,
    threadId: options.threadId ?? aliceThreadId,
    idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
    message: { content: options.content ?? "Hello, Oz" },
  }) satisfies SubmitMessageCommand;

const accept = (command: SubmitMessageCommand) =>
  run(MessageAdmission.use((admission) => admission.accept(command)));

const reject = (command: SubmitMessageCommand) =>
  run(Effect.flip(MessageAdmission.use((admission) => admission.accept(command))));

const authorityCounts = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly receipts: string;
        readonly messages: string;
        readonly events: string;
        readonly runs: string;
        readonly reservations: string;
        readonly outbox: string;
      }>`SELECT
        (SELECT count(*) FROM acceptance_receipts)::text AS receipts,
        (SELECT count(*) FROM user_messages)::text AS messages,
        (SELECT count(*) FROM thread_events)::text AS events,
        (SELECT count(*) FROM agent_runs)::text AS runs,
        (SELECT count(*) FROM agent_run_capacity_reservations)::text AS reservations,
        (SELECT count(*) FROM outbox_obligations)::text AS outbox`;
      return rows[0];
    }),
  );

beforeEach(seedAuthority);
afterAll(() => runtime.dispose());

describe("PostgreSQL Thread message admission", () => {
  it("atomically creates one correlated durable authority graph", async () => {
    const idempotencyKey = crypto.randomUUID();
    const receipt = await accept(messageCommand({ idempotencyKey }));

    expect(receipt).toMatchObject({
      protocolVersion: 1,
      idempotencyKey,
      threadId: aliceThreadId,
      threadPosition: "1",
    });
    expect(await authorityCounts()).toEqual({
      receipts: "1",
      messages: "1",
      events: "1",
      runs: "1",
      reservations: "1",
      outbox: "1",
    });

    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly receipt_id: string;
          readonly user_message_id: string;
          readonly agent_run_id: string;
          readonly position: string;
          readonly content: string;
          readonly event_type: string;
          readonly event_payload: {
            readonly agentRunId: string;
            readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
            readonly userMessageId: string;
          };
          readonly run_state: string;
          readonly execution_profile_ref: string;
          readonly reservation_state: string;
          readonly outbox_kind: string;
        }>`SELECT
          receipt.receipt_id::text,
          message.user_message_id::text,
          run.agent_run_id::text,
          event.position::text,
          message.content,
          event.event_type,
          event.payload AS event_payload,
          run.state AS run_state,
          run.execution_profile_ref,
          reservation.state AS reservation_state,
          outbox.kind AS outbox_kind
        FROM acceptance_receipts receipt
        JOIN user_messages message USING (user_message_id)
        JOIN agent_runs run USING (agent_run_id)
        JOIN thread_events event
          ON event.thread_id = receipt.thread_id
          AND event.position = receipt.thread_position
        JOIN agent_run_capacity_reservations reservation
          ON reservation.agent_run_id = receipt.agent_run_id
        JOIN outbox_obligations outbox
          ON outbox.agent_run_id = receipt.agent_run_id`;
      }),
    );

    expect(authority[0]).toMatchObject({
      receipt_id: receipt.receiptId,
      user_message_id: receipt.userMessageId,
      agent_run_id: receipt.agentRunId,
      position: receipt.threadPosition,
      content: "Hello, Oz",
      event_type: "UserMessageAppended",
      event_payload: {
        agentRunId: receipt.agentRunId,
        content: [{ type: "text", text: "Hello, Oz" }],
        userMessageId: receipt.userMessageId,
      },
      run_state: "pending",
      execution_profile_ref: executionProfileRef,
      reservation_state: "held",
      outbox_kind: "AgentRunPending",
    });
  });

  it("returns the original receipt after a lost response and under concurrent identical retries", async () => {
    const idempotencyKey = crypto.randomUUID();
    const originalReceipt = await accept(messageCommand({ idempotencyKey }));

    const retries = await Promise.all([
      accept(messageCommand({ idempotencyKey })),
      accept(messageCommand({ idempotencyKey })),
    ]);
    expect(retries).toEqual([originalReceipt, originalReceipt]);
    expect(await authorityCounts()).toEqual({
      receipts: "1",
      messages: "1",
      events: "1",
      runs: "1",
      reservations: "1",
      outbox: "1",
    });
  });

  it("rejects changed content under the same idempotency key without changing authority", async () => {
    const idempotencyKey = crypto.randomUUID();
    await accept(messageCommand({ idempotencyKey }));

    const error = await reject(messageCommand({ idempotencyKey, content: "Changed" }));
    expect(error).toMatchObject({ _tag: "IdempotencyConflict" });
    expect(await authorityCounts()).toEqual({
      receipts: "1",
      messages: "1",
      events: "1",
      runs: "1",
      reservations: "1",
      outbox: "1",
    });
  });

  it("rejects a changed Thread under the same idempotency key as a conflict", async () => {
    const idempotencyKey = crypto.randomUUID();
    await accept(messageCommand({ idempotencyKey }));

    const error = await reject(messageCommand({ idempotencyKey, threadId: bobThreadId }));
    expect(error).toMatchObject({ _tag: "IdempotencyConflict" });
  });

  it("makes an unauthorized Thread indistinguishable from an unknown Thread", async () => {
    const unauthorized = await reject(messageCommand({ threadId: bobThreadId }));
    const unknown = await reject(messageCommand({ threadId: unknownThreadId }));

    expect(unauthorized).toMatchObject({ _tag: "ThreadNotFound" });
    expect(unknown).toEqual(unauthorized);
    expect(await authorityCounts()).toEqual({
      receipts: "0",
      messages: "0",
      events: "0",
      runs: "0",
      reservations: "0",
      outbox: "0",
    });
  });

  it("rejects an unknown authentication token without creating authority", async () => {
    const error = await reject(messageCommand({ token: "unknown-session-token" }));

    expect(error).toMatchObject({ _tag: "AuthenticationRejected" });
    expect(await authorityCounts()).toEqual({
      receipts: "0",
      messages: "0",
      events: "0",
      runs: "0",
      reservations: "0",
      outbox: "0",
    });
  });

  it("rejects over-Principal-capacity commands before creating authority", async () => {
    await accept(messageCommand());

    const capacity = await reject(
      messageCommand({
        threadId: aliceSecondThreadId,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(capacity).toMatchObject({ _tag: "CapacityRejected", scope: "principal" });
    expect(await authorityCounts()).toEqual({
      receipts: "1",
      messages: "1",
      events: "1",
      runs: "1",
      reservations: "1",
      outbox: "1",
    });
  });

  it("rejects global capacity after different Principals consume every reservation", async () => {
    await accept(messageCommand());
    await accept(
      messageCommand({
        threadId: bobThreadId,
        token: bobToken,
      }),
    );

    const error = await reject(
      messageCommand({ threadId: aliceSecondThreadId, idempotencyKey: crypto.randomUUID() }),
    );
    expect(error).toMatchObject({ _tag: "CapacityRejected", scope: "global" });
    expect(await authorityCounts()).toEqual({
      receipts: "2",
      messages: "2",
      events: "2",
      runs: "2",
      reservations: "2",
      outbox: "2",
    });
  });

  it("enforces Principal and Thread correlation across the authority graph", async () => {
    await accept(messageCommand());

    await expect(
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE outbox_obligations
            SET principal_id = ${bobPrincipalId}::uuid,
                thread_id = ${bobThreadId}::uuid`;
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE agent_run_capacity_reservations
            SET principal_id = ${bobPrincipalId}::uuid`;
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("makes accepted receipts, messages, and Thread events immutable", async () => {
    await accept(messageCommand());

    for (const mutation of [
      "UPDATE acceptance_receipts SET accepted_at = accepted_at",
      "DELETE FROM acceptance_receipts",
      "UPDATE user_messages SET content = content",
      "DELETE FROM user_messages",
      "UPDATE thread_events SET payload = payload",
      "DELETE FROM thread_events",
    ]) {
      await expect(
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(mutation);
          }),
        ),
      ).rejects.toBeDefined();
    }
  });

  it("rolls back every write and reports a definite rejection as unavailable", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`
          CREATE FUNCTION fail_message_admission() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'injected admission failure';
          END;
          $$;
          CREATE TRIGGER fail_message_admission
          BEFORE INSERT ON outbox_obligations
          FOR EACH ROW EXECUTE FUNCTION fail_message_admission();
        `);
      }),
    );

    const error = await reject(messageCommand());
    expect(error).toMatchObject({ _tag: "AdmissionUnavailable" });
    expect(await authorityCounts()).toEqual({
      receipts: "0",
      messages: "0",
      events: "0",
      runs: "0",
      reservations: "0",
      outbox: "0",
    });

    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`
          DROP TRIGGER fail_message_admission ON outbox_obligations;
          DROP FUNCTION fail_message_admission();
        `);
      }),
    );
  });
});
