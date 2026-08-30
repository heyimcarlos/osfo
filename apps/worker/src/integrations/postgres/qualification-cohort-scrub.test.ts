/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/run-effect-inside-effect, eslint/no-underscore-dangle -- PostgreSQL test setup is Promise-native, timestamps are fixed, outcomes use the canonical _tag discriminator, and the lock-wait test deliberately starts a concurrent Effect across the Promise transaction boundary. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect generators. */
import { expect, it } from "@effect/vitest";
import {
  qualificationCohorts,
  qualificationCohortScrubDispatches,
} from "@osfo/db/schema/qualification-cohorts";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { qualificationChecksum } from "../../qualification/qualification-checksum";
import { qualificationCohortScrubPartitionProtocol } from "../../qualification/cohort-scrub-partition";
import { qualificationCohortScrubDispatchIdentity } from "../../qualification/cohort-scrub-dispatch";
import { qualificationCohortScrubRootWorkflowPayload } from "../../qualification/cohort-scrub-root";
import { settleScheduledBranches } from "../../scheduled-lifecycle";
import { makeQualificationCohortAuthority } from "./qualification-cohort";
import { makeQualificationCohortScrubDispatchAuthority } from "./qualification-cohort-scrub-dispatch";
import { makeQualificationPostTeardownPublicationAuthority } from "./qualification-post-teardown";

const cohortId = "qualification-scrub-cohort";
const executionId = "qualification-scrub-execution";
const activatedAt = "2099-08-29T17:00:00.000Z";
const deletedAt = "2099-08-30T17:00:00.000Z";

const partitionPayload = {
  cohortId,
  executionId,
  firstPagePosition: 0,
  pageCount: 2,
  partitionIndex: 0,
  protocolVersion: qualificationCohortScrubPartitionProtocol,
  rootCoordinatorInstanceId: "scrub-root",
} as const;
const rootPayload = qualificationCohortScrubRootWorkflowPayload(cohortId, executionId);

const deletionReceipt = (userId: string, deletionCaseId: string) => {
  const receiptId = `postgres:qualification-account-deletion:${deletionCaseId}`;
  return {
    checksum: qualificationChecksum({
      deletionCaseId,
      receiptId,
      state: "DELETED",
      userId,
    }),
    receiptId,
  };
};

