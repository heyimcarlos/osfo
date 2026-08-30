import { describe, expect, it } from "vitest";

import {
  decodeQualificationCohortScrubRootWorkflowPayload,
  qualificationCohortScrubRootInstanceId,
  qualificationCohortScrubRootMaximumExternalCalls,
  qualificationCohortScrubRootMaximumStepCount,
  qualificationCohortScrubRootProtocol,
  qualificationCohortScrubRootTopology,
  qualificationCohortScrubRootWorkflowPayload,
} from "./cohort-scrub-root";
import { qualificationCohortScrubPartitionEventType } from "./cohort-scrub-partition";

const payload = qualificationCohortScrubRootWorkflowPayload("cohort", "execution");

describe("qualification cohort scrub root contract", () => {
  it.each([
    [1, 1, 1],
    [31, 31, 1],
    [32, 32, 1],
    [33, 33, 2],
    [3_999, 3_999, 125],
    [4_000, 4_000, 125],
  ])(
    "maps %i pages to the exact bounded partition topology",
    (pageCount, expectedPages, partitions) => {
      expect(
        qualificationCohortScrubRootTopology(payload, {
          adventurer: 0,
          free: pageCount * 25,
        }),
      ).toMatchObject({ partitionCount: partitions, totalPageCount: expectedPages });
    },
  );

  it("keeps Free pages before Adventurer pages at the Public boundary", () => {
    const topology = qualificationCohortScrubRootTopology(payload, {
      adventurer: 10_000,
      free: 90_000,
    });
    expect(topology).toMatchObject({
      adventurerPageCount: 400,
      freePageCount: 3_600,
      partitionCount: 125,
      totalPageCount: 4_000,
    });
  });

  it("rejects zero, unsafe, overflow, and malformed root authority", () => {
    expect(qualificationCohortScrubRootTopology(payload, { adventurer: 0, free: 0 })).toBeNull();
    expect(
      qualificationCohortScrubRootTopology(payload, { adventurer: 0, free: 100_001 }),
    ).toBeNull();
    expect(
      qualificationCohortScrubRootTopology(payload, {
        adventurer: 0,
        free: Number.MAX_SAFE_INTEGER,
      }),
    ).toBeNull();
    expect(
      decodeQualificationCohortScrubRootWorkflowPayload({
        ...payload,
        protocolVersion: "legacy",
      }),
    ).toBeNull();
  });

  it("derives bounded root and partition-specific event identities", () => {
    expect(qualificationCohortScrubRootInstanceId(payload.executionId)).toMatch(
      /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u,
    );
    expect(qualificationCohortScrubRootInstanceId(payload.executionId).length).toBeLessThanOrEqual(
      100,
    );
    expect(qualificationCohortScrubPartitionEventType(0)).not.toBe(
      qualificationCohortScrubPartitionEventType(1),
    );
    expect(qualificationCohortScrubPartitionEventType(124).length).toBeLessThanOrEqual(100);
  });

  it("pins the Public root budget below installed paid defaults", () => {
    expect(qualificationCohortScrubRootMaximumStepCount).toBe(377);
    expect(qualificationCohortScrubRootMaximumExternalCalls).toBe(877);
    expect(qualificationCohortScrubRootMaximumStepCount).toBeLessThan(10_000);
    expect(qualificationCohortScrubRootMaximumExternalCalls).toBeLessThan(10_000);
  });

  it("constructs only the current root protocol", () => {
    expect(payload.protocolVersion).toBe(qualificationCohortScrubRootProtocol);
  });
});
