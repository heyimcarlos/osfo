import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { and, eq, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  admissionGlobalCapacity,
  admissionPrincipalCapacity,
  acceptanceReceipts,
  agentRunCapacityReservations,
  agentRuns,
  authenticationSessions,
  principals,
  threadEvents,
  threads,
  userMessages,
} from "./schema.js";

export interface MessageAdmissionFixture {
  readonly principals: ReadonlyArray<{
    readonly principalId: string;
    readonly authenticationToken: string;
    readonly threadIds: ReadonlyArray<string>;
  }>;
}

export class MessageAuthorityCountsUnavailable extends Data.TaggedError(
  "MessageAuthorityCountsUnavailable",
) {}

export class ReferenceJourneyAuthorityUnavailable extends Data.TaggedError(
  "ReferenceJourneyAuthorityUnavailable",
) {}

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
        return yield* new MessageAuthorityCountsUnavailable();
      }
      return counts;
    }),
  );

export type MessageAuthorityCounts = Effect.Success<ReturnType<typeof readMessageAuthorityCounts>>;

export interface ReferenceJourneyAuthorityRequest {
  readonly agentRunId: string;
  readonly receiptId: string;
  readonly threadId: string;
  readonly userMessageId: string;
}

export const readReferenceJourneyAuthority = (
  databaseUrl: string,
  request: ReferenceJourneyAuthorityRequest,
) =>
  withTestDatabase(
    databaseUrl,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();
      const [facts] = yield* db
        .select({
          acceptanceReceipts: sql<string>`(
            SELECT count(*) FROM ${acceptanceReceipts} receipt
            WHERE receipt.receipt_id = ${request.receiptId}::uuid
              AND receipt.agent_run_id = ${request.agentRunId}::uuid
              AND receipt.user_message_id = ${request.userMessageId}::uuid
          )::text`,
          agentRunState: agentRuns.state,
          agentRuns: sql<string>`(
            SELECT count(*) FROM ${agentRuns} counted_run
            WHERE counted_run.agent_run_id = ${request.agentRunId}::uuid
              AND counted_run.thread_id = ${request.threadId}::uuid
          )::text`,
          globalReserved: admissionGlobalCapacity.reservedCount,
          principalId: agentRuns.principalId,
          principalReserved: admissionPrincipalCapacity.reservedCount,
          reservationState: agentRunCapacityReservations.state,
          terminalEvents: sql<string>`(
            SELECT count(*) FROM ${threadEvents} terminal_event
            WHERE terminal_event.agent_run_id = ${request.agentRunId}::uuid
              AND terminal_event.event_type IN ('AgentRunSucceeded', 'AgentRunFailed')
          )::text`,
          userMessages: sql<string>`(
            SELECT count(*) FROM ${userMessages} counted_message
            WHERE counted_message.user_message_id = ${request.userMessageId}::uuid
              AND counted_message.thread_id = ${request.threadId}::uuid
          )::text`,
        })
        .from(agentRuns)
        .innerJoin(
          agentRunCapacityReservations,
          eq(agentRunCapacityReservations.agentRunId, agentRuns.agentRunId),
        )
        .innerJoin(
          admissionPrincipalCapacity,
          eq(admissionPrincipalCapacity.principalId, agentRuns.principalId),
        )
        .innerJoin(admissionGlobalCapacity, eq(admissionGlobalCapacity.singleton, true))
        .where(
          and(
            eq(agentRuns.agentRunId, request.agentRunId),
            eq(agentRuns.threadId, request.threadId),
          ),
        );
      if (facts === undefined) return yield* new ReferenceJourneyAuthorityUnavailable();

      const events = yield* db
        .select({ eventType: threadEvents.eventType, position: threadEvents.position })
        .from(threadEvents)
        .where(
          and(
            eq(threadEvents.agentRunId, request.agentRunId),
            eq(threadEvents.threadId, request.threadId),
          ),
        )
        .orderBy(threadEvents.position);

      return {
        ...facts,
        eventTypes: events.map((event) => event.eventType),
        threadPositions: events.map((event) => String(event.position)),
      };
    }),
  );
