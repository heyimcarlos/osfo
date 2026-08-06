import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MessageAdmission,
  handleNativeThreadRequest,
  submitThreadMessage,
} from "@osfo/native-thread-transport";
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

const messageRequest = (
  options: {
    readonly content?: string;
    readonly idempotencyKey?: string;
    readonly threadId?: string;
    readonly token?: string;
    readonly extraBody?: Record<string, unknown>;
  } = {},
) =>
  new Request(`http://localhost/v1/threads/${options.threadId ?? aliceThreadId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? aliceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: 1,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      message: { content: options.content ?? "Hello, Oz" },
      ...options.extraBody,
    }),
  });

const submit = (request: Request) => run(handleNativeThreadRequest(request));

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
    const response = await submit(messageRequest({ idempotencyKey }));
    const receipt = (await response.json()) as {
      readonly receiptId: string;
      readonly userMessageId: string;
      readonly agentRunId: string;
      readonly threadPosition: string;
    };

    expect(response.status).toBe(200);
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
    const first = await submit(messageRequest({ idempotencyKey }));
    const originalReceipt = await first.json();

    const retries = await Promise.all([
      submit(messageRequest({ idempotencyKey })),
      submit(messageRequest({ idempotencyKey })),
    ]);
    expect(retries.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(retries.map((response) => response.json()))).toEqual([
      originalReceipt,
      originalReceipt,
    ]);
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
    expect((await submit(messageRequest({ idempotencyKey }))).status).toBe(200);

    const response = await submit(messageRequest({ idempotencyKey, content: "Changed" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      type: "idempotency_conflict",
      title: "Idempotency conflict",
      retryable: false,
    });
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
    expect((await submit(messageRequest({ idempotencyKey }))).status).toBe(200);

    const response = await submit(messageRequest({ idempotencyKey, threadId: bobThreadId }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ type: "idempotency_conflict" });
  });

  it("makes an unauthorized Thread indistinguishable from an unknown Thread", async () => {
    const unauthorized = await submit(messageRequest({ threadId: bobThreadId }));
    const unknown = await submit(messageRequest({ threadId: unknownThreadId }));

    expect(unauthorized.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await unauthorized.json()).toEqual(await unknown.json());
    expect(await authorityCounts()).toEqual({
      receipts: "0",
      messages: "0",
      events: "0",
      runs: "0",
      reservations: "0",
      outbox: "0",
    });
  });

  it("rejects malformed and over-Principal-capacity commands before creating authority", async () => {
    const malformed = await submit(messageRequest({ extraBody: { unexpected: true } }));
    expect(malformed.status).toBe(400);
    expect((await submit(messageRequest())).status).toBe(200);

    const capacity = await submit(
      messageRequest({
        threadId: aliceSecondThreadId,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(capacity.status).toBe(429);
    expect(await capacity.json()).toEqual({
      protocolVersion: 1,
      type: "capacity_rejected",
      title: "Capacity rejected",
      retryable: true,
    });
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
    expect((await submit(messageRequest())).status).toBe(200);
    expect(
      (
        await submit(
          messageRequest({
            threadId: bobThreadId,
            token: bobToken,
          }),
        )
      ).status,
    ).toBe(200);

    const response = await submit(
      messageRequest({ threadId: aliceSecondThreadId, idempotencyKey: crypto.randomUUID() }),
    );
    expect(response.status).toBe(429);
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
    expect((await submit(messageRequest())).status).toBe(200);

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
    expect((await submit(messageRequest())).status).toBe(200);

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

    const response = await submit(messageRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      type: "admission_unavailable",
      title: "Admission unavailable",
      retryable: true,
    });
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

  it("types a lost browser response as unknown commit and reconciles by retry", async () => {
    const idempotencyKey = crypto.randomUUID();
    const command = {
      endpoint: `http://localhost/v1/threads/${aliceThreadId}/messages`,
      authenticationToken: aliceToken,
      threadId: aliceThreadId,
      idempotencyKey,
      message: { content: "Unknown response" },
    } as const;

    const unknown = await Effect.runPromise(
      Effect.flip(
        submitThreadMessage(command, async (request) => {
          await submit(request);
          throw new TypeError("response connection lost");
        }),
      ),
    );
    expect(unknown._tag).toBe("CommitUnknown");

    const receipt = await Effect.runPromise(
      submitThreadMessage(command, (request) => submit(request)),
    );
    expect(receipt).toMatchObject({ idempotencyKey, threadId: aliceThreadId });
    expect(await authorityCounts()).toEqual({
      receipts: "1",
      messages: "1",
      events: "1",
      runs: "1",
      reservations: "1",
      outbox: "1",
    });
  });
});
