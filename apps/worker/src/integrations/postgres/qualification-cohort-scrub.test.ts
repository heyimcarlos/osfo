/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle -- PostgreSQL test setup is Promise-native, timestamps are fixed, and outcomes use the canonical _tag discriminator. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect generators. */
import { expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import { qualificationChecksum } from "../../qualification/qualification-checksum";
import { qualificationCohortScrubPartitionProtocol } from "../../qualification/cohort-scrub-partition";
import { qualificationCohortScrubRootWorkflowPayload } from "../../qualification/cohort-scrub-root";
import { makeQualificationCohortAuthority } from "./qualification-cohort";

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
