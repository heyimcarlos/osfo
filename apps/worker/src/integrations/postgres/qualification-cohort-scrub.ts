/* oxlint-disable effecttsgo/global-date -- PostgreSQL authority timestamps are adapted at this Promise-native boundary. */
import {
  qualificationCohortScrubPages,
  qualificationCohortScrubRoots,
  qualificationCohorts,
  qualificationParticipantAllocations,
  qualificationParticipantProvisions,
} from "@osfo/db/schema/qualification-cohorts";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "@osfo/db";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import { qualificationCohortArtifactProtocol } from "../../qualification/cohort-artifact-authority-contract";
import { QualificationCohortAuthorityUnavailable } from "./qualification-cohort-error";

/* oxlint-disable effecttsgo/async-function -- Drizzle owns these transaction Promise boundaries. */

const pageSize = 25;
const provisionPageSize = 50;
const leaseMilliseconds = 5 * 60_000;
const noneChecksum = "NONE";

type Plan = "adventurer" | "free";

interface PageIdentity {
  readonly cohortId: string;
  readonly executionId: string;
  readonly pageIndex: number;
  readonly plan: Plan;
}

export interface QualificationScrubPageClaimInput extends PageIdentity {
  readonly claimToken: string;
}

export interface QualificationScrubPageCompletionInput extends QualificationScrubPageClaimInput {
  readonly artifactAuthorityProofChecksum: string;
  readonly deletedArtifactCount: number;
  readonly deletedArtifactsChecksum: string;
}

interface RootIdentity {
  readonly cohortId: string;
  readonly executionId: string;
}

export interface QualificationScrubRootClaimInput extends RootIdentity {
  readonly claimToken: string;
}

export interface QualificationScrubRootCompletionInput extends QualificationScrubRootClaimInput {
  readonly artifactAuthorityProofChecksum: string;
  readonly deletedArtifactCount: number;
  readonly deletedArtifactsChecksum: string;
}

interface PageDescriptor extends PageIdentity {
  readonly claimToken: string;
  readonly deletionReceiptsChecksum: string;
  readonly expectedArtifactCount: number;
  readonly expectedArtifactIds: ReadonlyArray<string>;
  readonly expectedArtifactsChecksum: string;
  readonly firstParticipantIndex: number;
  readonly leaseExpiresAt: Date;
  readonly participantCount: number;
  readonly previousPageChecksum: string;
}

interface RootDescriptor extends RootIdentity {
  readonly claimToken: string;
  readonly expectedArtifactCount: number;
  readonly expectedArtifactIds: ReadonlyArray<string>;
  readonly expectedArtifactsChecksum: string;
  readonly expectedPageCount: number;
  readonly expectedParticipantCount: number;
  readonly finalPageChecksum: string;
  readonly leaseExpiresAt: Date;
}

export type QualificationScrubPageClaim =
  | ({ readonly _tag: "Claimed" } & PageDescriptor)
  | ({
      readonly _tag: "Completed";
      readonly artifactAuthorityProofChecksum: string;
      readonly pageChecksum: string;
    } & Omit<PageDescriptor, "expectedArtifactIds">)
  | { readonly _tag: "Busy"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "LeaseExpired"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "Conflict" }
  | {
      readonly _tag: "Pending";
      readonly reason:
        | "artifactAuthorityUnavailable"
        | "previousPageIncomplete"
        | "productDeletionIncomplete";
    };

export type QualificationScrubPageCompletion =
  | {
      readonly _tag: "Completed";
      readonly completedAt: Date;
      readonly artifactAuthorityProofChecksum: string;
      readonly pageChecksum: string;
      readonly previousPageChecksum: string;
    }
  | { readonly _tag: "Conflict" };

export type QualificationScrubRootClaim =
  | ({ readonly _tag: "Claimed" } & RootDescriptor)
  | ({
      readonly _tag: "Completed";
      readonly artifactAuthorityProofChecksum: string;
      readonly rootChecksum: string;
    } & Omit<RootDescriptor, "expectedArtifactIds">)
  | { readonly _tag: "Busy"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "LeaseExpired"; readonly leaseExpiresAt: Date }
  | { readonly _tag: "Conflict" }
  | {
      readonly _tag: "Pending";
      readonly reason: "artifactAuthorityUnavailable" | "scrubPagesIncomplete";
    };

export type QualificationScrubRootCompletion =
  | {
      readonly _tag: "Completed";
      readonly artifactAuthorityProofChecksum: string;
      readonly completedAt: Date;
      readonly rootChecksum: string;
    }
  | { readonly _tag: "Conflict" };

export interface QualificationTeardownInspection {
  readonly productDeletion: {
    readonly deleted: number;
    readonly expected: number;
    readonly state: "COMPLETE" | "PENDING";
  };
  readonly scrub: {
    readonly completedPages: number;
    readonly expectedPages: number;
    readonly state: "COMPLETE" | "IN_PROGRESS" | "NOT_STARTED";
  };
}

