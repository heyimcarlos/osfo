import { expect, it } from "vitest";

import { qualificationCohortArtifactPostDeleteSurvivors } from "./cohort-artifact-authority-contract";

it("distinguishes an ambiguous delete survivor from a resolved delete survivor", () => {
  expect(
    qualificationCohortArtifactPostDeleteSurvivors(true, "operation", ["artifact-b"]),
  ).toMatchObject({
    _tag: "Retryable",
    operationId: "operation",
    survivingArtifactCount: 1,
  });
  expect(
    qualificationCohortArtifactPostDeleteSurvivors(false, "operation", ["artifact-b"]),
  ).toEqual({ _tag: "Conflict", code: "resolvedDeleteRetainedSurvivor" });
  expect(qualificationCohortArtifactPostDeleteSurvivors(true, "operation", [])).toBeNull();
});
