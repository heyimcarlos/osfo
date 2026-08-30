/* oxlint-disable effecttsgo/async-function -- Promise fakes model the R2 boundary. */
import { describe, expect, it } from "@effect/vitest";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { qualificationDistributedEvaluationReport } from "../qualification/distributed-evaluation-report";
import {
  authenticateQualificationDistributedEvaluationReportCompletion,
  authenticateQualificationDistributedEvaluationReport,
  retainQualificationDistributedEvaluationReport,
  retainQualificationDistributedEvaluationOwnerResponse,
} from "./qualification-owner-report";

const report = qualificationDistributedEvaluationReport({
  acceptanceLevel: "BoundedBeta",
  correctness: { reason: "correctness_missing", verdict: "MISSING" },
  dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
  executionId: "report-storage-test",
  manifestChecksum: "manifest-checksum",
  planChecksum: "plan-checksum",
  sourceVersion: "source-v1",
  topologyVersion: "topology-v1",
});

const memoryBucket = () => {
  const values = new Map<
    string,
    {
      customMetadata: Readonly<Record<string, string>>;
      encoded: string;
      httpMetadata: { readonly contentType?: string };
    }
  >();
  return {
    bucket: {
      get: (key: string) => {
        const retained = values.get(key);
        return Promise.resolve(
          retained === undefined
            ? null
            : {
                customMetadata: retained.customMetadata,
                httpMetadata: retained.httpMetadata,
                text: () => Promise.resolve(retained.encoded),
              },
        );
      },
      put: (key: string, encoded: string, options: R2PutOptions) => {
        if (values.has(key)) return Promise.resolve(null);
        const contentType =
          options.httpMetadata instanceof Headers
            ? (options.httpMetadata.get("content-type") ?? undefined)
            : options.httpMetadata?.contentType;
        values.set(key, {
          customMetadata: options.customMetadata ?? {},
          encoded,
          httpMetadata: contentType === undefined ? {} : { contentType },
        });
        return Promise.resolve({ etag: "created" });
      },
    },
    values,
  };
};

