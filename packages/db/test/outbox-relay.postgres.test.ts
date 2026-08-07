import { createHash, randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  AgentRunRepository,
  OutboxRelay,
  OutboxRelayWake,
  RunnableDeliveryPublisher,
  RunnableDeliveryPublisherUnavailable,
  makeOutboxRelayLayer,
} from "@osfo/agent-run";
import { MessageAdmission } from "@osfo/api";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeAgentRunRepositoryLayer, makeMessageAdmissionLayer } from "../src/index.js";
import { OUTBOX_RELAY_SELECTOR_LOCK_ID } from "../src/outbox-relay-wake.js";

const databaseUrl = process.env.OSFO_TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("OSFO_TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const noisyPrincipalId = "46d31756-595b-4b62-a535-94e37c8c6d6c";
const quietPrincipalId = "39689877-e987-40a0-ac11-ffc5fc771a8a";
const noisyAuthenticationToken = "noisy-relay-token";
const quietAuthenticationToken = "quiet-relay-token";
const noisyThreadIds = [
  "8d8ef529-5145-40c7-b6ce-3264041a24e6",
  "6854343f-20c1-4741-8641-62f0591d7b94",
  "541a0d64-0055-4723-8f4e-2df04fddde48",
  "f2724a8d-770e-47d4-89f6-6ae6cc7ddbc8",
  "ef5d464a-9b0b-48b8-9cce-fe1405e5b595",
  "d163f3d3-fb5f-4bb3-b860-3ffbd84d1911",
  "52bf8e38-aa43-463f-a88b-ac302ccaf77d",
  "6a67ee3a-866d-4017-be08-ad66e892a80e",
] as const;
const quietThreadId = "e7f65cb8-8795-4134-9899-733713fbd49b";

const publishedAgentRunIds: Array<string> = [];
let failBeforePublish = false;
let failAfterPublish = false;
let publicationBlock:
  | {
      readonly release: Deferred.Deferred<void>;
      readonly started: Deferred.Deferred<void>;
    }
  | undefined;

const databaseLayer = PgClient.layer({
  applicationName: "osfo-outbox-relay-test",
  maxConnections: 8,
  url: Redacted.make(databaseUrl),
});
const repositoryLayer = makeAgentRunRepositoryLayer({ databaseUrl, maxConnections: 8 });
const publisherLayer = Layer.succeed(RunnableDeliveryPublisher)(
  RunnableDeliveryPublisher.of({
    publish: (delivery) =>
      Effect.gen(function* () {
        if (failBeforePublish) {
          failBeforePublish = false;
          return yield* new RunnableDeliveryPublisherUnavailable({ cause: "loss before publish" });
        }
        if (publicationBlock !== undefined) {
          yield* Deferred.succeed(publicationBlock.started, undefined);
          yield* Deferred.await(publicationBlock.release);
        }
        publishedAgentRunIds.push(delivery.agentRunId);
        if (failAfterPublish) {
          failAfterPublish = false;
          return yield* new RunnableDeliveryPublisherUnavailable({
            cause: "loss after provider confirmation",
          });
        }
        return { providerMessageId: `pubsub-${publishedAgentRunIds.length}` };
      }),
  }),
);
const relayLayer = makeOutboxRelayLayer({
  relayId: "production-relay",
  leaseDurationMs: 30_000,
  publicationWindowSize: 4,
}).pipe(Layer.provide(repositoryLayer), Layer.provide(publisherLayer));
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    databaseLayer,
    repositoryLayer,
    relayLayer,
    makeMessageAdmissionLayer({
      databaseUrl,
      executionProfileRef: "oz.deterministic.v1",
      globalNonTerminalLimit: 16,
      maxConnections: 8,
      principalNonTerminalLimit: 16,
    }),
  ),
);

type TestServices =
  | AgentRunRepository
  | MessageAdmission
  | OutboxRelay
  | OutboxRelayWake
  | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, TestServices>) => runtime.runPromise(effect);

const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

