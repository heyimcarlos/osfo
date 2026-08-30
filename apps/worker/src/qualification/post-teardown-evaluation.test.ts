import { describe, expect, it } from "@effect/vitest";

import {
  qualificationDistributedEvaluationReport,
  qualificationDistributedEvaluationReportCompletionArtifactId,
} from "./distributed-evaluation-report";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import {
  qualificationPostTeardownCompletion,
  qualificationPostTeardownConflict,
  qualificationPostTeardownReceipt,
  qualificationPostTeardownReport,
  qualificationPostTeardownResponse,
} from "./post-teardown-evaluation";

const makePre = (executionId: string) =>
  qualificationDistributedEvaluationReport({
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
    executionId,
    expectedDimensionCount: 153,
    expectedRootCount: 2,
    manifestChecksum: "manifest",
    planChecksum: "plan",
    sourceVersion: "source",
    topologyVersion: "topology",
  });
const pre = makePre("post-test");
const preCompletionId = qualificationDistributedEvaluationReportCompletionArtifactId(
  pre.executionId,
);
const preResponseId = `qualification/executions/${encodeURIComponent(pre.executionId)}/owner-response.json`;

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
  preTeardownCompletionChecksum: "pre-completion-checksum",
  preTeardownReportChecksum: pre.checksum,
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
      preTeardownCompletionArtifactId: preCompletionId,
      preTeardownCompletionChecksum: "pre-completion-checksum",
      preTeardownReport: pre,
      preTeardownResponseArtifactId: preResponseId,
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
        preTeardownCompletionArtifactId: preCompletionId,
        preTeardownCompletionChecksum: "pre-completion-checksum",
        preTeardownReport: pre,
        preTeardownResponseArtifactId: preResponseId,
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
        preTeardownCompletionChecksum: "pre-completion-checksum",
        preTeardownReportChecksum: pre.checksum,
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
        preTeardownCompletionChecksum: "pre-completion-checksum",
        preTeardownReportChecksum: pre.checksum,
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
      preTeardownCompletionChecksum: "pre-completion-checksum",
      preTeardownReportChecksum: pre.checksum,
      preTeardownResponseChecksum: "pre-response-checksum",
      sourceVersion: pre.sourceVersion,
      teardownVerdict: "FAIL",
    });
    const report = qualificationPostTeardownReport({
      ownerRequestChecksum: "owner",
      preTeardownCompletionArtifactId: preCompletionId,
      preTeardownCompletionChecksum: "pre-completion-checksum",
      preTeardownReport: pre,
      preTeardownResponseArtifactId: preResponseId,
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

  it("keeps worst-case compact artifacts bounded and checksums exact after stripping extras", () => {
    const longPre = makePre("x".repeat(500));
    const longReceiptInput = {
      allocationIdentityCount: 0,
      artifactAuthorityProofChecksum: "p",
      artifactAuthorityProtocol: "p",
      cohortArtifactChecksum: "c",
      cohortArtifactId: "c",
      cohortId: "c",
      dispatchId: "d",
      dispatchProtocolVersion: "d",
      executionId: longPre.executionId,
      expectedPageCount: 1,
      expectedParticipantCount: 1,
      failureChecksum: "opposite-branch-extra",
      finalPageChecksum: "f",
      manifestChecksum: longPre.manifestChecksum,
      ownerRequestChecksum: "o",
      planChecksum: longPre.planChecksum,
      preTeardownCompletionChecksum: "pc",
      preTeardownReportChecksum: longPre.checksum,
      preTeardownResponseChecksum: "pr",
      provisionIdentityCount: 0,
      qualificationRootAttemptCount: 0,
      rootChecksum: "r",
      rootInstanceId: "r",
      sourceVersion: longPre.sourceVersion,
      teardownVerdict: "PASS",
    } as const;
    const longReceipt = qualificationPostTeardownReceipt(longReceiptInput);
    expect("failureChecksum" in longReceipt).toBe(false);
    const { checksum: receiptChecksum, ...receiptContent } = longReceipt;
    expect(receiptChecksum).toBe(qualificationChecksum(receiptContent));
    expect(
      new TextEncoder().encode(canonicalQualificationJson(longReceipt)).byteLength,
    ).toBeLessThanOrEqual(4_095);
    const longReport = qualificationPostTeardownReport({
      ownerRequestChecksum: "o",
      preTeardownCompletionArtifactId: qualificationDistributedEvaluationReportCompletionArtifactId(
        longPre.executionId,
      ),
      preTeardownCompletionChecksum: "pc",
      preTeardownReport: longPre,
      preTeardownResponseArtifactId: `qualification/executions/${encodeURIComponent(longPre.executionId)}/owner-response.json`,
      preTeardownResponseChecksum: "pr",
      teardownReceipt: longReceipt,
    });
    const completion = qualificationPostTeardownCompletion(longReport);
    const response = qualificationPostTeardownResponse(longReport, completion);
    expect(
      new TextEncoder().encode(canonicalQualificationJson(completion)).byteLength,
    ).toBeLessThanOrEqual(4_095);
    expect(
      new TextEncoder().encode(canonicalQualificationJson(response)).byteLength,
    ).toBeLessThanOrEqual(4_095);
    const common = {
      conflictingArtifactId: "",
      executionId: longPre.executionId,
      finalizationInputChecksum: "i",
      manifestChecksum: longPre.manifestChecksum,
      ownerRequestChecksum: "o",
      planChecksum: longPre.planChecksum,
      preTeardownCompletionChecksum: "pc",
      preTeardownReportChecksum: longPre.checksum,
      preTeardownResponseChecksum: "pr",
    };
    const receiptConflictInput = {
      ...common,
      conflictingArtifactId: `qualification/executions/${encodeURIComponent(longPre.executionId)}/distributed-report/post-teardown-v1/cohort-teardown.json`,
      reportChecksum: "later-extra",
      stage: "receipt",
    } as const;
    const receiptConflict = qualificationPostTeardownConflict(receiptConflictInput);
    const conflicts = [
      receiptConflict,
      qualificationPostTeardownConflict({
        ...common,
        conflictingArtifactId: `qualification/executions/${encodeURIComponent(longPre.executionId)}/distributed-report/post-teardown-v1/report.json`,
        stage: "report",
        teardownReceiptChecksum: longReceipt.checksum,
      }),
      qualificationPostTeardownConflict({
        ...common,
        conflictingArtifactId: `qualification/executions/${encodeURIComponent(longPre.executionId)}/distributed-report/post-teardown-v1/completion.json`,
        reportChecksum: longReport.checksum,
        stage: "completion",
        teardownReceiptChecksum: longReceipt.checksum,
      }),
      qualificationPostTeardownConflict({
        ...common,
        completionChecksum: completion.checksum,
        conflictingArtifactId: `qualification/executions/${encodeURIComponent(longPre.executionId)}/distributed-report/post-teardown-v1/owner-response.json`,
        reportChecksum: longReport.checksum,
        stage: "response",
        teardownReceiptChecksum: longReceipt.checksum,
      }),
    ];
    expect("reportChecksum" in receiptConflict).toBe(false);
    for (const conflict of conflicts) {
      const { checksum, ...content } = conflict;
      expect(checksum).toBe(qualificationChecksum(content));
      expect(
        new TextEncoder().encode(canonicalQualificationJson(conflict)).byteLength,
      ).toBeLessThanOrEqual(4_095);
    }
  });
});
