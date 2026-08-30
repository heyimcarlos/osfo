import { describe, expect, it } from "@effect/vitest";

import { qualificationDistributedEvaluationReport } from "./distributed-evaluation-report";
import {
  qualificationPostTeardownCompletion,
  qualificationPostTeardownConflict,
  qualificationPostTeardownReceipt,
  qualificationPostTeardownReport,
  qualificationPostTeardownResponse,
} from "./post-teardown-evaluation";

const pre = qualificationDistributedEvaluationReport({
  acceptanceLevel: "BoundedBeta",
  correctness: {
    acceptedCount: 2,
    artifactId: "correctness",
    checksum: "correctness-checksum",
    failCount: 0,
    missingCount: 0,
    rootCount: 2,
    verdict: "PASS",
  },
  dimensions: {
    artifactId: "dimensions",
    checksum: "dimensions-checksum",
    dimensionCount: 153,
    failCount: 0,
    missingCount: 0,
    verdict: "PASS",
  },
  executionCorpus: {
    acceptedCount: 2,
    artifactId: "corpus",
    checksum: "corpus-checksum",
    completionCount: 1,
    pageCount: 1,
    partitionCount: 1,
    rootCount: 2,
    terminalJoinPageChecksum: "join",
    terminalLaunchPageChecksum: "launch",
  },
  executionId: "post-test",
  expectedDimensionCount: 153,
  expectedRootCount: 2,
  manifestChecksum: "manifest",
  planChecksum: "plan",
  sourceVersion: "source",
  topologyVersion: "topology",
});

const receipt = qualificationPostTeardownReceipt({
  allocationIdentityCount: 0,
  artifactAuthorityProofChecksum: "proof",
  artifactAuthorityProtocol: "protocol",
  cohortArtifactChecksum: "cohort-checksum",
  cohortArtifactId: "cohort-artifact",
  cohortId: "cohort",
  dispatchId: "dispatch",
  dispatchProtocolVersion: "dispatch-protocol",
  executionId: pre.executionId,
  expectedPageCount: 1,
  expectedParticipantCount: 2,
  finalPageChecksum: "page",
  manifestChecksum: pre.manifestChecksum,
  ownerRequestChecksum: "owner",
  planChecksum: pre.planChecksum,
  preTeardownCompletionArtifactId: "pre-completion",
  preTeardownCompletionChecksum: "pre-completion-checksum",
  preTeardownReportArtifactId: pre.artifactId,
  preTeardownReportChecksum: pre.checksum,
  preTeardownResponseArtifactId: "pre-response",
  preTeardownResponseChecksum: "pre-response-checksum",
  provisionIdentityCount: 0,
  qualificationRootAttemptCount: 0,
  rootChecksum: "root",
  rootInstanceId: "root-instance",
  sourceVersion: pre.sourceVersion,
  teardownVerdict: "PASS",
});

