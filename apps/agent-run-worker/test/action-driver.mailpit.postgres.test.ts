import { NodeHttpClient } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  ActionApplicationPolicy,
  ActionAuthorization,
  ActionDriver,
  makeActionDriverLayer,
} from "@osfo/agent-run";
import { makeActionRepositoryLayer } from "@osfo/db";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeMailpitActionAdapterLayer } from "../src/mailpit-action-adapter.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}
const mailpitEnabled = process.env.OSFO_TEST_MAILPIT === "1";
const apiOrigin = process.env.OSFO_TEST_MAILPIT_API_ORIGIN ?? "http://127.0.0.1:18025";
const smtpPort = Number(process.env.OSFO_TEST_MAILPIT_SMTP_PORT ?? "11025");

const principalId = "8f08ec7e-bdc1-456b-b09d-a6ab0a8e6f40";
const threadId = "99dc1679-78cd-4813-8d3f-61c36b179e4c";
const userMessageId = "e547e6bd-4ee7-4850-98d4-b647a0d27ecf";
const agentRunId = "85103d40-229e-4893-b976-611e8f05a7dc";
const toolCallId = "tool_e584fbb0-7ad7-48e9-a0cb-21ac07110271";
const fence = { agentRunId, claimEpoch: "1", workerId: "mailpit-action-worker" } as const;
const request = {
  agentRunId,
  runtimeGate: "permit",
  subject: "Durable local Action evidence",
  toolCallId,
} as const;

const databaseLayer = PgClient.layer({
  applicationName: "osfo-action-mailpit-postgres-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});
const databaseRuntime = ManagedRuntime.make(databaseLayer);
const runDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  databaseRuntime.runPromise(effect);

const repositoryLayer = makeActionRepositoryLayer({ databaseUrl, maxConnections: 8 });
const adapterLayer = makeMailpitActionAdapterLayer({
  apiOrigin,
  fault: "loseDataAcknowledgement",
  requestTimeoutMs: 2_000,
  smtpHost: "127.0.0.1",
  smtpPort,
}).pipe(Layer.provide(NodeHttpClient.layerUndici));
const driverLayer = makeActionDriverLayer().pipe(
  Layer.provideMerge(repositoryLayer),
  Layer.provideMerge(
    Layer.succeed(ActionApplicationPolicy)({ gate: () => Effect.succeed("requireApproval") }),
  ),
  Layer.provideMerge(
    Layer.succeed(ActionAuthorization)({
      current: () => Effect.succeed({ authorized: true, revision: "mailpit-demo-auth-v1" }),
    }),
  ),
  Layer.provideMerge(adapterLayer),
);

const clearMailpit = HttpClient.HttpClient.use((client) =>
  client
    .pipe(HttpClient.filterStatusOk)
    .execute(HttpClientRequest.make("DELETE")(`${apiOrigin}/api/v1/messages`))
    .pipe(Effect.flatMap((response) => response.text)),
).pipe(Effect.provide(NodeHttpClient.layerUndici));

describe.runIf(mailpitEnabled)("durable PostgreSQL to Mailpit Action path", () => {
  beforeEach(async () => {
    await Effect.runPromise(clearMailpit);
    await runDatabase(
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
            'send the controlled demo email', transaction_timestamp()
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
    );
  });

  afterAll(() => databaseRuntime.dispose());

  it.live("recovers a lost acknowledgement through the durable uncertain attempt", () =>
    ActionDriver.use((driver) =>
      Effect.gen(function* () {
        const waiting = yield* driver.drive(fence, request);
        if (waiting.type !== "waitingApproval") return yield* Effect.die("approval missing");
        yield* driver.decideApproval({
          approvalRequestId: waiting.approvalRequest.approvalRequestId,
          decision: "approved",
          decisionId: "f53d62f6-fe17-4815-bd32-627d77993ebf",
          toolCallId,
        });
        expect(yield* driver.drive(fence, request)).toEqual({ type: "reconcileRequired" });
        const terminal = yield* driver.drive(fence, request);
        const evidence = yield* Effect.promise(() =>
          runDatabase(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return (yield* sql<{
                readonly attempts: number;
                readonly receipts: number;
              }>`SELECT
                (SELECT count(*)::int FROM action_attempts) AS attempts,
                (SELECT count(*)::int FROM action_receipts) AS receipts`)[0];
            }),
          ),
        );

        expect(terminal).toMatchObject({ type: "terminal", receipt: { outcome: "applied" } });
        expect(evidence).toEqual({ attempts: 1, receipts: 1 });
      }),
    ).pipe(Effect.provide(driverLayer)),
  );
});
