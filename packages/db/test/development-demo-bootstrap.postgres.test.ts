import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  AuthenticationRejected,
  DevelopmentBootstrapRejected,
  DevelopmentDemoBootstrap,
  MessageAdmission,
  ThreadNotFound,
  type SubmitMessageCommand,
} from "@osfo/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  createDevelopmentDemoAuthority,
  makeDevelopmentDemoBootstrapLayer,
  makeMessageAdmissionLayer,
} from "../src/index.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const accessCode = "password";
const accessCodeSha256 = "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8";
const databaseLayer = PgClient.layer({
  applicationName: "osfo-development-demo-bootstrap-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    databaseLayer,
    makeDevelopmentDemoBootstrapLayer({ accessCodeSha256, databaseUrl, maxAttempts: 100 }),
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.development-demo.test.v1",
      globalNonTerminalLimit: 10,
      maxConnections: 8,
      principalNonTerminalLimit: 2,
    }),
  ),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, DevelopmentDemoBootstrap | MessageAdmission | SqlClient.SqlClient>,
) => runtime.runPromise(effect);

const createSession = () =>
  run(DevelopmentDemoBootstrap.use((bootstrap) => bootstrap.create({ accessCode })));

const command = (authenticationToken: string, threadId: string): SubmitMessageCommand => ({
  authenticationToken,
  idempotencyKey: crypto.randomUUID(),
  message: { content: "Development demo bootstrap verification" },
  protocolVersion: 1,
  threadId,
});

beforeEach(() =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE
        admission_principal_capacity,
        authentication_sessions,
        threads,
        principals,
        admission_global_capacity
        CASCADE`;
    }),
  ),
);

afterAll(() => runtime.dispose());

describe("PostgreSQL development demo bootstrap", () => {
  it("creates a fresh usable authority while persisting only the bearer hash", async () => {
    const session = await createSession();
    const receipt = await run(
      MessageAdmission.use((admission) =>
        admission.accept(command(session.authenticationToken, session.threadId)),
      ),
    );
    const authority = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly principal_capacity_count: string;
          readonly principal_id: string;
          readonly session_count: string;
          readonly thread_count: string;
          readonly token_sha256: string;
        }>`SELECT
          authentication_sessions.principal_id::text,
          authentication_sessions.token_sha256,
          (SELECT count(*) FROM authentication_sessions)::text AS session_count,
          (SELECT count(*) FROM threads)::text AS thread_count,
          (SELECT count(*) FROM admission_principal_capacity)::text AS principal_capacity_count
        FROM authentication_sessions`;
        return rows[0];
      }),
    );

    expect(session).toMatchObject({
      productionQualification: "MISSING",
      protocolVersion: 1,
      scope: "development",
    });
    expect(receipt.threadId).toBe(session.threadId);
    expect(authority).toMatchObject({
      principal_capacity_count: "1",
      session_count: "1",
      thread_count: "1",
      token_sha256: createHash("sha256").update(session.authenticationToken).digest("hex"),
    });
    expect(JSON.stringify(authority)).not.toContain(session.authenticationToken);
    expect(JSON.stringify(authority)).not.toContain(accessCode);
  });

  it("isolates every generated bearer to its own Principal and Thread", async () => {
    const first = await createSession();
    const second = await createSession();

    const firstToSecond = await run(
      MessageAdmission.use((admission) =>
        admission.accept(command(first.authenticationToken, second.threadId)),
      ).pipe(Effect.flip),
    );
    const secondToFirst = await run(
      MessageAdmission.use((admission) =>
        admission.accept(command(second.authenticationToken, first.threadId)),
      ).pipe(Effect.flip),
    );
    const counts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly principals: string;
          readonly sessions: string;
          readonly threads: string;
        }>`SELECT
          (SELECT count(*) FROM principals)::text AS principals,
          (SELECT count(*) FROM authentication_sessions)::text AS sessions,
          (SELECT count(*) FROM threads)::text AS threads`;
        return rows[0];
      }),
    );

    expect(first.authenticationToken).not.toBe(second.authenticationToken);
    expect(first.threadId).not.toBe(second.threadId);
    expect(firstToSecond).toEqual(new ThreadNotFound());
    expect(secondToFirst).toEqual(new ThreadNotFound());
    expect(counts).toEqual({ principals: "2", sessions: "2", threads: "2" });
  });

  it("rejects an invalid access code without mutating authority tables", async () => {
    const failure = await run(
      DevelopmentDemoBootstrap.use((bootstrap) => bootstrap.create({ accessCode: "invalid" })).pipe(
        Effect.flip,
      ),
    );
    const counts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly principals: string;
          readonly sessions: string;
          readonly threads: string;
        }>`SELECT
          (SELECT count(*) FROM principals)::text AS principals,
          (SELECT count(*) FROM authentication_sessions)::text AS sessions,
          (SELECT count(*) FROM threads)::text AS threads`;
        return rows[0];
      }),
    );

    expect(failure).toEqual(new DevelopmentBootstrapRejected());
    expect(counts).toEqual({ principals: "0", sessions: "0", threads: "0" });
  });

  it("persists expired credentials but rejects them at the authentication boundary", async () => {
    const expired = await Effect.runPromise(
      createDevelopmentDemoAuthority({
        databaseUrl,
        now: new Date("2020-01-01T00:00:00.000Z"),
      }),
    );
    const failure = await run(
      MessageAdmission.use((admission) =>
        admission.accept(command(expired.authenticationToken, expired.threadId)),
      ).pipe(Effect.flip),
    );

    expect(new Date(expired.expiresAt).getTime()).toBeLessThan(Date.now());
    expect(failure).toEqual(new AuthenticationRejected());
  });
});
