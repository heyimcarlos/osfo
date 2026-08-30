/* oxlint-disable effecttsgo/async-function -- Promise fakes model the R2 boundary. */
import { describe, expect, it } from "@effect/vitest";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import {
  qualificationDistributedEvaluationReport,
  qualificationDistributedEvaluationReportCompletionArtifactId,
} from "../qualification/distributed-evaluation-report";
import { qualificationExecutionRunCorpusReceiptArtifactId } from "../qualification/execution-run-corpus";
import {
  qualificationEvaluationCorrectnessReceipt,
  qualificationEvaluationRootAccumulatorReceipt,
} from "../qualification/qualification-evaluation-reducer";
import { qualificationCorrectnessRootReceiptArtifactId } from "../qualification/owner-partitions";
import {
  authenticateQualificationDistributedCorrectnessReference,
  authenticateQualificationDistributedEvaluationConflict,
  authenticateQualificationDistributedEvaluationReportCompletion,
  authenticateQualificationDistributedEvaluationReport,
  retainQualificationDistributedEvaluationReport,
  retainQualificationDistributedEvaluationOwnerResponse,
  retainQualificationExecutionRunCorpusOrConflict,
} from "./qualification-owner-report";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const executionCorpus = {
  acceptedCount: 1,
  artifactId: qualificationExecutionRunCorpusReceiptArtifactId("report-storage-test"),
  checksum: "execution-corpus-checksum",
  completionCount: 1,
  pageCount: 1,
  partitionCount: 1,
  rootCount: 1,
  terminalJoinPageChecksum: "join-checksum",
  terminalLaunchPageChecksum: "launch-checksum",
};

const historicalMissingCorpusReport =
  '{"acceptanceLevel":"BoundedBeta","artifactId":"qualification/executions/legacy/distributed-evaluation-report.json","executionId":"legacy","expectedDimensionCount":1,"expectedRootCount":1,"failingFamilyCount":0,"families":[{"failCount":0,"family":"manifest_plan","missingCount":0,"reason":"authenticated_frozen_owner_request","verdict":"PASS","references":[],"checksum":"sha256:2110ed3b128d996eff24e985c3bc066974846454d7394fb1349f16fda262b535"},{"failCount":0,"family":"forest_correctness","missingCount":1,"reason":"missing","verdict":"MISSING","references":[],"checksum":"sha256:8cacc7a828b8bcd1e530096976555abe01577f85bab80a9d27461709e88f2516"},{"failCount":0,"family":"numeric_stage_operation_dimensions","missingCount":1,"reason":"missing","verdict":"MISSING","references":[],"checksum":"sha256:bca5c99633438104d2548345bc19db6d297819f4ad1e7b1e9f8fc309ff6e2c97"},{"failCount":0,"family":"semantic_good_root","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:4943e2994dc21406286ad51c4dc46bb6967154a2821ec5328634e700ba26adda"},{"failCount":0,"family":"execution_run_corpus","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:157ca1a0e17831b2de5429be65a88c7df731077631860501effc42856a9d9909"},{"failCount":0,"family":"recovery_reserve_slope","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:efd5fc097eb984a86582ad5322ae52bcec2665ff0fb95409c70c37f567b0ed35"},{"failCount":0,"family":"resource_headroom","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:1d30b8e733edc863550e311df1f46fa99e01edb918ddb85ddbdde24a87986c59"},{"failCount":0,"family":"cost_economics","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:e9f8db1ae57096edc60469977c978473231332e3b7cf995603761e5b6e6856f5"},{"failCount":0,"family":"memory_semantics","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:7d69552ced8060b4dc6abfc9c35e9a31ab936c8731b98ad1d49922f3ac0608d0"},{"failCount":0,"family":"external_gates_public_promotion","missingCount":1,"reason":"authority_not_installed_pre_teardown","verdict":"MISSING","references":[],"checksum":"sha256:179671c44fbf2ac99f5d3f4abb2e99a9001aefe9177fcc987c0f206b23058350"},{"failCount":0,"family":"cohort_teardown","missingCount":1,"reason":"post_run_teardown_not_evaluated","verdict":"MISSING","references":[],"checksum":"sha256:574310db318f8ad2bc39fc4d28c141eb48ee93a48bd1ba7eaffd7eb73b58eb81"},{"failCount":0,"family":"evidence_retention","missingCount":1,"reason":"evidence_retention_authority_not_installed","verdict":"MISSING","references":[],"checksum":"sha256:def3e98f176515c60cc3fa7dfbea144e0fac96ed5bdc66c468927db1fd462876"}],"manifestChecksum":"m","missingFamilyCount":11,"phase":"PRE_TEARDOWN","planChecksum":"p","sourceVersion":"s","topologyVersion":"t","verdict":"MISSING","version":"qualification-distributed-evaluation-report-v1","checksum":"sha256:e982c1afc55a46efb5ee4dc8eca6ec19ac6c487ee07b285b91368c099c765aed"}';

