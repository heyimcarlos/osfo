/* oxlint-disable effecttsgo/async-function -- R2 is a Promise-native Worker boundary. */
import { Schema } from "effect";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import {
  QualificationDistributedEvaluationReport,
  QualificationDistributedEvaluationReportCompletion,
  qualificationDistributedEvaluationFamilyNames,
  qualificationDistributedEvaluationUnimplementedFamilies,
  qualificationDistributedEvaluationReportCompletion,
  qualificationDistributedEvaluationReportArtifactId,
  qualificationDistributedEvaluationReportCompletionArtifactId,
  qualificationDistributedEvaluationReport,
  type QualificationDistributedEvaluationReportInput,
} from "../qualification/distributed-evaluation-report";
import type { QualificationOwnerWorkflowPayload } from "../workflow-contracts";

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
  return family.references.length === 0;
};

const reportMetadata = (report: QualificationDistributedEvaluationReport, bodySha256: string) => ({
  "osfo-artifact-checksum": report.checksum,
  "osfo-body-sha256": bodySha256,
  "osfo-execution-id": report.executionId,
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
    throw new Error("Retained qualification distributed report artifact conflicts");
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
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly sourceVersion: string;
  readonly topologyVersion: string;
}): Promise<QualificationDistributedEvaluationReportMaterial> => {
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
    report.families[0]?.verdict === "PASS";
  return report.artifactId === input.artifactId &&
    report.artifactId === qualificationDistributedEvaluationReportArtifactId(input.executionId) &&
    report.checksum === input.checksum &&
    checksum === qualificationChecksum(content) &&
    report.executionId === input.executionId &&
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

export const authenticateQualificationDistributedEvaluationReportCompletion = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationOwnerReportReadBucket;
  readonly checksum: string;
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly planChecksum: string;
  readonly reportArtifactId: string;
  readonly reportChecksum: string;
}): Promise<QualificationDistributedEvaluationReportCompletionMaterial> => {
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
    completion.manifestChecksum === input.manifestChecksum &&
    completion.planChecksum === input.planChecksum &&
    completion.reportArtifactId === input.reportArtifactId &&
    completion.reportChecksum === input.reportChecksum &&
    retained.httpMetadata?.contentType === "application/json" &&
    exactMetadata(retained.customMetadata, completionMetadata(completion, await sha256Hex(encoded)))
    ? { completion, status: "COMPLETE" }
    : { status: "FAIL" };
};

const responseArtifactId = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/owner-response.json`;

/** Seal the report and then publish the exact terminal response that names it. */
export const retainQualificationDistributedEvaluationOwnerResponse = async (
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
      "osfo-execution-id": payload.executionId,
      "osfo-kind": "qualification-owner-response-v2",
      "osfo-report-checksum": report.checksum,
      "osfo-verdict": report.verdict,
    },
  });
  return completion;
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
