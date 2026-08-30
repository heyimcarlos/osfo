/* oxlint-disable effecttsgo/async-function -- R2 is a Promise-native Worker boundary. */
import { Data, Schema } from "effect";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { QualificationEvaluationCorrectnessReceipt } from "../qualification/qualification-evaluation-reducer";
import {
  QualificationDistributedEvaluationReport,
  QualificationDistributedEvaluationReportCompletion,
  qualificationDistributedEvaluationFamilyNames,
  qualificationDistributedEvaluationReportHasLegacyMissingCorpus,
  qualificationDistributedEvaluationUnimplementedFamilies,
  qualificationDistributedEvaluationReportCompletion,
  qualificationDistributedEvaluationReportArtifactId,
  qualificationDistributedEvaluationReportCompletionArtifactId,
  qualificationDistributedEvaluationReport,
  type QualificationDistributedEvaluationReportInput,
} from "../qualification/distributed-evaluation-report";
import { qualificationExecutionRunCorpusReceiptArtifactId } from "../qualification/execution-run-corpus";
import type { QualificationOwnerWorkflowPayload } from "../workflow-contracts";
import {
  QualificationDimensionCoordinatorCompletion,
  qualificationDimensionCoordinatorCompletionArtifactId,
  qualificationDimensionPageSize,
} from "./qualification-owner-dimensions";
import { qualificationCorrectnessRootReceiptArtifactId } from "../qualification/owner-partitions";
import {
  QualificationExecutionRunCorpusRetentionConflict,
  retainQualificationExecutionRunCorpusReceipt,
} from "./qualification-execution-run-corpus";

interface QualificationOwnerReportReadBucket {
  readonly get: (key: string) => Promise<{
    readonly customMetadata?: Readonly<Record<string, string>>;
    readonly httpMetadata?: { readonly contentType?: string };
    readonly text: () => Promise<string>;
  } | null>;
}

interface QualificationOwnerResponseBucket extends QualificationOwnerReportReadBucket {
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>;
      readonly httpMetadata: { readonly contentType: string };
      readonly onlyIf: { readonly etagDoesNotMatch: string };
    },
  ) => Promise<{ readonly etag: string } | null>;
}

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const exactMetadata = (
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
) =>
  actual !== undefined &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);

