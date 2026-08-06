import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  authenticationSessions,
  principals,
  threads,
} from "./schema.js";

export interface MessageAdmissionFixture {
  readonly principals: ReadonlyArray<{
    readonly principalId: string;
    readonly authenticationToken: string;
    readonly threadIds: ReadonlyArray<string>;
  }>;
}

export interface MessageAuthorityCounts extends Record<string, unknown> {
  readonly receipts: string;
  readonly messages: string;
  readonly runs: string;
  readonly outbox: string;
}

const withTestDatabase = <A, E>(
  databaseUrl: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
) =>
  effect.pipe(
    Effect.provide(
      PgClient.layer({
        applicationName: "osfo-database-test-support",
        url: Redacted.make(databaseUrl),
      }),
    ),
  );

export const prepareMessageAdmissionFixture = (
  databaseUrl: string,
  fixture: MessageAdmissionFixture,
) =>
  withTestDatabase(
    databaseUrl,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();
      yield* db.execute(sql`TRUNCATE TABLE
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
        CASCADE`);

      for (const principal of fixture.principals) {
        yield* db.insert(principals).values({ principalId: principal.principalId });
        yield* db.insert(authenticationSessions).values({
          sessionId: randomUUID(),
          principalId: principal.principalId,
          tokenSha256: createHash("sha256").update(principal.authenticationToken).digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        });
        if (principal.threadIds.length > 0) {
          yield* db.insert(threads).values(
            principal.threadIds.map((threadId) => ({
              threadId,
              principalId: principal.principalId,
            })),
          );
        }
        yield* db.insert(admissionPrincipalCapacity).values({
          principalId: principal.principalId,
          reservedCount: 0,
        });
      }
      yield* db.insert(admissionGlobalCapacity).values({ singleton: true, reservedCount: 0 });
    }),
  );

export const readMessageAuthorityCounts = (databaseUrl: string) =>
  withTestDatabase(
    databaseUrl,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();
      const [counts] = yield* db
        .select({
          receipts: sql<string>`(SELECT count(*) FROM acceptance_receipts)::text`,
          messages: sql<string>`(SELECT count(*) FROM user_messages)::text`,
          runs: sql<string>`(SELECT count(*) FROM agent_runs)::text`,
          outbox: sql<string>`(SELECT count(*) FROM outbox_obligations)::text`,
        })
        .from(admissionGlobalCapacity)
        .limit(1);
      if (counts === undefined) {
        return yield* Effect.fail(new Error("Database did not return authority counts"));
      }
      return counts;
    }),
  );