/** Persistence-only scrub authority. R2 deletion remains outside this adapter. */
export const makeQualificationCohortScrubAuthority = (database: Database) => {
  const claimScrubPage = Effect.fn("QualificationCohortAuthority.claimScrubPage")(
    (input: QualificationScrubPageClaimInput) =>
      attempt("claimScrubPage", () =>
        database.transaction(async (transaction): Promise<QualificationScrubPageClaim> => {
          if (!validClaim(input.claimToken) || !validPageIndex(input.pageIndex)) return conflict;
          const [cohort] = await transaction
            .select()
            .from(qualificationCohorts)
            .where(
              and(
                eq(qualificationCohorts.cohort_id, input.cohortId),
                eq(qualificationCohorts.execution_id, input.executionId),
              ),
            )
            .limit(1)
            .for("update");
          if (cohort === undefined) return conflict;
          if (cohort.artifact_authority_protocol !== qualificationCohortArtifactProtocol) {
            return { _tag: "Pending", reason: "artifactAuthorityUnavailable" };
          }
          const counts = cohortCounts(cohort);
          const expectedPageCount = pagesFor(counts[input.plan]);
          if (input.pageIndex >= expectedPageCount) return conflict;
          const [retainedPage] = await transaction
            .select()
            .from(qualificationCohortScrubPages)
            .where(
              and(
                eq(qualificationCohortScrubPages.cohort_id, input.cohortId),
                eq(qualificationCohortScrubPages.plan, input.plan),
                eq(qualificationCohortScrubPages.page_index, input.pageIndex),
              ),
            )
            .limit(1)
            .for("update");
          if (cohort.state === "SCRUBBED") {
            return retainedPage !== undefined &&
              (await completedPageRowIsAuthentic(transaction, retainedPage, counts))
              ? completedPageClaim(retainedPage)
              : conflict;
          }
          const [allocationSummary] = await transaction
            .select({
              deleted: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.state} = 'DELETED')::int`,
              missingReceipts: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.state} = 'DELETED' and (${qualificationParticipantAllocations.deletion_case_id} is null or ${qualificationParticipantAllocations.deletion_requested_at} is null or ${qualificationParticipantAllocations.deleted_at} is null or ${qualificationParticipantAllocations.deletion_receipt_id} is null or ${qualificationParticipantAllocations.deletion_receipt_checksum} is null))::int`,
              total: sql<number>`count(*)::int`,
            })
            .from(qualificationParticipantAllocations)
            .where(
              and(
                eq(qualificationParticipantAllocations.cohort_id, input.cohortId),
                eq(qualificationParticipantAllocations.execution_id, input.executionId),
              ),
            );
          const expectedParticipantCount = counts.free + counts.adventurer;
          if (
            allocationSummary === undefined ||
            allocationSummary.total !== expectedParticipantCount ||
            allocationSummary.deleted !== expectedParticipantCount ||
            allocationSummary.missingReceipts !== 0 ||
            !productDeletionComplete(cohort.state)
          ) {
            return { _tag: "Pending", reason: "productDeletionIncomplete" };
          }
          const firstParticipantIndex = input.pageIndex * pageSize;
          const participantCount = Math.min(pageSize, counts[input.plan] - firstParticipantIndex);
          const allocations = await transaction
            .select({
              deletedAt: qualificationParticipantAllocations.deleted_at,
              deletionCaseId: qualificationParticipantAllocations.deletion_case_id,
              deletionReceiptChecksum:
                qualificationParticipantAllocations.deletion_receipt_checksum,
              deletionReceiptId: qualificationParticipantAllocations.deletion_receipt_id,
              index: qualificationParticipantAllocations.participant_index,
              plan: qualificationParticipantAllocations.plan,
              state: qualificationParticipantAllocations.state,
              userId: qualificationParticipantAllocations.user_id,
            })
            .from(qualificationParticipantAllocations)
            .where(
              and(
                eq(qualificationParticipantAllocations.cohort_id, input.cohortId),
                eq(qualificationParticipantAllocations.execution_id, input.executionId),
                eq(qualificationParticipantAllocations.plan, input.plan),
                sql`${qualificationParticipantAllocations.participant_index} >= ${firstParticipantIndex}`,
                sql`${qualificationParticipantAllocations.participant_index} < ${firstParticipantIndex + participantCount}`,
              ),
            )
            .orderBy(asc(qualificationParticipantAllocations.participant_index));
          if (
            allocations.length !== participantCount ||
            allocations.some(
              (allocation, offset) =>
                !exactDeletionReceipt(allocation, input.plan, firstParticipantIndex + offset),
            )
          ) {
            return conflict;
          }
          const previous = previousPage(input, counts);
          const previousPageChecksum =
            previous === null
              ? noneChecksum
              : await readCompletedPageChecksum(transaction, input.cohortId, previous);
          if (previousPageChecksum === null) {
            return { _tag: "Pending", reason: "previousPageIncomplete" };
          }
          const expectedArtifactIds = scrubPageArtifactIds(
            input.executionId,
            input.plan,
            firstParticipantIndex,
            participantCount,
            counts.free,
            input.pageIndex,
          );
          const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds });
          const deletionReceiptsChecksum = qualificationChecksum({
            receipts: allocations.map((allocation) => ({
              index: allocation.index,
              plan: allocation.plan,
              receiptChecksum: allocation.deletionReceiptChecksum,
            })),
          });
          const descriptor = {
            claimToken: input.claimToken,
            cohortId: input.cohortId,
            deletionReceiptsChecksum,
            executionId: input.executionId,
            expectedArtifactCount: expectedArtifactIds.length,
            expectedArtifactIds,
            expectedArtifactsChecksum,
            firstParticipantIndex,
            pageIndex: input.pageIndex,
            participantCount,
            plan: input.plan,
            previousPageChecksum,
          };
          const clock = await readDatabaseClock(transaction);
          if (clock === null) return conflict;
          const existing = retainedPage;
          if (existing !== undefined) {
            if (!pageRowMatches(existing, descriptor)) return conflict;
            if (existing.completed_at !== null && existing.page_checksum !== null) {
              return completedPageChecksumIsAuthentic(existing)
                ? completedPageClaim(existing)
                : conflict;
            }
            if (existing.claim_token === input.claimToken) {
              return existing.lease_expires_at <= clock
                ? { _tag: "LeaseExpired", leaseExpiresAt: existing.lease_expires_at }
                : claimedPage(existing, descriptor);
            }
            if (existing.lease_expires_at > clock) {
              return { _tag: "Busy", leaseExpiresAt: existing.lease_expires_at };
            }
            const leaseExpiresAt = new Date(clock.getTime() + leaseMilliseconds);
            const [reclaimed] = await transaction
              .update(qualificationCohortScrubPages)
              .set({
                claim_token: input.claimToken,
                claimed_at: clock,
                lease_expires_at: leaseExpiresAt,
              })
              .where(eq(qualificationCohortScrubPages.scrub_page_id, existing.scrub_page_id))
              .returning();
            return reclaimed === undefined ? conflict : claimedPage(reclaimed, descriptor);
          }
          const leaseExpiresAt = new Date(clock.getTime() + leaseMilliseconds);
          const [created] = await transaction
            .insert(qualificationCohortScrubPages)
            .values({
              claim_token: input.claimToken,
              claimed_at: clock,
              cohort_id: input.cohortId,
              deletion_receipts_checksum: deletionReceiptsChecksum,
              execution_id: input.executionId,
              expected_artifact_count: expectedArtifactIds.length,
              expected_artifacts_checksum: expectedArtifactsChecksum,
              first_participant_index: firstParticipantIndex,
              lease_expires_at: leaseExpiresAt,
              page_index: input.pageIndex,
              participant_count: participantCount,
              plan: input.plan,
              previous_page_checksum: previousPageChecksum,
              scrub_page_id: scrubPageId(input),
            })
            .returning();
          if (created === undefined) return conflict;
          if (cohort.state === "PRODUCT_DELETED") {
            await transaction
              .update(qualificationCohorts)
              .set({ state: "SCRUBBING" })
              .where(eq(qualificationCohorts.cohort_id, input.cohortId));
          }
          return claimedPage(created, descriptor);
        }),
      ),
  );

  const completeScrubPage = Effect.fn("QualificationCohortAuthority.completeScrubPage")(
    (input: QualificationScrubPageCompletionInput) =>
      attempt("completeScrubPage", () =>
        database.transaction(async (transaction): Promise<QualificationScrubPageCompletion> => {
          if (
            !validClaim(input.claimToken) ||
            !validChecksum(input.artifactAuthorityProofChecksum) ||
            !validPageIndex(input.pageIndex) ||
            !Number.isSafeInteger(input.deletedArtifactCount) ||
            input.deletedArtifactCount <= 0
          ) {
            return conflict;
          }
          const [page] = await transaction
            .select()
            .from(qualificationCohortScrubPages)
            .where(
              and(
                eq(qualificationCohortScrubPages.cohort_id, input.cohortId),
                eq(qualificationCohortScrubPages.execution_id, input.executionId),
                eq(qualificationCohortScrubPages.plan, input.plan),
                eq(qualificationCohortScrubPages.page_index, input.pageIndex),
              ),
            )
            .limit(1)
            .for("update");
          if (
            page === undefined ||
            page.claim_token !== input.claimToken ||
            page.expected_artifact_count !== input.deletedArtifactCount ||
            page.expected_artifacts_checksum !== input.deletedArtifactsChecksum
          ) {
            return conflict;
          }
          if (page.completed_at !== null && page.page_checksum !== null) {
            return page.artifact_authority_proof_checksum ===
              input.artifactAuthorityProofChecksum && completedPageChecksumIsAuthentic(page)
              ? pageCompletion(page)
              : conflict;
          }
          if (page.artifact_authority_proof_checksum !== null) return conflict;
          const clock = await readDatabaseClock(transaction);
          if (clock === null || page.lease_expires_at <= clock) return conflict;
          const content = {
            artifactAuthorityProofChecksum: input.artifactAuthorityProofChecksum,
            cohortId: input.cohortId,
            completedAtUtc: clock.toISOString(),
            deletedArtifactCount: input.deletedArtifactCount,
            deletedArtifactsChecksum: input.deletedArtifactsChecksum,
            deletionReceiptsChecksum: page.deletion_receipts_checksum,
            executionId: input.executionId,
            pageIndex: input.pageIndex,
            participantCount: page.participant_count,
            plan: input.plan,
            previousPageChecksum: page.previous_page_checksum,
          };
          const pageChecksum = qualificationChecksum(content);
          const [completed] = await transaction
            .update(qualificationCohortScrubPages)
            .set({
              artifact_authority_proof_checksum: input.artifactAuthorityProofChecksum,
              completed_at: clock,
              deleted_artifact_count: input.deletedArtifactCount,
              deleted_artifacts_checksum: input.deletedArtifactsChecksum,
              page_checksum: pageChecksum,
            })
            .where(eq(qualificationCohortScrubPages.scrub_page_id, page.scrub_page_id))
            .returning();
          return completed === undefined ? conflict : pageCompletion(completed);
        }),
      ),
  );

  const claimScrubRoot = Effect.fn("QualificationCohortAuthority.claimScrubRoot")(
    (input: QualificationScrubRootClaimInput) =>
      attempt("claimScrubRoot", () =>
        database.transaction(async (transaction): Promise<QualificationScrubRootClaim> => {
          if (!validClaim(input.claimToken)) return conflict;
          const [cohort] = await transaction
            .select()
            .from(qualificationCohorts)
            .where(
              and(
                eq(qualificationCohorts.cohort_id, input.cohortId),
                eq(qualificationCohorts.execution_id, input.executionId),
              ),
            )
            .limit(1)
            .for("update");
          if (cohort === undefined || !productDeletionComplete(cohort.state)) return conflict;
          if (cohort.artifact_authority_protocol !== qualificationCohortArtifactProtocol) {
            return { _tag: "Pending", reason: "artifactAuthorityUnavailable" };
          }
          const counts = cohortCounts(cohort);
          const expectedPageCount = pagesFor(counts.free) + pagesFor(counts.adventurer);
          const expectedParticipantCount = counts.free + counts.adventurer;
          const ordered = transaction.$with("ordered_scrub_pages").as(
            transaction
              .select({
                completed: qualificationCohortScrubPages.completed_at,
                pageChecksum: qualificationCohortScrubPages.page_checksum,
                participantCount: qualificationCohortScrubPages.participant_count,
                position:
                  sql<number>`case when ${qualificationCohortScrubPages.plan} = 'free' then ${qualificationCohortScrubPages.page_index} else ${pagesFor(counts.free)} + ${qualificationCohortScrubPages.page_index} end`.as(
                    "position",
                  ),
                previousPageChecksum: qualificationCohortScrubPages.previous_page_checksum,
                computedPreviousChecksum: sql<
                  string | null
                >`lag(${qualificationCohortScrubPages.page_checksum}) over (order by case when ${qualificationCohortScrubPages.plan} = 'free' then 0 else 1 end, ${qualificationCohortScrubPages.page_index})`.as(
                  "computed_previous_checksum",
                ),
              })
              .from(qualificationCohortScrubPages)
              .where(
                and(
                  eq(qualificationCohortScrubPages.cohort_id, input.cohortId),
                  eq(qualificationCohortScrubPages.execution_id, input.executionId),
                ),
              ),
          );
          const [summary] = await transaction
            .with(ordered)
            .select({
              broken: sql<number>`count(*) filter (where ${ordered.completed} is null or ${ordered.pageChecksum} is null or ${ordered.position} < 0 or (${ordered.position} = 0 and ${ordered.previousPageChecksum} <> ${noneChecksum}) or (${ordered.position} > 0 and ${ordered.previousPageChecksum} is distinct from ${ordered.computedPreviousChecksum}))::int`,
              completed: sql<number>`count(*) filter (where ${ordered.completed} is not null)::int`,
              count: sql<number>`count(*)::int`,
              distinctPositions: sql<number>`count(distinct ${ordered.position})::int`,
              finalPageChecksum: sql<
                string | null
              >`max(${ordered.pageChecksum}) filter (where ${ordered.position} = ${expectedPageCount - 1})`,
              maximumPosition: sql<number | null>`max(${ordered.position})`,
              minimumPosition: sql<number | null>`min(${ordered.position})`,
              participants: sql<number>`coalesce(sum(${ordered.participantCount}), 0)::int`,
            })
            .from(ordered);
          if (summary === undefined) return conflict;
          if (summary.count < expectedPageCount || summary.completed < expectedPageCount) {
            return { _tag: "Pending", reason: "scrubPagesIncomplete" };
          }
          if (
            summary.count !== expectedPageCount ||
            summary.completed !== expectedPageCount ||
            summary.distinctPositions !== expectedPageCount ||
            summary.minimumPosition !== 0 ||
            summary.maximumPosition !== expectedPageCount - 1 ||
            summary.participants !== expectedParticipantCount ||
            summary.broken !== 0 ||
            summary.finalPageChecksum === null
          ) {
            return conflict;
          }
          const expectedArtifactIds = rootArtifactIds(input.executionId);
          const expectedArtifactsChecksum = qualificationChecksum({ expectedArtifactIds });
          const descriptor = {
            claimToken: input.claimToken,
            cohortId: input.cohortId,
            executionId: input.executionId,
            expectedArtifactCount: expectedArtifactIds.length,
            expectedArtifactIds,
            expectedArtifactsChecksum,
            expectedPageCount,
            expectedParticipantCount,
            finalPageChecksum: summary.finalPageChecksum,
          };
          const clock = await readDatabaseClock(transaction);
          if (clock === null) return conflict;
          const [existing] = await transaction
            .select()
            .from(qualificationCohortScrubRoots)
            .where(eq(qualificationCohortScrubRoots.cohort_id, input.cohortId))
            .limit(1)
            .for("update");
          if (existing !== undefined) {
            if (!rootRowMatches(existing, descriptor)) return conflict;
            if (
              existing.completed_at !== null &&
              existing.root_checksum !== null &&
              completedRootRowIsAuthentic(existing)
            ) {
              return completedRootClaim(existing);
            }
            if (existing.completed_at !== null || existing.root_checksum !== null) return conflict;
            if (existing.claim_token === input.claimToken) {
              return existing.lease_expires_at <= clock
                ? { _tag: "LeaseExpired", leaseExpiresAt: existing.lease_expires_at }
                : claimedRoot(existing, descriptor);
            }
            if (existing.lease_expires_at > clock) {
              return { _tag: "Busy", leaseExpiresAt: existing.lease_expires_at };
            }
            const leaseExpiresAt = new Date(clock.getTime() + leaseMilliseconds);
            const [reclaimed] = await transaction
              .update(qualificationCohortScrubRoots)
              .set({
                claim_token: input.claimToken,
                claimed_at: clock,
                lease_expires_at: leaseExpiresAt,
              })
              .where(eq(qualificationCohortScrubRoots.scrub_root_id, existing.scrub_root_id))
              .returning();
            return reclaimed === undefined ? conflict : claimedRoot(reclaimed, descriptor);
          }
          const leaseExpiresAt = new Date(clock.getTime() + leaseMilliseconds);
          const [created] = await transaction
            .insert(qualificationCohortScrubRoots)
            .values({
              claim_token: input.claimToken,
              claimed_at: clock,
              cohort_id: input.cohortId,
              execution_id: input.executionId,
              expected_artifact_count: expectedArtifactIds.length,
              expected_artifacts_checksum: expectedArtifactsChecksum,
              expected_page_count: expectedPageCount,
              expected_participant_count: expectedParticipantCount,
              final_page_checksum: summary.finalPageChecksum,
              lease_expires_at: leaseExpiresAt,
              scrub_root_id: scrubRootId(input),
            })
            .returning();
          return created === undefined ? conflict : claimedRoot(created, descriptor);
        }),
      ),
  );

  const completeScrubRoot = Effect.fn("QualificationCohortAuthority.completeScrubRoot")(
    (input: QualificationScrubRootCompletionInput) =>
      attempt("completeScrubRoot", () =>
        database.transaction(async (transaction): Promise<QualificationScrubRootCompletion> => {
          if (
            !validClaim(input.claimToken) ||
            !validChecksum(input.artifactAuthorityProofChecksum) ||
            !Number.isSafeInteger(input.deletedArtifactCount) ||
            input.deletedArtifactCount <= 0
          ) {
            return conflict;
          }
          const [cohort] = await transaction
            .select({ state: qualificationCohorts.state })
            .from(qualificationCohorts)
            .where(
              and(
                eq(qualificationCohorts.cohort_id, input.cohortId),
                eq(qualificationCohorts.execution_id, input.executionId),
              ),
            )
            .limit(1)
            .for("update");
          if (cohort === undefined) return conflict;
          const [root] = await transaction
            .select()
            .from(qualificationCohortScrubRoots)
            .where(
              and(
                eq(qualificationCohortScrubRoots.cohort_id, input.cohortId),
                eq(qualificationCohortScrubRoots.execution_id, input.executionId),
              ),
            )
            .limit(1)
            .for("update");
          if (
            root === undefined ||
            root.claim_token !== input.claimToken ||
            root.expected_artifact_count !== input.deletedArtifactCount ||
            root.expected_artifacts_checksum !== input.deletedArtifactsChecksum
          ) {
            return conflict;
          }
          if (root.completed_at !== null && root.root_checksum !== null) {
            return cohort.state === "SCRUBBED" &&
              root.artifact_authority_proof_checksum === input.artifactAuthorityProofChecksum &&
              completedRootRowIsAuthentic(root)
              ? rootCompletion(root)
              : conflict;
          }
          if (root.artifact_authority_proof_checksum !== null) return conflict;
          if (cohort.state !== "SCRUBBING") return conflict;
          const clock = await readDatabaseClock(transaction);
          if (clock === null || root.lease_expires_at <= clock) return conflict;
          const content = {
            artifactAuthorityProofChecksum: input.artifactAuthorityProofChecksum,
            cohortId: input.cohortId,
            completedAtUtc: clock.toISOString(),
            deletedArtifactCount: input.deletedArtifactCount,
            deletedArtifactsChecksum: input.deletedArtifactsChecksum,
            executionId: input.executionId,
            expectedPageCount: root.expected_page_count,
            expectedParticipantCount: root.expected_participant_count,
            finalPageChecksum: root.final_page_checksum,
          };
          const rootChecksum = qualificationChecksum(content);
          const [completed] = await transaction
            .update(qualificationCohortScrubRoots)
            .set({
              artifact_authority_proof_checksum: input.artifactAuthorityProofChecksum,
              completed_at: clock,
              deleted_artifact_count: input.deletedArtifactCount,
              deleted_artifacts_checksum: input.deletedArtifactsChecksum,
              root_checksum: rootChecksum,
            })
            .where(eq(qualificationCohortScrubRoots.scrub_root_id, root.scrub_root_id))
            .returning();
          if (completed === undefined) return conflict;
          await transaction
            .delete(qualificationParticipantAllocations)
            .where(
              and(
                eq(qualificationParticipantAllocations.cohort_id, input.cohortId),
                eq(qualificationParticipantAllocations.execution_id, input.executionId),
              ),
            );
          await transaction
            .delete(qualificationParticipantProvisions)
            .where(
              and(
                eq(qualificationParticipantProvisions.cohort_id, input.cohortId),
                eq(qualificationParticipantProvisions.execution_id, input.executionId),
              ),
            );
          const [scrubbed] = await transaction
            .update(qualificationCohorts)
            .set({ state: "SCRUBBED" })
            .where(
              and(
                eq(qualificationCohorts.cohort_id, input.cohortId),
                eq(qualificationCohorts.execution_id, input.executionId),
                eq(qualificationCohorts.state, "SCRUBBING"),
              ),
            )
            .returning({ cohortId: qualificationCohorts.cohort_id });
          if (scrubbed === undefined) {
            throw new Error("The locked qualification cohort changed during scrub completion");
          }
          return rootCompletion(completed);
        }),
      ),
  );

  const inspectTeardown = Effect.fn("QualificationCohortAuthority.inspectTeardown")(
    (cohortId: string) =>
      attempt("inspectTeardown", async (): Promise<QualificationTeardownInspection | null> => {
        const [cohort] = await database
          .select()
          .from(qualificationCohorts)
          .where(eq(qualificationCohorts.cohort_id, cohortId))
          .limit(1);
        if (cohort === undefined) return null;
        const expectedParticipants =
          cohort.expected_free_participants + cohort.expected_adventurer_participants;
        const expectedPages =
          pagesFor(cohort.expected_free_participants) +
          pagesFor(cohort.expected_adventurer_participants);
        const [[allocation], [pages], [root]] = await Promise.all([
          database
            .select({
              deleted: sql<number>`count(*) filter (where ${qualificationParticipantAllocations.state} = 'DELETED')::int`,
              total: sql<number>`count(*)::int`,
            })
            .from(qualificationParticipantAllocations)
            .where(eq(qualificationParticipantAllocations.cohort_id, cohortId)),
          database
            .select({
              completed: sql<number>`count(*) filter (where ${qualificationCohortScrubPages.completed_at} is not null)::int`,
              total: sql<number>`count(*)::int`,
            })
            .from(qualificationCohortScrubPages)
            .where(eq(qualificationCohortScrubPages.cohort_id, cohortId)),
          database
            .select({ rootChecksum: qualificationCohortScrubRoots.root_checksum })
            .from(qualificationCohortScrubRoots)
            .where(eq(qualificationCohortScrubRoots.cohort_id, cohortId))
            .limit(1),
        ]);
        const scrubComplete =
          cohort.state === "SCRUBBED" &&
          root?.rootChecksum !== null &&
          root?.rootChecksum !== undefined &&
          allocation?.total === 0;
        const productDeleted = scrubComplete ? expectedParticipants : (allocation?.deleted ?? 0);
        return {
          productDeletion: {
            deleted: productDeleted,
            expected: expectedParticipants,
            state:
              productDeleted === expectedParticipants && productDeletionComplete(cohort.state)
                ? "COMPLETE"
                : "PENDING",
          },
          scrub: {
            completedPages: pages?.completed ?? 0,
            expectedPages,
            state: scrubComplete
              ? "COMPLETE"
              : cohort.state === "SCRUBBING"
                ? "IN_PROGRESS"
                : "NOT_STARTED",
          },
        };
      }),
  );

  return {
    claimScrubPage,
    claimScrubRoot,
    completeScrubPage,
    completeScrubRoot,
    inspectTeardown,
  } as const;
};

