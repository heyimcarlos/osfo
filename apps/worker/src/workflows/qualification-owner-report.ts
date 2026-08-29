import { canonicalQualificationJson } from "../qualification/qualification-checksum";
import type { QualificationOwnerWorkflowPayload } from "../workflow-contracts";

interface QualificationOwnerResponseBucket {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (
    key: string,
    value: string,
    options: R2PutOptions,
  ) => Promise<{ readonly etag: string } | null>;
}

const responseArtifactId = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/owner-response.json`;

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
