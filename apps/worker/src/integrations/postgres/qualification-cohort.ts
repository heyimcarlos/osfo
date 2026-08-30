/* oxlint-disable effecttsgo/global-date -- PostgreSQL rows are adapted to native Date values at this Promise-native boundary. */
import { agents } from "@osfo/db/schema/agents";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import {
  qualificationCohortFinalizationPages,
  qualificationCohorts,
  qualificationParticipantAllocations,
  qualificationParticipantProvisions,
} from "@osfo/db/schema/qualification-cohorts";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "@osfo/db";
import {
  qualificationDocumentBuildFixturePolicy,
  type QualificationCohortManifest,
  type QualificationParticipantGrant,
} from "../../qualification/qualification-cohort";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import { qualificationCohortArtifactProtocol } from "../../qualification/cohort-artifact-authority-contract";
import { QualificationCohortAuthorityUnavailable } from "./qualification-cohort-error";
import { makeQualificationCohortScrubAuthority } from "./qualification-cohort-scrub";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns these transaction Promise boundaries. */

export { QualificationCohortAuthorityUnavailable } from "./qualification-cohort-error";

interface ProvisionedParticipant {
  readonly allocationId: string;
  readonly grant: QualificationParticipantGrant;
}

interface DisposableParticipantProvision {
  readonly cohortId: string;
  readonly enrollmentDigest: string;
  readonly executionId: string;
  readonly expiresAt: Date;
  readonly participantIndex: number;
  readonly plan: "adventurer" | "free";
  readonly provisionId: string;
}

interface OwnedCohortInput {
  readonly cohortId: string;
  readonly executionId: string;
  readonly expiresAt: Date;
  readonly manifestChecksum: string;
  readonly notBefore: Date;
  readonly participantCounts: { readonly adventurer: number; readonly free: number };
  readonly planChecksum: string;
  readonly sourceVersion: string;
}

interface FinalizationPageInput {
  readonly cohortId: string;
  readonly executionId: string;
  readonly firstParticipantIndex: number;
  readonly pageIndex: number;
  readonly participantCount: number;
  readonly plan: "adventurer" | "free";
  readonly receiptChecksum: string;
  readonly receiptId: string;
}