const conflict = { _tag: "Conflict" as const };

const attempt = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new QualificationCohortAuthorityUnavailable({
        cause,
        message: "The disposable qualification cohort scrub authority is unavailable",
        operation,
      }),
  });

const validClaim = (claimToken: string) => claimToken.length > 0 && claimToken.length <= 300;
const validChecksum = (checksum: string) => checksum.length > 0 && checksum.length <= 300;
const validPageIndex = (pageIndex: number) => Number.isSafeInteger(pageIndex) && pageIndex >= 0;
const pagesFor = (participants: number) => Math.ceil(participants / pageSize);
const productDeletionComplete = (state: string) =>
  state === "PRODUCT_DELETED" || state === "SCRUBBING" || state === "SCRUBBED";

const cohortCounts = (cohort: typeof qualificationCohorts.$inferSelect) => ({
  adventurer: cohort.expected_adventurer_participants,
  free: cohort.expected_free_participants,
});

const scrubPageId = (identity: PageIdentity) =>
  qualificationChecksum({
    cohortId: identity.cohortId,
    executionId: identity.executionId,
    kind: "qualificationCohortScrubPage",
    pageIndex: identity.pageIndex,
    plan: identity.plan,
  });

const scrubRootId = (identity: RootIdentity) =>
  qualificationChecksum({
    cohortId: identity.cohortId,
    executionId: identity.executionId,
    kind: "qualificationCohortScrubRoot",
  });