export const qualificationDistributedEvaluationConflictArtifactId = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/distributed-report/pre-teardown-v1/conflict.json`;

const QualificationDistributedEvaluationConflict = Schema.Struct({
  artifactId: Schema.String,
  checksum: Schema.String,
  conflictingArtifactId: Schema.String,
  executionId: Schema.String,
  manifestChecksum: Schema.String,
  planChecksum: Schema.String,
  version: Schema.Literal("qualification-distributed-evaluation-conflict-v1"),
});

class DistributedEvaluationRetentionConflict extends Data.TaggedError(
  "DistributedEvaluationRetentionConflict",
)<{ readonly artifactId: string; readonly message: string }> {}

const familyStructureExact = (
  family: QualificationDistributedEvaluationReport["families"][number],
): boolean => {
  const countsExact =
    (family.verdict === "PASS" && family.failCount === 0 && family.missingCount === 0) ||
    (family.verdict === "MISSING" && family.failCount === 0 && family.missingCount > 0) ||
    (family.verdict === "FAIL" && family.failCount > 0);
  if (!countsExact) return false;
  if (family.family === "forest_correctness") {
    return (
      (family.verdict !== "PASS" || family.references.length === 1) &&
      family.references.length <= 1 &&
      family.references.every(({ kind }) => kind === "correctness")
    );
  }
  if (family.family === "numeric_stage_operation_dimensions") {
    return (
      (family.verdict !== "PASS" || family.references.length === 1) &&
      family.references.length <= 1 &&
      family.references.every(({ kind }) => kind === "dimensions")
    );
  }
  if (family.family === "execution_run_corpus") {
    return (
      (family.verdict === "PASS" &&
        family.reason === "authenticated_execution_run_corpus" &&
        family.failCount === 0 &&
        family.missingCount === 0 &&
        family.references.length === 1 &&
        family.references[0]?.kind === "executionCorpus") ||
      (family.verdict === "MISSING" &&
        family.reason === "authority_not_installed_pre_teardown" &&
        family.failCount === 0 &&
        family.missingCount === 1 &&
        family.references.length === 0)
    );
  }
  return family.references.length === 0;
};

const reportMetadata = (report: QualificationDistributedEvaluationReport, bodySha256: string) => ({
  "osfo-artifact-checksum": report.checksum,
  "osfo-body-sha256": bodySha256,
  "osfo-execution-id": report.executionId,
  "osfo-expected-dimension-count": String(report.expectedDimensionCount),
  "osfo-expected-root-count": String(report.expectedRootCount),
  "osfo-kind": "qualification-distributed-evaluation-report-v1",
  "osfo-manifest-checksum": report.manifestChecksum,
  "osfo-plan-checksum": report.planChecksum,
  "osfo-verdict": report.verdict,
});

const completionMetadata = (
  completion: QualificationDistributedEvaluationReportCompletion,
  bodySha256: string,
) => ({
  "osfo-artifact-checksum": completion.checksum,
  "osfo-body-sha256": bodySha256,
  "osfo-execution-id": completion.executionId,
  "osfo-kind": "qualification-distributed-evaluation-report-completion-v1",
  "osfo-manifest-checksum": completion.manifestChecksum,
  "osfo-plan-checksum": completion.planChecksum,
  "osfo-report-checksum": completion.reportChecksum,
  "osfo-verdict": completion.verdict,
});

const retainImmutable = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationOwnerResponseBucket;
  readonly encoded: string;
  readonly metadata: Readonly<Record<string, string>>;
}): Promise<void> => {
  const retained = await input.bucket.put(input.artifactId, input.encoded, {
    customMetadata: input.metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return;
  const existing = await input.bucket.get(input.artifactId);
  if (
    existing === null ||
    (await existing.text()) !== input.encoded ||
    existing.httpMetadata?.contentType !== "application/json" ||
    !exactMetadata(existing.customMetadata, input.metadata)
  ) {
    throw new DistributedEvaluationRetentionConflict({
      artifactId: input.artifactId,
      message: "Retained qualification distributed report artifact conflicts",
    });
  }
};

export const retainQualificationDistributedEvaluationConflict = async (
  bucket: QualificationOwnerResponseBucket,
  payload: QualificationOwnerWorkflowPayload,
  conflictingArtifactId: string,
) => {
  const artifactId = qualificationDistributedEvaluationConflictArtifactId(payload.executionId);
  const content = {
    artifactId,
    conflictingArtifactId,
    executionId: payload.executionId,
    manifestChecksum: payload.manifestChecksum,
    planChecksum: payload.planChecksum,
    version: "qualification-distributed-evaluation-conflict-v1" as const,
  };
  const marker = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(marker);
  await retainImmutable({
    artifactId,
    bucket,
    encoded,
    metadata: {
      "osfo-artifact-checksum": marker.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-conflicting-artifact-id": conflictingArtifactId,
      "osfo-execution-id": payload.executionId,
      "osfo-kind": "qualification-distributed-evaluation-conflict-v1",
      "osfo-manifest-checksum": payload.manifestChecksum,
      "osfo-plan-checksum": payload.planChecksum,
    },
  });
};

export const retainQualificationExecutionRunCorpusOrConflict = async (
  bucket: QualificationOwnerResponseBucket,
  payload: QualificationOwnerWorkflowPayload,
  input: Omit<Parameters<typeof retainQualificationExecutionRunCorpusReceipt>[0], "bucket">,
) => {
  try {
    return await retainQualificationExecutionRunCorpusReceipt({ ...input, bucket });
  } catch (cause) {
    if (!(cause instanceof QualificationExecutionRunCorpusRetentionConflict)) throw cause;
    await retainQualificationDistributedEvaluationConflict(bucket, payload, cause.artifactId);
    throw cause;
  }
};

export const authenticateQualificationDistributedEvaluationConflict = async (input: {
  readonly bucket: QualificationOwnerReportReadBucket;
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
}): Promise<"ABSENT" | "CONFLICT"> => {
  const artifactId = qualificationDistributedEvaluationConflictArtifactId(input.executionId);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return "ABSENT";
  const encoded = await retained.text();
  try {
    const marker = Schema.decodeSync(
      Schema.fromJsonString(QualificationDistributedEvaluationConflict),
    )(encoded);
    const { checksum, ...content } = marker;
    const canonicalConflicts = new Set([
      qualificationDistributedEvaluationReportArtifactId(input.executionId),
      qualificationDistributedEvaluationReportCompletionArtifactId(input.executionId),
      qualificationExecutionRunCorpusReceiptArtifactId(input.executionId),
      responseArtifactId(input.executionId),
    ]);
    if (
      marker.artifactId !== artifactId ||
      marker.checksum !== qualificationChecksum(content) ||
      marker.executionId !== input.executionId ||
      marker.manifestChecksum !== input.manifestChecksum ||
      marker.planChecksum !== input.planChecksum ||
      !canonicalConflicts.has(marker.conflictingArtifactId) ||
      retained.httpMetadata?.contentType !== "application/json" ||
      !exactMetadata(retained.customMetadata, {
        "osfo-artifact-checksum": checksum,
        "osfo-body-sha256": await sha256Hex(encoded),
        "osfo-conflicting-artifact-id": marker.conflictingArtifactId,
        "osfo-execution-id": marker.executionId,
        "osfo-kind": "qualification-distributed-evaluation-conflict-v1",
        "osfo-manifest-checksum": marker.manifestChecksum,
        "osfo-plan-checksum": marker.planChecksum,
      })
    )
      return "CONFLICT";
    return "CONFLICT";
  } catch {
    return "CONFLICT";
  }
};

/** Retain the compact report before its envelope so every crash edge replays create-identically. */
export const retainQualificationDistributedEvaluationReport = async (
  bucket: QualificationOwnerResponseBucket,
  report: QualificationDistributedEvaluationReport,
): Promise<QualificationDistributedEvaluationReportCompletion> => {
  const encodedReport = canonicalQualificationJson(report);
  await retainImmutable({
    artifactId: report.artifactId,
    bucket,
    encoded: encodedReport,
    metadata: reportMetadata(report, await sha256Hex(encodedReport)),
  });
  const completion = qualificationDistributedEvaluationReportCompletion(report);
  const encodedCompletion = canonicalQualificationJson(completion);
  await retainImmutable({
    artifactId: completion.artifactId,
    bucket,
    encoded: encodedCompletion,
    metadata: completionMetadata(completion, await sha256Hex(encodedCompletion)),
  });
  return completion;
};

export type QualificationDistributedEvaluationReportMaterial =
  | { readonly report: QualificationDistributedEvaluationReport; readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" };

/** Exact report readback. Absence is material MISSING; retained disagreement is FAIL. */
export const authenticateQualificationDistributedEvaluationReport = async (input: {
  readonly acceptanceLevel: "BoundedBeta" | "ScaleQualifiedPublic";
  readonly artifactId: string;
  readonly bucket: QualificationOwnerReportReadBucket;
  readonly checksum: string;
  readonly executionId: string;
  readonly expectedDimensionCount: number;
  readonly expectedRootCount: number;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
}): Promise<QualificationDistributedEvaluationReportMaterial> => {
  if (input.artifactId !== qualificationDistributedEvaluationReportArtifactId(input.executionId)) {
    return { status: "FAIL" };
  }
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  let report: QualificationDistributedEvaluationReport;
  try {
    report = Schema.decodeSync(Schema.fromJsonString(QualificationDistributedEvaluationReport))(
      encoded,
    );
  } catch {
    return { status: "FAIL" };
  }
  const { checksum, ...content } = report;
  const correctnessReference = report.families[1]?.references[0];
  const dimensionReference = report.families[2]?.references[0];
  const corpusReference = report.families[4]?.references[0];
  const legacyMissingCorpus =
    qualificationDistributedEvaluationReportHasLegacyMissingCorpus(report);
  const familiesExact =
    report.failingFamilyCount ===
      report.families.filter(({ verdict }) => verdict === "FAIL").length &&
    report.missingFamilyCount ===
      report.families.filter(({ verdict }) => verdict === "MISSING").length &&
    report.missingFamilyCount > 0 &&
    report.families.every(
      ({ family: name }, index) => name === qualificationDistributedEvaluationFamilyNames[index],
    ) &&
    qualificationDistributedEvaluationUnimplementedFamilies.every(
      (name) =>
        report.families.find(({ family: candidate }) => candidate === name)?.verdict === "MISSING",
    ) &&
    report.families.every((candidate) => {
      const { checksum: familyChecksum, ...familyContent } = candidate;
      return (
        familyChecksum === qualificationChecksum(familyContent) && familyStructureExact(candidate)
      );
    }) &&
    (legacyMissingCorpus ||
      (corpusReference?.kind === "executionCorpus" &&
        report.families[4]?.verdict === "PASS" &&
        corpusReference.rootCount === report.expectedRootCount &&
        corpusReference.acceptedCount <= corpusReference.rootCount)) &&
    (correctnessReference === undefined ||
      (correctnessReference.kind === "correctness" &&
        correctnessReference.rootCount === report.expectedRootCount &&
        correctnessReference.acceptedCount <= correctnessReference.rootCount &&
        (report.families[1]?.verdict !== "PASS" ||
          correctnessReference.acceptedCount === correctnessReference.rootCount))) &&
    (correctnessReference === undefined ||
      legacyMissingCorpus ||
      (corpusReference?.kind === "executionCorpus" &&
        corpusReference.acceptedCount === correctnessReference.acceptedCount &&
        corpusReference.rootCount === correctnessReference.rootCount)) &&
    (dimensionReference === undefined ||
      (dimensionReference.kind === "dimensions" &&
        dimensionReference.dimensionCount === report.expectedDimensionCount)) &&
    report.families[0]?.verdict === "PASS";
  return report.artifactId === input.artifactId &&
    report.artifactId === qualificationDistributedEvaluationReportArtifactId(input.executionId) &&
    report.checksum === input.checksum &&
    checksum === qualificationChecksum(content) &&
    report.executionId === input.executionId &&
    report.expectedDimensionCount === input.expectedDimensionCount &&
    report.expectedRootCount === input.expectedRootCount &&
    report.manifestChecksum === input.manifestChecksum &&
    report.planChecksum === input.planChecksum &&
    report.acceptanceLevel === input.acceptanceLevel &&
    report.sourceVersion === input.sourceVersion &&
    report.topologyVersion === input.topologyVersion &&
    report.verdict === (report.failingFamilyCount > 0 ? "FAIL" : "MISSING") &&
    familiesExact &&
    retained.httpMetadata?.contentType === "application/json" &&
    exactMetadata(retained.customMetadata, reportMetadata(report, await sha256Hex(encoded)))
    ? { report, status: "COMPLETE" }
    : { status: "FAIL" };
};

export type QualificationDistributedEvaluationReportCompletionMaterial =
  | {
      readonly completion: QualificationDistributedEvaluationReportCompletion;
      readonly status: "COMPLETE";
    }
  | { readonly status: "FAIL" | "MISSING" };

export type QualificationDistributedEvaluationReferenceMaterial =
  | { readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" };

/** Authenticate only the compact terminal correctness receipt, never its retained shard tree. */
export const authenticateQualificationDistributedCorrectnessReference = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationOwnerReportReadBucket;
  readonly checksum: string;
  readonly executionId: string;
  readonly expectedAcceptedCount: number;
  readonly expectedRootCount: number;
  readonly partitionCount: number;
  readonly planChecksum: string;
  readonly verdict: "FAIL" | "MISSING" | "PASS";
}): Promise<QualificationDistributedEvaluationReferenceMaterial> => {
  if (
    input.artifactId !==
    qualificationCorrectnessRootReceiptArtifactId(input.executionId, input.partitionCount)
  ) {
    return { status: "FAIL" };
  }
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  let receipt: typeof QualificationEvaluationCorrectnessReceipt.Type;
  try {
    receipt = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationCorrectnessReceipt))(
      encoded,
    );
  } catch {
    return { status: "FAIL" };
  }
  const { checksum, ...content } = receipt;
  return receipt.artifactId === input.artifactId &&
    receipt.checksum === input.checksum &&
    checksum === qualificationChecksum(content) &&
    receipt.executionId === input.executionId &&
    receipt.rootAccumulator.acceptedCount === input.expectedAcceptedCount &&
    receipt.rootAccumulator.rootCount === input.expectedRootCount &&
    (input.verdict !== "PASS" || input.expectedAcceptedCount === input.expectedRootCount) &&
    receipt.planChecksum === input.planChecksum &&
    receipt.verdict === input.verdict &&
    retained.httpMetadata?.contentType === "application/json" &&
    exactMetadata(retained.customMetadata, {
      "osfo-artifact-checksum": receipt.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-execution-id": receipt.executionId,
      "osfo-first-partition-index": String(receipt.firstPartitionIndex),
      "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
      "osfo-kind": "qualification-evaluation-correctness-receipt-v1",
      "osfo-last-partition-index": String(receipt.lastPartitionIndex),
      "osfo-plan-checksum": receipt.planChecksum,
      "osfo-record-count": String(receipt.rootAccumulator.rootCount),
      "osfo-root-receipt-checksum": receipt.rootAccumulator.checksum,
      "osfo-summary-checksum": receipt.findingSummaryArtifactChecksum,
      "osfo-verdict": receipt.verdict,
    })
    ? { status: "COMPLETE" }
    : { status: "FAIL" };
};

/** Authenticate only the compact dimension completion, never its root or evaluation pages. */
export const authenticateQualificationDistributedDimensionReference = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationOwnerReportReadBucket;
  readonly checksum: string;
  readonly executionId: string;
  readonly expectedDimensionCount: number;
  readonly planChecksum: string;
  readonly verdict: "FAIL" | "MISSING" | "PASS";
}): Promise<QualificationDistributedEvaluationReferenceMaterial> => {
  if (
    input.artifactId !== qualificationDimensionCoordinatorCompletionArtifactId(input.executionId)
  ) {
    return { status: "FAIL" };
  }
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  let completion: typeof QualificationDimensionCoordinatorCompletion.Type;
  try {
    completion = Schema.decodeSync(
      Schema.fromJsonString(QualificationDimensionCoordinatorCompletion),
    )(encoded);
  } catch {
    return { status: "FAIL" };
  }
  const { checksum, ...content } = completion;
  return completion.artifactId === input.artifactId &&
    completion.checksum === input.checksum &&
    checksum === qualificationChecksum(content) &&
    completion.executionId === input.executionId &&
    completion.dimensionCount === input.expectedDimensionCount &&
    completion.planChecksum === input.planChecksum &&
    completion.verdict === input.verdict &&
    completion.dimensionCount ===
      completion.identityDimensionCount + completion.numericDimensionCount &&
    completion.rootPageCount ===
      Math.ceil(completion.dimensionCount / qualificationDimensionPageSize) &&
    completion.evaluationPageCount ===
      Math.ceil(completion.numericDimensionCount / qualificationDimensionPageSize) &&
    retained.httpMetadata?.contentType === "application/json" &&
    exactMetadata(retained.customMetadata, {
      "osfo-artifact-checksum": completion.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-dimension-count": String(completion.dimensionCount),
      "osfo-execution-id": completion.executionId,
      "osfo-kind": "qualification-dimension-coordinator-completion-v1",
      "osfo-plan-checksum": completion.planChecksum,
      "osfo-record-count": String(completion.evaluationPageCount),
      "osfo-verdict": completion.verdict,
    })
    ? { status: "COMPLETE" }
    : { status: "FAIL" };
};

export const authenticateQualificationDistributedEvaluationReportCompletion = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationOwnerReportReadBucket;
  readonly checksum: string;
  readonly executionId: string;
  readonly failingFamilyCount: number;
  readonly manifestChecksum: string;
  readonly missingFamilyCount: number;
  readonly planChecksum: string;
  readonly reportArtifactId: string;
  readonly reportChecksum: string;
  readonly verdict: "FAIL" | "MISSING";
}): Promise<QualificationDistributedEvaluationReportCompletionMaterial> => {
  if (
    input.artifactId !==
    qualificationDistributedEvaluationReportCompletionArtifactId(input.executionId)
  ) {
    return { status: "FAIL" };
  }
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  let completion: QualificationDistributedEvaluationReportCompletion;
  try {
    completion = Schema.decodeSync(
      Schema.fromJsonString(QualificationDistributedEvaluationReportCompletion),
    )(encoded);
  } catch {
    return { status: "FAIL" };
  }
  const { checksum, ...content } = completion;
  return completion.artifactId === input.artifactId &&
    completion.artifactId ===
      qualificationDistributedEvaluationReportCompletionArtifactId(input.executionId) &&
    completion.checksum === input.checksum &&
    checksum === qualificationChecksum(content) &&
    completion.executionId === input.executionId &&
    completion.failingFamilyCount === input.failingFamilyCount &&
    completion.manifestChecksum === input.manifestChecksum &&
    completion.missingFamilyCount === input.missingFamilyCount &&
    completion.planChecksum === input.planChecksum &&
    completion.reportArtifactId === input.reportArtifactId &&
    completion.reportChecksum === input.reportChecksum &&
    completion.verdict === input.verdict &&
    retained.httpMetadata?.contentType === "application/json" &&
    exactMetadata(retained.customMetadata, completionMetadata(completion, await sha256Hex(encoded)))
    ? { completion, status: "COMPLETE" }
    : { status: "FAIL" };
};

const responseArtifactId = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/owner-response.json`;