const publicationAuthority = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        readonly activeTasks: number;
        readonly dispatchActive: number;
        readonly unpublished: number;
      }>`SELECT
        (SELECT count(*)::int FROM relay_publication_tasks) AS "activeTasks",
        (SELECT active_count FROM relay_dispatch_capacity
          WHERE singleton = true) AS "dispatchActive",
        (SELECT count(*)::int FROM outbox_obligations
          WHERE published_at IS NULL) AS unpublished`;
      return row;
    }),
  );

const seedAuthority = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE TABLE principals, admission_global_capacity,
        relay_dispatch_capacity CASCADE`;
      yield* sql`INSERT INTO principals (principal_id) VALUES
        (${noisyPrincipalId}::uuid), (${quietPrincipalId}::uuid)`;
      yield* sql`INSERT INTO authentication_sessions
        (session_id, principal_id, token_sha256, expires_at) VALUES
        (${randomUUID()}::uuid, ${noisyPrincipalId}::uuid,
          ${tokenDigest(noisyAuthenticationToken)}, now() + interval '1 hour'),
        (${randomUUID()}::uuid, ${quietPrincipalId}::uuid,
          ${tokenDigest(quietAuthenticationToken)}, now() + interval '1 hour')`;
      yield* sql`INSERT INTO threads (thread_id, principal_id) VALUES
        (${noisyThreadIds[0]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[1]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[2]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[3]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[4]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[5]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[6]}::uuid, ${noisyPrincipalId}::uuid),
        (${noisyThreadIds[7]}::uuid, ${noisyPrincipalId}::uuid),
        (${quietThreadId}::uuid, ${quietPrincipalId}::uuid)`;
      yield* sql`INSERT INTO admission_global_capacity (singleton, reserved_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO relay_dispatch_capacity (singleton, active_count)
        VALUES (true, 0)`;
      yield* sql`INSERT INTO admission_principal_capacity (principal_id, reserved_count) VALUES
        (${noisyPrincipalId}::uuid, 0), (${quietPrincipalId}::uuid, 0)`;
    }),
  );

beforeEach(async () => {
  publishedAgentRunIds.length = 0;
  failBeforePublish = false;
  failAfterPublish = false;
  publicationBlock = undefined;
  await seedAuthority();
});

afterAll(() => runtime.dispose());

describe("concurrent Principal-first publication", () => {
  const accept = (authenticationToken: string, threadId: string, content: string) =>
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

  it("fills the publication window without letting one Principal's Threads crowd out another", async () => {
    const noisyReceipts = await Promise.all(
      noisyThreadIds
        .slice(0, 4)
        .map((threadId, index) => accept(noisyAuthenticationToken, threadId, `noisy ${index + 1}`)),
    );
    const quietReceipt = await accept(quietAuthenticationToken, quietThreadId, "quiet publication");

    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(
      OutboxRelay.use((relay) =>
        Effect.forEach([0, 1, 2, 3], () => relay.publishOnce(), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );

    expect(publishedAgentRunIds).toHaveLength(4);
    expect(publishedAgentRunIds).toContain(quietReceipt.agentRunId);
    expect(
      publishedAgentRunIds.filter((agentRunId) =>
        noisyReceipts.some((receipt) => receipt.agentRunId === agentRunId),
      ),
    ).toHaveLength(3);

    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(OutboxRelay.use((relay) => relay.publishOnce()));

    const authority = await publicationAuthority();

    expect(publishedAgentRunIds).toHaveLength(5);
    expect(authority).toEqual({ activeTasks: 0, dispatchActive: 0, unpublished: 0 });
  });

  it("advances a quiet Principal in every window while noisy Threads remain eligible", async () => {
    await Promise.all(
      noisyThreadIds.map((threadId, index) =>
        accept(noisyAuthenticationToken, threadId, `sustained noisy ${index + 1}`),
      ),
    );
    const quietReceipts = [];
    for (let index = 0; index < 4; index += 1) {
      quietReceipts.push(
        await accept(quietAuthenticationToken, quietThreadId, `quiet progress ${index + 1}`),
      );
    }

    for (const quietReceipt of quietReceipts) {
      await run(OutboxRelay.use((relay) => relay.selectOnce()));
      await run(
        OutboxRelay.use((relay) =>
          Effect.forEach([0, 1, 2, 3], () => relay.publishOnce(), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );
      expect(publishedAgentRunIds).toContain(quietReceipt.agentRunId);
    }

    const authority = await publicationAuthority();

    expect(publishedAgentRunIds).toHaveLength(12);
    expect(authority).toEqual({ activeTasks: 0, dispatchActive: 0, unpublished: 0 });
  });

  it("emits committed admission wakes, coalesces duplicates, and suppresses rolled-back hints", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const connected = yield* Deferred.make<void>();
          const notified = yield* Deferred.make<void>();
          const coalesced = yield* Deferred.make<void>();
          const unexpected = yield* Deferred.make<void>();
          let notificationCount = 0;
          const listener = yield* Effect.forkChild(
            OutboxRelayWake.use((wake) =>
              Stream.runForEach(wake.events, (event) =>
                Effect.sync(() => {
                  if (event.type === "connected") {
                    Deferred.doneUnsafe(connected, Effect.void);
                    return;
                  }
                  notificationCount += 1;
                  if (notificationCount === 1) Deferred.doneUnsafe(notified, Effect.void);
                  if (notificationCount === 2) Deferred.doneUnsafe(coalesced, Effect.void);
                  if (notificationCount > 2) Deferred.doneUnsafe(unexpected, Effect.void);
                }),
              ),
            ),
          );
          yield* Deferred.await(connected);

          yield* MessageAdmission.use((admission) =>
            admission.accept({
              protocolVersion: 1,
              authenticationToken: noisyAuthenticationToken,
              threadId: noisyThreadIds[0],
              idempotencyKey: randomUUID(),
              message: { content: "committed wake" },
            }),
          );
          const committedWake = yield* Deferred.await(notified).pipe(Effect.timeoutOption(500));

          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.all(
              [
                sql`SELECT pg_notify('osfo_outbox_relay_wake', 'wake')`,
                sql`SELECT pg_notify('osfo_outbox_relay_wake', 'wake')`,
              ],
              { concurrency: 1, discard: true },
            ),
          );
          const coalescedWake = yield* Deferred.await(coalesced).pipe(Effect.timeoutOption(500));
          yield* Effect.exit(
            sql.withTransaction(
              sql`SELECT pg_notify('osfo_outbox_relay_wake', 'wake')`.pipe(
                Effect.andThen(Effect.fail("force rollback")),
              ),
            ),
          );
          const rolledBackWake = yield* Deferred.await(unexpected).pipe(Effect.timeoutOption(100));
          yield* Fiber.interrupt(listener);

          expect(Option.isSome(committedWake)).toBe(true);
          expect(Option.isSome(coalescedWake)).toBe(true);
          expect(Option.isNone(rolledBackWake)).toBe(true);
          expect(notificationCount).toBe(2);
        }),
      ),
    );
  });

  it("releases the global selector lock before broker publication", async () => {
    await accept(noisyAuthenticationToken, noisyThreadIds[0], "lock-scoped publication");
    await run(OutboxRelay.use((relay) => relay.selectOnce()));

    await run(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        publicationBlock = { release, started };
        const publication = yield* Effect.forkChild(
          OutboxRelay.use((relay) => relay.publishOnce()),
        );
        yield* Deferred.await(started);

        const sql = yield* SqlClient.SqlClient;
        const [lock] = yield* sql.withTransaction(
          sql<{ readonly acquired: boolean }>`SELECT
            pg_try_advisory_xact_lock(${OUTBOX_RELAY_SELECTOR_LOCK_ID}) AS acquired`,
        );
        expect(lock).toEqual({ acquired: true });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(publication);
      }),
    );
  });

  it("recovers a publication lease lost before broker contact without duplicate delivery", async () => {
    const receipt = await accept(
      noisyAuthenticationToken,
      noisyThreadIds[0],
      "recover before publish",
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    failBeforePublish = true;
    await run(Effect.exit(OutboxRelay.use((relay) => relay.publishOnce())));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE relay_publication_tasks
          SET publication_lease_expires_at = clock_timestamp() - interval '1 millisecond'`;
      }),
    );

    await run(OutboxRelay.use((relay) => relay.publishOnce()));

    expect(publishedAgentRunIds).toEqual([receipt.agentRunId]);
    expect(await publicationAudit(receipt.agentRunId)).toEqual({
      activeTasks: 0,
      dispatchActive: 0,
      epochs: ["1", "2"],
      states: ["expired", "confirmed"],
    });
  });

  it("recovers a publication lease lost after broker confirmation with one harmless duplicate", async () => {
    const receipt = await accept(
      noisyAuthenticationToken,
      noisyThreadIds[0],
      "recover after confirmation",
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    failAfterPublish = true;
    await run(Effect.exit(OutboxRelay.use((relay) => relay.publishOnce())));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE relay_publication_tasks
          SET publication_lease_expires_at = clock_timestamp() - interval '1 millisecond'`;
      }),
    );

    await run(OutboxRelay.use((relay) => relay.publishOnce()));

    expect(publishedAgentRunIds).toEqual([receipt.agentRunId, receipt.agentRunId]);
    expect(await publicationAudit(receipt.agentRunId)).toEqual({
      activeTasks: 0,
      dispatchActive: 0,
      epochs: ["1", "2"],
      states: ["expired", "confirmed"],
    });
  });

  it("rolls confirmation back when dispatch capacity cannot be released", async () => {
    const receipt = await accept(
      noisyAuthenticationToken,
      noisyThreadIds[0],
      "preserve exact publication capacity",
    );
    await run(OutboxRelay.use((relay) => relay.selectOnce()));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE relay_dispatch_capacity SET active_count = 0 WHERE singleton = true`;
      }),
    );

    const failedConfirmation = await run(
      Effect.exit(OutboxRelay.use((relay) => relay.publishOnce())),
    );

    expect(Exit.isFailure(failedConfirmation)).toBe(true);
    expect(publishedAgentRunIds).toEqual([receipt.agentRunId]);
    expect(await publicationAuthority()).toEqual({
      activeTasks: 1,
      dispatchActive: 0,
      unpublished: 1,
    });

    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE relay_dispatch_capacity SET active_count = 1 WHERE singleton = true`;
        yield* sql`UPDATE relay_publication_tasks
          SET publication_lease_expires_at = clock_timestamp() - interval '1 millisecond'`;
      }),
    );
    await run(OutboxRelay.use((relay) => relay.publishOnce()));

    expect(publishedAgentRunIds).toEqual([receipt.agentRunId, receipt.agentRunId]);
    expect(await publicationAudit(receipt.agentRunId)).toEqual({
      activeTasks: 0,
      dispatchActive: 0,
      epochs: ["1", "2"],
      states: ["expired", "confirmed"],
    });
  });
});

const publicationAudit = (agentRunId: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        readonly activeTasks: number;
        readonly dispatchActive: number;
        readonly epochs: ReadonlyArray<string>;
        readonly states: ReadonlyArray<string>;
      }>`SELECT
        (SELECT count(*)::int FROM relay_publication_tasks) AS "activeTasks",
        (SELECT active_count FROM relay_dispatch_capacity
          WHERE singleton = true) AS "dispatchActive",
        ARRAY(SELECT publication_epoch::text FROM relay_publication_attempts attempt
          JOIN outbox_obligations obligation USING (outbox_id)
          WHERE obligation.agent_run_id = ${agentRunId}::uuid
          ORDER BY publication_epoch) AS epochs,
        ARRAY(SELECT state FROM relay_publication_attempts attempt
          JOIN outbox_obligations obligation USING (outbox_id)
          WHERE obligation.agent_run_id = ${agentRunId}::uuid
          ORDER BY publication_epoch) AS states`;
      return row;
    }),
  );
