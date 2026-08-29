/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed authority timestamps make the retained proof deterministic. */
/* oxlint-disable effecttsgo/prefer-schema-over-json -- This adversarial test mutates an already-schema-encoded retained artifact. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect generators. */
import { expect, it } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import {
  qualificationParticipantAllocations,
  qualificationParticipantProvisions,
} from "@osfo/db/schema/qualification-cohorts";
import { administrativeAuthorities } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect, Predicate } from "effect";

import { Db } from "../../db";
import { AdminActorId, AdminReason } from "../../domain/account-administration";
import { DeletionCaseId } from "../../domain/deletion-case";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import { qualificationAdmissionReceipt } from "../../qualification/qualification-attempt";
import {
  decodeQualificationCohortManifest,
  decodeQualificationParticipantGrant,
  type QualificationCohortManifest,
  type QualificationParticipantGrant,
} from "../../qualification/qualification-cohort";
import { makeQualificationCohortAuthority } from "./qualification-cohort";
import { makeQualificationAttemptIndex } from "./qualification-attempt-index";
import { AccountDeletionPostgres } from "./account-deletion";
import { DeletionCasePostgres } from "./deletion-case";

const cohortCreatedAtUtc = "2099-08-29T16:58:00.000Z";
const createdAtUtc = "2099-08-29T16:59:00.000Z";
const notBeforeUtc = "2099-08-29T17:00:00.000Z";
const expiresAtUtc = "2099-08-30T17:00:00.000Z";

const cohort = (): QualificationCohortManifest => {
  const content = {
    cohortId: "qualification-cohort-1",
    createdAtUtc: cohortCreatedAtUtc,
    executionId: "qualification-execution-1",
    expiresAtUtc,
    grantPrefix: "qualification/executions/qualification-execution-1/cohort/grants",
    manifestChecksum: "manifest-1",
    notBeforeUtc,
    participantCounts: { adventurer: 1, free: 2 },
    planChecksum: "plan-1",
    sourceVersion: "source-1",
    teardownPolicy: "permanentAccountDeletion" as const,
  };
  const decoded = decodeQualificationCohortManifest(
    canonicalQualificationJson({ ...content, artifactChecksum: qualificationChecksum(content) }),
  );
  if (decoded === null) throw new Error("The cohort fixture must decode");
  return decoded;
};

const grant = (
  manifest: QualificationCohortManifest,
  plan: "adventurer" | "free",
  index: number,
  userId: string,
  provisionChecksum = `provision-checksum-${userId}`,
): QualificationParticipantGrant => {
  const content = {
    agentId: `agent-${userId}`,
    cohortChecksum: manifest.artifactChecksum,
    cohortId: manifest.cohortId,
    createdAtUtc,
    executionId: manifest.executionId,
    expiresAtUtc,
    index,
    isolation: "disposableQualificationUser" as const,
    notBeforeUtc,
    plan,
    provisionChecksum,
    provisionId: `provision-${userId}`,
    routeId: `route-${userId}`,
    sessionId: `session-${userId}`,
    status: "ACTIVE" as const,
    userId,
  };
  const decoded = decodeQualificationParticipantGrant(
    canonicalQualificationJson({ ...content, artifactChecksum: qualificationChecksum(content) }),
  );
  if (decoded === null) throw new Error("The participant fixture must decode");
  return decoded;
};

