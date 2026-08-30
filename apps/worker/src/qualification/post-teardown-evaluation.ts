import { Schema } from "effect";

import {
  QualificationDistributedEvaluationAuthorityReference,
  type QualificationDistributedEvaluationReport,
  qualificationDistributedEvaluationFamilyNames,
} from "./distributed-evaluation-report";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const qualificationPostTeardownArtifactMaximumBytes = 4_095;
export const qualificationPostTeardownReportMaximumBytes = 32_767;
export const qualificationPostTeardownPrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/distributed-report/post-teardown-v1`;
export const qualificationPostTeardownReceiptArtifactId = (executionId: string) =>
  `${qualificationPostTeardownPrefix(executionId)}/cohort-teardown.json`;
export const qualificationPostTeardownReportArtifactId = (executionId: string) =>
  `${qualificationPostTeardownPrefix(executionId)}/report.json`;
export const qualificationPostTeardownCompletionArtifactId = (executionId: string) =>
  `${qualificationPostTeardownPrefix(executionId)}/completion.json`;
export const qualificationPostTeardownResponseArtifactId = (executionId: string) =>
  `${qualificationPostTeardownPrefix(executionId)}/owner-response.json`;
export const qualificationPostTeardownConflictArtifactId = (executionId: string) =>
  `${qualificationPostTeardownPrefix(executionId)}/conflict.json`;

const ReceiptBase = {
  artifactId: Identity,
  checksum: Identity,
  cohortId: Identity,
  executionId: Identity,
  manifestChecksum: Identity,
  ownerRequestChecksum: Identity,
  planChecksum: Identity,
  preTeardownCompletionArtifactId: Identity,
  preTeardownCompletionChecksum: Identity,
  preTeardownReportArtifactId: Identity,
  preTeardownReportChecksum: Identity,
  preTeardownResponseArtifactId: Identity,
  preTeardownResponseChecksum: Identity,
  sourceVersion: Identity,
  version: Schema.Literal("qualification-post-teardown-evaluation-receipt-v1"),
} as const;

export const QualificationPostTeardownReceipt = Schema.Union([
  Schema.Struct({
    ...ReceiptBase,
    allocationIdentityCount: Schema.Literal(0),
    artifactAuthorityProofChecksum: Identity,
    artifactAuthorityProtocol: Identity,
    cohortArtifactId: Identity,
    cohortArtifactChecksum: Identity,
    dispatchId: Identity,
    dispatchProtocolVersion: Identity,
    expectedPageCount: NonNegativeInteger,
    expectedParticipantCount: NonNegativeInteger,
    finalPageChecksum: Identity,
    provisionIdentityCount: Schema.Literal(0),
    qualificationRootAttemptCount: Schema.Literal(0),
    rootChecksum: Identity,
    rootInstanceId: Identity,
    teardownVerdict: Schema.Literal("PASS"),
  }),
  Schema.Struct({
    ...ReceiptBase,
    dispatchId: Identity,
    failureKind: Schema.Literals(["dispatchConflict", "settledAuthorityConflict"]),
    failureChecksum: Identity,
    teardownVerdict: Schema.Literal("FAIL"),
  }),
]);
export type QualificationPostTeardownReceipt = typeof QualificationPostTeardownReceipt.Type;
type ReceiptInput<T> = T extends unknown ? Omit<T, "artifactId" | "checksum" | "version"> : never;

const TeardownReference = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  cohortId: Identity,
  kind: Schema.Literal("cohortTeardown"),
  rootChecksum: Schema.NullOr(Identity),
  teardownVerdict: Schema.Literals(["FAIL", "PASS"]),
});

export const QualificationPostTeardownFamily = Schema.Struct({
  checksum: Identity,
  failCount: NonNegativeInteger,
  family: Schema.Literals(qualificationDistributedEvaluationFamilyNames),
  missingCount: NonNegativeInteger,
  reason: Identity,
  references: Schema.Array(
    Schema.Union([QualificationDistributedEvaluationAuthorityReference, TeardownReference]),
  ).check(Schema.isMaxLength(2)),
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
});

export const QualificationPostTeardownReport = Schema.Struct({
  acceptanceLevel: Schema.Literals(["BoundedBeta", "ScaleQualifiedPublic"]),
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  expectedDimensionCount: NonNegativeInteger,
  expectedRootCount: NonNegativeInteger,
  failingFamilyCount: NonNegativeInteger,
  families: Schema.Array(QualificationPostTeardownFamily).check(
    Schema.isMinLength(qualificationDistributedEvaluationFamilyNames.length),
    Schema.isMaxLength(qualificationDistributedEvaluationFamilyNames.length),
  ),
  manifestChecksum: Identity,
  missingFamilyCount: NonNegativeInteger,
  ownerRequestChecksum: Identity,
  phase: Schema.Literal("POST_TEARDOWN"),
  planChecksum: Identity,
  preTeardownCompletionArtifactId: Identity,
  preTeardownCompletionChecksum: Identity,
  preTeardownReportArtifactId: Identity,
  preTeardownReportChecksum: Identity,
  preTeardownResponseArtifactId: Identity,
  preTeardownResponseChecksum: Identity,
  sourceVersion: Identity,
  teardownReceiptArtifactId: Identity,
  teardownReceiptChecksum: Identity,
  teardownVerdict: Schema.Literals(["FAIL", "PASS"]),
  topologyVersion: Identity,
  verdict: Schema.Literals(["FAIL", "MISSING"]),
  version: Schema.Literal("qualification-post-teardown-evaluation-report-v1"),
});
export type QualificationPostTeardownReport = typeof QualificationPostTeardownReport.Type;

export const QualificationPostTeardownCompletion = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  failingFamilyCount: NonNegativeInteger,
  manifestChecksum: Identity,
  ownerRequestChecksum: Identity,
  missingFamilyCount: NonNegativeInteger,
  planChecksum: Identity,
  preTeardownCompletionArtifactId: Identity,
  preTeardownCompletionChecksum: Identity,
  preTeardownReportArtifactId: Identity,
  preTeardownReportChecksum: Identity,
  preTeardownResponseArtifactId: Identity,
  preTeardownResponseChecksum: Identity,
  reportArtifactId: Identity,
  reportChecksum: Identity,
  teardownReceiptArtifactId: Identity,
  teardownReceiptChecksum: Identity,
  teardownVerdict: Schema.Literals(["FAIL", "PASS"]),
  verdict: Schema.Literals(["FAIL", "MISSING"]),
  version: Schema.Literal("qualification-post-teardown-evaluation-completion-v1"),
});

export const QualificationPostTeardownResponse = Schema.Struct({
  body: Schema.Struct({
    completionArtifactId: Identity,
    completionChecksum: Identity,
    error: Schema.Literals([
      "qualificationAuthorityConflict",
      "qualificationAuthorityMaterialMissing",
    ]),
    executionId: Identity,
    manifestChecksum: Identity,
    ownerRequestChecksum: Identity,
    phase: Schema.Literal("POST_TEARDOWN"),
    planChecksum: Identity,
    preTeardownCompletionArtifactId: Identity,
    preTeardownCompletionChecksum: Identity,
    preTeardownReportArtifactId: Identity,
    preTeardownReportChecksum: Identity,
    preTeardownResponseArtifactId: Identity,
    preTeardownResponseChecksum: Identity,
    reportArtifactId: Identity,
    reportChecksum: Identity,
    teardownReceiptArtifactId: Identity,
    teardownReceiptChecksum: Identity,
    teardownVerdict: Schema.Literals(["FAIL", "PASS"]),
    verdict: Schema.Literals(["FAIL", "MISSING"]),
    version: Schema.Literal("qualification-post-teardown-owner-response-v1"),
  }),
  status: Schema.Literals([409, 424]),
});

const ConflictBase = {
  artifactId: Identity,
  checksum: Identity,
  conflictingArtifactId: Identity,
  executionId: Identity,
  finalizationInputChecksum: Identity,
  manifestChecksum: Identity,
  ownerRequestChecksum: Identity,
  planChecksum: Identity,
  preTeardownCompletionArtifactId: Identity,
  preTeardownCompletionChecksum: Identity,
  preTeardownReportArtifactId: Identity,
  preTeardownReportChecksum: Identity,
  preTeardownResponseArtifactId: Identity,
  preTeardownResponseChecksum: Identity,
  version: Schema.Literal("qualification-post-teardown-evaluation-conflict-v1"),
} as const;
export const QualificationPostTeardownConflict = Schema.Union([
  Schema.Struct({ ...ConflictBase, stage: Schema.Literal("receipt") }),
  Schema.Struct({
    ...ConflictBase,
    stage: Schema.Literal("report"),
    teardownReceiptArtifactId: Identity,
    teardownReceiptChecksum: Identity,
  }),
  Schema.Struct({
    ...ConflictBase,
    stage: Schema.Literal("completion"),
    reportArtifactId: Identity,
    reportChecksum: Identity,
    teardownReceiptArtifactId: Identity,
    teardownReceiptChecksum: Identity,
  }),
  Schema.Struct({
    ...ConflictBase,
    stage: Schema.Literal("response"),
    completionArtifactId: Identity,
    completionChecksum: Identity,
    reportArtifactId: Identity,
    reportChecksum: Identity,
    teardownReceiptArtifactId: Identity,
    teardownReceiptChecksum: Identity,
  }),
]);
export type QualificationPostTeardownConflict = typeof QualificationPostTeardownConflict.Type;

// oxlint-disable-next-line osfo/no-object-parameters -- Constructors pass only schema-owned POST authority values.
const encodedBytes = (value: object) =>
  new TextEncoder().encode(canonicalQualificationJson(value)).byteLength;

export const qualificationPostTeardownReceipt = (
  input: ReceiptInput<QualificationPostTeardownReceipt>,
): QualificationPostTeardownReceipt => {
  const content = {
    ...input,
    artifactId: qualificationPostTeardownReceiptArtifactId(input.executionId),
    version: "qualification-post-teardown-evaluation-receipt-v1" as const,
  };
  const receipt = { ...content, checksum: qualificationChecksum(content) };
  if (encodedBytes(receipt) > qualificationPostTeardownArtifactMaximumBytes)
    throw new Error("Qualification teardown receipt exceeds compact authority budget");
  return Schema.decodeSync(QualificationPostTeardownReceipt)(receipt);
};

const copiedFamily = (family: QualificationDistributedEvaluationReport["families"][number]) => ({
  ...family,
  references: [...family.references],
});

export const qualificationPostTeardownReport = (input: {
  readonly ownerRequestChecksum: string;
  readonly preTeardownCompletionArtifactId: string;
  readonly preTeardownCompletionChecksum: string;
  readonly preTeardownReport: QualificationDistributedEvaluationReport;
  readonly preTeardownResponseArtifactId: string;
  readonly preTeardownResponseChecksum: string;
  readonly teardownReceipt: QualificationPostTeardownReceipt;
}): QualificationPostTeardownReport => {
  const pre = input.preTeardownReport;
  if (
    input.teardownReceipt.executionId !== pre.executionId ||
    input.teardownReceipt.manifestChecksum !== pre.manifestChecksum ||
    input.teardownReceipt.planChecksum !== pre.planChecksum ||
    input.teardownReceipt.sourceVersion !== pre.sourceVersion ||
    input.teardownReceipt.ownerRequestChecksum !== input.ownerRequestChecksum ||
    input.teardownReceipt.preTeardownReportArtifactId !== pre.artifactId ||
    input.teardownReceipt.preTeardownReportChecksum !== pre.checksum ||
    input.teardownReceipt.preTeardownCompletionArtifactId !==
      input.preTeardownCompletionArtifactId ||
    input.teardownReceipt.preTeardownCompletionChecksum !== input.preTeardownCompletionChecksum ||
    input.teardownReceipt.preTeardownResponseArtifactId !== input.preTeardownResponseArtifactId ||
    input.teardownReceipt.preTeardownResponseChecksum !== input.preTeardownResponseChecksum
  )
    throw new Error("Qualification teardown lineage conflicts");
  const families = pre.families.map((candidate) => {
    if (candidate.family !== "cohort_teardown") return copiedFamily(candidate);
    const content = {
      failCount: input.teardownReceipt.teardownVerdict === "FAIL" ? 1 : 0,
      family: "cohort_teardown" as const,
      missingCount: 0,
      reason:
        input.teardownReceipt.teardownVerdict === "PASS"
          ? "authenticated_cohort_teardown"
          : "cohort_teardown_authority_conflict",
      references: [
        {
          artifactId: input.teardownReceipt.artifactId,
          checksum: input.teardownReceipt.checksum,
          cohortId: input.teardownReceipt.cohortId,
          kind: "cohortTeardown" as const,
          rootChecksum:
            input.teardownReceipt.teardownVerdict === "PASS"
              ? input.teardownReceipt.rootChecksum
              : null,
          teardownVerdict: input.teardownReceipt.teardownVerdict,
        },
      ],
      verdict: input.teardownReceipt.teardownVerdict,
    };
    return { ...content, checksum: qualificationChecksum(content) };
  });
  const failingFamilyCount = families.filter(({ verdict }) => verdict === "FAIL").length;
  const missingFamilyCount = families.filter(({ verdict }) => verdict === "MISSING").length;
  const content = {
    acceptanceLevel: pre.acceptanceLevel,
    artifactId: qualificationPostTeardownReportArtifactId(pre.executionId),
    executionId: pre.executionId,
    expectedDimensionCount: pre.expectedDimensionCount,
    expectedRootCount: pre.expectedRootCount,
    failingFamilyCount,
    families,
    manifestChecksum: pre.manifestChecksum,
    missingFamilyCount,
    ownerRequestChecksum: input.ownerRequestChecksum,
    phase: "POST_TEARDOWN" as const,
    planChecksum: pre.planChecksum,
    preTeardownCompletionArtifactId: input.preTeardownCompletionArtifactId,
    preTeardownCompletionChecksum: input.preTeardownCompletionChecksum,
    preTeardownReportArtifactId: pre.artifactId,
    preTeardownReportChecksum: pre.checksum,
    preTeardownResponseArtifactId: input.preTeardownResponseArtifactId,
    preTeardownResponseChecksum: input.preTeardownResponseChecksum,
    sourceVersion: pre.sourceVersion,
    teardownReceiptArtifactId: input.teardownReceipt.artifactId,
    teardownReceiptChecksum: input.teardownReceipt.checksum,
    teardownVerdict: input.teardownReceipt.teardownVerdict,
    topologyVersion: pre.topologyVersion,
    verdict: failingFamilyCount > 0 ? ("FAIL" as const) : ("MISSING" as const),
    version: "qualification-post-teardown-evaluation-report-v1" as const,
  };
  const report = { ...content, checksum: qualificationChecksum(content) };
  if (encodedBytes(report) > qualificationPostTeardownReportMaximumBytes)
    throw new Error("Qualification POST report exceeds compact report budget");
  return Schema.decodeSync(QualificationPostTeardownReport)(report);
};

export const qualificationPostTeardownCompletion = (report: QualificationPostTeardownReport) => {
  const content = {
    artifactId: qualificationPostTeardownCompletionArtifactId(report.executionId),
    executionId: report.executionId,
    failingFamilyCount: report.failingFamilyCount,
    manifestChecksum: report.manifestChecksum,
    missingFamilyCount: report.missingFamilyCount,
    ownerRequestChecksum: report.ownerRequestChecksum,
    planChecksum: report.planChecksum,
    preTeardownCompletionArtifactId: report.preTeardownCompletionArtifactId,
    preTeardownCompletionChecksum: report.preTeardownCompletionChecksum,
    preTeardownReportArtifactId: report.preTeardownReportArtifactId,
    preTeardownReportChecksum: report.preTeardownReportChecksum,
    preTeardownResponseArtifactId: report.preTeardownResponseArtifactId,
    preTeardownResponseChecksum: report.preTeardownResponseChecksum,
    reportArtifactId: report.artifactId,
    reportChecksum: report.checksum,
    teardownReceiptArtifactId: report.teardownReceiptArtifactId,
    teardownReceiptChecksum: report.teardownReceiptChecksum,
    teardownVerdict: report.teardownVerdict,
    verdict: report.verdict,
    version: "qualification-post-teardown-evaluation-completion-v1" as const,
  };
  const completion = { ...content, checksum: qualificationChecksum(content) };
  if (encodedBytes(completion) > qualificationPostTeardownArtifactMaximumBytes)
    throw new Error("Qualification POST completion exceeds compact authority budget");
  return Schema.decodeSync(QualificationPostTeardownCompletion)(completion);
};

export const qualificationPostTeardownResponse = (
  report: QualificationPostTeardownReport,
  completion: typeof QualificationPostTeardownCompletion.Type,
) => {
  const expectedCompletion = qualificationPostTeardownCompletion(report);
  if (canonicalQualificationJson(completion) !== canonicalQualificationJson(expectedCompletion))
    throw new Error("Qualification POST completion lineage conflicts");
  const body = {
    completionArtifactId: completion.artifactId,
    completionChecksum: completion.checksum,
    error:
      report.verdict === "FAIL"
        ? ("qualificationAuthorityConflict" as const)
        : ("qualificationAuthorityMaterialMissing" as const),
    executionId: report.executionId,
    manifestChecksum: report.manifestChecksum,
    ownerRequestChecksum: report.ownerRequestChecksum,
    phase: "POST_TEARDOWN" as const,
    planChecksum: report.planChecksum,
    preTeardownCompletionArtifactId: report.preTeardownCompletionArtifactId,
    preTeardownCompletionChecksum: report.preTeardownCompletionChecksum,
    preTeardownReportArtifactId: report.preTeardownReportArtifactId,
    preTeardownReportChecksum: report.preTeardownReportChecksum,
    preTeardownResponseArtifactId: report.preTeardownResponseArtifactId,
    preTeardownResponseChecksum: report.preTeardownResponseChecksum,
    reportArtifactId: report.artifactId,
    reportChecksum: report.checksum,
    teardownReceiptArtifactId: report.teardownReceiptArtifactId,
    teardownReceiptChecksum: report.teardownReceiptChecksum,
    teardownVerdict: report.teardownVerdict,
    verdict: report.verdict,
    version: "qualification-post-teardown-owner-response-v1" as const,
  };
  const response = { body, status: report.verdict === "FAIL" ? (409 as const) : (424 as const) };
  if (encodedBytes(response) > qualificationPostTeardownArtifactMaximumBytes)
    throw new Error("Qualification POST response exceeds compact authority budget");
  return Schema.decodeSync(QualificationPostTeardownResponse)(response);
};

type ConflictInput<T> = T extends unknown ? Omit<T, "artifactId" | "checksum" | "version"> : never;
export const qualificationPostTeardownConflict = (
  input: ConflictInput<QualificationPostTeardownConflict>,
) => {
  const targetByStage = {
    completion: qualificationPostTeardownCompletionArtifactId(input.executionId),
    receipt: qualificationPostTeardownReceiptArtifactId(input.executionId),
    report: qualificationPostTeardownReportArtifactId(input.executionId),
    response: qualificationPostTeardownResponseArtifactId(input.executionId),
  } as const;
  if (input.conflictingArtifactId !== targetByStage[input.stage])
    throw new Error("Qualification POST conflict target is not canonical");
  const content = {
    ...input,
    artifactId: qualificationPostTeardownConflictArtifactId(input.executionId),
    version: "qualification-post-teardown-evaluation-conflict-v1" as const,
  };
  const conflict = {
    ...content,
    checksum: qualificationChecksum(content),
  };
  if (encodedBytes(conflict) > qualificationPostTeardownArtifactMaximumBytes)
    throw new Error("Qualification POST conflict exceeds compact authority budget");
  return Schema.decodeSync(QualificationPostTeardownConflict)(conflict);
};