describe("POST teardown evaluation contracts", () => {
  it("preserves every PRE family and mutates only cohort teardown", () => {
    const report = qualificationPostTeardownReport({
      ownerRequestChecksum: "owner",
      preTeardownCompletionArtifactId: "pre-completion",
      preTeardownCompletionChecksum: "pre-completion-checksum",
      preTeardownReport: pre,
      preTeardownResponseArtifactId: "pre-response",
      preTeardownResponseChecksum: "pre-response-checksum",
      teardownReceipt: receipt,
    });
    expect(report.families.filter(({ verdict }) => verdict === "MISSING")).toHaveLength(7);
    expect(report.verdict).toBe("MISSING");
    expect(report.teardownVerdict).toBe("PASS");
    expect(report.families.filter(({ family }) => family !== "cohort_teardown")).toEqual(
      pre.families.filter(({ family }) => family !== "cohort_teardown"),
    );
    const completion = qualificationPostTeardownCompletion(report);
    expect(completion.teardownVerdict).toBe("PASS");
    const response = qualificationPostTeardownResponse(report, completion);
    expect(response.status).toBe(424);
    expect(response.body.teardownVerdict).toBe("PASS");
    expect(() =>
      qualificationPostTeardownResponse(report, {
        ...completion,
        missingFamilyCount: completion.missingFamilyCount + 1,
      }),
    ).toThrow("Qualification POST completion lineage conflicts");
  });

  it("rejects cross-lineage and noncanonical conflict targets", () => {
    expect(() =>
      qualificationPostTeardownReport({
        ownerRequestChecksum: "changed",
        preTeardownCompletionArtifactId: "pre-completion",
        preTeardownCompletionChecksum: "pre-completion-checksum",
        preTeardownReport: pre,
        preTeardownResponseArtifactId: "pre-response",
        preTeardownResponseChecksum: "pre-response-checksum",
        teardownReceipt: receipt,
      }),
    ).toThrow("Qualification teardown lineage conflicts");
    expect(() =>
      qualificationPostTeardownConflict({
        conflictingArtifactId: "report.json",
        executionId: pre.executionId,
        finalizationInputChecksum: "input",
        manifestChecksum: pre.manifestChecksum,
        ownerRequestChecksum: "owner",
        planChecksum: pre.planChecksum,
        preTeardownCompletionArtifactId: "pre-completion",
        preTeardownCompletionChecksum: "pre-completion-checksum",
        preTeardownReportArtifactId: pre.artifactId,
        preTeardownReportChecksum: pre.checksum,
        preTeardownResponseArtifactId: "pre-response",
        preTeardownResponseChecksum: "pre-response-checksum",
        stage: "receipt",
      }),
    ).toThrow("Qualification POST conflict target is not canonical");
    expect(() =>
      qualificationPostTeardownConflict({
        conflictingArtifactId: `qualification/executions/${pre.executionId}/distributed-report/post-teardown-v1/report.json`,
        executionId: pre.executionId,
        finalizationInputChecksum: "input",
        manifestChecksum: pre.manifestChecksum,
        ownerRequestChecksum: "owner",
        planChecksum: pre.planChecksum,
        preTeardownCompletionArtifactId: "pre-completion",
        preTeardownCompletionChecksum: "pre-completion-checksum",
        preTeardownReportArtifactId: pre.artifactId,
        preTeardownReportChecksum: pre.checksum,
        preTeardownResponseArtifactId: "pre-response",
        preTeardownResponseChecksum: "pre-response-checksum",
        stage: "receipt",
      }),
    ).toThrow("Qualification POST conflict target is not canonical");
  });

  it("keeps teardown FAIL distinct and above remaining MISSING families", () => {
    const failed = qualificationPostTeardownReceipt({
      cohortId: "cohort",
      dispatchId: "dispatch",
      executionId: pre.executionId,
      failureChecksum: "failure",
      failureKind: "dispatchConflict",
      manifestChecksum: pre.manifestChecksum,
      ownerRequestChecksum: "owner",
      planChecksum: pre.planChecksum,
      preTeardownCompletionArtifactId: "pre-completion",
      preTeardownCompletionChecksum: "pre-completion-checksum",
      preTeardownReportArtifactId: pre.artifactId,
      preTeardownReportChecksum: pre.checksum,
      preTeardownResponseArtifactId: "pre-response",
      preTeardownResponseChecksum: "pre-response-checksum",
      sourceVersion: pre.sourceVersion,
      teardownVerdict: "FAIL",
    });
    const report = qualificationPostTeardownReport({
      ownerRequestChecksum: "owner",
      preTeardownCompletionArtifactId: "pre-completion",
      preTeardownCompletionChecksum: "pre-completion-checksum",
      preTeardownReport: pre,
      preTeardownResponseArtifactId: "pre-response",
      preTeardownResponseChecksum: "pre-response-checksum",
      teardownReceipt: failed,
    });
    expect(report).toMatchObject({
      missingFamilyCount: 7,
      teardownVerdict: "FAIL",
      verdict: "FAIL",
    });
    expect(
      qualificationPostTeardownResponse(report, qualificationPostTeardownCompletion(report)),
    ).toMatchObject({ status: 409, body: { teardownVerdict: "FAIL", verdict: "FAIL" } });
  });
});