it.effect("requires pre-registration provisions and rejects ordinary or duplicate Users", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    const manifest = cohort();
    const authority = makeQualificationCohortAuthority(fixture.database);
    expect(yield* authority.begin(manifest)).toBe("CREATED");
    expect(yield* authority.begin(manifest)).toBe("EXISTING");
    const changedManifest = { ...manifest, sourceVersion: "changed-source" };
    expect(yield* authority.begin(changedManifest)).toBe("CONFLICT");
    const provisionChecksums = new Map<string, string>();
    for (const [plan, index, userId] of [
      ["free", 0, "qualification-free-0"],
      ["free", 1, "qualification-free-1"],
      ["adventurer", 0, "qualification-adventurer"],
    ] as const) {
      const provisioned = yield* authority.provision({
        cohortId: manifest.cohortId,
        enrollmentDigest: `digest-${userId}`,
        executionId: manifest.executionId,
        expiresAt: new Date(expiresAtUtc),
        participantIndex: index,
        plan,
        provisionId: `provision-${userId}`,
      });
      expect(provisioned.status).toBe("CREATED");
      if ("provisionChecksum" in provisioned) {
        provisionChecksums.set(userId, provisioned.provisionChecksum);
      }
    }

    yield* Effect.promise(() =>
      fixture.database.insert(users).values([
        {
          email: "qualification-free-0@example.test",
          id: "qualification-free-0",
          name: "Qualification Free Zero",
          createdAt: new Date("2099-08-29T16:59:30.000Z"),
          registrationCompletedAt: new Date(notBeforeUtc),
        },
        {
          email: "qualification-free-1@example.test",
          id: "qualification-free-1",
          name: "Qualification Free One",
          createdAt: new Date("2099-08-29T16:59:30.000Z"),
          registrationCompletedAt: new Date(notBeforeUtc),
        },
        {
          email: "qualification-adventurer@example.test",
          id: "qualification-adventurer",
          name: "Qualification Adventurer",
          createdAt: new Date("2099-08-29T16:59:30.000Z"),
          registrationCompletedAt: new Date(notBeforeUtc),
        },
        {
          email: "ordinary-user@example.test",
          id: "ordinary-user",
          name: "Ordinary User",
          createdAt: new Date("2099-08-29T16:59:30.000Z"),
          registrationCompletedAt: new Date(notBeforeUtc),
        },
      ]),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(sessions).values([
        {
          expiresAt: new Date(expiresAtUtc),
          id: "qualification-auth-session-free-0",
          token: "qualification-auth-token-free-0",
          updatedAt: new Date(createdAtUtc),
          userId: "qualification-free-0",
        },
        {
          expiresAt: new Date("2099-08-29T16:59:59.000Z"),
          id: "qualification-auth-session-expired",
          token: "qualification-auth-token-expired",
          updatedAt: new Date(createdAtUtc),
          userId: "qualification-free-0",
        },
        {
          expiresAt: new Date(expiresAtUtc),
          id: "ordinary-auth-session",
          token: "ordinary-auth-token",
          updatedAt: new Date(createdAtUtc),
          userId: "ordinary-user",
        },
      ]),
    );
    expect(
      yield* authority.readActiveAuthSession({
        at: new Date(notBeforeUtc),
        userId: "qualification-free-0",
      }),
    ).toMatchObject({
      sessionId: "qualification-auth-session-free-0",
      userId: "qualification-free-0",
    });
    expect(
      yield* authority.readActiveAuthSession({
        at: new Date(expiresAtUtc),
        userId: "qualification-free-0",
      }),
    ).toBeNull();
    expect(
      yield* authority.readActiveAuthSession({
        at: new Date(notBeforeUtc),
        userId: "qualification-free-1",
      }),
    ).toBeNull();
    yield* Effect.forEach(
      ["qualification-free-0", "qualification-free-1", "qualification-adventurer"],
      (qualificationUserId) =>
        Effect.promise(() =>
          fixture.database
            .update(qualificationParticipantProvisions)
            .set({
              consumed_at: new Date(notBeforeUtc),
              state: "CONSUMED",
              user_id: qualificationUserId,
            })
            .where(
              eq(
                qualificationParticipantProvisions.provision_id,
                `provision-${qualificationUserId}`,
              ),
            ),
        ),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(agents).values(
        [
          "qualification-free-0",
          "qualification-free-1",
          "qualification-adventurer",
          "ordinary-user",
        ].map((userId) => ({
          agent_id: `agent-${userId}`,
          created_at: notBeforeUtc,
          user_id: userId,
        })),
      ),
    );
    yield* Effect.promise(() =>
      fixture.database.insert(billingSubscriptions).values([
        {
          billing_subscription_id: "subscription-free-0",
          plan: "free",
          plan_policy_version: "launch-v1",
          user_id: "qualification-free-0",
        },
        {
          billing_subscription_id: "subscription-free-1",
          plan: "free",
          plan_policy_version: "launch-v1",
          user_id: "qualification-free-1",
        },
        {
          billing_subscription_id: "subscription-ordinary",
          plan: "free",
          plan_policy_version: "launch-v1",
          user_id: "ordinary-user",
        },
        {
          billing_subscription_id: "subscription-adventurer",
          plan: "adventurer",
          plan_policy_version: "launch-v1",
          stripe_current_period_end: new Date("2099-09-29T17:00:00.000Z"),
          stripe_current_period_start: new Date(notBeforeUtc),
          stripe_latest_invoice_id: "invoice-qualification",
          stripe_price_id: "price-qualification",
          stripe_product_id: "product-qualification",
          stripe_status: "active",
          stripe_subscription_id: "stripe-subscription-qualification",
          user_id: "qualification-adventurer",
        },
      ]),
    );

    expect(
      yield* authority.allocate({
        allocationId: "allocation-ordinary",
        grant: grant(manifest, "free", 0, "ordinary-user"),
      }),
    ).toBe("INELIGIBLE");
    expect(
      yield* authority.inspectParticipant(grant(manifest, "free", 0, "ordinary-user")),
    ).toEqual({ _tag: "Missing" });

    const free0 = grant(
      manifest,
      "free",
      0,
      "qualification-free-0",
      provisionChecksums.get("qualification-free-0"),
    );
    const free1 = grant(
      manifest,
      "free",
      1,
      "qualification-free-1",
      provisionChecksums.get("qualification-free-1"),
    );
    const adventurer = grant(
      manifest,
      "adventurer",
      0,
      "qualification-adventurer",
      provisionChecksums.get("qualification-adventurer"),
    );
    yield* Effect.promise(() =>
      fixture.database
        .update(billingSubscriptions)
        .set({ plan: "free" })
        .where(eq(billingSubscriptions.user_id, adventurer.userId)),
    );
    expect(
      yield* authority.allocate({ allocationId: "allocation-adventurer", grant: adventurer }),
    ).toBe("INELIGIBLE");
    yield* Effect.promise(() =>
      fixture.database
        .update(billingSubscriptions)
        .set({ plan: "adventurer" })
        .where(eq(billingSubscriptions.user_id, adventurer.userId)),
    );
    expect(yield* authority.allocate({ allocationId: "allocation-free-0", grant: free0 })).toBe(
      "ALLOCATED",
    );
    yield* Effect.promise(() =>
      fixture.database.insert(allowancePeriods).values({
        allowance_period_id: "allowance-period-free-0",
        billing_subscription_id: "subscription-free-0",
        ends_at: new Date(expiresAtUtc),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: new Date(notBeforeUtc),
        user_id: free0.userId,
      }),
    );
    const attemptIndex = makeQualificationAttemptIndex(fixture.database);
    const attemptContext = {
      attemptId: "qualification-attempt-free-0",
      executionId: manifest.executionId,
      journey: "ordinaryConversation" as const,
      offeredAtEpochMs: Date.parse(notBeforeUtc),
      planChecksum: manifest.planChecksum,
      region: "americas" as const,
      rootId: "qualification-root-free-0",
      runId: "qualification-run-free-0",
    };
    const attempt = {
      agentId: free0.agentId,
      allocationId: "allocation-free-0",
      allowancePeriodId: "allowance-period-free-0",
      attemptId: attemptContext.attemptId,
      authSessionExpiresAt: new Date(expiresAtUtc),
      authSessionId: "qualification-auth-session-free-0",
      executionId: attemptContext.executionId,
      journey: attemptContext.journey,
      offeredAt: new Date(attemptContext.offeredAtEpochMs),
      planChecksum: attemptContext.planChecksum,
      rootId: attemptContext.rootId,
      runId: attemptContext.runId,
      sessionId: free0.sessionId,
      submissionId: "qualification-submission-free-0",
      userId: free0.userId,
    };
    expect(yield* attemptIndex.claim(attempt)).toMatchObject({ status: "CLAIMED" });
    expect(yield* attemptIndex.claim(attempt)).toMatchObject({ status: "EXISTING" });
    expect(yield* attemptIndex.claim({ ...attempt, rootId: "conflicting-root" })).toEqual({
      status: "CONFLICT",
    });
    expect(
      yield* attemptIndex.claim({ ...attempt, authSessionId: "fabricated-auth-session" }),
    ).toEqual({ status: "CONFLICT" });
    const admission = qualificationAdmissionReceipt(
      {
        authorization: { user: { userId: free0.userId } },
        message: "Qualification turn",
        proofArtifactChecksum: "proof-checksum",
        proofArtifactId: "proof-artifact",
        qualificationContext: attemptContext,
        routeId: free0.routeId,
        submissionId: attempt.submissionId,
      },
      free0.agentId,
      {
        decision: "accepted",
        occurredAt: notBeforeUtc,
        thinkSubmissionId: attempt.submissionId,
      },
    );
    expect(yield* attemptIndex.recordDecision(admission)).toBe("RECORDED");
    expect(yield* attemptIndex.recordDecision(admission)).toBe("EXISTING");
    expect(
      yield* attemptIndex.readPage({
        afterAttemptId: "",
        executionId: manifest.executionId,
        limit: 25,
      }),
    ).toMatchObject([{ admissionFactId: admission.productFactId, state: "DECIDED" }]);
    expect(yield* authority.allocate({ allocationId: "allocation-free-0", grant: free0 })).toBe(
      "EXISTING",
    );
    expect(
      yield* authority.allocate({
        allocationId: "allocation-duplicate-user",
        grant: grant(manifest, "free", 1, "qualification-free-0"),
      }),
    ).toBe("INELIGIBLE");
    yield* authority.allocate({ allocationId: "allocation-free-1", grant: free1 });
    yield* authority.allocate({ allocationId: "allocation-adventurer", grant: adventurer });
    expect(yield* authority.inspectProvisionInventory(manifest)).toEqual({ _tag: "Ready" });
    expect(yield* authority.activate(manifest.cohortId)).toBe("INCOMPLETE");
    const freePage = {
      cohortId: manifest.cohortId,
      executionId: manifest.executionId,
      firstParticipantIndex: 0,
      pageIndex: 0,
      participantCount: 2,
      plan: "free" as const,
      receiptChecksum: "free-page-checksum",
      receiptId: "qualification/finalize/free/0",
    };
    expect(yield* authority.confirmFinalizationPage(freePage)).toBe("CONFIRMED");
    expect(yield* authority.confirmFinalizationPage(freePage)).toBe("EXISTING");
    expect(
      yield* authority.confirmFinalizationPage({
        ...freePage,
        receiptChecksum: "conflicting-checksum",
      }),
    ).toBe("CONFLICT");
    expect(
      yield* authority.confirmFinalizationPage({
        cohortId: manifest.cohortId,
        executionId: manifest.executionId,
        firstParticipantIndex: 0,
        pageIndex: 0,
        participantCount: 1,
        plan: "adventurer",
        receiptChecksum: "adventurer-page-checksum",
        receiptId: "qualification/finalize/adventurer/0",
      }),
    ).toBe("CONFIRMED");
    expect(yield* authority.inspectFinalizationInventory(manifest)).toEqual({ _tag: "Ready" });
    const activated = yield* authority.activate(manifest.cohortId);
    expect(activated).toMatchObject({ status: "ACTIVE" });
    const replayedActivation = yield* authority.activate(manifest.cohortId);
    expect(replayedActivation).toEqual(activated);
    const inventory = yield* authority.inspectInventory(manifest);
    expect(inventory).toMatchObject({ _tag: "Ready" });
    if (
      Predicate.isTagged(inventory, "Ready") &&
      Predicate.hasProperty(activated, "status") &&
      activated.status === "ACTIVE" &&
      Predicate.hasProperty(activated, "activatedAt")
    ) {
      expect(inventory.verifiedAt).toEqual(activated.activatedAt);
    }
    expect(yield* authority.inspectParticipant(free0)).toMatchObject({ _tag: "Ready" });
    yield* Effect.promise(() =>
      fixture.database
        .update(qualificationParticipantAllocations)
        .set({ grant_checksum: "" })
        .where(eq(qualificationParticipantAllocations.user_id, free0.userId)),
    );
    expect(yield* authority.inspectInventory(manifest)).toEqual({ _tag: "Missing" });
    yield* Effect.promise(() =>
      fixture.database
        .update(qualificationParticipantAllocations)
        .set({ grant_checksum: free0.artifactChecksum })
        .where(eq(qualificationParticipantAllocations.user_id, free0.userId)),
    );
    const adminActorId = AdminActorId.make("qualification-provisioner");
    const reason = AdminReason.make("Disposable qualification cohort teardown");
    yield* Effect.promise(() =>
      fixture.database.insert(administrativeAuthorities).values({
        admin_actor_id: adminActorId,
      }),
    );
    const deletionCases = yield* Effect.scoped(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The integration test constructs this complete scoped adapter entry point.
      DeletionCasePostgres.make.pipe(Effect.provide(Db.layerFromDatabase(fixture.database))),
    );
    const accountDeletion = AccountDeletionPostgres.make(fixture.database);
    yield* Effect.forEach(
      [free0, free1, adventurer],
      (participant) =>
        Effect.gen(function* () {
          const deletionCaseId = DeletionCaseId.make(`deletion-${participant.userId}`);
          const command = { adminActorId, reason, userId: participant.userId };
          expect(yield* deletionCases.request(command, deletionCaseId)).toEqual({
            _tag: "Created",
          });
          expect(yield* deletionCases.markAccessFenced(command, deletionCaseId)).toEqual({
            _tag: "Fenced",
          });
          yield* accountDeletion.removeUser({
            _tag: "Administrative",
            adminActorId,
            agentId: participant.agentId,
            deletionCaseId,
            reason,
            userId: participant.userId,
          });
        }),
      { concurrency: 1, discard: true },
    );
    expect(yield* authority.inspectTeardown(manifest.cohortId)).toMatchObject({
      active: 0,
      activeCohorts: 0,
      deleted: 3,
      missingReceipts: 0,
    });
    const retainedProvisions = yield* Effect.promise(() =>
      fixture.database.select().from(qualificationParticipantProvisions),
    );
    expect(JSON.stringify(retainedProvisions)).not.toContain("@example.test");
    expect(JSON.stringify(retainedProvisions)).not.toContain("+1");
  }),
);

it.effect("mints a database-timestamped cohort with exact replay", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    const authority = makeQualificationCohortAuthority(fixture.database);
    const input = {
      cohortId: "owned-cohort",
      executionId: "owned-execution",
      expiresAt: new Date("2099-08-30T17:00:00.000Z"),
      manifestChecksum: "owned-manifest",
      notBefore: new Date("2099-08-29T17:00:00.000Z"),
      participantCounts: { adventurer: 1, free: 2 },
      planChecksum: "owned-plan",
      sourceVersion: "owned-source",
    };

    const created = yield* authority.beginOwned(input);
    expect(created).toMatchObject({ status: "CREATED" });
    const replay = yield* authority.beginOwned(input);
    expect(replay).toMatchObject({ status: "EXISTING" });
    if (created.status === "CREATED" && replay.status === "EXISTING") {
      expect(replay.manifest).toEqual(created.manifest);
      expect(created.manifest.createdAtUtc).not.toBe(input.notBefore.toISOString());
    }
    expect(yield* authority.beginOwned({ ...input, sourceVersion: "conflicting-source" })).toEqual({
      status: "CONFLICT",
    });
  }),
);