const historicalMissingCorpusCompletion =
  '{"artifactId":"qualification/executions/legacy/distributed-evaluation-report-completion.json","executionId":"legacy","failingFamilyCount":0,"manifestChecksum":"m","missingFamilyCount":11,"planChecksum":"p","reportArtifactId":"qualification/executions/legacy/distributed-evaluation-report.json","reportChecksum":"sha256:e982c1afc55a46efb5ee4dc8eca6ec19ac6c487ee07b285b91368c099c765aed","verdict":"MISSING","version":"qualification-distributed-evaluation-report-completion-v1","checksum":"sha256:83d654cb6d4db9dbfa21de4e4901c681dd06cd714a9fed1af23934358e254351"}';

const historicalAcceptedReport = historicalMissingCorpusReport
  .replaceAll(
    "qualification/executions/legacy/distributed-evaluation-report.json",
    "qualification/executions/legacy/distributed-report/pre-teardown-v1/report.json",
  )
  .replace(
    "sha256:e982c1afc55a46efb5ee4dc8eca6ec19ac6c487ee07b285b91368c099c765aed",
    "sha256:20d6bfe2885d74273b4b74016d70c1a458be55705e57a28e21267567ce803ff6",
  );
const historicalAcceptedCompletion = historicalMissingCorpusCompletion
  .replaceAll(
    "qualification/executions/legacy/distributed-evaluation-report-completion.json",
    "qualification/executions/legacy/distributed-report/pre-teardown-v1/completion.json",
  )
  .replaceAll(
    "qualification/executions/legacy/distributed-evaluation-report.json",
    "qualification/executions/legacy/distributed-report/pre-teardown-v1/report.json",
  )
  .replaceAll(
    "sha256:e982c1afc55a46efb5ee4dc8eca6ec19ac6c487ee07b285b91368c099c765aed",
    "sha256:20d6bfe2885d74273b4b74016d70c1a458be55705e57a28e21267567ce803ff6",
  )
  .replace(
    "sha256:83d654cb6d4db9dbfa21de4e4901c681dd06cd714a9fed1af23934358e254351",
    "sha256:4854ec7c2f08d56a15839be4f0f78476e71d6b89577e248e91bc0e4425a1101d",
  );