const previousPage = (
  input: PageIdentity,
  counts: { readonly adventurer: number; readonly free: number },
): Pick<PageIdentity, "pageIndex" | "plan"> | null => {
  if (input.pageIndex > 0) return { pageIndex: input.pageIndex - 1, plan: input.plan };
  if (input.plan === "free") return null;
  return { pageIndex: pagesFor(counts.free) - 1, plan: "free" };
};

const readCompletedPageChecksum = async (
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  cohortId: string,
  identity: Pick<PageIdentity, "pageIndex" | "plan">,
) => {
  const [previous] = await transaction
    .select({
      completedAt: qualificationCohortScrubPages.completed_at,
      pageChecksum: qualificationCohortScrubPages.page_checksum,
    })
    .from(qualificationCohortScrubPages)
    .where(
      and(
        eq(qualificationCohortScrubPages.cohort_id, cohortId),
        eq(qualificationCohortScrubPages.plan, identity.plan),
        eq(qualificationCohortScrubPages.page_index, identity.pageIndex),
      ),
    )
    .limit(1);
  return previous?.completedAt === null || previous?.completedAt === undefined
    ? null
    : previous.pageChecksum;
};

const readDatabaseClock = async (
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
) => {
  const [clock] = await transaction
    .select({ now: sql<string>`clock_timestamp()::text` })
    .from(qualificationCohorts)
    .limit(1);
  if (clock === undefined) return null;
  const epochMilliseconds = Date.parse(clock.now);
  return Number.isFinite(epochMilliseconds) ? new Date(epochMilliseconds) : null;
};