const seedCohort = (
  fixture: Effect.Success<typeof makeTestDatabase>,
  input: {
    readonly adventurer: number;
    readonly free: number;
    readonly active?: ReadonlyArray<string>;
    readonly artifactAuthorityProtocol?: string | null;
  },
) =>
  Effect.promise(async () => {
    await fixture.client.query(
      `insert into qualification_cohorts (
        artifact_authority_protocol, artifact_checksum, artifact_id, activated_at, cohort_id, created_at,
        created_for_qualification, execution_id, expected_adventurer_participants,
        expected_free_participants, expires_at, manifest_checksum, not_before,
        plan_checksum, source_version, state, teardown_policy
      ) values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'permanentAccountDeletion')`,
      [
        input.artifactAuthorityProtocol === undefined
          ? "qualification-cohort-artifacts-v1"
          : input.artifactAuthorityProtocol,
        "cohort-checksum",
        `qualification/executions/${executionId}/cohort/manifest.json`,
        activatedAt,
        cohortId,
        "2099-08-29T16:58:00.000Z",
        executionId,
        input.adventurer,
        input.free,
        "2099-09-30T17:00:00.000Z",
        "manifest-checksum",
        activatedAt,
        "plan-checksum",
        "source-version",
        input.active?.length === undefined || input.active.length === 0
          ? "PRODUCT_DELETED"
          : "ACTIVE",
      ],
    );
    await Promise.all(
      (["free", "adventurer"] as const)
        .flatMap((plan) => Array.from({ length: input[plan] }, (_, index) => ({ index, plan })))
        .map(async ({ index, plan }) => {
          const userId = `qualification-${plan}-${index}`;
          const provisionId = `provision-${plan}-${index}`;
          const deletionCaseId = `delete-${plan}-${index}`;
          const receipt = deletionReceipt(userId, deletionCaseId);
          const active = input.active?.includes(`${plan}:${index}`) ?? false;
          await fixture.client.query(
            `insert into qualification_participant_provisions (
            cohort_id, consumed_at, created_at, enrollment_digest, execution_id,
            expires_at, participant_index, plan, provision_checksum, provision_id,
            state, user_id
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONSUMED', $11)`,
            [
              cohortId,
              activatedAt,
              "2099-08-29T16:59:00.000Z",
              `digest-${plan}-${index}`,
              executionId,
              "2099-09-30T17:00:00.000Z",
              index,
              plan,
              `provision-checksum-${plan}-${index}`,
              provisionId,
              userId,
            ],
          );
          await fixture.client.query(
            `insert into qualification_participant_allocations (
            agent_id, allocation_id, cohort_id, created_at, created_for_qualification,
            deleted_at, deletion_case_id, deletion_receipt_checksum, deletion_receipt_id,
            deletion_requested_at, execution_id, expires_at, grant_checksum, grant_id,
            not_before, participant_index, plan, provision_checksum, provision_id,
            route_id, session_id, state, user_id
          ) values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
            [
              `agent-${plan}-${index}`,
              `allocation-${plan}-${index}`,
              cohortId,
              activatedAt,
              active ? null : deletedAt,
              active ? null : deletionCaseId,
              active ? null : receipt.checksum,
              active ? null : receipt.receiptId,
              active ? null : activatedAt,
              executionId,
              "2099-09-30T17:00:00.000Z",
              `grant-checksum-${plan}-${index}`,
              `qualification/executions/${executionId}/cohort/grants/${plan}/${String(index).padStart(8, "0")}.json`,
              activatedAt,
              index,
              plan,
              `provision-checksum-${plan}-${index}`,
              provisionId,
              `route-${plan}-${index}`,
              `session-${plan}-${index}`,
              active ? "ACTIVE" : "DELETED",
              userId,
            ],
          );
        }),
    );
  });

it.effect("does not expose scrub work before every product deletion is proven", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, active: ["free:1"], free: 2 });
    const authority = makeQualificationCohortAuthority(fixture.database);

    expect(
      yield* authority.claimScrubPage({
        claimToken: "claim-partial",
        cohortId,
        executionId,
        pageIndex: 0,
        plan: "free",
      }),
    ).toEqual({ _tag: "Pending", reason: "productDeletionIncomplete" });
    expect(yield* authority.inspectScrubRoot(rootPayload)).toEqual({
      _tag: "Pending",
      reason: "productDeletionIncomplete",
    });
    expect(yield* authority.inspectTeardown(cohortId)).toMatchObject({
      productDeletion: { deleted: 2, expected: 3, state: "PENDING" },
      scrub: { state: "NOT_STARTED" },
    });
  }),
);

it.effect("claims and reclaims due POST teardown publication work", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const identity = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
    yield* Effect.promise(() =>
      fixture.database.insert(qualificationCohortScrubDispatches).values({
        cohort_id: cohortId,
        dispatch_id: identity.dispatchId,
        execution_id: executionId,
        protocol_version: identity.protocolVersion,
        publication_attempt_count: 0,
        publication_next_attempt_at: new Date(0),
        publication_state: "PENDING",
        root_instance_id: identity.rootInstanceId,
        root_checksum: "root",
        settled_at: new Date(0),
        state: "SETTLED",
      }),
    );
    const authority = makeQualificationPostTeardownPublicationAuthority(fixture.database);
    const [claimed] = yield* authority.claimBatch("first");
    expect(claimed).toMatchObject({ _tag: "Claimed", attemptCount: 1 });
    yield* Effect.promise(() =>
      fixture.client.query(
        `update qualification_cohort_scrub_dispatches set publication_lease_expires_at = clock_timestamp() + interval '50 milliseconds' where dispatch_id = $1`,
        [identity.dispatchId],
      ),
    );
    const blockedMutation = yield* Effect.promise(async () => {
      let pending: Promise<unknown> | undefined;
      await fixture.database.transaction(async (transaction) => {
        await transaction
          .select()
          .from(qualificationCohortScrubDispatches)
          .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
          .for("update");
        pending = Effect.runPromise(authority.pinInput(identity, "first", "input"));
        await Effect.runPromise(Effect.sleep("100 millis"));
      });
      if (pending === undefined) throw new Error("Concurrent publication mutation did not start");
      return pending;
    });
    expect(blockedMutation).toMatchObject({ _tag: "LeaseExpired" });
    expect(yield* authority.claimExact(identity, "first")).toMatchObject({ _tag: "LeaseExpired" });
    expect(yield* authority.claimBatch("first")).toEqual([]);
    const [reclaimed] = yield* authority.claimBatch("second");
    expect(reclaimed).toMatchObject({ _tag: "Claimed", attemptCount: 2, claimToken: "second" });
    expect(yield* authority.pinInput(identity, "first", "input")).toEqual({ _tag: "Conflict" });
    expect(yield* authority.pinInput(identity, "second", "input")).toEqual({ _tag: "Applied" });
    expect(yield* authority.release(identity, "second", 3_600_001)).toEqual({ _tag: "Conflict" });
    expect(yield* authority.release(identity, "second", 1_000)).toEqual({ _tag: "Applied" });
    expect(yield* authority.claimExact(identity, "third")).toMatchObject({ _tag: "Deferred" });
    yield* Effect.promise(() =>
      fixture.client.query(
        `update qualification_cohort_scrub_dispatches set publication_next_attempt_at = clock_timestamp() - interval '1 second' where dispatch_id = $1`,
        [identity.dispatchId],
      ),
    );
    expect(yield* authority.claimExact(identity, "third")).toMatchObject({
      _tag: "Claimed",
      attemptCount: 3,
      inputChecksum: "input",
    });
    expect(yield* authority.publish(identity, "second", "input", "post-checksum")).toEqual({
      _tag: "Conflict",
    });
    expect(yield* authority.publish(identity, "third", "input", "post-checksum")).toEqual({
      _tag: "Applied",
    });
    const [terminal] = yield* Effect.promise(() =>
      fixture.database
        .select()
        .from(qualificationCohortScrubDispatches)
        .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId)),
    );
    expect(terminal).toMatchObject({
      publication_artifact_checksum: "post-checksum",
      publication_next_attempt_at: null,
      publication_state: "PUBLISHED",
    });
    expect(yield* authority.claimExact(identity, "replay")).toMatchObject({
      _tag: "Terminal",
      artifactChecksum: "post-checksum",
      inputChecksum: "input",
      state: "PUBLISHED",
    });
  }),
);

it.effect("rejects nullable and stale POST publication state combinations", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const identity = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
    yield* Effect.promise(() =>
      fixture.database.insert(qualificationCohortScrubDispatches).values({
        cohort_id: cohortId,
        dispatch_id: identity.dispatchId,
        execution_id: executionId,
        protocol_version: identity.protocolVersion,
        root_instance_id: identity.rootInstanceId,
        state: "PENDING",
      }),
    );
    yield* Effect.promise(async () => {
      await expect(
        fixture.client.query(
          `update qualification_cohort_scrub_dispatches set publication_artifact_checksum = 'stale' where dispatch_id = $1`,
          [identity.dispatchId],
        ),
      ).rejects.toThrow("publication_check");
      await expect(
        fixture.client.query(
          `update qualification_cohort_scrub_dispatches set state = 'SETTLED', settled_at = clock_timestamp(), root_checksum = 'root', publication_state = null, publication_attempt_count = 0, publication_next_attempt_at = clock_timestamp() where dispatch_id = $1`,
          [identity.dispatchId],
        ),
      ).rejects.toThrow("publication_check");
      await expect(
        fixture.client.query(
          `update qualification_cohort_scrub_dispatches set state = 'SETTLED', settled_at = clock_timestamp(), root_checksum = 'root', publication_state = 'PENDING', publication_attempt_count = null, publication_next_attempt_at = clock_timestamp() where dispatch_id = $1`,
          [identity.dispatchId],
        ),
      ).rejects.toThrow("publication_check");
      await expect(
        fixture.client.query(
          `update qualification_cohort_scrub_dispatches set state = 'SETTLED', settled_at = clock_timestamp(), root_checksum = 'root', publication_state = 'CLAIMED', publication_attempt_count = null, publication_claim_token = 'claim', publication_next_attempt_at = clock_timestamp(), publication_lease_expires_at = clock_timestamp() + interval '5 minutes' where dispatch_id = $1`,
          [identity.dispatchId],
        ),
      ).rejects.toThrow("publication_check");
      await expect(
        fixture.client.query(
          `update qualification_cohort_scrub_dispatches set state = 'SETTLED', settled_at = clock_timestamp(), root_checksum = 'root', publication_state = 'PUBLISHED', publication_attempt_count = null, publication_input_checksum = 'input', publication_artifact_checksum = 'artifact', publication_settled_at = clock_timestamp() where dispatch_id = $1`,
          [identity.dispatchId],
        ),
      ).rejects.toThrow("publication_check");
    });
  }),
);

it.effect("samples scrub terminal mutation time after its dispatch lock", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const identity = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
    yield* Effect.promise(() =>
      fixture.database
        .insert(qualificationCohortScrubDispatches)
        .values({
          claim_token: "old",
          claimed_at: new Date(),
          cohort_id: cohortId,
          dispatch_id: identity.dispatchId,
          execution_id: executionId,
          lease_expires_at: new Date(Date.now() + 50),
          protocol_version: identity.protocolVersion,
          root_instance_id: identity.rootInstanceId,
          state: "PENDING",
        }),
    );
    const dispatch = makeQualificationCohortScrubDispatchAuthority(fixture.database);
    const blocked = yield* Effect.promise(async () => {
      let pending: Promise<unknown> | undefined;
      await fixture.database.transaction(async (transaction) => {
        await transaction
          .select()
          .from(qualificationCohortScrubDispatches)
          .where(eq(qualificationCohortScrubDispatches.dispatch_id, identity.dispatchId))
          .for("update");
        pending = Effect.runPromise(dispatch.settle(identity, "old", "root"));
        await Effect.runPromise(Effect.sleep("100 millis"));
      });
      if (pending === undefined) throw new Error("Concurrent scrub mutation did not start");
      return pending;
    });
    expect(blocked).toMatchObject({ _tag: "LeaseExpired" });
    const [unchanged] = yield* Effect.promise(() =>
      fixture.database.select().from(qualificationCohortScrubDispatches),
    );
    expect(unchanged).toMatchObject({
      publication_state: null,
      root_checksum: null,
      state: "PENDING",
    });
    expect(yield* dispatch.claimExact(identity, "fresh")).toMatchObject({ _tag: "Claimed" });
    expect(yield* dispatch.retainConflict(identity, "fresh", "failure")).toEqual({
      _tag: "Applied",
    });
  }),
);

it.effect("derives the exact partition window from PostgreSQL-owned cohort counts", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 25 });
    const authority = makeQualificationCohortAuthority(fixture.database);

    expect(yield* authority.inspectScrubPartition(partitionPayload)).toMatchObject({
      _tag: "Ready",
      freeParticipantCount: 25,
      pageCount: 2,
      pages: [
        { pageIndex: 0, plan: "free", position: 0 },
        { pageIndex: 0, plan: "adventurer", position: 1 },
      ],
      totalPageCount: 2,
    });
    expect(
      yield* authority.inspectScrubPartition({ ...partitionPayload, firstPagePosition: 1 }),
    ).toEqual({ _tag: "Conflict" });
    expect(yield* authority.inspectScrubPartition({ ...partitionPayload, pageCount: 1 })).toEqual({
      _tag: "Conflict",
    });
  }),
);

it.effect("authenticates one exact completed partition chain from PostgreSQL authority", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 26 });
    const authority = makeQualificationCohortAuthority(fixture.database);

    expect(yield* authority.inspectScrubRoot(rootPayload)).toMatchObject({
      _tag: "Ready",
      partitionCount: 1,
      totalPageCount: 3,
    });
    expect(yield* authority.inspectScrubPartitionCompletion(rootPayload, 0)).toEqual({
      _tag: "Pending",
      reason: "partitionPagesIncomplete",
    });

    let previousPageChecksum = "NONE";
    for (const [plan, pageIndex] of [
      ["free", 0],
      ["free", 1],
      ["adventurer", 0],
    ] as const) {
      const claimToken = `root-inspection-${plan}-${pageIndex}`;
      const claimed = yield* authority.claimScrubPage({
        claimToken,
        cohortId,
        executionId,
        pageIndex,
        plan,
      });
      expect(claimed).toMatchObject({ _tag: "Claimed", previousPageChecksum });
      if (claimed._tag !== "Claimed") return;
      const completed = yield* authority.completeScrubPage({
        artifactAuthorityProofChecksum: `root-proof-${plan}-${pageIndex}`,
        claimToken,
        cohortId,
        deletedArtifactCount: claimed.expectedArtifactCount,
        deletedArtifactsChecksum: claimed.expectedArtifactsChecksum,
        executionId,
        pageIndex,
        plan,
      });
      expect(completed._tag).toBe("Completed");
      if (completed._tag !== "Completed") return;
      previousPageChecksum = completed.pageChecksum;
    }

    expect(yield* authority.inspectScrubPartitionCompletion(rootPayload, 0)).toEqual({
      _tag: "Ready",
      deletedArtifactCount: 31,
      pageCount: 3,
      partitionIndex: 0,
      previousPageChecksum: "NONE",
      terminalPageChecksum: previousPageChecksum,
      terminalPosition: 2,
    });

    yield* Effect.promise(() =>
      fixture.client.query(
        "update qualification_cohort_scrub_pages set previous_page_checksum = 'tampered' where plan = 'adventurer' and page_index = 0",
      ),
    );
    expect(yield* authority.inspectScrubPartitionCompletion(rootPayload, 0)).toEqual({
      _tag: "Conflict",
    });
  }),
);

it.effect("keeps legacy root topology fail-closed", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, {
      adventurer: 1,
      artifactAuthorityProtocol: null,
      free: 1,
    });
    const authority = makeQualificationCohortAuthority(fixture.database);

    expect(yield* authority.inspectScrubRoot(rootPayload)).toEqual({
      _tag: "Pending",
      reason: "artifactAuthorityUnavailable",
    });
  }),
);

it.effect("keeps legacy cohorts without exclusive artifact authority fail-closed", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, {
      adventurer: 1,
      artifactAuthorityProtocol: null,
      free: 1,
    });
    const authority = makeQualificationCohortAuthority(fixture.database);

    expect(
      yield* authority.claimScrubPage({
        claimToken: "legacy-page",
        cohortId,
        executionId,
        pageIndex: 0,
        plan: "free",
      }),
    ).toEqual({ _tag: "Pending", reason: "artifactAuthorityUnavailable" });
    expect(
      yield* authority.claimScrubRoot({
        claimToken: "legacy-root",
        cohortId,
        executionId,
      }),
    ).toEqual({ _tag: "Pending", reason: "artifactAuthorityUnavailable" });
  }),
);

it.effect("serializes concurrent claims for the same scrub page", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const authority = makeQualificationCohortAuthority(fixture.database);
    const outcomes = yield* Effect.all(
      ["concurrent-a", "concurrent-b"].map((claimToken) =>
        authority.claimScrubPage({
          claimToken,
          cohortId,
          executionId,
          pageIndex: 0,
          plan: "free",
        }),
      ),
      { concurrency: "unbounded" },
    );

    expect(new Set(outcomes.map(({ _tag }) => _tag))).toEqual(new Set(["Busy", "Claimed"]));
  }),
);

it.effect(
  "claims, reclaims, and completes one exact scrub page without identity-bearing rows",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTestDatabase;
      yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
      yield* applyMigrations(fixture.client);
      yield* seedCohort(fixture, { adventurer: 1, free: 2 });
      const authority = makeQualificationCohortAuthority(fixture.database);
      const input = {
        claimToken: "page-claim-1",
        cohortId,
        executionId,
        pageIndex: 0,
        plan: "free" as const,
      };

      const claimed = yield* authority.claimScrubPage(input);
      expect(claimed).toMatchObject({
        _tag: "Claimed",
        expectedArtifactCount: 4,
        firstParticipantIndex: 0,
        participantCount: 2,
        previousPageChecksum: "NONE",
      });
      expect(yield* authority.claimScrubPage(input)).toEqual(claimed);
      expect(
        yield* authority.claimScrubPage({ ...input, claimToken: "page-claim-busy" }),
      ).toMatchObject({ _tag: "Busy" });

      yield* Effect.promise(() =>
        fixture.client.query(
          "update qualification_cohort_scrub_pages set claimed_at = now() - interval '10 minutes', lease_expires_at = now() - interval '1 second'",
        ),
      );
      expect(yield* authority.claimScrubPage(input)).toMatchObject({ _tag: "LeaseExpired" });
      const reclaimed = yield* authority.claimScrubPage({
        ...input,
        claimToken: "page-claim-2",
      });
      expect(reclaimed).toMatchObject({ _tag: "Claimed", claimToken: "page-claim-2" });
      if (reclaimed._tag !== "Claimed") return;
      yield* Effect.promise(() =>
        fixture.client.query(
          "update qualification_cohort_scrub_pages set claimed_at = now() - interval '10 minutes', lease_expires_at = now() - interval '1 second'",
        ),
      );
      expect(
        yield* authority.completeScrubPage({
          artifactAuthorityProofChecksum: "proof-reclaimed-expired",
          claimToken: reclaimed.claimToken,
          cohortId,
          deletedArtifactCount: reclaimed.expectedArtifactCount,
          deletedArtifactsChecksum: reclaimed.expectedArtifactsChecksum,
          executionId,
          pageIndex: 0,
          plan: "free",
        }),
      ).toEqual({ _tag: "Conflict" });
      const finalClaim = yield* authority.claimScrubPage({
        ...input,
        claimToken: "page-claim-3",
      });
      expect(finalClaim).toMatchObject({ _tag: "Claimed", claimToken: "page-claim-3" });
      if (finalClaim._tag !== "Claimed") return;
      expect(
        yield* authority.completeScrubPage({
          artifactAuthorityProofChecksum: "proof-wrong-claim",
          claimToken: input.claimToken,
          cohortId,
          deletedArtifactCount: finalClaim.expectedArtifactCount,
          deletedArtifactsChecksum: finalClaim.expectedArtifactsChecksum,
          executionId,
          pageIndex: 0,
          plan: "free",
        }),
      ).toEqual({ _tag: "Conflict" });
      const completed = yield* authority.completeScrubPage({
        artifactAuthorityProofChecksum: "proof-free-page",
        claimToken: finalClaim.claimToken,
        cohortId,
        deletedArtifactCount: finalClaim.expectedArtifactCount,
        deletedArtifactsChecksum: finalClaim.expectedArtifactsChecksum,
        executionId,
        pageIndex: 0,
        plan: "free",
      });
      expect(completed).toMatchObject({ _tag: "Completed", previousPageChecksum: "NONE" });
      expect(
        yield* authority.completeScrubPage({
          artifactAuthorityProofChecksum: "proof-free-page",
          claimToken: finalClaim.claimToken,
          cohortId,
          deletedArtifactCount: finalClaim.expectedArtifactCount,
          deletedArtifactsChecksum: finalClaim.expectedArtifactsChecksum,
          executionId,
          pageIndex: 0,
          plan: "free",
        }),
      ).toEqual(completed);
      expect(
        yield* authority.completeScrubPage({
          artifactAuthorityProofChecksum: "different-proof",
          claimToken: finalClaim.claimToken,
          cohortId,
          deletedArtifactCount: finalClaim.expectedArtifactCount,
          deletedArtifactsChecksum: finalClaim.expectedArtifactsChecksum,
          executionId,
          pageIndex: 0,
          plan: "free",
        }),
      ).toEqual({ _tag: "Conflict" });

      const columns = yield* Effect.promise(() =>
        fixture.client.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_name in ('qualification_cohort_scrub_pages', 'qualification_cohort_scrub_roots') order by column_name",
        ),
      );
      expect(columns.rows.map(({ column_name }) => column_name)).not.toEqual(
        expect.arrayContaining([
          "agent_id",
          "customer_content",
          "deletion_case_id",
          "file_id",
          "grant_body",
          "session_id",
          "user_id",
        ]),
      );
    }),
);

it.effect("chains every plan page before one root scrub completion", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 26 });
    const authority = makeQualificationCohortAuthority(fixture.database);
    expect(
      yield* authority.claimScrubPage({
        claimToken: "free-page-1-too-early",
        cohortId,
        executionId,
        pageIndex: 1,
        plan: "free",
      }),
    ).toEqual({ _tag: "Pending", reason: "previousPageIncomplete" });

    let previousPageChecksum = "NONE";
    for (const [plan, pageIndex] of [
      ["free", 0],
      ["free", 1],
      ["adventurer", 0],
    ] as const) {
      const claimToken = `${plan}-${pageIndex}-claim`;
      const claimed = yield* authority.claimScrubPage({
        claimToken,
        cohortId,
        executionId,
        pageIndex,
        plan,
      });
      expect(claimed).toMatchObject({ _tag: "Claimed", previousPageChecksum });
      if (claimed._tag !== "Claimed") return;
      const completed = yield* authority.completeScrubPage({
        artifactAuthorityProofChecksum: `proof-${plan}-${pageIndex}`,
        claimToken,
        cohortId,
        deletedArtifactCount: claimed.expectedArtifactCount,
        deletedArtifactsChecksum: claimed.expectedArtifactsChecksum,
        executionId,
        pageIndex,
        plan,
      });
      expect(completed._tag).toBe("Completed");
      if (completed._tag !== "Completed") return;
      previousPageChecksum = completed.pageChecksum;
    }

    const root = yield* authority.claimScrubRoot({
      claimToken: "root-claim",
      cohortId,
      executionId,
    });
    expect(root).toMatchObject({
      _tag: "Claimed",
      expectedArtifactCount: 2,
      expectedPageCount: 3,
      expectedParticipantCount: 27,
      finalPageChecksum: previousPageChecksum,
    });
    if (root._tag !== "Claimed") return;
    yield* Effect.promise(() =>
      fixture.client.query(
        "update qualification_cohort_scrub_roots set claimed_at = now() - interval '10 minutes', lease_expires_at = now() - interval '1 second'",
      ),
    );
    expect(
      yield* authority.claimScrubRoot({
        claimToken: root.claimToken,
        cohortId,
        executionId,
      }),
    ).toMatchObject({ _tag: "LeaseExpired" });
    expect(
      yield* authority.completeScrubRoot({
        artifactAuthorityProofChecksum: "proof-expired-root",
        claimToken: root.claimToken,
        cohortId,
        deletedArtifactCount: root.expectedArtifactCount,
        deletedArtifactsChecksum: root.expectedArtifactsChecksum,
        executionId,
      }),
    ).toMatchObject({ _tag: "LeaseExpired" });
    const reclaimedRoot = yield* authority.claimScrubRoot({
      claimToken: "root-claim-reclaimed",
      cohortId,
      executionId,
    });
    expect(reclaimedRoot).toMatchObject({
      _tag: "Claimed",
      claimToken: "root-claim-reclaimed",
    });
    if (reclaimedRoot._tag !== "Claimed") return;
    const completedRoot = yield* authority.completeScrubRoot({
      artifactAuthorityProofChecksum: "proof-root",
      claimToken: reclaimedRoot.claimToken,
      cohortId,
      deletedArtifactCount: reclaimedRoot.expectedArtifactCount,
      deletedArtifactsChecksum: reclaimedRoot.expectedArtifactsChecksum,
      executionId,
    });
    expect(completedRoot._tag).toBe("Completed");
    if (completedRoot._tag !== "Completed") return;
    expect(
      yield* authority.claimScrubPage({
        claimToken: "post-scrub-page-replay",
        cohortId,
        executionId,
        pageIndex: 0,
        plan: "free",
      }),
    ).toMatchObject({ _tag: "Completed" });
    expect(
      yield* authority.claimScrubRoot({
        claimToken: "post-scrub-root-replay",
        cohortId,
        executionId,
      }),
    ).toMatchObject({ _tag: "Completed", rootChecksum: completedRoot.rootChecksum });
    expect(yield* authority.inspectTeardown(cohortId)).toMatchObject({
      productDeletion: { deleted: 27, expected: 27, state: "COMPLETE" },
      scrub: { completedPages: 3, expectedPages: 3, state: "COMPLETE" },
    });
    const retainedIdentities = yield* Effect.promise(() =>
      fixture.client.query<{ allocations: number; provisions: number }>(
        `select
          (select count(*)::int from qualification_participant_allocations where cohort_id = $1) as allocations,
          (select count(*)::int from qualification_participant_provisions where cohort_id = $1) as provisions`,
        [cohortId],
      ),
    );
    expect(retainedIdentities.rows[0]).toEqual({ allocations: 0, provisions: 0 });
    expect(yield* authority.inspectScrubRootCompletion({ cohortId, executionId })).toMatchObject({
      _tag: "Ready",
      artifactAuthorityProofChecksum: "proof-root",
      allocationIdentityCount: 0,
      provisionIdentityCount: 0,
      rootChecksum: completedRoot.rootChecksum,
    });
    const dispatchIdentity = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
    yield* Effect.promise(() =>
      fixture.database.insert(qualificationCohortScrubDispatches).values({
        cohort_id: cohortId,
        dispatch_id: dispatchIdentity.dispatchId,
        execution_id: executionId,
        last_status: "complete",
        last_status_checksum: qualificationChecksum({
          dispatchId: dispatchIdentity.dispatchId,
          rootChecksum: completedRoot.rootChecksum,
        }),
        protocol_version: dispatchIdentity.protocolVersion,
        publication_attempt_count: 0,
        publication_next_attempt_at: new Date(),
        publication_state: "PENDING",
        root_checksum: completedRoot.rootChecksum,
        root_instance_id: dispatchIdentity.rootInstanceId,
        settled_at: new Date(),
        state: "SETTLED",
      }),
    );
    const publication = makeQualificationPostTeardownPublicationAuthority(fixture.database);
    const inspection = {
      cohortArtifactChecksum: "cohort-checksum",
      cohortArtifactId: `qualification/executions/${executionId}/cohort/manifest.json`,
      cohortId,
      executionId,
      manifestChecksum: "manifest-checksum",
      planChecksum: "plan-checksum",
      sourceVersion: "source-version",
    };
    expect(yield* publication.inspectAuthority(inspection)).toMatchObject({
      _tag: "Ready",
      cohortId,
      rootChecksum: completedRoot.rootChecksum,
    });
    expect(yield* publication.inspectAuthority({ ...inspection, cohortId: "substituted" })).toEqual(
      { _tag: "Conflict" },
    );
    expect(
      yield* publication.inspectAuthority({ ...inspection, cohortArtifactId: "substituted" }),
    ).toEqual({ _tag: "Conflict" });
    expect(
      yield* publication.inspectAuthority({ ...inspection, cohortArtifactChecksum: "substituted" }),
    ).toEqual({ _tag: "Conflict" });
    yield* Effect.promise(() =>
      fixture.client.query(
        "update qualification_cohort_scrub_roots set artifact_authority_proof_checksum = 'substituted-proof' where cohort_id = $1",
        [cohortId],
      ),
    );
    expect(yield* authority.inspectScrubRootCompletion({ cohortId, executionId })).toEqual({
      _tag: "Conflict",
    });
  }),
);

it.effect("rolls back root completion when the cohort state no longer permits scrubbing", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const authority = makeQualificationCohortAuthority(fixture.database);
    for (const plan of ["free", "adventurer"] as const) {
      const page = yield* authority.claimScrubPage({
        claimToken: `state-race-${plan}-page`,
        cohortId,
        executionId,
        pageIndex: 0,
        plan,
      });
      expect(page._tag).toBe("Claimed");
      if (page._tag !== "Claimed") return;
      expect(
        yield* authority.completeScrubPage({
          artifactAuthorityProofChecksum: `proof-state-${plan}`,
          claimToken: page.claimToken,
          cohortId,
          deletedArtifactCount: page.expectedArtifactCount,
          deletedArtifactsChecksum: page.expectedArtifactsChecksum,
          executionId,
          pageIndex: 0,
          plan,
        }),
      ).toMatchObject({ _tag: "Completed" });
    }
    const root = yield* authority.claimScrubRoot({
      claimToken: "state-race-root",
      cohortId,
      executionId,
    });
    expect(root._tag).toBe("Claimed");
    if (root._tag !== "Claimed") return;
    yield* Effect.promise(() =>
      fixture.client.query("update qualification_cohorts set state = 'PRODUCT_DELETED'"),
    );

    expect(
      yield* authority.completeScrubRoot({
        artifactAuthorityProofChecksum: "proof-state-root",
        claimToken: root.claimToken,
        cohortId,
        deletedArtifactCount: root.expectedArtifactCount,
        deletedArtifactsChecksum: root.expectedArtifactsChecksum,
        executionId,
      }),
    ).toEqual({ _tag: "Conflict" });
    const state = yield* Effect.promise(() =>
      fixture.client.query<{
        allocations: number;
        provisions: number;
        rootCompleted: boolean;
      }>(
        `select
          (select count(*)::int from qualification_participant_allocations where cohort_id = $1) as allocations,
          (select count(*)::int from qualification_participant_provisions where cohort_id = $1) as provisions,
          (select completed_at is not null from qualification_cohort_scrub_roots where cohort_id = $1) as "rootCompleted"`,
        [cohortId],
      ),
    );
    expect(state.rows[0]).toEqual({ allocations: 2, provisions: 2, rootCompleted: false });
  }),
);

it.effect("rejects a malformed product-deletion receipt before claiming its page", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 2 });
    yield* Effect.promise(() =>
      fixture.client.query(
        "update qualification_participant_allocations set deletion_receipt_checksum = 'tampered' where plan = 'free' and participant_index = 1",
      ),
    );
    const authority = makeQualificationCohortAuthority(fixture.database);

    expect(
      yield* authority.claimScrubPage({
        claimToken: "malformed-claim",
        cohortId,
        executionId,
        pageIndex: 0,
        plan: "free",
      }),
    ).toEqual({ _tag: "Conflict" });
  }),
);

it.effect(
  "claims the durable scrub dispatch with DB-clock lease fencing and bounded concurrency",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTestDatabase;
      yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
      yield* applyMigrations(fixture.client);
      yield* seedCohort(fixture, { adventurer: 1, free: 1 });
      const identity = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
      yield* Effect.promise(() =>
        fixture.database.insert(qualificationCohortScrubDispatches).values({
          cohort_id: cohortId,
          dispatch_id: identity.dispatchId,
          execution_id: executionId,
          protocol_version: identity.protocolVersion,
          root_instance_id: identity.rootInstanceId,
          state: "PENDING",
        }),
      );
      const authority = makeQualificationCohortScrubDispatchAuthority(fixture.database);

      const first = yield* authority.claimExact(identity, "claim-1");
      expect(first).toMatchObject({ _tag: "Claimed", claimToken: "claim-1" });
      expect(yield* authority.claimExact(identity, "claim-1")).toEqual(first);
      expect(yield* authority.claimExact(identity, "claim-2")).toMatchObject({ _tag: "Busy" });
      expect(yield* authority.claimBatch("batch-while-busy")).toEqual([]);

      yield* Effect.promise(() =>
        fixture.client.query(
          `update qualification_cohort_scrub_dispatches
         set claimed_at = clock_timestamp() - interval '2 seconds',
             lease_expires_at = clock_timestamp() - interval '1 second'`,
        ),
      );
      expect(yield* authority.claimExact(identity, "claim-1")).toMatchObject({
        _tag: "LeaseExpired",
      });
      expect(yield* authority.claimExact(identity, "claim-2")).toMatchObject({
        _tag: "Claimed",
        claimToken: "claim-2",
      });
    }),
);

it("keeps hourly maintenance successful when no scrub dispatch is pending", async () => {
  const fixture = Effect.runSync(makeTestDatabase);
  try {
    await Effect.runPromise(applyMigrations(fixture.client));
    const authority = makeQualificationCohortScrubDispatchAuthority(fixture.database);

    await settleScheduledBranches([
      () => Effect.runPromise(authority.claimBatch("empty-hourly-claim")).then(() => undefined),
    ]);
    await expect(Effect.runPromise(authority.claimBatch("empty-direct-claim"))).resolves.toEqual(
      [],
    );
  } finally {
    await Effect.runPromise(closeTestDatabase(fixture));
  }
});

it.effect("quarantines a malformed dispatch without starving later authentic work", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const laterCohortId = "qualification-scrub-cohort-later";
    const laterExecutionId = "qualification-scrub-execution-later";
    yield* Effect.promise(() =>
      fixture.database.insert(qualificationCohorts).values({
        artifact_authority_protocol: "qualification-cohort-artifacts-v1",
        artifact_checksum: "later-cohort-checksum",
        artifact_id: `qualification/executions/${laterExecutionId}/cohort/manifest.json`,
        activated_at: new Date(activatedAt),
        cohort_id: laterCohortId,
        created_at: new Date("2099-08-29T16:58:30.000Z"),
        created_for_qualification: true,
        execution_id: laterExecutionId,
        expected_adventurer_participants: 1,
        expected_free_participants: 1,
        expires_at: new Date("2099-09-30T17:00:00.000Z"),
        manifest_checksum: "later-manifest-checksum",
        not_before: new Date(activatedAt),
        plan_checksum: "later-plan-checksum",
        source_version: "source-version",
        state: "PRODUCT_DELETED",
        teardown_policy: "permanentAccountDeletion",
      }),
    );
    const malformed = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
    const authentic = qualificationCohortScrubDispatchIdentity(laterCohortId, laterExecutionId);
    yield* Effect.promise(() =>
      fixture.database.insert(qualificationCohortScrubDispatches).values([
        {
          cohort_id: cohortId,
          created_at: new Date("2099-08-30T17:00:00.000Z"),
          dispatch_id: malformed.dispatchId,
          execution_id: executionId,
          protocol_version: "qualification-cohort-scrub-dispatch-corrupt",
          root_instance_id: malformed.rootInstanceId,
          state: "PENDING",
        },
        {
          cohort_id: laterCohortId,
          created_at: new Date("2099-08-30T17:00:01.000Z"),
          dispatch_id: authentic.dispatchId,
          execution_id: laterExecutionId,
          protocol_version: authentic.protocolVersion,
          root_instance_id: authentic.rootInstanceId,
          state: "PENDING",
        },
      ]),
    );
    const authority = makeQualificationCohortScrubDispatchAuthority(fixture.database);
    const failureChecksum = qualificationChecksum({
      dispatchId: malformed.dispatchId,
      failure: "qualificationCohortScrubDispatchIdentityConflict",
      protocolVersion: malformed.protocolVersion,
    });

    expect(yield* authority.claimBatch("quarantine-claim")).toEqual([
      expect.objectContaining({
        _tag: "Claimed",
        claimToken: "quarantine-claim",
        dispatchId: authentic.dispatchId,
      }),
    ]);
    const [quarantined] = yield* Effect.promise(() =>
      fixture.database
        .select()
        .from(qualificationCohortScrubDispatches)
        .where(eq(qualificationCohortScrubDispatches.dispatch_id, malformed.dispatchId)),
    );
    expect(quarantined).toMatchObject({
      claim_token: null,
      last_status: "identityConflict",
      last_status_checksum: failureChecksum,
      lease_expires_at: null,
      state: "CONFLICT",
      terminal_failure_checksum: failureChecksum,
    });
  }),
);

it.effect("persists one bounded restart generation and exact settled replay", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* seedCohort(fixture, { adventurer: 1, free: 1 });
    const identity = qualificationCohortScrubDispatchIdentity(cohortId, executionId);
    yield* Effect.promise(() =>
      fixture.database.insert(qualificationCohortScrubDispatches).values({
        cohort_id: cohortId,
        dispatch_id: identity.dispatchId,
        execution_id: executionId,
        protocol_version: identity.protocolVersion,
        root_instance_id: identity.rootInstanceId,
        state: "PENDING",
      }),
    );
    const authority = makeQualificationCohortScrubDispatchAuthority(fixture.database);
    expect(yield* authority.claimBatch("claim", 26)).toEqual([]);
    const [claimed] = yield* authority.claimBatch("claim", 25);
    expect(claimed).toBeDefined();
    if (claimed === undefined) return;
    const reserved = yield* authority.reserveRestart(identity, "claim", "status-checksum");
    expect(reserved).toMatchObject({ _tag: "Reserved", generation: 1 });
    if (reserved._tag !== "Reserved") return;
    expect(yield* authority.reserveRestart(identity, "claim", "status-checksum")).toEqual({
      _tag: "Conflict",
    });
    expect(yield* authority.markRestartApplied(identity, "claim", reserved.intentChecksum)).toEqual(
      { _tag: "Applied" },
    );
    expect(yield* authority.claimExact(identity, "observe-claim")).toMatchObject({
      _tag: "Claimed",
    });
    expect(yield* authority.observe(identity, "observe-claim", "running")).toEqual({
      _tag: "Applied",
    });
    const [afterObservation] = yield* Effect.promise(() =>
      fixture.database.select().from(qualificationCohortScrubDispatches),
    );
    expect(afterObservation).toMatchObject({
      restart_applied_at: null,
      restart_generation: 1,
      restart_intent_checksum: null,
      restart_reserved_at: null,
    });
    const replayClaim = yield* authority.claimExact(identity, "settle-claim");
    expect(replayClaim._tag).toBe("Claimed");
    expect(yield* authority.settle(identity, "settle-claim", "root-checksum")).toEqual({
      _tag: "Applied",
    });
    expect(yield* authority.claimExact(identity, "replay")).toMatchObject({
      _tag: "Completed",
      ...identity,
      rootChecksum: "root-checksum",
    });
    const [retained] = yield* Effect.promise(() =>
      fixture.database.select().from(qualificationCohortScrubDispatches),
    );
    expect(Object.keys(retained ?? {})).not.toContain("user_id");
  }),
);
