import { describe, expect, it } from "@effect/vitest";

import { initialCorpusManifest } from "../src/corpus";
import { digestValue } from "../src/manifest";
import { assessCanary } from "../src/promotion";
import { passingCurrentReleaseEvidence, passingReleasePass } from "./evidence-fixture";

const releaseEvidence = {
  currentEvidence: passingCurrentReleaseEvidence,
  releasePass: passingReleasePass(),
};
const cohortDigest = digestValue("cohort", "cohort-a-users");

describe("Model Quality canary", () => {
  it("stops promotion and signals rollback after one confirmed critical failure", () => {
    expect(
      assessCanary({
        ...releaseEvidence,
        cohortId: "cohort-a",
        cohortDigest,
        confirmedCriticalFailures: 1,
        eligibleMessages: 200,
        eligiblePercent: 5,
        eligibleUsers: 25,
        evaluationCorpus: initialCorpusManifest,
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        stage: "five-percent",
      }),
    ).toEqual({ action: "ROLLBACK", verdict: "FAIL" });
  });

  it("reports insufficient stage evidence as MISSING", () => {
    expect(
      assessCanary({
        ...releaseEvidence,
        cohortId: "cohort-a",
        cohortDigest,
        confirmedCriticalFailures: 0,
        eligibleMessages: 199,
        eligiblePercent: 5,
        eligibleUsers: 24,
        evaluationCorpus: initialCorpusManifest,
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        stage: "five-percent",
      }),
    ).toEqual({ action: "EXTEND", verdict: "MISSING" });
  });

  it("does not enter the 25% stage without a passing 5% stage for the same release", () => {
    expect(
      assessCanary({
        ...releaseEvidence,
        cohortId: "cohort-b",
        cohortDigest,
        confirmedCriticalFailures: 0,
        eligibleMessages: 500,
        eligiblePercent: 25,
        eligibleUsers: 100,
        evaluationCorpus: initialCorpusManifest,
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        stage: "twenty-five-percent",
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
  });

  it("pauses after seven days or until a new failure mode has an evaluation case", () => {
    const common = {
      ...releaseEvidence,
      cohortId: "cohort-a",
      cohortDigest,
      confirmedCriticalFailures: 0,
      eligibleMessages: 199,
      eligiblePercent: 5 as const,
      eligibleUsers: 25,
      evaluationCorpus: initialCorpusManifest,
      observedHours: 168,
      priorStage: null,
      releaseId: "release-1",
      stage: "five-percent" as const,
    };
    expect(assessCanary({ ...common, failureMode: { kind: "none" } })).toEqual({
      action: "PAUSE",
      verdict: "MISSING",
    });
    expect(
      assessCanary({
        ...common,
        eligibleMessages: 200,
        failureMode: { description: "new refusal defect", kind: "uncovered" },
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
    expect(
      assessCanary({
        ...common,
        eligibleMessages: 200,
        failureMode: { caseId: "safety-160", failureModeId: "safety-160", kind: "covered" },
      }),
    ).toEqual({ action: "ADVANCE", verdict: "PASS" });
    expect(
      assessCanary({
        ...common,
        eligibleMessages: 200,
        evaluationCorpus: initialCorpusManifest,
        failureMode: { caseId: "safety-161", failureModeId: "safety-161", kind: "covered" },
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
  });

  it("does not promote without a current verified release PASS", () => {
    expect(
      assessCanary({
        ...releaseEvidence,
        cohortId: "cohort-a",
        cohortDigest,
        confirmedCriticalFailures: 0,
        eligibleMessages: 200,
        eligiblePercent: 5,
        eligibleUsers: 25,
        evaluationCorpus: initialCorpusManifest,
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: null,
        releaseId: "release-1",
        releasePass: null,
        stage: "five-percent",
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
  });

  it("rejects a second-stage cohort that differs from its passing first stage", () => {
    expect(
      assessCanary({
        ...releaseEvidence,
        cohortId: "cohort-a",
        cohortDigest: digestValue("cohort", "changed-users"),
        confirmedCriticalFailures: 0,
        eligibleMessages: 500,
        eligiblePercent: 25,
        eligibleUsers: 100,
        evaluationCorpus: initialCorpusManifest,
        failureMode: { kind: "none" },
        observedHours: 72,
        priorStage: {
          cohortDigest,
          releaseId: "release-1",
          stage: "five-percent",
          verdict: "PASS",
        },
        releaseId: "release-1",
        stage: "twenty-five-percent",
      }),
    ).toEqual({ action: "PAUSE", verdict: "MISSING" });
  });
});