const completedPageRowIsAuthentic = async (
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  row: typeof qualificationCohortScrubPages.$inferSelect,
  counts: { readonly adventurer: number; readonly free: number },
) => {
  if (!completedPageChecksumIsAuthentic(row)) return false;
  const expectedParticipantCount = Math.min(pageSize, counts[row.plan] - row.page_index * pageSize);
  if (expectedParticipantCount <= 0) return false;
  const expectedArtifactIds = scrubPageArtifactIds(
    row.execution_id,
    row.plan,
    row.page_index * pageSize,
    expectedParticipantCount,
    counts.free,
    row.page_index,
  );
  const previous = previousPage(
    {
      cohortId: row.cohort_id,
      executionId: row.execution_id,
      pageIndex: row.page_index,
      plan: row.plan,
    },
    counts,
  );
  const previousPageChecksum =
    previous === null
      ? noneChecksum
      : await readCompletedPageChecksum(transaction, row.cohort_id, previous);
  return (
    previousPageChecksum !== null &&
    row.first_participant_index === row.page_index * pageSize &&
    row.participant_count === expectedParticipantCount &&
    row.expected_artifact_count === expectedArtifactIds.length &&
    row.expected_artifacts_checksum === qualificationChecksum({ expectedArtifactIds }) &&
    row.previous_page_checksum === previousPageChecksum
  );
};

