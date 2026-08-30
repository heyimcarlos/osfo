import { describe, expect, it } from "vitest";

import {
  decodeQualificationCohortScrubPartitionWorkflowPayload,
  qualificationCohortScrubPageClaimToken,
  qualificationCohortScrubPartitionInstanceId,
  qualificationCohortScrubPartitionMaximumAuthorityCalls,
  qualificationCohortScrubPartitionMaximumDoR2CallsPerPage,
  qualificationCohortScrubPartitionMaximumParentSubrequests,
  qualificationCohortScrubPartitionMaximumStepCount,
  qualificationCohortScrubPartitionProtocol,
  qualificationCohortScrubPartitionTopology,
  qualificationCohortScrubPartitionWake,
  type QualificationCohortScrubPartitionWorkflowPayload,
} from "./cohort-scrub-partition";

const payload = (
  pageCount: number,
  partitionIndex = 0,
): QualificationCohortScrubPartitionWorkflowPayload => ({
  cohortId: "cohort",
  executionId: "execution",
  firstPagePosition: partitionIndex * 32,
  pageCount,
  partitionIndex,
  protocolVersion: qualificationCohortScrubPartitionProtocol,
  rootCoordinatorInstanceId: "qualification-cohort-scrub-root",
});

describe("qualification cohort scrub partition contract", () => {
  it("maps exact one, 31, and 32-page windows", () => {
    expect(
      qualificationCohortScrubPartitionTopology(payload(1), { adventurer: 0, free: 1 }),
    ).toMatchObject({ pageCount: 1, pages: [{ pageIndex: 0, plan: "free", position: 0 }] });
    expect(
      qualificationCohortScrubPartitionTopology(payload(31), { adventurer: 0, free: 775 }),
    ).toMatchObject({ pageCount: 31 });
    expect(
      qualificationCohortScrubPartitionTopology(payload(32), { adventurer: 0, free: 800 }),
    ).toMatchObject({ pageCount: 32 });
  });

  it("maps Free pages before Adventurer pages at the boundary", () => {
    const topology = qualificationCohortScrubPartitionTopology(payload(32), {
      adventurer: 50,
      free: 750,
    });
    expect(topology?.pages.at(29)).toEqual({ pageIndex: 29, plan: "free", position: 29 });
    expect(topology?.pages.at(30)).toEqual({
      pageIndex: 0,
      plan: "adventurer",
      position: 30,
    });
    expect(topology?.pages.at(31)).toEqual({
      pageIndex: 1,
      plan: "adventurer",
      position: 31,
    });
  });

  it("pins the Public 100,000-participant topology to 4,000 pages and 125 partitions", () => {
    const crossing = qualificationCohortScrubPartitionTopology(payload(32, 112), {
      adventurer: 10_000,
      free: 90_000,
    });
    expect(crossing?.totalPageCount).toBe(4_000);
    expect(crossing?.pages.at(15)).toEqual({ pageIndex: 3_599, plan: "free", position: 3_599 });
    expect(crossing?.pages.at(16)).toEqual({
      pageIndex: 0,
      plan: "adventurer",
      position: 3_600,
    });
    expect(
      qualificationCohortScrubPartitionTopology(payload(32, 124), {
        adventurer: 10_000,
        free: 90_000,
      }),
    ).toMatchObject({ firstPagePosition: 3_968, pageCount: 32 });
    expect(
      qualificationCohortScrubPartitionTopology(payload(1, 125), {
        adventurer: 10_000,
        free: 90_000,
      }),
    ).toBeNull();
  });

  it("rejects mismatched, overlapping, and out-of-range topology", () => {
    expect(
      qualificationCohortScrubPartitionTopology(
        { ...payload(32), firstPagePosition: 1 },
        {
          adventurer: 0,
          free: 800,
        },
      ),
    ).toBeNull();
    expect(
      qualificationCohortScrubPartitionTopology(payload(31), { adventurer: 0, free: 800 }),
    ).toBeNull();
    expect(
      qualificationCohortScrubPartitionTopology(payload(1, 1), { adventurer: 0, free: 800 }),
    ).toBeNull();
    expect(
      decodeQualificationCohortScrubPartitionWorkflowPayload({ ...payload(1), pageCount: 33 }),
    ).toBeNull();
  });

  it("derives stable attempt-scoped claim tokens and bounded host identities", () => {
    const first = qualificationCohortScrubPageClaimToken(payload(1), 0, 1);
    expect(qualificationCohortScrubPageClaimToken(payload(1), 0, 1)).toBe(first);
    expect(qualificationCohortScrubPageClaimToken(payload(1), 0, 2)).not.toBe(first);
    expect(qualificationCohortScrubPartitionInstanceId("execution", 0).length).toBeLessThanOrEqual(
      100,
    );
    expect(qualificationCohortScrubPartitionInstanceId("execution", 0)).toMatch(
      /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u,
    );
    expect(qualificationCohortScrubPartitionWake(payload(1))).toEqual(
      qualificationCohortScrubPartitionWake(payload(1)),
    );
  });

  it("pins the 32-page Workflow budget below installed defaults", () => {
    expect(qualificationCohortScrubPartitionMaximumStepCount).toBe(33);
    expect(qualificationCohortScrubPartitionMaximumAuthorityCalls).toBe(129);
    expect(qualificationCohortScrubPartitionMaximumParentSubrequests).toBe(1_067);
    expect(qualificationCohortScrubPartitionMaximumDoR2CallsPerPage).toBe(55);
    expect(qualificationCohortScrubPartitionMaximumStepCount).toBeLessThan(10_000);
    expect(qualificationCohortScrubPartitionMaximumParentSubrequests).toBeLessThan(10_000);
  });
});
