/* oxlint-disable eslint/no-underscore-dangle -- Tests assert the canonical Effect/domain outcome discriminator. */
import { describe, expect, it } from "vitest";

import {
  qualificationCohortScrubDispatchBatchLimit,
  qualificationCohortScrubDispatchIdentity,
  qualificationCohortScrubDispatchLeaseMilliseconds,
  qualificationCohortScrubDispatchRestartLimit,
  qualificationCohortScrubWorkflowObservation,
} from "./cohort-scrub-dispatch";

const dispatch = qualificationCohortScrubDispatchIdentity("cohort", "execution");
const output = {
  cohortId: "cohort",
  executionId: "execution",
  finalPageChecksum: "page",
  rootChecksum: "root",
  state: "SCRUBBED",
  totalPageCount: 4_000,
  totalPartitionCount: 125,
};

describe("qualification cohort scrub dispatch", () => {
  it("pins bounded lease, batch, and restart policy", () => {
    expect(qualificationCohortScrubDispatchBatchLimit).toBe(25);
    expect(qualificationCohortScrubDispatchLeaseMilliseconds).toBe(300_000);
    expect(qualificationCohortScrubDispatchRestartLimit).toBe(3);
  });

  it("classifies active, deliberate pause, and unknown status without restarting", () => {
    expect(qualificationCohortScrubWorkflowObservation(dispatch, { status: "queued" })).toEqual({
      _tag: "Active",
      status: "queued",
    });
    expect(qualificationCohortScrubWorkflowObservation(dispatch, { status: "paused" })).toEqual({
      _tag: "Paused",
      status: "paused",
    });
    expect(qualificationCohortScrubWorkflowObservation(dispatch, { status: "unknown" })).toEqual({
      _tag: "Transient",
      status: "unknown",
    });
  });

  it("accepts only an exact decoded SCRUBBED output", () => {
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, { output, status: "complete" }),
    ).toEqual({ _tag: "Complete", rootChecksum: "root" });
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, {
        output: { ...output, cohortId: "substituted" },
        status: "complete",
      })._tag,
    ).toBe("Conflict");
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, { output: {}, status: "complete" })
        ._tag,
    ).toBe("Conflict");
  });

  it("restarts bounded host failures but retains the exact structural error name", () => {
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, { status: "terminated" })._tag,
    ).toBe("Restartable");
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, {
        error: { message: "step exhausted", name: "WorkflowTimeoutError" },
        status: "errored",
      })._tag,
    ).toBe("Restartable");
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, {
        error: { message: "bad authority", name: "QualificationCohortScrubRootConflict" },
        status: "errored",
      })._tag,
    ).toBe("Conflict");
    expect(
      qualificationCohortScrubWorkflowObservation(dispatch, {
        error: { message: "postgres unavailable", name: "PostgresError" },
        status: "errored",
      })._tag,
    ).toBe("Restartable");
    expect(qualificationCohortScrubWorkflowObservation(dispatch, { status: "errored" })._tag).toBe(
      "Conflict",
    );
  });
});