const completedPageChecksumIsAuthentic = (row: typeof qualificationCohortScrubPages.$inferSelect) =>
  row.completed_at !== null &&
  row.artifact_authority_proof_checksum !== null &&
  row.deleted_artifact_count !== null &&
  row.deleted_artifacts_checksum !== null &&
  row.deleted_artifact_count === row.expected_artifact_count &&
  row.deleted_artifacts_checksum === row.expected_artifacts_checksum &&
  row.page_checksum ===
    qualificationChecksum({
      artifactAuthorityProofChecksum: row.artifact_authority_proof_checksum,
      cohortId: row.cohort_id,
      completedAtUtc: row.completed_at.toISOString(),
      deletedArtifactCount: row.deleted_artifact_count,
      deletedArtifactsChecksum: row.deleted_artifacts_checksum,
      deletionReceiptsChecksum: row.deletion_receipts_checksum,
      executionId: row.execution_id,
      pageIndex: row.page_index,
      participantCount: row.participant_count,
      plan: row.plan,
      previousPageChecksum: row.previous_page_checksum,
    });

const completedRootRowIsAuthentic = (row: typeof qualificationCohortScrubRoots.$inferSelect) =>
  row.completed_at !== null &&
  row.artifact_authority_proof_checksum !== null &&
  row.deleted_artifact_count !== null &&
  row.deleted_artifacts_checksum !== null &&
  row.deleted_artifact_count === row.expected_artifact_count &&
  row.deleted_artifacts_checksum === row.expected_artifacts_checksum &&
  row.root_checksum ===
    qualificationChecksum({
      artifactAuthorityProofChecksum: row.artifact_authority_proof_checksum,
      cohortId: row.cohort_id,
      completedAtUtc: row.completed_at.toISOString(),
      deletedArtifactCount: row.deleted_artifact_count,
      deletedArtifactsChecksum: row.deleted_artifacts_checksum,
      executionId: row.execution_id,
      expectedPageCount: row.expected_page_count,
      expectedParticipantCount: row.expected_participant_count,
      finalPageChecksum: row.final_page_checksum,
    });