describe("qualification owner distributed report retention", () => {
  it.each([
    [
      "correctness FAIL",
      { reason: "correctness_conflict", verdict: "FAIL" as const },
      { reason: "correctness_prerequisite_failed", verdict: "MISSING" as const },
      "FAIL",
    ],
    [
      "correctness MISSING",
      { reason: "correctness_absent", verdict: "MISSING" as const },
      { reason: "correctness_prerequisite_missing", verdict: "MISSING" as const },
      "MISSING",
    ],
    [
      "dimension FAIL",
      {
        acceptedCount: 1,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 0,
        missingCount: 0,
        rootCount: 1,
        verdict: "PASS" as const,
      },
      { reason: "dimension_conflict", verdict: "FAIL" as const },
      "FAIL",
    ],
    [
      "dimension MISSING",
      {
        acceptedCount: 1,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 0,
        missingCount: 0,
        rootCount: 1,
        verdict: "PASS" as const,
      },
      { reason: "dimension_absent", verdict: "MISSING" as const },
      "MISSING",
    ],
    [
      "post-dimension report MISSING",
      {
        acceptedCount: 1,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 0,
        missingCount: 0,
        rootCount: 1,
        verdict: "PASS" as const,
      },
      {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        failCount: 0,
        missingCount: 0,
        verdict: "PASS" as const,
      },
      "MISSING",
    ],
  ] as const)(
    "materializes the trusted terminal %s path",
    async (_, correctness, dimensions, verdict) => {
      const retained = memoryBucket();
      await retainQualificationDistributedEvaluationOwnerResponse(
        retained.bucket,
        {
          executionId: report.executionId,
          manifestChecksum: report.manifestChecksum,
          planChecksum: report.planChecksum,
          requestArtifactChecksum: "request-checksum",
          requestArtifactId: "request.json",
        },
        {
          acceptanceLevel: report.acceptanceLevel,
          correctness,
          dimensions,
          sourceVersion: report.sourceVersion,
          topologyVersion: report.topologyVersion,
        },
      );
      const encoded = retained.values.get(report.artifactId)?.encoded;
      expect(encoded).toContain(`"verdict":"${verdict}"`);
    },
  );

  it("retains and authenticates byte-identical report and completion artifacts", async () => {
    const retained = memoryBucket();
    const completion = await retainQualificationDistributedEvaluationReport(
      retained.bucket,
      report,
    );
    const replay = await retainQualificationDistributedEvaluationReport(retained.bucket, report);

    expect(replay).toEqual(completion);
    expect(retained.values.get(report.artifactId)?.encoded).toBe(
      canonicalQualificationJson(report),
    );
    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: report.acceptanceLevel,
        artifactId: report.artifactId,
        bucket: retained.bucket,
        checksum: report.checksum,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      }),
    ).resolves.toEqual({ report, status: "COMPLETE" });
    await expect(
      authenticateQualificationDistributedEvaluationReportCompletion({
        artifactId: completion.artifactId,
        bucket: retained.bucket,
        checksum: completion.checksum,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        reportArtifactId: report.artifactId,
        reportChecksum: report.checksum,
      }),
    ).resolves.toEqual({ completion, status: "COMPLETE" });
  });

  it("distinguishes an absent report from retained metadata conflict", async () => {
    const retained = memoryBucket();
    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: report.acceptanceLevel,
        artifactId: report.artifactId,
        bucket: retained.bucket,
        checksum: report.checksum,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      }),
    ).resolves.toEqual({ status: "MISSING" });

    await retainQualificationDistributedEvaluationReport(retained.bucket, report);
    const stored = retained.values.get(report.artifactId);
    if (stored === undefined) throw new Error("Expected report fixture");
    retained.values.set(report.artifactId, {
      ...stored,
      customMetadata: { ...stored.customMetadata, "osfo-plan-checksum": "other-plan" },
    });
    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: report.acceptanceLevel,
        artifactId: report.artifactId,
        bucket: retained.bucket,
        checksum: report.checksum,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      }),
    ).resolves.toEqual({ status: "FAIL" });
    await expect(
      retainQualificationDistributedEvaluationReport(retained.bucket, report),
    ).rejects.toThrow("Retained qualification distributed report artifact conflicts");
  });

  it.each([
    ["execution", { executionId: "other-execution" }],
    ["manifest", { manifestChecksum: "other-manifest" }],
    ["plan", { planChecksum: "other-plan" }],
    ["source", { sourceVersion: "other-source" }],
    ["topology", { topologyVersion: "other-topology" }],
    ["acceptance level", { acceptanceLevel: "ScaleQualifiedPublic" as const }],
  ] as const)("rejects a report under another %s identity", async (_, changed) => {
    const retained = memoryBucket();
    await retainQualificationDistributedEvaluationReport(retained.bucket, report);

    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: report.acceptanceLevel,
        artifactId: report.artifactId,
        bucket: retained.bucket,
        checksum: report.checksum,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
        ...changed,
      }),
    ).resolves.toEqual({ status: "FAIL" });
  });

  it("rejects a self-checksummed reordered family ledger", async () => {
    const retained = memoryBucket();
    const first = report.families[0];
    const second = report.families[1];
    if (first === undefined || second === undefined) throw new Error("Expected report families");
    const families = [second, first, ...report.families.slice(2)];
    const { checksum: _, ...originalContent } = report;
    const content = { ...originalContent, families };
    const reordered = { ...content, checksum: qualificationChecksum(content) };
    await retainQualificationDistributedEvaluationReport(retained.bucket, reordered);

    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: report.acceptanceLevel,
        artifactId: report.artifactId,
        bucket: retained.bucket,
        checksum: reordered.checksum,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      }),
    ).resolves.toEqual({ status: "FAIL" });
  });

  it("rejects a self-checksummed PASS family without its authority reference", async () => {
    const retained = memoryBucket();
    const completeReport = qualificationDistributedEvaluationReport({
      acceptanceLevel: report.acceptanceLevel,
      correctness: {
        acceptedCount: 1,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 0,
        missingCount: 0,
        rootCount: 1,
        verdict: "PASS",
      },
      dimensions: {
        artifactId: "dimensions.json",
        checksum: "dimension-checksum",
        dimensionCount: 153,
        failCount: 0,
        missingCount: 0,
        verdict: "PASS",
      },
      executionId: report.executionId,
      manifestChecksum: report.manifestChecksum,
      planChecksum: report.planChecksum,
      sourceVersion: report.sourceVersion,
      topologyVersion: report.topologyVersion,
    });
    const correctness = completeReport.families[1];
    if (correctness === undefined) throw new Error("Expected correctness family");
    const { checksum: _, ...correctnessContent } = correctness;
    const changedCorrectnessContent = { ...correctnessContent, references: [] };
    const changedCorrectness = {
      ...changedCorrectnessContent,
      checksum: qualificationChecksum(changedCorrectnessContent),
    };
    const families = completeReport.families.map((candidate, index) =>
      index === 1 ? changedCorrectness : candidate,
    );
    const { checksum: __, ...originalContent } = completeReport;
    const content = { ...originalContent, families };
    const changed = { ...content, checksum: qualificationChecksum(content) };
    await retainQualificationDistributedEvaluationReport(retained.bucket, changed);

    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: changed.acceptanceLevel,
        artifactId: changed.artifactId,
        bucket: retained.bucket,
        checksum: changed.checksum,
        executionId: changed.executionId,
        manifestChecksum: changed.manifestChecksum,
        planChecksum: changed.planChecksum,
        sourceVersion: changed.sourceVersion,
        topologyVersion: changed.topologyVersion,
      }),
    ).resolves.toEqual({ status: "FAIL" });
  });

  it.each(["report.json", "completion.json"] as const)(
    "reconciles an applied %s put whose response was lost",
    async (lostArtifact) => {
      const retained = memoryBucket();
      let loseResponse = true;
      const bucket = {
        ...retained.bucket,
        put: async (key: string, encoded: string, options: R2PutOptions) => {
          const result = await retained.bucket.put(key, encoded, options);
          if (loseResponse && key.endsWith(lostArtifact)) {
            loseResponse = false;
            throw new Error("simulated lost response");
          }
          return result;
        },
      };
      await expect(retainQualificationDistributedEvaluationReport(bucket, report)).rejects.toThrow(
        "simulated lost response",
      );

      const completion = await retainQualificationDistributedEvaluationReport(bucket, report);
      expect(completion.reportChecksum).toBe(report.checksum);
      expect(retained.values.size).toBe(2);
    },
  );

  it("publishes a v2 owner response only after the report envelope", async () => {
    const retained = memoryBucket();
    const completion = await retainQualificationDistributedEvaluationOwnerResponse(
      retained.bucket,
      {
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        requestArtifactChecksum: "request-checksum",
        requestArtifactId: "request.json",
      },
      {
        acceptanceLevel: report.acceptanceLevel,
        correctness: { reason: "correctness_missing", verdict: "MISSING" },
        dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      },
    );
    const response = retained.values.get(
      `qualification/executions/${report.executionId}/owner-response.json`,
    );

    expect(completion.reportChecksum).toBe(report.checksum);
    expect(response?.encoded).toContain('"version":"qualification-owner-response-v2"');
    expect(response?.encoded).toContain('"status":424');
    expect(retained.values.size).toBe(3);
  });

  it("reconciles an applied owner response whose return was lost", async () => {
    const retained = memoryBucket();
    let loseResponse = true;
    const bucket = {
      ...retained.bucket,
      put: async (key: string, encoded: string, options: R2PutOptions) => {
        const result = await retained.bucket.put(key, encoded, options);
        if (loseResponse && key.endsWith("/owner-response.json")) {
          loseResponse = false;
          throw new Error("simulated owner response loss");
        }
        return result;
      },
    };
    const retain = () =>
      retainQualificationDistributedEvaluationOwnerResponse(
        bucket,
        {
          executionId: report.executionId,
          manifestChecksum: report.manifestChecksum,
          planChecksum: report.planChecksum,
          requestArtifactChecksum: "request-checksum",
          requestArtifactId: "request.json",
        },
        {
          acceptanceLevel: report.acceptanceLevel,
          correctness: { reason: "correctness_missing", verdict: "MISSING" },
          dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
          sourceVersion: report.sourceVersion,
          topologyVersion: report.topologyVersion,
        },
      );

    await expect(retain()).rejects.toThrow("simulated owner response loss");
    await expect(retain()).resolves.toMatchObject({ reportChecksum: report.checksum });
    expect(retained.values.size).toBe(3);
  });
});