const qualificationCohortManifestFor = (row: typeof qualificationCohorts.$inferSelect) => {
  const content = {
    artifactAuthorityProtocol: qualificationCohortArtifactProtocol,
    cohortId: row.cohort_id,
    createdAtUtc: row.created_at.toISOString(),
    executionId: row.execution_id,
    expiresAtUtc: row.expires_at.toISOString(),
    grantPrefix: `qualification/executions/${encodeURIComponent(row.execution_id)}/cohort/grants`,
    documentBuildFixturePolicy: qualificationDocumentBuildFixturePolicy,
    manifestChecksum: row.manifest_checksum,
    notBeforeUtc: row.not_before.toISOString(),
    participantCounts: {
      adventurer: row.expected_adventurer_participants,
      free: row.expected_free_participants,
    },
    planChecksum: row.plan_checksum,
    sourceVersion: row.source_version,
    teardownPolicy: "permanentAccountDeletion" as const,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

/** PostgreSQL authority owned by the disposable qualification-account provisioner. */
export const makeQualificationCohortAuthority = (database: Database) => {
  const scrub = makeQualificationCohortScrubAuthority(database);
  const readActiveAuthSession = Effect.fn("QualificationCohortAuthority.readActiveAuthSession")(
    (input: { readonly at: Date; readonly userId: string }) =>
      attempt("readActiveAuthSession", async () => {
        const [session] = await database
          .select({
            expiresAt: sessions.expiresAt,
            sessionId: sessions.id,
            userId: sessions.userId,
          })
          .from(sessions)
          .where(and(eq(sessions.userId, input.userId), gt(sessions.expiresAt, input.at)))
          .orderBy(desc(sessions.expiresAt), asc(sessions.id))
          .limit(1);
        return session ?? null;
      }),
  );
  const confirmFinalizationPage = Effect.fn("QualificationCohortAuthority.confirmFinalizationPage")(
    (input: FinalizationPageInput) =>
      attempt("confirmFinalizationPage", () =>
        database.transaction(async (transaction) => {
          const [cohort] = await transaction
            .select({ state: qualificationCohorts.state })
            .from(qualificationCohorts)
            .where(
              and(
                eq(qualificationCohorts.cohort_id, input.cohortId),
                eq(qualificationCohorts.execution_id, input.executionId),
              ),
            )
            .for("update")
            .limit(1);
          if (cohort?.state !== "PROVISIONING") return "INELIGIBLE" as const;
          const [retained] = await transaction
            .insert(qualificationCohortFinalizationPages)
            .values({
              cohort_id: input.cohortId,
              execution_id: input.executionId,
              first_participant_index: input.firstParticipantIndex,
              page_index: input.pageIndex,
              participant_count: input.participantCount,
              plan: input.plan,
              receipt_checksum: input.receiptChecksum,
              receipt_id: input.receiptId,
            })
            .onConflictDoNothing()
            .returning();
          const existing =
            retained ??
            (
              await transaction
                .select()
                .from(qualificationCohortFinalizationPages)
                .where(
                  and(
                    eq(qualificationCohortFinalizationPages.cohort_id, input.cohortId),
                    eq(qualificationCohortFinalizationPages.plan, input.plan),
                    eq(qualificationCohortFinalizationPages.page_index, input.pageIndex),
                  ),
                )
                .limit(1)
            )[0];
          return existing !== undefined &&
            existing.execution_id === input.executionId &&
            existing.first_participant_index === input.firstParticipantIndex &&
            existing.participant_count === input.participantCount &&
            existing.receipt_checksum === input.receiptChecksum &&
            existing.receipt_id === input.receiptId
            ? retained === undefined
              ? ("EXISTING" as const)
              : ("CONFIRMED" as const)
            : ("CONFLICT" as const);
        }),
      ),
  );
  const beginOwned = Effect.fn("QualificationCohortAuthority.beginOwned")(
    (input: OwnedCohortInput) =>
      attempt("beginOwned", () =>
        database.transaction(async (transaction) => {
          const [existing] = await transaction
            .select()
            .from(qualificationCohorts)
            .where(eq(qualificationCohorts.execution_id, input.executionId))
            .for("update")
            .limit(1);
          if (existing !== undefined) {
            const manifest = qualificationCohortManifestFor(existing);
            const exact =
              existing.artifact_authority_protocol === qualificationCohortArtifactProtocol &&
              existing.artifact_checksum === manifest.artifactChecksum &&
              existing.cohort_id === input.cohortId &&
              existing.created_for_qualification &&
              existing.execution_id === input.executionId &&
              existing.expected_adventurer_participants === input.participantCounts.adventurer &&
              existing.expected_free_participants === input.participantCounts.free &&
              existing.expires_at.getTime() === input.expiresAt.getTime() &&
              existing.manifest_checksum === input.manifestChecksum &&
              existing.not_before.getTime() === input.notBefore.getTime() &&
              existing.plan_checksum === input.planChecksum &&
              existing.source_version === input.sourceVersion &&
              (existing.state === "PROVISIONING" || existing.state === "ACTIVE");
            return exact
              ? ({ manifest, status: "EXISTING" as const } as const)
              : ({ status: "CONFLICT" as const } as const);
          }
          const [inserted] = await transaction
            .insert(qualificationCohorts)
            .values({
              artifact_authority_protocol: qualificationCohortArtifactProtocol,
              artifact_checksum: "pending-transaction-checksum",
              artifact_id: `qualification/executions/${encodeURIComponent(input.executionId)}/cohort/manifest.json`,
              cohort_id: input.cohortId,
              created_for_qualification: true,
              execution_id: input.executionId,
              expected_adventurer_participants: input.participantCounts.adventurer,
              expected_free_participants: input.participantCounts.free,
              expires_at: input.expiresAt,
              manifest_checksum: input.manifestChecksum,
              not_before: input.notBefore,
              plan_checksum: input.planChecksum,
              source_version: input.sourceVersion,
              state: "PROVISIONING",
              teardown_policy: "permanentAccountDeletion",
            })
            .returning();
          if (inserted === undefined) throw new Error("Qualification cohort was not retained");
          const manifest = qualificationCohortManifestFor(inserted);
          await transaction
            .update(qualificationCohorts)
            .set({ artifact_checksum: manifest.artifactChecksum })
            .where(eq(qualificationCohorts.cohort_id, input.cohortId));
          return { manifest, status: "CREATED" as const } as const;
        }),
      ),
  );
  const begin = Effect.fn("QualificationCohortAuthority.begin")(
    (manifest: QualificationCohortManifest) =>
      attempt("begin", () =>
        database.transaction(async (transaction) => {
          const [existing] = await transaction
            .select()
            .from(qualificationCohorts)
            .where(eq(qualificationCohorts.execution_id, manifest.executionId))
            .for("update")
            .limit(1);
          if (existing !== undefined) {
            return existing.artifact_checksum === manifest.artifactChecksum &&
              existing.artifact_authority_protocol === qualificationCohortArtifactProtocol &&
              existing.cohort_id === manifest.cohortId &&
              existing.created_at.toISOString() === manifest.createdAtUtc &&
              existing.created_for_qualification &&
              existing.execution_id === manifest.executionId &&
              existing.expected_adventurer_participants === manifest.participantCounts.adventurer &&
              existing.expected_free_participants === manifest.participantCounts.free &&
              existing.expires_at.toISOString() === manifest.expiresAtUtc &&
              existing.manifest_checksum === manifest.manifestChecksum &&
              existing.not_before.toISOString() === manifest.notBeforeUtc &&
              existing.plan_checksum === manifest.planChecksum &&
              existing.source_version === manifest.sourceVersion &&
              existing.teardown_policy === manifest.teardownPolicy
              ? ("EXISTING" as const)
              : ("CONFLICT" as const);
          }
          await transaction.insert(qualificationCohorts).values({
            artifact_authority_protocol: qualificationCohortArtifactProtocol,
            artifact_checksum: manifest.artifactChecksum,
            artifact_id: `qualification/executions/${encodeURIComponent(manifest.executionId)}/cohort/manifest.json`,
            cohort_id: manifest.cohortId,
            created_at: new Date(manifest.createdAtUtc),
            created_for_qualification: true,
            execution_id: manifest.executionId,
            expected_adventurer_participants: manifest.participantCounts.adventurer,
            expected_free_participants: manifest.participantCounts.free,
            expires_at: new Date(manifest.expiresAtUtc),
            manifest_checksum: manifest.manifestChecksum,
            not_before: new Date(manifest.notBeforeUtc),
            plan_checksum: manifest.planChecksum,
            source_version: manifest.sourceVersion,
            state: "PROVISIONING",
            teardown_policy: manifest.teardownPolicy,
          });
          return "CREATED" as const;
        }),
      ),
  );

  const provision = Effect.fn("QualificationCohortAuthority.provision")(
    (input: DisposableParticipantProvision) =>
      attempt("provision", () =>
        database.transaction(async (transaction) => {
          const [cohort] = await transaction
            .select({
              adventurer: qualificationCohorts.expected_adventurer_participants,
              executionId: qualificationCohorts.execution_id,
              expiresAt: qualificationCohorts.expires_at,
              free: qualificationCohorts.expected_free_participants,
              state: qualificationCohorts.state,
            })
            .from(qualificationCohorts)
            .where(eq(qualificationCohorts.cohort_id, input.cohortId))
            .for("update")
            .limit(1);
          if (
            cohort === undefined ||
            cohort.executionId !== input.executionId ||
            cohort.state !== "PROVISIONING" ||
            input.expiresAt > cohort.expiresAt ||
            input.participantIndex >= (input.plan === "free" ? cohort.free : cohort.adventurer)
          ) {
            return { status: "INELIGIBLE" as const };
          }
          const [existing] = await transaction
            .select()
            .from(qualificationParticipantProvisions)
            .where(
              or(
                eq(qualificationParticipantProvisions.provision_id, input.provisionId),
                eq(qualificationParticipantProvisions.enrollment_digest, input.enrollmentDigest),
                and(
                  eq(qualificationParticipantProvisions.cohort_id, input.cohortId),
                  eq(qualificationParticipantProvisions.plan, input.plan),
                  eq(qualificationParticipantProvisions.participant_index, input.participantIndex),
                ),
              ),
            )
            .for("update")
            .limit(1);
          if (existing !== undefined) {
            return existing.cohort_id === input.cohortId &&
              existing.enrollment_digest === input.enrollmentDigest &&
              existing.execution_id === input.executionId &&
              existing.expires_at.getTime() === input.expiresAt.getTime() &&
              existing.participant_index === input.participantIndex &&
              existing.plan === input.plan &&
              existing.provision_id === input.provisionId &&
              existing.state === "PENDING" &&
              existing.user_id === null
              ? ({
                  createdAt: existing.created_at,
                  provisionChecksum: existing.provision_checksum,
                  status: "EXISTING" as const,
                } as const)
              : ({ status: "CONFLICT" as const } as const);
          }
          const [inserted] = await transaction
            .insert(qualificationParticipantProvisions)
            .values({
              cohort_id: input.cohortId,
              enrollment_digest: input.enrollmentDigest,
              execution_id: input.executionId,
              expires_at: input.expiresAt,
              participant_index: input.participantIndex,
              plan: input.plan,
              provision_checksum: "pending-transaction-checksum",
              provision_id: input.provisionId,
              state: "PENDING",
            })
            .returning({ committedAt: qualificationParticipantProvisions.created_at });
          if (inserted === undefined || inserted.committedAt >= input.expiresAt) {
            throw new Error("The committed qualification provision lifetime is invalid");
          }
          const committedAt = inserted.committedAt;
          const provisionChecksum = qualificationChecksum({
            cohortId: input.cohortId,
            committedAtUtc: committedAt.toISOString(),
            enrollmentDigest: input.enrollmentDigest,
            executionId: input.executionId,
            expiresAtUtc: input.expiresAt.toISOString(),
            participantIndex: input.participantIndex,
            plan: input.plan,
            provisionId: input.provisionId,
          });
          await transaction
            .update(qualificationParticipantProvisions)
            .set({ provision_checksum: provisionChecksum })
            .where(eq(qualificationParticipantProvisions.provision_id, input.provisionId));
          return { createdAt: committedAt, provisionChecksum, status: "CREATED" as const };
        }),
      ),
  );

  const allocate = Effect.fn("QualificationCohortAuthority.allocate")(
    ({ allocationId, grant }: ProvisionedParticipant) =>
      attempt("allocate", () =>
        database.transaction(async (transaction) => {
          const [eligible] = await transaction
            .select({
              agentId: agents.agent_id,
              cohortArtifactChecksum: qualificationCohorts.artifact_checksum,
              cohortCreatedAt: qualificationCohorts.created_at,
              cohortExpiresAt: qualificationCohorts.expires_at,
              cohortNotBefore: qualificationCohorts.not_before,
              cohortState: qualificationCohorts.state,
              expectedAdventurer: qualificationCohorts.expected_adventurer_participants,
              expectedFree: qualificationCohorts.expected_free_participants,
              plan: billingSubscriptions.plan,
              provisionChecksum: qualificationParticipantProvisions.provision_checksum,
              provisionIndex: qualificationParticipantProvisions.participant_index,
              provisionPlan: qualificationParticipantProvisions.plan,
              provisionState: qualificationParticipantProvisions.state,
              registrationCompletedAt: users.registrationCompletedAt,
              userId: users.id,
            })
            .from(qualificationCohorts)
            .innerJoin(users, eq(users.id, grant.userId))
            .innerJoin(agents, eq(agents.user_id, users.id))
            .innerJoin(billingSubscriptions, eq(billingSubscriptions.user_id, users.id))
            .innerJoin(
              qualificationParticipantProvisions,
              and(
                eq(qualificationParticipantProvisions.provision_id, grant.provisionId),
                eq(qualificationParticipantProvisions.user_id, users.id),
                eq(qualificationParticipantProvisions.cohort_id, qualificationCohorts.cohort_id),
                eq(
                  qualificationParticipantProvisions.execution_id,
                  qualificationCohorts.execution_id,
                ),
              ),
            )
            .where(
              and(
                eq(qualificationCohorts.cohort_id, grant.cohortId),
                eq(qualificationCohorts.execution_id, grant.executionId),
                eq(qualificationCohorts.state, "PROVISIONING"),
              ),
            )
            .for("update")
            .limit(1);
          if (
            eligible === undefined ||
            eligible.userId !== grant.userId ||
            eligible.agentId !== grant.agentId ||
            eligible.plan !== grant.plan ||
            eligible.provisionChecksum !== grant.provisionChecksum ||
            eligible.provisionIndex !== grant.index ||
            eligible.provisionPlan !== grant.plan ||
            eligible.provisionState !== "CONSUMED" ||
            eligible.registrationCompletedAt === null ||
            eligible.cohortArtifactChecksum !== grant.cohortChecksum ||
            Date.parse(grant.createdAtUtc) < eligible.cohortCreatedAt.getTime() ||
            Date.parse(grant.createdAtUtc) > eligible.cohortNotBefore.getTime() ||
            eligible.cohortNotBefore.toISOString() !== grant.notBeforeUtc ||
            eligible.cohortExpiresAt.toISOString() !== grant.expiresAtUtc ||
            grant.index >=
              (grant.plan === "free" ? eligible.expectedFree : eligible.expectedAdventurer)
          ) {
            return "INELIGIBLE" as const;
          }
          const grantId = `qualification/executions/${encodeURIComponent(grant.executionId)}/cohort/grants/${grant.plan}/${grant.index.toString().padStart(8, "0")}.json`;
          const [existing] = await transaction
            .select()
            .from(qualificationParticipantAllocations)
            .where(
              or(
                eq(qualificationParticipantAllocations.allocation_id, allocationId),
                and(
                  eq(qualificationParticipantAllocations.cohort_id, grant.cohortId),
                  eq(qualificationParticipantAllocations.plan, grant.plan),
                  eq(qualificationParticipantAllocations.participant_index, grant.index),
                ),
                eq(qualificationParticipantAllocations.user_id, grant.userId),
                eq(qualificationParticipantAllocations.agent_id, grant.agentId),
                eq(qualificationParticipantAllocations.session_id, grant.sessionId),
                eq(qualificationParticipantAllocations.grant_id, grantId),
              ),
            )
            .for("update")
            .limit(1);
          if (existing !== undefined) {
            return existing.agent_id === grant.agentId &&
              existing.allocation_id === allocationId &&
              existing.cohort_id === grant.cohortId &&
              existing.created_at.toISOString() === grant.createdAtUtc &&
              existing.created_for_qualification &&
              existing.execution_id === grant.executionId &&
              existing.expires_at.toISOString() === grant.expiresAtUtc &&
              existing.grant_checksum === grant.artifactChecksum &&
              existing.grant_id === grantId &&
              existing.not_before.toISOString() === grant.notBeforeUtc &&
              existing.participant_index === grant.index &&
              existing.plan === grant.plan &&
              existing.provision_checksum === grant.provisionChecksum &&
              existing.provision_id === grant.provisionId &&
              existing.route_id === grant.routeId &&
              existing.session_id === grant.sessionId &&
              existing.state === "ACTIVE" &&
              existing.user_id === grant.userId
              ? ("EXISTING" as const)
              : ("CONFLICT" as const);
          }
          await transaction.insert(qualificationParticipantAllocations).values({
            agent_id: grant.agentId,
            allocation_id: allocationId,
            cohort_id: grant.cohortId,
            created_at: new Date(grant.createdAtUtc),
            created_for_qualification: true,
            execution_id: grant.executionId,
            expires_at: new Date(grant.expiresAtUtc),
            grant_checksum: grant.artifactChecksum,
            grant_id: grantId,
            not_before: new Date(grant.notBeforeUtc),
            participant_index: grant.index,
            plan: grant.plan,
            provision_checksum: grant.provisionChecksum,
            provision_id: grant.provisionId,
            route_id: grant.routeId,
            session_id: grant.sessionId,
            state: "ACTIVE",
            user_id: grant.userId,
          });
          return "ALLOCATED" as const;
        }),
      ),
  );

  const activate = Effect.fn("QualificationCohortAuthority.activate")((cohortId: string) =>
    attempt("activate", () =>
      database.transaction(async (transaction) => {
        const [cohort] = await transaction
          .select({
            activatedAt: qualificationCohorts.activated_at,
            adventurer: qualificationCohorts.expected_adventurer_participants,
            free: qualificationCohorts.expected_free_participants,
            state: qualificationCohorts.state,
          })
          .from(qualificationCohorts)
          .where(eq(qualificationCohorts.cohort_id, cohortId))
          .for("update")
          .limit(1);
        if (cohort === undefined) return "MISSING" as const;
        if (cohort.state === "ACTIVE") {
          return cohort.activatedAt === null
            ? ({ status: "CONFLICT" as const } as const)
            : ({ activatedAt: cohort.activatedAt, status: "ACTIVE" as const } as const);
        }
        if (cohort.state !== "PROVISIONING") return "CONFLICT" as const;
        const [counts] = await transaction
          .select({
            adventurer: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.plan} = 'adventurer')::int`,
            free: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.plan} = 'free')::int`,
          })
          .from(qualificationParticipantAllocations)
          .where(
            and(
              eq(qualificationParticipantAllocations.cohort_id, cohortId),
              eq(qualificationParticipantAllocations.state, "ACTIVE"),
            ),
          );
        if (counts?.adventurer !== cohort.adventurer || counts.free !== cohort.free) {
          return "INCOMPLETE" as const;
        }
        const [finalization] = await transaction
          .select({
            adventurerPages: sql<number>`count(*) filter (where ${qualificationCohortFinalizationPages.plan} = 'adventurer')::int`,
            adventurerParticipants: sql<number>`coalesce(sum(${qualificationCohortFinalizationPages.participant_count}) filter (where ${qualificationCohortFinalizationPages.plan} = 'adventurer'), 0)::int`,
            freePages: sql<number>`count(*) filter (where ${qualificationCohortFinalizationPages.plan} = 'free')::int`,
            freeParticipants: sql<number>`coalesce(sum(${qualificationCohortFinalizationPages.participant_count}) filter (where ${qualificationCohortFinalizationPages.plan} = 'free'), 0)::int`,
          })
          .from(qualificationCohortFinalizationPages)
          .where(eq(qualificationCohortFinalizationPages.cohort_id, cohortId));
        if (
          finalization?.freePages !== Math.ceil(cohort.free / 25) ||
          finalization.adventurerPages !== Math.ceil(cohort.adventurer / 25) ||
          finalization.freeParticipants !== cohort.free ||
          finalization.adventurerParticipants !== cohort.adventurer
        ) {
          return "INCOMPLETE" as const;
        }
        const [activated] = await transaction
          .update(qualificationCohorts)
          .set({ activated_at: sql`clock_timestamp()`, state: "ACTIVE" })
          .where(
            and(
              eq(qualificationCohorts.cohort_id, cohortId),
              eq(qualificationCohorts.state, "PROVISIONING"),
            ),
          )
          .returning({ activatedAt: qualificationCohorts.activated_at });
        return activated?.activatedAt === null || activated?.activatedAt === undefined
          ? ({ status: "CONFLICT" as const } as const)
          : ({ activatedAt: activated.activatedAt, status: "ACTIVE" as const } as const);
      }),
    ),
  );

  const inspectParticipant = Effect.fn("QualificationCohortAuthority.inspectParticipant")(
    (grant: QualificationParticipantGrant) =>
      attempt("inspectParticipant", async () => {
        const [row] = await database
          .select({
            agentId: agents.agent_id,
            allocationId: qualificationParticipantAllocations.allocation_id,
            cohortArtifactChecksum: qualificationCohorts.artifact_checksum,
            cohortState: qualificationCohorts.state,
            createdAt: qualificationParticipantAllocations.created_at,
            createdForQualification: qualificationParticipantAllocations.created_for_qualification,
            expiresAt: qualificationParticipantAllocations.expires_at,
            grantChecksum: qualificationParticipantAllocations.grant_checksum,
            grantId: qualificationParticipantAllocations.grant_id,
            notBefore: qualificationParticipantAllocations.not_before,
            plan: billingSubscriptions.plan,
            provisionChecksum: qualificationParticipantAllocations.provision_checksum,
            provisionId: qualificationParticipantAllocations.provision_id,
            registrationCompletedAt: users.registrationCompletedAt,
            routeId: qualificationParticipantAllocations.route_id,
            sessionId: qualificationParticipantAllocations.session_id,
            state: qualificationParticipantAllocations.state,
            userId: users.id,
          })
          .from(qualificationParticipantAllocations)
          .innerJoin(
            qualificationCohorts,
            and(
              eq(qualificationCohorts.cohort_id, qualificationParticipantAllocations.cohort_id),
              eq(
                qualificationCohorts.execution_id,
                qualificationParticipantAllocations.execution_id,
              ),
            ),
          )
          .innerJoin(users, eq(users.id, qualificationParticipantAllocations.user_id))
          .innerJoin(agents, eq(agents.user_id, users.id))
          .innerJoin(billingSubscriptions, eq(billingSubscriptions.user_id, users.id))
          .where(
            and(
              eq(qualificationParticipantAllocations.cohort_id, grant.cohortId),
              eq(qualificationParticipantAllocations.execution_id, grant.executionId),
              eq(qualificationParticipantAllocations.participant_index, grant.index),
              eq(qualificationParticipantAllocations.plan, grant.plan),
            ),
          )
          .limit(1);
        if (row === undefined) return { _tag: "Missing" } as const;
        const exact =
          row.agentId === grant.agentId &&
          row.cohortArtifactChecksum === grant.cohortChecksum &&
          row.cohortState === "ACTIVE" &&
          row.createdAt.toISOString() === grant.createdAtUtc &&
          row.createdForQualification &&
          row.expiresAt.toISOString() === grant.expiresAtUtc &&
          row.grantChecksum === grant.artifactChecksum &&
          row.grantId ===
            `qualification/executions/${encodeURIComponent(grant.executionId)}/cohort/grants/${grant.plan}/${grant.index.toString().padStart(8, "0")}.json` &&
          row.notBefore.toISOString() === grant.notBeforeUtc &&
          row.plan === grant.plan &&
          row.provisionChecksum === grant.provisionChecksum &&
          row.provisionId === grant.provisionId &&
          row.registrationCompletedAt !== null &&
          row.routeId === grant.routeId &&
          row.sessionId === grant.sessionId &&
          row.state === "ACTIVE" &&
          row.userId === grant.userId;
        return exact
          ? ({ _tag: "Ready", allocationId: row.allocationId } as const)
          : ({ _tag: "Conflict" } as const);
      }),
  );

  const inspectInventory = Effect.fn("QualificationCohortAuthority.inspectInventory")(
    (manifest: QualificationCohortManifest) =>
      attempt("inspectInventory", async () => {
        const [cohort] = await database
          .select()
          .from(qualificationCohorts)
          .where(eq(qualificationCohorts.execution_id, manifest.executionId))
          .limit(1);
        if (cohort === undefined) return { _tag: "Missing" } as const;
        const exactCohort =
          cohort.artifact_authority_protocol === qualificationCohortArtifactProtocol &&
          cohort.artifact_checksum === manifest.artifactChecksum &&
          cohort.cohort_id === manifest.cohortId &&
          cohort.created_at.toISOString() === manifest.createdAtUtc &&
          cohort.created_for_qualification &&
          cohort.expected_adventurer_participants === manifest.participantCounts.adventurer &&
          cohort.expected_free_participants === manifest.participantCounts.free &&
          cohort.expires_at.toISOString() === manifest.expiresAtUtc &&
          cohort.manifest_checksum === manifest.manifestChecksum &&
          cohort.not_before.toISOString() === manifest.notBeforeUtc &&
          cohort.plan_checksum === manifest.planChecksum &&
          cohort.source_version === manifest.sourceVersion &&
          cohort.state === "ACTIVE" &&
          cohort.teardown_policy === manifest.teardownPolicy;
        if (!exactCohort) return { _tag: "Conflict" } as const;
        const [summary] = await database
          .select({
            adventurer: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.plan} = 'adventurer')::int`,
            adventurerDistinctIndexes: sql<number>`count(distinct ${qualificationParticipantAllocations.participant_index}) filter (where ${qualificationParticipantAllocations.plan} = 'adventurer')::int`,
            adventurerMaximumIndex: sql<
              number | null
            >`max(${qualificationParticipantAllocations.participant_index}) filter (where ${qualificationParticipantAllocations.plan} = 'adventurer')`,
            adventurerMinimumIndex: sql<
              number | null
            >`min(${qualificationParticipantAllocations.participant_index}) filter (where ${qualificationParticipantAllocations.plan} = 'adventurer')`,
            distinctAgents: sql<number>`count(distinct ${qualificationParticipantAllocations.agent_id})::int`,
            distinctSessions: sql<number>`count(distinct ${qualificationParticipantAllocations.session_id})::int`,
            distinctUsers: sql<number>`count(distinct ${qualificationParticipantAllocations.user_id})::int`,
            free: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.plan} = 'free')::int`,
            freeDistinctIndexes: sql<number>`count(distinct ${qualificationParticipantAllocations.participant_index}) filter (where ${qualificationParticipantAllocations.plan} = 'free')::int`,
            freeMaximumIndex: sql<
              number | null
            >`max(${qualificationParticipantAllocations.participant_index}) filter (where ${qualificationParticipantAllocations.plan} = 'free')`,
            freeMinimumIndex: sql<
              number | null
            >`min(${qualificationParticipantAllocations.participant_index}) filter (where ${qualificationParticipantAllocations.plan} = 'free')`,
            joinedCurrentAuthorities: sql<number>`count(*) filter (where ${users.id} is not null and ${agents.agent_id} is not null and ${billingSubscriptions.user_id} is not null and ${qualificationParticipantProvisions.state} = 'CONSUMED')::int`,
            matchingPlans: sql<number>`count(*) filter (where ${billingSubscriptions.plan} = ${qualificationParticipantAllocations.plan})::int`,
            matchingProofs: sql<number>`count(*) filter (where length(${qualificationParticipantAllocations.grant_checksum}) > 0 and length(${qualificationParticipantAllocations.grant_id}) > 0 and ${qualificationParticipantProvisions.provision_checksum} = ${qualificationParticipantAllocations.provision_checksum})::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(qualificationParticipantAllocations)
          .leftJoin(users, eq(users.id, qualificationParticipantAllocations.user_id))
          .leftJoin(agents, eq(agents.user_id, qualificationParticipantAllocations.user_id))
          .leftJoin(
            billingSubscriptions,
            eq(billingSubscriptions.user_id, qualificationParticipantAllocations.user_id),
          )
          .leftJoin(
            qualificationParticipantProvisions,
            and(
              eq(
                qualificationParticipantProvisions.provision_id,
                qualificationParticipantAllocations.provision_id,
              ),
              eq(
                qualificationParticipantProvisions.user_id,
                qualificationParticipantAllocations.user_id,
              ),
            ),
          )
          .where(
            and(
              eq(qualificationParticipantAllocations.cohort_id, manifest.cohortId),
              eq(qualificationParticipantAllocations.execution_id, manifest.executionId),
              eq(qualificationParticipantAllocations.state, "ACTIVE"),
            ),
          );
        const expectedTotal =
          manifest.participantCounts.free + manifest.participantCounts.adventurer;
        const exactInventory =
          summary !== undefined &&
          summary.total === expectedTotal &&
          summary.free === manifest.participantCounts.free &&
          summary.adventurer === manifest.participantCounts.adventurer &&
          summary.freeDistinctIndexes === manifest.participantCounts.free &&
          summary.adventurerDistinctIndexes === manifest.participantCounts.adventurer &&
          summary.freeMinimumIndex === 0 &&
          summary.freeMaximumIndex === manifest.participantCounts.free - 1 &&
          summary.adventurerMinimumIndex === 0 &&
          summary.adventurerMaximumIndex === manifest.participantCounts.adventurer - 1 &&
          summary.distinctUsers === expectedTotal &&
          summary.distinctAgents === expectedTotal &&
          summary.distinctSessions === expectedTotal &&
          summary.joinedCurrentAuthorities === expectedTotal &&
          summary.matchingPlans === expectedTotal &&
          summary.matchingProofs === expectedTotal;
        return exactInventory && cohort.activated_at !== null
          ? ({ _tag: "Ready", verifiedAt: cohort.activated_at } as const)
          : ({ _tag: "Missing" } as const);
      }),
  );

  const inspectProvisionInventory = Effect.fn(
    "QualificationCohortAuthority.inspectProvisionInventory",
  )((manifest: QualificationCohortManifest) =>
    attempt("inspectProvisionInventory", async () => {
      const [summary] = await database
        .select({
          adventurer: sql<number>`count(*) filter (where ${qualificationParticipantProvisions.plan} = 'adventurer')::int`,
          adventurerDistinctIndexes: sql<number>`count(distinct ${qualificationParticipantProvisions.participant_index}) filter (where ${qualificationParticipantProvisions.plan} = 'adventurer')::int`,
          consumed: sql<number>`count(*) filter (where ${qualificationParticipantProvisions.state} = 'CONSUMED')::int`,
          distinctDigests: sql<number>`count(distinct ${qualificationParticipantProvisions.enrollment_digest})::int`,
          distinctUsers: sql<number>`count(distinct ${qualificationParticipantProvisions.user_id})::int`,
          free: sql<number>`count(*) filter (where ${qualificationParticipantProvisions.plan} = 'free')::int`,
          freeDistinctIndexes: sql<number>`count(distinct ${qualificationParticipantProvisions.participant_index}) filter (where ${qualificationParticipantProvisions.plan} = 'free')::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(qualificationParticipantProvisions)
        .where(
          and(
            eq(qualificationParticipantProvisions.cohort_id, manifest.cohortId),
            eq(qualificationParticipantProvisions.execution_id, manifest.executionId),
          ),
        );
      const expectedTotal = manifest.participantCounts.free + manifest.participantCounts.adventurer;
      return summary !== undefined &&
        summary.total === expectedTotal &&
        summary.consumed === expectedTotal &&
        summary.distinctDigests === expectedTotal &&
        summary.distinctUsers === expectedTotal &&
        summary.free === manifest.participantCounts.free &&
        summary.adventurer === manifest.participantCounts.adventurer &&
        summary.freeDistinctIndexes === manifest.participantCounts.free &&
        summary.adventurerDistinctIndexes === manifest.participantCounts.adventurer
        ? ({ _tag: "Ready" } as const)
        : ({ _tag: "Missing" } as const);
    }),
  );

  const inspectFinalizationInventory = Effect.fn(
    "QualificationCohortAuthority.inspectFinalizationInventory",
  )((manifest: QualificationCohortManifest) =>
    attempt("inspectFinalizationInventory", async () => {
      const [summary] = await database
        .select({
          adventurerPages: sql<number>`count(*) filter (where ${qualificationCohortFinalizationPages.plan} = 'adventurer')::int`,
          adventurerParticipants: sql<number>`coalesce(sum(${qualificationCohortFinalizationPages.participant_count}) filter (where ${qualificationCohortFinalizationPages.plan} = 'adventurer'), 0)::int`,
          distinctPositions: sql<number>`count(distinct (${qualificationCohortFinalizationPages.plan}, ${qualificationCohortFinalizationPages.page_index}))::int`,
          freePages: sql<number>`count(*) filter (where ${qualificationCohortFinalizationPages.plan} = 'free')::int`,
          freeParticipants: sql<number>`coalesce(sum(${qualificationCohortFinalizationPages.participant_count}) filter (where ${qualificationCohortFinalizationPages.plan} = 'free'), 0)::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(qualificationCohortFinalizationPages)
        .where(
          and(
            eq(qualificationCohortFinalizationPages.cohort_id, manifest.cohortId),
            eq(qualificationCohortFinalizationPages.execution_id, manifest.executionId),
          ),
        );
      const expectedFreePages = Math.ceil(manifest.participantCounts.free / 25);
      const expectedAdventurerPages = Math.ceil(manifest.participantCounts.adventurer / 25);
      const expectedPages = expectedFreePages + expectedAdventurerPages;
      return summary !== undefined &&
        summary.total === expectedPages &&
        summary.distinctPositions === expectedPages &&
        summary.freePages === expectedFreePages &&
        summary.adventurerPages === expectedAdventurerPages &&
        summary.freeParticipants === manifest.participantCounts.free &&
        summary.adventurerParticipants === manifest.participantCounts.adventurer
        ? ({ _tag: "Ready" } as const)
        : ({ _tag: "Missing" } as const);
    }),
  );

  const listActive = Effect.fn("QualificationCohortAuthority.listActive")((cohortId: string) =>
    attempt("listActive", () =>
      database
        .select({
          agentId: qualificationParticipantAllocations.agent_id,
          index: qualificationParticipantAllocations.participant_index,
          plan: qualificationParticipantAllocations.plan,
          sessionId: qualificationParticipantAllocations.session_id,
          userId: qualificationParticipantAllocations.user_id,
        })
        .from(qualificationParticipantAllocations)
        .where(
          and(
            eq(qualificationParticipantAllocations.cohort_id, cohortId),
            eq(qualificationParticipantAllocations.state, "ACTIVE"),
            isNull(qualificationParticipantAllocations.deleted_at),
          ),
        )
        .orderBy(
          asc(qualificationParticipantAllocations.plan),
          asc(qualificationParticipantAllocations.participant_index),
        ),
    ),
  );

  const listConsumedProvisionPage = Effect.fn(
    "QualificationCohortAuthority.listConsumedProvisionPage",
  )(
    (input: {
      readonly afterIndex: number;
      readonly cohortId: string;
      readonly limit: number;
      readonly plan: "adventurer" | "free";
    }) =>
      attempt("listConsumedProvisionPage", () =>
        database
          .select({
            agentId: agents.agent_id,
            consumedAt: qualificationParticipantProvisions.consumed_at,
            index: qualificationParticipantProvisions.participant_index,
            plan: qualificationParticipantProvisions.plan,
            provisionChecksum: qualificationParticipantProvisions.provision_checksum,
            provisionId: qualificationParticipantProvisions.provision_id,
            userId: qualificationParticipantProvisions.user_id,
          })
          .from(qualificationParticipantProvisions)
          .innerJoin(users, eq(users.id, qualificationParticipantProvisions.user_id))
          .innerJoin(agents, eq(agents.user_id, users.id))
          .innerJoin(billingSubscriptions, eq(billingSubscriptions.user_id, users.id))
          .where(
            and(
              eq(qualificationParticipantProvisions.cohort_id, input.cohortId),
              eq(qualificationParticipantProvisions.plan, input.plan),
              eq(qualificationParticipantProvisions.state, "CONSUMED"),
              eq(billingSubscriptions.plan, qualificationParticipantProvisions.plan),
              sql`${qualificationParticipantProvisions.participant_index} > ${input.afterIndex}`,
            ),
          )
          .orderBy(asc(qualificationParticipantProvisions.participant_index))
          .limit(input.limit),
      ),
  );

  const listInventoryPage = Effect.fn("QualificationCohortAuthority.listInventoryPage")(
    (input: {
      readonly afterIndex: number;
      readonly cohortId: string;
      readonly limit: number;
      readonly plan: "adventurer" | "free";
    }) =>
      attempt("listInventoryPage", () =>
        database
          .select({
            agentId: qualificationParticipantAllocations.agent_id,
            grantChecksum: qualificationParticipantAllocations.grant_checksum,
            grantId: qualificationParticipantAllocations.grant_id,
            index: qualificationParticipantAllocations.participant_index,
            provisionChecksum: qualificationParticipantAllocations.provision_checksum,
            provisionId: qualificationParticipantAllocations.provision_id,
            sessionId: qualificationParticipantAllocations.session_id,
            userId: qualificationParticipantAllocations.user_id,
          })
          .from(qualificationParticipantAllocations)
          .where(
            and(
              eq(qualificationParticipantAllocations.cohort_id, input.cohortId),
              eq(qualificationParticipantAllocations.plan, input.plan),
              eq(qualificationParticipantAllocations.state, "ACTIVE"),
              sql`${qualificationParticipantAllocations.participant_index} > ${input.afterIndex}`,
            ),
          )
          .orderBy(asc(qualificationParticipantAllocations.participant_index))
          .limit(input.limit),
      ),
  );

  return {
    activate,
    allocate,
    begin,
    beginOwned,
    confirmFinalizationPage,
    inspectFinalizationInventory,
    inspectInventory,
    inspectParticipant,
    inspectProvisionInventory,
    ...scrub,
    listActive,
    listConsumedProvisionPage,
    listInventoryPage,
    readActiveAuthSession,
    provision,
  } as const;
};

const attempt = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new QualificationCohortAuthorityUnavailable({
        cause,
        message: "The disposable qualification cohort authority is unavailable",
        operation,
      }),
  });