/** Seal the report and then publish the exact terminal response that names it. */
const retainDistributedEvaluationOwnerResponse = async (
  bucket: QualificationOwnerResponseBucket,
  payload: QualificationOwnerWorkflowPayload,
  input: Omit<
    QualificationDistributedEvaluationReportInput,
    "executionId" | "manifestChecksum" | "planChecksum"
  >,
): Promise<QualificationDistributedEvaluationReportCompletion> => {
  const report = qualificationDistributedEvaluationReport({
    ...input,
    executionId: payload.executionId,
    manifestChecksum: payload.manifestChecksum,
    planChecksum: payload.planChecksum,
  });
  const completion = await retainQualificationDistributedEvaluationReport(bucket, report);
  const failingFamilies = report.families
    .filter(({ verdict }) => verdict === "FAIL")
    .map(({ family: name }) => name);
  const missingFamilies = report.families
    .filter(({ verdict }) => verdict === "MISSING")
    .map(({ family: name }) => name);
  const response = {
    body: {
      completionArtifactId: completion.artifactId,
      completionChecksum: completion.checksum,
      error:
        report.verdict === "FAIL"
          ? ("qualificationAuthorityConflict" as const)
          : ("qualificationAuthorityMaterialMissing" as const),
      executionId: payload.executionId,
      failingFamilies,
      manifestChecksum: payload.manifestChecksum,
      missingFamilies,
      phase: "PRE_TEARDOWN" as const,
      planChecksum: payload.planChecksum,
      reportArtifactId: report.artifactId,
      reportChecksum: report.checksum,
      verdict: report.verdict,
      version: "qualification-owner-response-v2" as const,
    },
    status: report.verdict === "FAIL" ? 409 : 424,
  };
  const encoded = canonicalQualificationJson(response);
  await retainImmutable({
    artifactId: responseArtifactId(payload.executionId),
    bucket,
    encoded,
    metadata: {
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-execution-id": payload.executionId,
      "osfo-kind": "qualification-owner-response-v2",
      "osfo-manifest-checksum": payload.manifestChecksum,
      "osfo-plan-checksum": payload.planChecksum,
      "osfo-report-checksum": report.checksum,
      "osfo-verdict": report.verdict,
    },
  });
  return completion;
};

