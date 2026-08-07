import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
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
  assistantOutputs,
  authenticationSessions,
  modelCallAttempts,
  modelCallFragments,
  modelCalls,
  outboxObligations,
  principals,
  relayDispatchCapacity,
  relayPrincipals,
  relayPublicationAttempts,
  relayPublicationTasks,
  relayThreads,
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
        admission_rejections,
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

export const readReferenceJourneyAuthority = (databaseUrl: string) =>
  withTestDatabase(
    databaseUrl,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();
      const principalRows = yield* db
        .select({ principalId: principals.principalId })
        .from(principals)
        .orderBy(principals.principalId);
      const threadRows = yield* db
        .select({ principalId: threads.principalId, threadId: threads.threadId })
        .from(threads)
        .orderBy(threads.threadId);
      const sessionRows = yield* db
        .select({ principalId: authenticationSessions.principalId })
        .from(authenticationSessions)
        .orderBy(authenticationSessions.sessionId);
      const receiptRows = yield* db
        .select({
          agentRunId: acceptanceReceipts.agentRunId,
          idempotencyKey: acceptanceReceipts.idempotencyKey,
          principalId: acceptanceReceipts.principalId,
          protocolVersion: acceptanceReceipts.protocolVersion,
          receiptId: acceptanceReceipts.receiptId,
          threadId: acceptanceReceipts.threadId,
          threadPosition: acceptanceReceipts.threadPosition,
          userMessageId: acceptanceReceipts.userMessageId,
        })
        .from(acceptanceReceipts)
        .orderBy(acceptanceReceipts.threadPosition);
      const messageRows = yield* db
        .select({
          content: userMessages.content,
          principalId: userMessages.principalId,
          threadId: userMessages.threadId,
          userMessageId: userMessages.userMessageId,
        })
        .from(userMessages)
        .orderBy(userMessages.userMessageId);
      const runRows = yield* db
        .select({
          agentRunId: agentRuns.agentRunId,
          executionProfileRef: agentRuns.executionProfileRef,
          principalId: agentRuns.principalId,
          state: agentRuns.state,
          threadId: agentRuns.threadId,
          userMessageId: agentRuns.userMessageId,
        })
        .from(agentRuns)
        .orderBy(agentRuns.agentRunId);
      const reservationRows = yield* db
        .select({
          agentRunId: agentRunCapacityReservations.agentRunId,
          principalId: agentRunCapacityReservations.principalId,
          state: agentRunCapacityReservations.state,
        })
        .from(agentRunCapacityReservations)
        .orderBy(agentRunCapacityReservations.agentRunId);
      const eventRows = yield* db
        .select({
          agentRunId: threadEvents.agentRunId,
          eventId: threadEvents.eventId,
          eventType: threadEvents.eventType,
          position: threadEvents.position,
          principalId: threadEvents.principalId,
          threadId: threadEvents.threadId,
          userMessageId: threadEvents.userMessageId,
        })
        .from(threadEvents)
        .orderBy(threadEvents.position);
      const outboxRows = yield* db
        .select({
          agentRunId: outboxObligations.agentRunId,
          outboxId: outboxObligations.outboxId,
          principalId: outboxObligations.principalId,
          publicationEvidence: outboxObligations.publicationEvidence,
          publishedAt: outboxObligations.publishedAt,
          threadId: outboxObligations.threadId,
        })
        .from(outboxObligations)
        .orderBy(outboxObligations.outboxId);
      const relayPrincipalRows = yield* db
        .select({ principalId: relayPrincipals.principalId })
        .from(relayPrincipals)
        .orderBy(relayPrincipals.principalId);
      const relayThreadRows = yield* db
        .select({ principalId: relayThreads.principalId, threadId: relayThreads.threadId })
        .from(relayThreads)
        .orderBy(relayThreads.threadId);
      const relayDispatchCapacityRows = yield* db
        .select({ activeCount: relayDispatchCapacity.activeCount })
        .from(relayDispatchCapacity);
      const relayTaskRows = yield* db
        .select({ outboxId: relayPublicationTasks.outboxId })
        .from(relayPublicationTasks)
        .orderBy(relayPublicationTasks.outboxId);
      const relayAttemptRows = yield* db
        .select({
          outboxId: relayPublicationAttempts.outboxId,
          providerMessageId: relayPublicationAttempts.providerMessageId,
          publicationEpoch: relayPublicationAttempts.publicationEpoch,
          publicationOwner: relayPublicationAttempts.publicationOwner,
          state: relayPublicationAttempts.state,
        })
        .from(relayPublicationAttempts)
        .orderBy(relayPublicationAttempts.outboxId, relayPublicationAttempts.publicationEpoch);
      const assistantOutputRows = yield* db
        .select({
          agentRunId: assistantOutputs.agentRunId,
          assistantOutputId: assistantOutputs.assistantOutputId,
          state: assistantOutputs.state,
        })
        .from(assistantOutputs)
        .orderBy(assistantOutputs.assistantOutputId);
      const modelCallRows = yield* db
        .select({
          agentRunId: modelCalls.agentRunId,
          modelCallId: modelCalls.modelCallId,
          state: modelCalls.state,
        })
        .from(modelCalls)
        .orderBy(modelCalls.modelCallId);
      const modelCallAttemptRows = yield* db
        .select({
          agentRunId: modelCallAttempts.agentRunId,
          assistantOutputId: modelCallAttempts.assistantOutputId,
          attemptNumber: modelCallAttempts.attemptNumber,
          claimEpoch: modelCallAttempts.claimEpoch,
          modelCallAttemptId: modelCallAttempts.modelCallAttemptId,
          modelCallId: modelCallAttempts.modelCallId,
          state: modelCallAttempts.state,
        })
        .from(modelCallAttempts)
        .orderBy(modelCallAttempts.modelCallAttemptId);
      const modelCallFragmentRows = yield* db
        .select({
          agentRunId: modelCallFragments.agentRunId,
          assistantOutputId: modelCallFragments.assistantOutputId,
          fragmentIndex: modelCallFragments.fragmentIndex,
          modelCallAttemptId: modelCallFragments.modelCallAttemptId,
          modelCallId: modelCallFragments.modelCallId,
          text: modelCallFragments.text,
          threadEventId: modelCallFragments.threadEventId,
        })
        .from(modelCallFragments)
        .orderBy(modelCallFragments.modelCallAttemptId, modelCallFragments.fragmentIndex);
      const globalCapacityRows = yield* db
        .select({ reservedCount: admissionGlobalCapacity.reservedCount })
        .from(admissionGlobalCapacity);
      const principalCapacityRows = yield* db
        .select({
          principalId: admissionPrincipalCapacity.principalId,
          reservedCount: admissionPrincipalCapacity.reservedCount,
        })
        .from(admissionPrincipalCapacity)
        .orderBy(admissionPrincipalCapacity.principalId);

      return {
        agentRuns: runRows,
        assistantOutputs: assistantOutputRows,
        authenticationSessions: sessionRows,
        events: eventRows.map((event) => ({ ...event, position: String(event.position) })),
        globalCapacities: globalCapacityRows,
        modelCallAttempts: modelCallAttemptRows.map((attempt) => ({
          ...attempt,
          claimEpoch: String(attempt.claimEpoch),
        })),
        modelCallFragments: modelCallFragmentRows,
        modelCalls: modelCallRows,
        outbox: outboxRows.map(({ publishedAt, ...obligation }) => ({
          ...obligation,
          published: publishedAt !== null,
        })),
        principalCapacities: principalCapacityRows,
        principals: principalRows,
        relayDispatchCapacities: relayDispatchCapacityRows,
        relayPrincipals: relayPrincipalRows,
        relayPublicationAttempts: relayAttemptRows.map((attempt) => ({
          ...attempt,
          publicationEpoch: String(attempt.publicationEpoch),
        })),
        relayPublicationTasks: relayTaskRows,
        relayThreads: relayThreadRows,
        receipts: receiptRows.map((receipt) => ({
          ...receipt,
          threadPosition: String(receipt.threadPosition),
        })),
        reservations: reservationRows,
        threads: threadRows,
        userMessages: messageRows,
      };
    }),
  );
