import { Schema } from "effect";

import { qualificationChecksum } from "./qualification-checksum";

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Identity = Schema.String.check(Schema.isMinLength(1));

export const qualificationDistributedEvaluationFamilyNames = [
  "manifest_plan",
  "forest_correctness",
  "numeric_stage_operation_dimensions",
  "semantic_good_root",
  "execution_run_corpus",
  "recovery_reserve_slope",
  "resource_headroom",
  "cost_economics",
  "memory_semantics",
  "external_gates_public_promotion",
  "cohort_teardown",
  "evidence_retention",
] as const;

export type QualificationDistributedEvaluationFamilyName =
  (typeof qualificationDistributedEvaluationFamilyNames)[number];

export const qualificationDistributedEvaluationUnimplementedFamilies =
  qualificationDistributedEvaluationFamilyNames.slice(3);

export const QualificationDistributedEvaluationAuthorityReference = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  kind: Schema.Literals(["correctness", "dimensions"]),
});

export const QualificationDistributedEvaluationFamily = Schema.Struct({
  checksum: Identity,
  failCount: NonNegativeInteger,
  family: Schema.Literals(qualificationDistributedEvaluationFamilyNames),
  missingCount: NonNegativeInteger,
  reason: Identity,
  references: Schema.Array(QualificationDistributedEvaluationAuthorityReference).check(
    Schema.isMaxLength(2),
  ),
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
});

export const QualificationDistributedEvaluationReport = Schema.Struct({
  acceptanceLevel: Schema.Literals(["BoundedBeta", "ScaleQualifiedPublic"]),
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  failingFamilyCount: NonNegativeInteger,
  families: Schema.Array(QualificationDistributedEvaluationFamily).check(
    Schema.isMinLength(qualificationDistributedEvaluationFamilyNames.length),
    Schema.isMaxLength(qualificationDistributedEvaluationFamilyNames.length),
  ),
  manifestChecksum: Identity,
  missingFamilyCount: NonNegativeInteger,
  phase: Schema.Literal("PRE_TEARDOWN"),
  planChecksum: Identity,
  sourceVersion: Identity,
  topologyVersion: Identity,
  verdict: Schema.Literals(["FAIL", "MISSING"]),
  version: Schema.Literal("qualification-distributed-evaluation-report-v1"),
});

export type QualificationDistributedEvaluationReport =
  typeof QualificationDistributedEvaluationReport.Type;

export const QualificationDistributedEvaluationReportCompletion = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  failingFamilyCount: NonNegativeInteger,
  manifestChecksum: Identity,
  missingFamilyCount: NonNegativeInteger,
  planChecksum: Identity,
  reportArtifactId: Identity,
  reportChecksum: Identity,
  verdict: Schema.Literals(["FAIL", "MISSING"]),
  version: Schema.Literal("qualification-distributed-evaluation-report-completion-v1"),
});

export type QualificationDistributedEvaluationReportCompletion =
  typeof QualificationDistributedEvaluationReportCompletion.Type;

interface QualificationDistributedEvaluationForestInput {
  readonly acceptedCount: number;
  readonly artifactId: string;
  readonly checksum: string;
  readonly failCount: number;
  readonly missingCount: number;
  readonly rootCount: number;
  readonly verdict: "FAIL" | "MISSING" | "PASS";
}

type QualificationDistributedEvaluationDimensionInput =
  | {
      readonly artifactId: string;
      readonly checksum: string;
      readonly dimensionCount: number;
      readonly failCount: number;
      readonly missingCount: number;
      readonly verdict: "FAIL" | "MISSING" | "PASS";
    }
  | {
      readonly reason: string;
      readonly verdict: "FAIL" | "MISSING";
    };

export interface QualificationDistributedEvaluationReportInput {
  readonly acceptanceLevel: "BoundedBeta" | "ScaleQualifiedPublic";
  readonly correctness:
    | QualificationDistributedEvaluationForestInput
    | { readonly reason: string; readonly verdict: "FAIL" | "MISSING" };
  readonly dimensions: QualificationDistributedEvaluationDimensionInput;
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
}

export type QualificationDistributedEvaluationDimensionTerminal =
  | { readonly kind: "reducerFailed" }
  | { readonly kind: "reducerMissing" }
  | {
      readonly artifactId: string;
      readonly checksum: string;
      readonly dimensionCount: number;
      readonly kind: "authenticated";
      readonly verdict: "FAIL" | "MISSING" | "PASS";
    };

/** Map every trusted dimension terminal path to the exact bounded report evidence. */
export const qualificationDistributedEvaluationDimensionTerminalEvidence = (
  terminal: QualificationDistributedEvaluationDimensionTerminal,
): QualificationDistributedEvaluationReportInput["dimensions"] => {
  if (terminal.kind === "reducerFailed") {
    return { reason: "qualificationDimensionReducerFailed", verdict: "FAIL" };
  }
  if (terminal.kind === "reducerMissing") {
    return { reason: "bounded_qualification_reducer", verdict: "MISSING" };
  }
  return {
    artifactId: terminal.artifactId,
    checksum: terminal.checksum,
    dimensionCount: terminal.dimensionCount,
    failCount: terminal.verdict === "FAIL" ? 1 : 0,
    missingCount: terminal.verdict === "MISSING" ? 1 : 0,
    verdict: terminal.verdict,
  };
};

const reportArtifactPrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/distributed-report/pre-teardown-v1`;

export const qualificationDistributedEvaluationReportArtifactId = (executionId: string) =>
  `${reportArtifactPrefix(executionId)}/report.json`;

export const qualificationDistributedEvaluationReportCompletionArtifactId = (executionId: string) =>
  `${reportArtifactPrefix(executionId)}/completion.json`;

const safeCount = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Qualification distributed report count is invalid");
  }
  return value;
};

const family = (input: {
  readonly failCount: number;
  readonly family: QualificationDistributedEvaluationFamilyName;
  readonly missingCount: number;
  readonly reason: string;
  readonly references?: ReadonlyArray<{
    readonly artifactId: string;
    readonly checksum: string;
    readonly kind: "correctness" | "dimensions";
  }>;
  readonly verdict: "FAIL" | "MISSING" | "PASS";
}): typeof QualificationDistributedEvaluationFamily.Type => {
  if (
    (input.verdict === "PASS" && (input.failCount !== 0 || input.missingCount !== 0)) ||
    (input.verdict === "MISSING" && (input.failCount !== 0 || input.missingCount === 0)) ||
    (input.verdict === "FAIL" && input.failCount === 0)
  ) {
    throw new Error("Qualification distributed report family verdict conflicts with its counts");
  }
  const content = {
    failCount: safeCount(input.failCount),
    family: input.family,
    missingCount: safeCount(input.missingCount),
    reason: input.reason,
    references: input.references ?? [],
    verdict: input.verdict,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

const missingFamily = (
  name: QualificationDistributedEvaluationFamilyName,
  reason = "authority_not_installed_pre_teardown",
) => family({ failCount: 0, family: name, missingCount: 1, reason, verdict: "MISSING" });

const correctnessFamily = (input: QualificationDistributedEvaluationReportInput["correctness"]) => {
  if (!("artifactId" in input)) {
    return family({
      failCount: input.verdict === "FAIL" ? 1 : 0,
      family: "forest_correctness",
      missingCount: input.verdict === "MISSING" ? 1 : 0,
      reason: input.reason,
      verdict: input.verdict,
    });
  }
  if (safeCount(input.acceptedCount) > safeCount(input.rootCount)) {
    throw new Error("Qualification distributed report correctness counts conflict");
  }
  return family({
    failCount: input.failCount,
    family: "forest_correctness",
    missingCount: input.missingCount,
    reason: "authenticated_correctness_forest",
    references: [{ artifactId: input.artifactId, checksum: input.checksum, kind: "correctness" }],
    verdict: input.verdict,
  });
};

const dimensionFamily = (input: QualificationDistributedEvaluationReportInput["dimensions"]) => {
  if (!("artifactId" in input)) {
    return family({
      failCount: input.verdict === "FAIL" ? 1 : 0,
      family: "numeric_stage_operation_dimensions",
      missingCount: input.verdict === "MISSING" ? 1 : 0,
      reason: input.reason,
      verdict: input.verdict,
    });
  }
  safeCount(input.dimensionCount);
  return family({
    failCount: input.failCount,
    family: "numeric_stage_operation_dimensions",
    missingCount: input.missingCount,
    reason: "authenticated_dimension_forest",
    references: [{ artifactId: input.artifactId, checksum: input.checksum, kind: "dimensions" }],
    verdict: input.verdict,
  });
};

/** Assemble the bounded report without upgrading any unimplemented production gate. */
export const qualificationDistributedEvaluationReport = (
  input: QualificationDistributedEvaluationReportInput,
): QualificationDistributedEvaluationReport => {
  const families = [
    family({
      failCount: 0,
      family: "manifest_plan",
      missingCount: 0,
      reason: "authenticated_frozen_owner_request",
      verdict: "PASS",
    }),
    correctnessFamily(input.correctness),
    dimensionFamily(input.dimensions),
    missingFamily("semantic_good_root"),
    missingFamily("execution_run_corpus"),
    missingFamily("recovery_reserve_slope"),
    missingFamily("resource_headroom"),
    missingFamily("cost_economics"),
    missingFamily("memory_semantics"),
    missingFamily("external_gates_public_promotion"),
    missingFamily("cohort_teardown", "post_run_teardown_not_evaluated"),
    missingFamily("evidence_retention", "evidence_retention_authority_not_installed"),
  ] satisfies ReadonlyArray<typeof QualificationDistributedEvaluationFamily.Type>;
  const failingFamilyCount = families.filter(({ verdict }) => verdict === "FAIL").length;
  const missingFamilyCount = families.filter(({ verdict }) => verdict === "MISSING").length;
  const artifactId = qualificationDistributedEvaluationReportArtifactId(input.executionId);
  const content = {
    acceptanceLevel: input.acceptanceLevel,
    artifactId,
    executionId: input.executionId,
    failingFamilyCount,
    families,
    manifestChecksum: input.manifestChecksum,
    missingFamilyCount,
    phase: "PRE_TEARDOWN" as const,
    planChecksum: input.planChecksum,
    sourceVersion: input.sourceVersion,
    topologyVersion: input.topologyVersion,
    verdict: failingFamilyCount > 0 ? ("FAIL" as const) : ("MISSING" as const),
    version: "qualification-distributed-evaluation-report-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

export const qualificationDistributedEvaluationReportCompletion = (
  report: QualificationDistributedEvaluationReport,
): QualificationDistributedEvaluationReportCompletion => {
  const content = {
    artifactId: qualificationDistributedEvaluationReportCompletionArtifactId(report.executionId),
    executionId: report.executionId,
    failingFamilyCount: report.failingFamilyCount,
    manifestChecksum: report.manifestChecksum,
    missingFamilyCount: report.missingFamilyCount,
    planChecksum: report.planChecksum,
    reportArtifactId: report.artifactId,
    reportChecksum: report.checksum,
    verdict: report.verdict,
    version: "qualification-distributed-evaluation-report-completion-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};