const report = qualificationDistributedEvaluationReport({
  acceptanceLevel: "BoundedBeta",
  correctness: { reason: "correctness_missing", verdict: "MISSING" },
  dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
  executionId: "report-storage-test",
  expectedDimensionCount: 153,
  expectedRootCount: 1,
  executionCorpus,
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
  it("retains a rejected-root correctness FAIL when corpus counts agree", async () => {
    const retained = memoryBucket();
    const rejectedReport = qualificationDistributedEvaluationReport({
      acceptanceLevel: "BoundedBeta",
      correctness: {
        acceptedCount: 0,
        artifactId: "correctness.json",
        checksum: "correctness-checksum",
        failCount: 1,
        missingCount: 0,
        rootCount: 1,
        verdict: "FAIL",
      },
      dimensions: { reason: "correctness_prerequisite_failed", verdict: "MISSING" },
      executionCorpus: { ...executionCorpus, acceptedCount: 0 },
      executionId: report.executionId,
      expectedDimensionCount: report.expectedDimensionCount,
      expectedRootCount: 1,
      manifestChecksum: report.manifestChecksum,
      planChecksum: report.planChecksum,
      sourceVersion: report.sourceVersion,
      topologyVersion: report.topologyVersion,
    });
    await expect(
      retainQualificationDistributedEvaluationReport(retained.bucket, rejectedReport),
    ).resolves.toMatchObject({ verdict: "FAIL" });
  });

  it("authenticates a literal historical report without execution corpus authority", async () => {
    const retained = memoryBucket();
    const bodySha256 = await sha256Hex(historicalAcceptedReport);
    retained.values.set(
      "qualification/executions/legacy/distributed-report/pre-teardown-v1/report.json",
      {
        customMetadata: {
          "osfo-artifact-checksum":
            "sha256:20d6bfe2885d74273b4b74016d70c1a458be55705e57a28e21267567ce803ff6",
          "osfo-body-sha256": bodySha256,
          "osfo-execution-id": "legacy",
          "osfo-expected-dimension-count": "1",
          "osfo-expected-root-count": "1",
          "osfo-kind": "qualification-distributed-evaluation-report-v1",
          "osfo-manifest-checksum": "m",
          "osfo-plan-checksum": "p",
          "osfo-verdict": "MISSING",
        },
        encoded: historicalAcceptedReport,
        httpMetadata: { contentType: "application/json" },
      },
    );
    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: "BoundedBeta",
        artifactId:
          "qualification/executions/legacy/distributed-report/pre-teardown-v1/report.json",
        bucket: retained.bucket,
        checksum: "sha256:20d6bfe2885d74273b4b74016d70c1a458be55705e57a28e21267567ce803ff6",
        executionId: "legacy",
        expectedDimensionCount: 1,
        expectedRootCount: 1,
        manifestChecksum: "m",
        planChecksum: "p",
        sourceVersion: "s",
        topologyVersion: "t",
      }),
    ).resolves.toMatchObject({ status: "COMPLETE" });
    retained.values.set(
      "qualification/executions/legacy/distributed-report/pre-teardown-v1/completion.json",
      {
        customMetadata: {
          "osfo-artifact-checksum":
            "sha256:4854ec7c2f08d56a15839be4f0f78476e71d6b89577e248e91bc0e4425a1101d",
          "osfo-body-sha256": await sha256Hex(historicalAcceptedCompletion),
          "osfo-execution-id": "legacy",
          "osfo-kind": "qualification-distributed-evaluation-report-completion-v1",
          "osfo-manifest-checksum": "m",
          "osfo-plan-checksum": "p",
          "osfo-report-checksum":
            "sha256:20d6bfe2885d74273b4b74016d70c1a458be55705e57a28e21267567ce803ff6",
          "osfo-verdict": "MISSING",
        },
        encoded: historicalAcceptedCompletion,
        httpMetadata: { contentType: "application/json" },
      },
    );
    await expect(
      authenticateQualificationDistributedEvaluationReportCompletion({
        artifactId:
          "qualification/executions/legacy/distributed-report/pre-teardown-v1/completion.json",
        bucket: retained.bucket,
        checksum: "sha256:4854ec7c2f08d56a15839be4f0f78476e71d6b89577e248e91bc0e4425a1101d",
        executionId: "legacy",
        failingFamilyCount: 0,
        manifestChecksum: "m",
        missingFamilyCount: 11,
        planChecksum: "p",
        reportArtifactId:
          "qualification/executions/legacy/distributed-report/pre-teardown-v1/report.json",
        reportChecksum: "sha256:20d6bfe2885d74273b4b74016d70c1a458be55705e57a28e21267567ce803ff6",
        verdict: "MISSING",
      }),
    ).resolves.toMatchObject({ status: "COMPLETE" });
  });
  it("authenticates the compact correctness receipt without traversing its shard tree", async () => {
    const retained = memoryBucket();
    const root = qualificationEvaluationRootAccumulatorReceipt({
      acceptedCount: 0,
      artifactId: "correctness-roots-receipt.json",
      artifactPrefix: "correctness-roots",
      executionId: report.executionId,
      firstPartitionIndex: 0,
      firstRootId: null,
      firstShardChecksum: "ZERO",
      index: 0,
      inputReceiptChecksums: ["leaf-checksum"],
      lastPartitionIndex: 0,
      lastRootId: null,
      level: 0,
      planChecksum: report.planChecksum,
      rootCount: 0,
      shardCount: 0,
      terminalShardChecksum: "ZERO",
    });
    if (root === null) throw new Error("Expected root receipt fixture");
    const receipt = qualificationEvaluationCorrectnessReceipt({
      artifactId: qualificationCorrectnessRootReceiptArtifactId(report.executionId, 1),
      executionId: report.executionId,
      findingSummary: { exemplars: [], failCount: 0, missingCount: 0 },
      findingSummaryArtifactChecksum: "summary-checksum",
      findingSummaryArtifactId: "summary.json",
      index: 0,
      inputReceiptChecksums: ["leaf-checksum"],
      level: 0,
      planChecksum: report.planChecksum,
      rootAccumulator: root,
    });
    if (receipt === null) throw new Error("Expected correctness receipt fixture");
    const encoded = canonicalQualificationJson(receipt);
    retained.values.set(receipt.artifactId, {
      customMetadata: {
        "osfo-artifact-checksum": receipt.checksum,
        "osfo-body-sha256": await sha256Hex(encoded),
        "osfo-execution-id": receipt.executionId,
        "osfo-first-partition-index": "0",
        "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
        "osfo-kind": "qualification-evaluation-correctness-receipt-v1",
        "osfo-last-partition-index": "0",
        "osfo-plan-checksum": receipt.planChecksum,
        "osfo-record-count": "0",
        "osfo-root-receipt-checksum": receipt.rootAccumulator.checksum,
        "osfo-summary-checksum": receipt.findingSummaryArtifactChecksum,
        "osfo-verdict": "PASS",
      },
      encoded,
      httpMetadata: { contentType: "application/json" },
    });

    const input = {
      artifactId: receipt.artifactId,
      bucket: retained.bucket,
      checksum: receipt.checksum,
      executionId: receipt.executionId,
      expectedAcceptedCount: 0,
      expectedRootCount: 0,
      partitionCount: 1,
      planChecksum: receipt.planChecksum,
      verdict: "PASS" as const,
    };
    await expect(authenticateQualificationDistributedCorrectnessReference(input)).resolves.toEqual({
      status: "COMPLETE",
    });
    await expect(
      authenticateQualificationDistributedCorrectnessReference({
        ...input,
        executionId: "other-execution",
      }),
    ).resolves.toEqual({ status: "FAIL" });
    const current = retained.values.get(receipt.artifactId);
    if (current === undefined) throw new Error("Expected retained correctness fixture");
    retained.values.set(receipt.artifactId, {
      ...current,
      customMetadata: {
        ...current.customMetadata,
        "osfo-record-count": "1",
      },
    });
    await expect(authenticateQualificationDistributedCorrectnessReference(input)).resolves.toEqual({
      status: "FAIL",
    });
  });

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
          executionCorpus,
          expectedDimensionCount: report.expectedDimensionCount,
          expectedRootCount: report.expectedRootCount,
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
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
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
        failingFamilyCount: report.failingFamilyCount,
        manifestChecksum: report.manifestChecksum,
        missingFamilyCount: report.missingFamilyCount,
        planChecksum: report.planChecksum,
        reportArtifactId: report.artifactId,
        reportChecksum: report.checksum,
        verdict: report.verdict,
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
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
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
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
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

  it("rejects noncanonical report keys before R2 and keeps canonical absence MISSING", async () => {
    const retained = memoryBucket();
    await expect(
      authenticateQualificationDistributedEvaluationReport({
        acceptanceLevel: report.acceptanceLevel,
        artifactId: "foreign-report.json",
        bucket: retained.bucket,
        checksum: report.checksum,
        executionId: report.executionId,
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      }),
    ).resolves.toEqual({ status: "FAIL" });

    const completionInput = {
      artifactId: qualificationDistributedEvaluationReportCompletionArtifactId(report.executionId),
      bucket: retained.bucket,
      checksum: "completion-checksum",
      executionId: report.executionId,
      failingFamilyCount: report.failingFamilyCount,
      manifestChecksum: report.manifestChecksum,
      missingFamilyCount: report.missingFamilyCount,
      planChecksum: report.planChecksum,
      reportArtifactId: report.artifactId,
      reportChecksum: report.checksum,
      verdict: report.verdict,
    };
    await expect(
      authenticateQualificationDistributedEvaluationReportCompletion({
        ...completionInput,
        artifactId: "foreign-completion.json",
      }),
    ).resolves.toEqual({ status: "FAIL" });
    await expect(
      authenticateQualificationDistributedEvaluationReportCompletion(completionInput),
    ).resolves.toEqual({ status: "MISSING" });
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
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
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
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
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
      executionCorpus,
      expectedDimensionCount: report.expectedDimensionCount,
      expectedRootCount: report.expectedRootCount,
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
        expectedDimensionCount: changed.expectedDimensionCount,
        expectedRootCount: changed.expectedRootCount,
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
        executionCorpus,
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
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
          executionCorpus,
          expectedDimensionCount: report.expectedDimensionCount,
          expectedRootCount: report.expectedRootCount,
          sourceVersion: report.sourceVersion,
          topologyVersion: report.topologyVersion,
        },
      );

    await expect(retain()).rejects.toThrow("simulated owner response loss");
    await expect(retain()).resolves.toMatchObject({ reportChecksum: report.checksum });
    expect(retained.values.size).toBe(3);
  });

  it.each(["report", "completion", "response"] as const)(
    "retains an authenticated conflict marker for an immutable %s collision",
    async (collision) => {
      const retained = memoryBucket();
      const payload = {
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        requestArtifactChecksum: "request-checksum",
        requestArtifactId: "request.json",
      };
      const input = {
        acceptanceLevel: report.acceptanceLevel,
        correctness: { reason: "correctness_missing", verdict: "MISSING" as const },
        dimensions: {
          reason: "correctness_prerequisite_missing",
          verdict: "MISSING" as const,
        },
        executionCorpus,
        expectedDimensionCount: report.expectedDimensionCount,
        expectedRootCount: report.expectedRootCount,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      };
      if (collision !== "report") {
        await retainQualificationDistributedEvaluationReport(retained.bucket, report);
      }
      const artifactId =
        collision === "report"
          ? report.artifactId
          : collision === "completion"
            ? qualificationDistributedEvaluationReportCompletionArtifactId(report.executionId)
            : `qualification/executions/${report.executionId}/owner-response.json`;
      retained.values.set(artifactId, {
        customMetadata: {},
        encoded: canonicalQualificationJson({ conflict: collision }),
        httpMetadata: { contentType: "application/json" },
      });

      await expect(
        retainQualificationDistributedEvaluationOwnerResponse(retained.bucket, payload, input),
      ).rejects.toThrow("Retained qualification distributed report artifact conflicts");
      await expect(
        authenticateQualificationDistributedEvaluationConflict({
          bucket: retained.bucket,
          executionId: report.executionId,
          manifestChecksum: report.manifestChecksum,
          planChecksum: report.planChecksum,
        }),
      ).resolves.toBe("CONFLICT");
    },
  );

  it("routes an execution-corpus collision through the owner conflict marker", async () => {
    const retained = memoryBucket();
    retained.values.set(executionCorpus.artifactId, {
      customMetadata: {},
      encoded: canonicalQualificationJson({ conflict: "execution-corpus" }),
      httpMetadata: { contentType: "application/json" },
    });
    const payload = {
      executionId: report.executionId,
      manifestChecksum: report.manifestChecksum,
      planChecksum: report.planChecksum,
      requestArtifactChecksum: "request-checksum",
      requestArtifactId: "request.json",
    };
    await expect(
      retainQualificationExecutionRunCorpusOrConflict(retained.bucket, payload, {
        completion: {
          acceptedCount: 1,
          completeOutcomeCount: 1,
          completionCount: 1,
          failOutcomeCount: 0,
          missingCompletionCount: 0,
          outcomeMissingCount: 0,
          pageCount: 1,
          rootCount: 1,
          terminalPageChecksum: "join-checksum",
        },
        descriptor: { partitionCount: 1, terminalPageChecksum: "launch-checksum" },
        executionId: report.executionId,
        expectedRootCount: 1,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
        sourceVersion: report.sourceVersion,
        topologyVersion: report.topologyVersion,
      }),
    ).rejects.toThrow("Retained qualification execution/run corpus receipt conflicts");
    await expect(
      authenticateQualificationDistributedEvaluationConflict({
        bucket: retained.bucket,
        executionId: report.executionId,
        manifestChecksum: report.manifestChecksum,
        planChecksum: report.planChecksum,
      }),
    ).resolves.toBe("CONFLICT");
  });
});