export const retainQualificationDistributedEvaluationOwnerResponse = async (
  bucket: QualificationOwnerResponseBucket,
  payload: QualificationOwnerWorkflowPayload,
  input: Omit<
    QualificationDistributedEvaluationReportInput,
    "executionId" | "manifestChecksum" | "planChecksum"
  >,
): Promise<QualificationDistributedEvaluationReportCompletion> => {
  try {
    return await retainDistributedEvaluationOwnerResponse(bucket, payload, input);
  } catch (cause) {
    if (!(cause instanceof DistributedEvaluationRetentionConflict)) throw cause;
    await retainQualificationDistributedEvaluationConflict(bucket, payload, cause.artifactId);
    throw cause;
  }
};

/** Retain the exact MISSING outcome while concrete product authority exports are unavailable. */
// oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-native boundary.
export const retainMissingQualificationReport = async (
  bucket: QualificationOwnerResponseBucket,
  payload: QualificationOwnerWorkflowPayload,
  missingSources: ReadonlyArray<string>,
): Promise<void> => {
  const report = {
    body: {
      error: "qualificationAuthorityMaterialMissing",
      executionId: payload.executionId,
      manifestChecksum: payload.manifestChecksum,
      missingSources,
      planChecksum: payload.planChecksum,
      verdict: "MISSING",
    },
    status: 424,
  };
  const encoded = canonicalQualificationJson(report);
  const artifactId = responseArtifactId(payload.executionId);
  const retained = await bucket.put(artifactId, encoded, {
    customMetadata: {
      "osfo-execution-id": payload.executionId,
      "osfo-kind": "qualification-owner-response-v1",
      "osfo-verdict": "MISSING",
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return;
  const existing = await bucket.get(artifactId);
  if (existing === null || (await existing.text()) !== encoded) {
    throw new Error("Retained qualification-owner response conflicts");
  }
};

/** Retain a deterministic qualification authority conflict as FAIL, never source absence. */
// oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-native boundary.
export const retainFailedQualificationReport = async (
  bucket: QualificationOwnerResponseBucket,
  payload: QualificationOwnerWorkflowPayload,
  failureCodes: ReadonlyArray<string>,
): Promise<void> => {
  const report = {
    body: {
      error: "qualificationAuthorityConflict",
      executionId: payload.executionId,
      failureCodes,
      manifestChecksum: payload.manifestChecksum,
      planChecksum: payload.planChecksum,
      verdict: "FAIL",
    },
    status: 409,
  };
  const encoded = canonicalQualificationJson(report);
  const artifactId = responseArtifactId(payload.executionId);
  const retained = await bucket.put(artifactId, encoded, {
    customMetadata: {
      "osfo-execution-id": payload.executionId,
      "osfo-kind": "qualification-owner-response-v1",
      "osfo-verdict": "FAIL",
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return;
  const existing = await bucket.get(artifactId);
  if (existing === null || (await existing.text()) !== encoded) {
    throw new Error("Retained qualification-owner FAIL response conflicts");
  }
};