const exactDeletionReceipt = (
  allocation: {
    readonly deletedAt: Date | null;
    readonly deletionCaseId: string | null;
    readonly deletionReceiptChecksum: string | null;
    readonly deletionReceiptId: string | null;
    readonly index: number;
    readonly plan: Plan;
    readonly state: string;
    readonly userId: string;
  },
  plan: Plan,
  index: number,
) => {
  if (
    allocation.state !== "DELETED" ||
    allocation.plan !== plan ||
    allocation.index !== index ||
    allocation.deletedAt === null ||
    allocation.deletionCaseId === null ||
    allocation.deletionReceiptId === null ||
    allocation.deletionReceiptChecksum === null
  ) {
    return false;
  }
  const expectedReceiptId = `postgres:qualification-account-deletion:${allocation.deletionCaseId}`;
  return (
    allocation.deletionReceiptId === expectedReceiptId &&
    allocation.deletionReceiptChecksum ===
      qualificationChecksum({
        deletionCaseId: allocation.deletionCaseId,
        receiptId: expectedReceiptId,
        state: "DELETED",
        userId: allocation.userId,
      })
  );
};

const scrubPageArtifactIds = (
  executionId: string,
  plan: Plan,
  firstParticipantIndex: number,
  participantCount: number,
  freeParticipants: number,
  pageIndex: number,
) => {
  const prefix = `qualification/executions/${encodeURIComponent(executionId)}/cohort`;
  const artifactIds = Array.from({ length: participantCount }, (_, offset) => {
    const index = firstParticipantIndex + offset;
    return `${prefix}/grants/${plan}/${String(index).padStart(8, "0")}.json`;
  });
  artifactIds.push(`${prefix}/finalize-pages/${plan}/${String(pageIndex).padStart(8, "0")}.json`);
  for (let offset = 0; offset < participantCount; offset += 1) {
    const index = firstParticipantIndex + offset;
    const globalPosition = plan === "free" ? index : freeParticipants + index;
    if (globalPosition % provisionPageSize === 0) {
      artifactIds.push(
        `${prefix}/provision-pages/${String(globalPosition / provisionPageSize).padStart(8, "0")}.json`,
      );
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 has no toSorted and this fresh list needs a canonical order.
  artifactIds.sort((left, right) => left.localeCompare(right));
  return artifactIds;
};

const rootArtifactIds = (executionId: string) => {
  const prefix = `qualification/executions/${encodeURIComponent(executionId)}/cohort`;
  return [`${prefix}/inventory-receipt.json`, `${prefix}/manifest.json`];
};

const pageRowMatches = (
  row: typeof qualificationCohortScrubPages.$inferSelect,
  descriptor: Omit<PageDescriptor, "leaseExpiresAt">,
) =>
  row.cohort_id === descriptor.cohortId &&
  row.execution_id === descriptor.executionId &&
  row.plan === descriptor.plan &&
  row.page_index === descriptor.pageIndex &&
  row.first_participant_index === descriptor.firstParticipantIndex &&
  row.participant_count === descriptor.participantCount &&
  row.deletion_receipts_checksum === descriptor.deletionReceiptsChecksum &&
  row.expected_artifact_count === descriptor.expectedArtifactCount &&
  row.expected_artifacts_checksum === descriptor.expectedArtifactsChecksum &&
  row.previous_page_checksum === descriptor.previousPageChecksum;

const rootRowMatches = (
  row: typeof qualificationCohortScrubRoots.$inferSelect,
  descriptor: Omit<RootDescriptor, "leaseExpiresAt">,
) =>
  row.cohort_id === descriptor.cohortId &&
  row.execution_id === descriptor.executionId &&
  row.expected_artifact_count === descriptor.expectedArtifactCount &&
  row.expected_artifacts_checksum === descriptor.expectedArtifactsChecksum &&
  row.expected_page_count === descriptor.expectedPageCount &&
  row.expected_participant_count === descriptor.expectedParticipantCount &&
  row.final_page_checksum === descriptor.finalPageChecksum;

const claimedPage = (
  row: typeof qualificationCohortScrubPages.$inferSelect,
  descriptor: Omit<PageDescriptor, "leaseExpiresAt">,
): QualificationScrubPageClaim => ({
  _tag: "Claimed",
  ...descriptor,
  claimToken: row.claim_token,
  leaseExpiresAt: row.lease_expires_at,
});

const completedPageClaim = (
  row: typeof qualificationCohortScrubPages.$inferSelect,
): QualificationScrubPageClaim => ({
  _tag: "Completed",
  artifactAuthorityProofChecksum: row.artifact_authority_proof_checksum ?? "",
  claimToken: row.claim_token,
  cohortId: row.cohort_id,
  deletionReceiptsChecksum: row.deletion_receipts_checksum,
  executionId: row.execution_id,
  expectedArtifactCount: row.expected_artifact_count,
  expectedArtifactsChecksum: row.expected_artifacts_checksum,
  firstParticipantIndex: row.first_participant_index,
  leaseExpiresAt: row.lease_expires_at,
  pageChecksum: row.page_checksum ?? "",
  pageIndex: row.page_index,
  participantCount: row.participant_count,
  plan: row.plan,
  previousPageChecksum: row.previous_page_checksum,
});

const pageCompletion = (
  row: typeof qualificationCohortScrubPages.$inferSelect,
): QualificationScrubPageCompletion =>
  row.completed_at === null || row.page_checksum === null
    ? conflict
    : {
        _tag: "Completed",
        artifactAuthorityProofChecksum: row.artifact_authority_proof_checksum ?? "",
        completedAt: row.completed_at,
        pageChecksum: row.page_checksum,
        previousPageChecksum: row.previous_page_checksum,
      };

const claimedRoot = (
  row: typeof qualificationCohortScrubRoots.$inferSelect,
  descriptor: Omit<RootDescriptor, "leaseExpiresAt">,
): QualificationScrubRootClaim => ({
  _tag: "Claimed",
  ...descriptor,
  claimToken: row.claim_token,
  leaseExpiresAt: row.lease_expires_at,
});

const completedRootClaim = (
  row: typeof qualificationCohortScrubRoots.$inferSelect,
): QualificationScrubRootClaim => ({
  _tag: "Completed",
  artifactAuthorityProofChecksum: row.artifact_authority_proof_checksum ?? "",
  claimToken: row.claim_token,
  cohortId: row.cohort_id,
  executionId: row.execution_id,
  expectedArtifactCount: row.expected_artifact_count,
  expectedArtifactsChecksum: row.expected_artifacts_checksum,
  expectedPageCount: row.expected_page_count,
  expectedParticipantCount: row.expected_participant_count,
  finalPageChecksum: row.final_page_checksum,
  leaseExpiresAt: row.lease_expires_at,
  rootChecksum: row.root_checksum ?? "",
});

const rootCompletion = (
  row: typeof qualificationCohortScrubRoots.$inferSelect,
): QualificationScrubRootCompletion =>
  row.completed_at === null || row.root_checksum === null
    ? conflict
    : {
        _tag: "Completed",
        artifactAuthorityProofChecksum: row.artifact_authority_proof_checksum ?? "",
        completedAt: row.completed_at,
        rootChecksum: row.root_checksum,
      };
