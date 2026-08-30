/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise fakes model Cloudflare boundaries; Effect Vitest assertions execute inside generator-backed tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { compactManifest, manifestVersions } from "../../../test/support/qualification-fixtures";
import {
  createQualificationExecutionPlan,
  type QualificationExecutionPlan,
} from "../../qualification/execution";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import {
  createBoundedBetaManifest,
  createScaleQualifiedPublicManifest,
  type ProductionQualificationManifest,
} from "../../qualification/qualification-manifest";
import { qualificationCohortArtifactId } from "../../qualification/qualification-cohort";
import { qualificationDistributedEvaluationReport } from "../../qualification/distributed-evaluation-report";
import {
  qualificationEvaluationCorrectnessReceipt,
  qualificationEvaluationRootAccumulatorReceipt,
} from "../../qualification/qualification-evaluation-reducer";
import { retainQualificationDistributedEvaluationReport } from "../../workflows/qualification-owner-report";
import type {
  QualificationExecutionListedObject,
  QualificationExecutionListingBucket,
} from "./qualification-execution-artifacts";
import {
  makeProductionQualificationComposition,
  runProductionQualification,
} from "./production-qualification";

const components = [
  "arrivals",
  "cost",
  "externalGates",
  "faults",
  "memorySemantic",
  "recovery",
  "resourceUse",
  "runs",
  "semantic",
  "stages",
] as const;
const authoritySources = [
  "allowance_and_billing_ledger",
  "gmail_provider_receipts",
  "memory_commit_receipts",
  "model_access_receipts",
  "osfo_agent_activation_log",
  "osfo_committed_turns",
  "provider_delivery_receipts",
  "qualification_fault_controller_receipts",
  "r2_object_metadata",
  "task_compute_receipts",
  "think_submission_receipts",
  "whatsapp_delivery_receipts",
  "worker_admission_receipts",
  "workflow_instance_receipts",
] as const;
const memoryBucket = () => {
  const retained = new Map<string, string>();
  let listCallCount = 0;
  const metadata = new Map<
    string,
    {
      readonly customMetadata: Readonly<Record<string, string>>;
      readonly httpMetadata: { readonly contentType: string };
    }
  >();
  const listed = new Map<string, QualificationExecutionListedObject>();
  const bucket = {
    get: (key: string) => {
      if (!retained.has(key)) return Promise.resolve(null);
      const retainedMetadata = metadata.get(key);
      const value = { text: () => Promise.resolve(retained.get(key) ?? "") };
      return Promise.resolve(
        retainedMetadata === undefined ? value : { ...retainedMetadata, ...value },
      );
    },
    list: ({
      cursor,
      limit,
      prefix,
    }: {
      cursor?: string | undefined;
      include: readonly ["customMetadata"];
      limit: number;
      prefix: string;
    }) => {
      listCallCount += 1;
      const offset = cursor === undefined ? 0 : Number(cursor);
      const matches = [...listed.values()].filter(({ key }) => key.startsWith(prefix));
      const objects = matches.slice(offset, offset + limit);
      const next = offset + objects.length;
      return Promise.resolve(
        next < matches.length
          ? { cursor: String(next), objects, truncated: true as const }
          : { objects, truncated: false as const },
      );
    },
    put: (
      key: string,
      value: string,
      options: {
        readonly customMetadata: Readonly<Record<string, string>>;
        readonly httpMetadata: { readonly contentType: string };
        readonly onlyIf: { readonly etagDoesNotMatch: string };
      },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, value);
      metadata.set(key, {
        customMetadata: options.customMetadata,
        httpMetadata: options.httpMetadata,
      });
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  } satisfies QualificationExecutionListingBucket;
  return { bucket, listCallCount: () => listCallCount, listed, metadata, retained };
};

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const retainDimensionReference = async (
  storage: ReturnType<typeof memoryBucket>,
  input: {
    readonly artifactId: string;
    readonly executionId: string;
    readonly planChecksum: string;
  },
) => {
  const content = {
    artifactId: input.artifactId,
    dimensionCount: 0,
    evaluationPageCount: 0,
    executionId: input.executionId,
    identityDimensionCount: 0,
    numericDimensionCount: 0,
    planChecksum: input.planChecksum,
    rootPageCount: 0,
    terminalEvaluationPageChecksum: "ZERO",
    terminalRootPageChecksum: "ZERO",
    verdict: "PASS" as const,
    version: "qualification-dimension-coordinator-completion-v1" as const,
  };
  const completion = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(completion);
  storage.retained.set(input.artifactId, encoded);
  storage.metadata.set(input.artifactId, {
    customMetadata: {
      "osfo-artifact-checksum": completion.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-dimension-count": "0",
      "osfo-execution-id": input.executionId,
      "osfo-kind": "qualification-dimension-coordinator-completion-v1",
      "osfo-plan-checksum": input.planChecksum,
      "osfo-record-count": "0",
      "osfo-verdict": "PASS",
    },
    httpMetadata: { contentType: "application/json" },
  });
  return completion;
};

const retainCorrectnessReference = async (
  storage: ReturnType<typeof memoryBucket>,
  input: {
    readonly artifactId: string;
    readonly executionId: string;
    readonly planChecksum: string;
  },
) => {
  const root = qualificationEvaluationRootAccumulatorReceipt({
    acceptedCount: 0,
    artifactId: `${input.artifactId}/roots.json`,
    artifactPrefix: `${input.artifactId}/roots`,
    executionId: input.executionId,
    firstPartitionIndex: 0,
    firstRootId: null,
    firstShardChecksum: "ZERO",
    index: 0,
    inputReceiptChecksums: ["leaf-checksum"],
    lastPartitionIndex: 0,
    lastRootId: null,
    level: 0,
    planChecksum: input.planChecksum,
    rootCount: 0,
    shardCount: 0,
    terminalShardChecksum: "ZERO",
  });
  if (root === null) throw new Error("Expected correctness root fixture");
  const receipt = qualificationEvaluationCorrectnessReceipt({
    artifactId: input.artifactId,
    executionId: input.executionId,
    findingSummary: { exemplars: [], failCount: 0, missingCount: 0 },
    findingSummaryArtifactChecksum: "summary-checksum",
    findingSummaryArtifactId: `${input.artifactId}/summary.json`,
    index: 0,
    inputReceiptChecksums: ["leaf-checksum"],
    level: 0,
    planChecksum: input.planChecksum,
    rootAccumulator: root,
  });
  if (receipt === null) throw new Error("Expected correctness fixture");
  const encoded = canonicalQualificationJson(receipt);
  storage.retained.set(input.artifactId, encoded);
  storage.metadata.set(input.artifactId, {
    customMetadata: {
      "osfo-artifact-checksum": receipt.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-execution-id": input.executionId,
      "osfo-first-partition-index": "0",
      "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
      "osfo-kind": "qualification-evaluation-correctness-receipt-v1",
      "osfo-last-partition-index": "0",
      "osfo-plan-checksum": input.planChecksum,
      "osfo-record-count": "0",
      "osfo-root-receipt-checksum": receipt.rootAccumulator.checksum,
      "osfo-summary-checksum": receipt.findingSummaryArtifactChecksum,
      "osfo-verdict": "PASS",
    },
    httpMetadata: { contentType: "application/json" },
  });
  return receipt;
};

const retainCohort = (
  retained: Map<string, string>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
) => {
  const content = {
    artifactAuthorityProtocol: "qualification-cohort-artifacts-v1" as const,
    cohortId: `${plan.executionId}-cohort`,
    createdAtUtc: "2026-08-29T16:59:00.000Z",
    executionId: plan.executionId,
    expiresAtUtc: "2099-08-30T17:00:00.000Z",
    grantPrefix: `qualification/executions/${plan.executionId}/cohort/grants`,
    manifestChecksum: manifest.manifestChecksum,
    notBeforeUtc: "2026-08-29T17:00:00.000Z",
    participantCounts: {
      adventurer: manifest.corpus.registeredUsers / 10,
      free: manifest.corpus.registeredUsers - manifest.corpus.registeredUsers / 10,
    },
    planChecksum: plan.planChecksum,
    sourceVersion: manifest.sourceVersion,
    teardownPolicy: "permanentAccountDeletion" as const,
  };
  retained.set(
    qualificationCohortArtifactId(plan.executionId),
    canonicalQualificationJson({ ...content, artifactChecksum: qualificationChecksum(content) }),
  );
};

const retainedOwner = (
  retained: Map<string, string>,
  listed: Map<string, QualificationExecutionListedObject>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  tamper:
    | "deletedShard"
    | "duplicateKey"
    | "partialStream"
    | "reportInput"
    | "staleMetadata"
    | "terminalChecksum"
    | null = null,
) => {
  retainCohort(retained, manifest, plan);
  return {
    fetch: () => {
      const executionId = plan.executionId;
      const manifestChecksum = manifest.manifestChecksum;
      const planChecksum = plan.planChecksum;
      const streams = components.map((component) => {
        const artifactPrefix = `qualification/executions/${executionId}/authority-streams/${component}`;
        const recordCount =
          component === "arrivals"
            ? plan.runs.reduce((total, run) => total + run.arrivalCount, 0)
            : component === "faults"
              ? plan.runs.filter((run) => run.fault !== null).length
              : component === "runs"
                ? plan.runs.length
                : component === "externalGates"
                  ? manifest.requiredExternalGates.length
                  : 1;
        const chunkCount = Math.ceil(recordCount / 256);
        let previousArtifactChecksum = "NONE";
        for (let index = 0; index < chunkCount; index += 1) {
          const chunkRecordCount = Math.min(256, recordCount - index * 256);
          const bodySha256 = qualificationChecksum({
            component,
            executionId,
            index,
            planChecksum,
            retainedFixture: true,
          }).slice("sha256:".length);
          const content = {
            bodySha256,
            component,
            executionId,
            index,
            planChecksum,
            previousArtifactChecksum,
            recordCount: chunkRecordCount,
            sourceVersion: manifest.sourceVersion,
          };
          const artifactChecksum = qualificationChecksum(content);
          const key = `${artifactPrefix}/${index.toString().padStart(8, "0")}.json`;
          const omit =
            component === "arrivals" &&
            ((tamper === "deletedShard" && index === 1) ||
              (tamper === "partialStream" && index === chunkCount - 1));
          if (!omit) {
            listed.set(key, {
              checksums: { sha256: hexToBytes(bodySha256) },
              customMetadata: {
                "osfo-artifact-checksum": artifactChecksum,
                "osfo-body-sha256": bodySha256,
                "osfo-component": component,
                "osfo-execution-id": executionId,
                "osfo-index": String(index),
                "osfo-kind": "qualification-authority-stream-v1",
                "osfo-plan-checksum": planChecksum,
                "osfo-previous-checksum": previousArtifactChecksum,
                "osfo-record-count": String(chunkRecordCount),
                "osfo-source-version":
                  tamper === "staleMetadata" && component === "arrivals" && index === 0
                    ? "stale-source"
                    : manifest.sourceVersion,
              },
              key,
            });
          }
          previousArtifactChecksum = artifactChecksum;
        }
        if (tamper === "duplicateKey" && component === "arrivals") {
          const first = listed.get(`${artifactPrefix}/00000000.json`);
          if (first !== undefined) listed.set(`${artifactPrefix}/00000000-copy.json`, first);
        }
        return {
          artifactPrefix,
          canonicalDigest: previousArtifactChecksum,
          chunkCount,
          component,
          recordCount,
          sourceVersion: manifest.sourceVersion,
          terminalChecksum:
            tamper === "terminalChecksum" && component === "arrivals"
              ? "sha256:tampered"
              : previousArtifactChecksum,
          verificationVersion: "qualification-owner-stream-v1" as const,
        };
      });
      const retainedEvaluationInputChecksum = qualificationChecksum({
        authoritySources,
        executionId,
        manifestChecksum,
        planChecksum,
        productAuthorityStreams: authoritySources.map((source) => ({
          artifactPrefix: `qualification/executions/${executionId}/product-authority/${source}`,
          chunkCount: 1,
          recordCount: 1,
          source,
          terminalChecksum: qualificationChecksum({ executionId, source }),
        })),
        streams,
      });
      const evaluationInputChecksum =
        tamper === "reportInput" ? "sha256:unrelated-report" : retainedEvaluationInputChecksum;
      const report = {
        adventurerContributionMargin: 0.75,
        costSummaries: [],
        evaluationInputChecksum,
        executionId,
        findings: [],
        foreignExchangeUsdMicros: "0",
        freeCostPerActivePeriodUsdMicros: "0",
        manifestChecksum,
        planChecksum,
        recoveryReservePerSecond: 2,
        stageSummaries: [],
        taxesUsdMicros: "0",
        verdict: "PASS",
      };
      const encodedReport = canonicalQualificationJson(report);
      const reportArtifactId = `qualification/executions/${executionId}/report.json`;
      retained.set(reportArtifactId, encodedReport);
      const content = {
        authoritySources,
        evaluatorVersion: "production-qualification-v1" as const,
        executionId,
        manifestChecksum,
        ownerIdentity: "osfo-qualification-owner-v1" as const,
        planChecksum,
        productAuthorityStreams: authoritySources.map((source) => ({
          artifactPrefix: `qualification/executions/${executionId}/product-authority/${source}`,
          chunkCount: 1,
          recordCount: 1,
          source,
          terminalChecksum: qualificationChecksum({ executionId, source }),
        })),
        reportArtifactChecksum: qualificationChecksum({ encodedReport }),
        reportArtifactId,
        streams,
      };
      const bundle = { ...content, artifactChecksum: qualificationChecksum(content) };
      const bundleArtifactId = `qualification/executions/${executionId}/bundle.json`;
      retained.set(bundleArtifactId, canonicalQualificationJson(bundle));
      return Promise.resolve(
        Response.json({
          bundleArtifactChecksum: bundle.artifactChecksum,
          bundleArtifactId,
          executionId,
          manifestChecksum,
          planChecksum,
        }),
      );
    },
  };
};

it.effect("reports the exact missing bounded owner binding", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "production-composition-test");
    const { bucket, retained } = memoryBucket();
    retainCohort(retained, manifest, plan);
    const composition = makeProductionQualificationComposition({
      ARTIFACTS: bucket,
    });
    const report = yield* Effect.promise(() =>
      runProductionQualification({ ARTIFACTS: bucket }, manifest, plan),
    );

    expect(composition.owner).toBeNull();
    expect(report).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "productionQualificationOwnerMissing",
          verdict: "MISSING",
        }),
      ]),
      verdict: "MISSING",
    });
  }),
);

it.effect("verifies compact authority descriptors for the full beta plan", () =>
  Effect.gen(function* () {
    const manifest = createBoundedBetaManifest(manifestVersions);
    const plan = createQualificationExecutionPlan(manifest, 0, "bounded-beta-owner-test");
    const { bucket, listed, retained } = memoryBucket();
    const owner = retainedOwner(retained, listed, manifest, plan);
    const report = yield* Effect.promise(() =>
      runProductionQualification(
        {
          ARTIFACTS: bucket,
          QUALIFICATION_OWNER: owner,
        },
        manifest,
        plan,
      ),
    );

    expect(plan.runs.reduce((total, run) => total + run.arrivalCount, 0)).toBeGreaterThan(100_000);
    expect(report.verdict).toBe("PASS");
    expect([...listed.keys()].filter((key) => key.includes("authority-streams"))).not.toHaveLength(
      0,
    );
  }),
);

it.effect("fails when a retained authority stream chain conflicts", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "tampered-owner-test");
    const { bucket, listed, retained } = memoryBucket();
    const owner = retainedOwner(retained, listed, manifest, plan, "terminalChecksum");
    const report = yield* Effect.promise(() =>
      runProductionQualification(
        {
          ARTIFACTS: bucket,
          QUALIFICATION_OWNER: owner,
        },
        manifest,
        plan,
      ),
    );

    expect(report).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "productionQualificationOwnerConflict",
          verdict: "FAIL",
        }),
      ]),
      verdict: "FAIL",
    });
  }),
);

it.effect("rejects a report unrelated to the retained authority stream roots", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "wrong-owner-corpus-test");
    const { bucket, listed, retained } = memoryBucket();
    const owner = retainedOwner(retained, listed, manifest, plan, "reportInput");
    const report = yield* Effect.promise(() =>
      runProductionQualification({ ARTIFACTS: bucket, QUALIFICATION_OWNER: owner }, manifest, plan),
    );

    expect(report).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "productionQualificationOwnerConflict",
          verdict: "FAIL",
        }),
      ]),
      verdict: "FAIL",
    });
  }),
);

it.effect(
  "verifies retained shard metadata for the 1.75m-root public corpus",
  () =>
    Effect.gen(function* () {
      const manifest = createScaleQualifiedPublicManifest(manifestVersions);
      const plan = createQualificationExecutionPlan(manifest, 0, "public-lazy-owner-test");
      const { bucket, listed, retained } = memoryBucket();
      const owner = retainedOwner(retained, listed, manifest, plan);
      const report = yield* Effect.promise(() =>
        runProductionQualification(
          { ARTIFACTS: bucket, QUALIFICATION_OWNER: owner },
          manifest,
          plan,
        ),
      );

      expect(plan.runs.reduce((total, run) => total + run.arrivalCount, 0)).toBe(1_750_422);
      expect([...listed.keys()].filter((key) => key.includes("/arrivals/"))).toHaveLength(6_838);
      expect(report.verdict).toBe("PASS");
    }),
  120_000,
);

it.effect("rejects missing, partial, stale, and duplicate retained shards", () =>
  Effect.gen(function* () {
    for (const tamper of [
      "deletedShard",
      "partialStream",
      "staleMetadata",
      "duplicateKey",
    ] as const) {
      const manifest = compactManifest();
      const plan = createQualificationExecutionPlan(manifest, 0, `shard-${tamper}`);
      const { bucket, listed, retained } = memoryBucket();
      const owner = retainedOwner(retained, listed, manifest, plan, tamper);
      const report = yield* Effect.promise(() =>
        runProductionQualification(
          { ARTIFACTS: bucket, QUALIFICATION_OWNER: owner },
          manifest,
          plan,
        ),
      );

      expect(report.verdict).toBe("FAIL");
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "productionQualificationOwnerConflict" }),
        ]),
      );
    }
  }),
);

it.effect("fails when an execution identity is replayed with another frozen plan", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const firstPlan = createQualificationExecutionPlan(manifest, 0, "replayed-execution");
    const secondPlan = createQualificationExecutionPlan(manifest, 1_000, "replayed-execution");
    const { bucket, listed, retained } = memoryBucket();
    const firstReport = yield* Effect.promise(() =>
      runProductionQualification(
        {
          ARTIFACTS: bucket,
          QUALIFICATION_OWNER: retainedOwner(retained, listed, manifest, firstPlan),
        },
        manifest,
        firstPlan,
      ),
    );
    const replayedReport = yield* Effect.promise(() =>
      runProductionQualification(
        {
          ARTIFACTS: bucket,
          QUALIFICATION_OWNER: retainedOwner(retained, listed, manifest, secondPlan),
        },
        manifest,
        secondPlan,
      ),
    );

    expect(firstReport.verdict).toBe("PASS");
    expect(replayedReport).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "productionQualificationOwnerConflict" }),
      ]),
      verdict: "FAIL",
    });
  }),
);

it.effect("preserves an exact completed MISSING authority-source report", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "missing-source-execution");
    const { bucket, retained } = memoryBucket();
    retainCohort(retained, manifest, plan);
    const report = yield* Effect.promise(() =>
      runProductionQualification(
        {
          ARTIFACTS: bucket,
          QUALIFICATION_OWNER: {
            fetch: () =>
              Promise.resolve(
                Response.json(
                  {
                    error: "qualificationAuthorityMaterialMissing",
                    executionId: plan.executionId,
                    manifestChecksum: manifest.manifestChecksum,
                    missingSources: ["fault-controller-authority-export"],
                    planChecksum: plan.planChecksum,
                    verdict: "MISSING",
                  },
                  { status: 424 },
                ),
              ),
          },
        },
        manifest,
        plan,
      ),
    );

    expect(report).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "productionQualificationAuthorityMissing",
          detail: expect.stringContaining("fault-controller-authority-export"),
        }),
      ]),
      verdict: "MISSING",
    });
  }),
);

it("preserves the legacy v1 FAIL response as owner-unavailable MISSING on replay", async () => {
  const manifest = compactManifest();
  const plan = createQualificationExecutionPlan(manifest, 0, "legacy-owner-fail");
  const { bucket, retained } = memoryBucket();
  retainCohort(retained, manifest, plan);
  const composition = {
    ARTIFACTS: bucket,
    QUALIFICATION_OWNER: {
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: "qualificationAuthorityConflict",
              executionId: plan.executionId,
              failureCodes: ["partitionCompletionConflict"],
              manifestChecksum: manifest.manifestChecksum,
              planChecksum: plan.planChecksum,
              verdict: "FAIL",
            },
            { status: 409 },
          ),
        ),
    },
  };

  const first = await runProductionQualification(composition, manifest, plan);
  const replay = await runProductionQualification(composition, manifest, plan);

  for (const result of [first, replay]) {
    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "productionQualificationOwnerUnavailable" }),
      ]),
      verdict: "MISSING",
    });
  }
});

it.each([false, true] as const)(
  "authenticates a distributed PRE_TEARDOWN report before returning %s",
  async (tamperMetadata) => {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(
      manifest,
      0,
      tamperMetadata ? "tampered-distributed-report" : "distributed-report",
    );
    const { bucket, listCallCount, metadata, retained } = memoryBucket();
    retainCohort(retained, manifest, plan);
    const report = qualificationDistributedEvaluationReport({
      acceptanceLevel: manifest.acceptanceLevel,
      correctness: { reason: "qualificationCorrectnessMissing", verdict: "MISSING" },
      dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
      executionId: plan.executionId,
      manifestChecksum: manifest.manifestChecksum,
      planChecksum: plan.planChecksum,
      sourceVersion: manifest.sourceVersion,
      topologyVersion: manifest.topologyVersion,
    });
    const result = await runProductionQualification(
      {
        ARTIFACTS: bucket,
        QUALIFICATION_OWNER: {
          fetch: async () => {
            const completion = await retainQualificationDistributedEvaluationReport(bucket, report);
            if (tamperMetadata) {
              const current = metadata.get(report.artifactId);
              if (current === undefined) throw new Error("Expected report metadata fixture");
              metadata.set(report.artifactId, {
                ...current,
                customMetadata: {
                  ...current.customMetadata,
                  "osfo-source-version": "substituted",
                },
              });
            }
            return Response.json(
              {
                completionArtifactId: completion.artifactId,
                completionChecksum: completion.checksum,
                error: "qualificationAuthorityMaterialMissing",
                executionId: plan.executionId,
                failingFamilies: [],
                manifestChecksum: manifest.manifestChecksum,
                missingFamilies: report.families
                  .filter(({ verdict }) => verdict === "MISSING")
                  .map(({ family }) => family),
                phase: "PRE_TEARDOWN",
                planChecksum: plan.planChecksum,
                reportArtifactId: report.artifactId,
                reportChecksum: report.checksum,
                verdict: "MISSING",
                version: "qualification-owner-response-v2",
              },
              { status: 424 },
            );
          },
        },
      },
      manifest,
      plan,
    );

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: tamperMetadata
            ? "productionQualificationOwnerConflict"
            : "productionQualificationDistributedReportMissing",
        }),
      ]),
      verdict: tamperMetadata ? "FAIL" : "MISSING",
    });
    expect(listCallCount()).toBe(0);
  },
);

it("rejects a self-authentic completion whose family counts disagree with the report", async () => {
  const manifest = compactManifest();
  const plan = createQualificationExecutionPlan(manifest, 0, "altered-completion-counts");
  const storage = memoryBucket();
  retainCohort(storage.retained, manifest, plan);
  const report = qualificationDistributedEvaluationReport({
    acceptanceLevel: manifest.acceptanceLevel,
    correctness: { reason: "qualificationCorrectnessMissing", verdict: "MISSING" },
    dimensions: { reason: "correctness_prerequisite_missing", verdict: "MISSING" },
    executionId: plan.executionId,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    sourceVersion: manifest.sourceVersion,
    topologyVersion: manifest.topologyVersion,
  });
  const result = await runProductionQualification(
    {
      ARTIFACTS: storage.bucket,
      QUALIFICATION_OWNER: {
        fetch: async () => {
          const completion = await retainQualificationDistributedEvaluationReport(
            storage.bucket,
            report,
          );
          const { checksum: _, ...originalContent } = completion;
          const content = {
            ...originalContent,
            missingFamilyCount: completion.missingFamilyCount + 1,
          };
          const altered = { ...content, checksum: qualificationChecksum(content) };
          const encoded = canonicalQualificationJson(altered);
          storage.retained.set(altered.artifactId, encoded);
          storage.metadata.set(altered.artifactId, {
            customMetadata: {
              "osfo-artifact-checksum": altered.checksum,
              "osfo-body-sha256": await sha256Hex(encoded),
              "osfo-execution-id": altered.executionId,
              "osfo-kind": "qualification-distributed-evaluation-report-completion-v1",
              "osfo-manifest-checksum": altered.manifestChecksum,
              "osfo-plan-checksum": altered.planChecksum,
              "osfo-report-checksum": altered.reportChecksum,
              "osfo-verdict": altered.verdict,
            },
            httpMetadata: { contentType: "application/json" },
          });
          return Response.json(
            {
              completionArtifactId: altered.artifactId,
              completionChecksum: altered.checksum,
              error: "qualificationAuthorityMaterialMissing",
              executionId: plan.executionId,
              failingFamilies: [],
              manifestChecksum: manifest.manifestChecksum,
              missingFamilies: report.families
                .filter(({ verdict }) => verdict === "MISSING")
                .map(({ family }) => family),
              phase: "PRE_TEARDOWN",
              planChecksum: plan.planChecksum,
              reportArtifactId: report.artifactId,
              reportChecksum: report.checksum,
              verdict: "MISSING",
              version: "qualification-owner-response-v2",
            },
            { status: 424 },
          );
        },
      },
    },
    manifest,
    plan,
  );

  expect(result).toMatchObject({
    findings: expect.arrayContaining([
      expect.objectContaining({ code: "productionQualificationOwnerConflict" }),
    ]),
    verdict: "FAIL",
  });
  expect(storage.listCallCount()).toBe(0);
});

it.each(["valid", "missing", "metadata", "crossExecution"] as const)(
  "authenticates the compact dimension reference without listing: %s",
  async (scenario) => {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, `distributed-reference-${scenario}`);
    const storage = memoryBucket();
    retainCohort(storage.retained, manifest, plan);
    const artifactId = `qualification/executions/${plan.executionId}/dimensions/completion.json`;
    const dimension = await retainDimensionReference(storage, {
      artifactId,
      executionId: scenario === "crossExecution" ? "other-execution" : plan.executionId,
      planChecksum: plan.planChecksum,
    });
    if (scenario === "missing") {
      storage.retained.delete(artifactId);
      storage.metadata.delete(artifactId);
    }
    if (scenario === "metadata") {
      const current = storage.metadata.get(artifactId);
      if (current === undefined) throw new Error("Expected dimension metadata fixture");
      storage.metadata.set(artifactId, {
        ...current,
        customMetadata: { ...current.customMetadata, "osfo-record-count": "1" },
      });
    }
    const report = qualificationDistributedEvaluationReport({
      acceptanceLevel: manifest.acceptanceLevel,
      correctness: { reason: "qualificationCorrectnessMissing", verdict: "MISSING" },
      dimensions: {
        artifactId,
        checksum: dimension.checksum,
        dimensionCount: 0,
        failCount: 0,
        missingCount: 0,
        verdict: "PASS",
      },
      executionId: plan.executionId,
      manifestChecksum: manifest.manifestChecksum,
      planChecksum: plan.planChecksum,
      sourceVersion: manifest.sourceVersion,
      topologyVersion: manifest.topologyVersion,
    });
    const result = await runProductionQualification(
      {
        ARTIFACTS: storage.bucket,
        QUALIFICATION_OWNER: {
          fetch: async () => {
            const completion = await retainQualificationDistributedEvaluationReport(
              storage.bucket,
              report,
            );
            return Response.json(
              {
                completionArtifactId: completion.artifactId,
                completionChecksum: completion.checksum,
                error: "qualificationAuthorityMaterialMissing",
                executionId: plan.executionId,
                failingFamilies: [],
                manifestChecksum: manifest.manifestChecksum,
                missingFamilies: report.families
                  .filter(({ verdict }) => verdict === "MISSING")
                  .map(({ family }) => family),
                phase: "PRE_TEARDOWN",
                planChecksum: plan.planChecksum,
                reportArtifactId: report.artifactId,
                reportChecksum: report.checksum,
                verdict: "MISSING",
                version: "qualification-owner-response-v2",
              },
              { status: 424 },
            );
          },
        },
      },
      manifest,
      plan,
    );

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code:
            scenario === "valid"
              ? "productionQualificationDistributedReportMissing"
              : scenario === "missing"
                ? "productionQualificationOwnerUnavailable"
                : "productionQualificationOwnerConflict",
        }),
      ]),
      verdict: scenario === "valid" || scenario === "missing" ? "MISSING" : "FAIL",
    });
    expect(storage.listCallCount()).toBe(0);
  },
);

it.each(["valid", "missing", "metadata", "crossExecution"] as const)(
  "authenticates the compact correctness reference without listing: %s",
  async (scenario) => {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(
      manifest,
      0,
      `distributed-correctness-reference-${scenario}`,
    );
    const storage = memoryBucket();
    retainCohort(storage.retained, manifest, plan);
    const artifactId = `qualification/executions/${plan.executionId}/correctness/receipt.json`;
    const correctness = await retainCorrectnessReference(storage, {
      artifactId,
      executionId: scenario === "crossExecution" ? "other-execution" : plan.executionId,
      planChecksum: plan.planChecksum,
    });
    if (scenario === "missing") {
      storage.retained.delete(artifactId);
      storage.metadata.delete(artifactId);
    }
    if (scenario === "metadata") {
      const current = storage.metadata.get(artifactId);
      if (current === undefined) throw new Error("Expected correctness metadata fixture");
      storage.metadata.set(artifactId, {
        ...current,
        customMetadata: { ...current.customMetadata, "osfo-record-count": "1" },
      });
    }
    const report = qualificationDistributedEvaluationReport({
      acceptanceLevel: manifest.acceptanceLevel,
      correctness: {
        acceptedCount: 0,
        artifactId,
        checksum: correctness.checksum,
        failCount: 0,
        missingCount: 0,
        rootCount: 0,
        verdict: "PASS",
      },
      dimensions: { reason: "dimension_authority_missing", verdict: "MISSING" },
      executionId: plan.executionId,
      manifestChecksum: manifest.manifestChecksum,
      planChecksum: plan.planChecksum,
      sourceVersion: manifest.sourceVersion,
      topologyVersion: manifest.topologyVersion,
    });
    const result = await runProductionQualification(
      {
        ARTIFACTS: storage.bucket,
        QUALIFICATION_OWNER: {
          fetch: async () => {
            const completion = await retainQualificationDistributedEvaluationReport(
              storage.bucket,
              report,
            );
            return Response.json(
              {
                completionArtifactId: completion.artifactId,
                completionChecksum: completion.checksum,
                error: "qualificationAuthorityMaterialMissing",
                executionId: plan.executionId,
                failingFamilies: [],
                manifestChecksum: manifest.manifestChecksum,
                missingFamilies: report.families
                  .filter(({ verdict }) => verdict === "MISSING")
                  .map(({ family }) => family),
                phase: "PRE_TEARDOWN",
                planChecksum: plan.planChecksum,
                reportArtifactId: report.artifactId,
                reportChecksum: report.checksum,
                verdict: "MISSING",
                version: "qualification-owner-response-v2",
              },
              { status: 424 },
            );
          },
        },
      },
      manifest,
      plan,
    );

    expect(result).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          code:
            scenario === "valid"
              ? "productionQualificationDistributedReportMissing"
              : scenario === "missing"
                ? "productionQualificationOwnerUnavailable"
                : "productionQualificationOwnerConflict",
        }),
      ]),
      verdict: scenario === "valid" || scenario === "missing" ? "MISSING" : "FAIL",
    });
    expect(storage.listCallCount()).toBe(0);
  },
);

it("returns an authenticated distributed FAIL ahead of missing report families", async () => {
  const manifest = compactManifest();
  const plan = createQualificationExecutionPlan(manifest, 0, "distributed-fail-report");
  const { bucket, retained } = memoryBucket();
  retainCohort(retained, manifest, plan);
  const report = qualificationDistributedEvaluationReport({
    acceptanceLevel: manifest.acceptanceLevel,
    correctness: { reason: "correctness_conflict", verdict: "FAIL" },
    dimensions: { reason: "correctness_prerequisite_failed", verdict: "MISSING" },
    executionId: plan.executionId,
    manifestChecksum: manifest.manifestChecksum,
    planChecksum: plan.planChecksum,
    sourceVersion: manifest.sourceVersion,
    topologyVersion: manifest.topologyVersion,
  });
  const result = await runProductionQualification(
    {
      ARTIFACTS: bucket,
      QUALIFICATION_OWNER: {
        fetch: async () => {
          const completion = await retainQualificationDistributedEvaluationReport(bucket, report);
          return Response.json(
            {
              completionArtifactId: completion.artifactId,
              completionChecksum: completion.checksum,
              error: "qualificationAuthorityConflict",
              executionId: plan.executionId,
              failingFamilies: ["forest_correctness"],
              manifestChecksum: manifest.manifestChecksum,
              missingFamilies: report.families
                .filter(({ verdict }) => verdict === "MISSING")
                .map(({ family }) => family),
              phase: "PRE_TEARDOWN",
              planChecksum: plan.planChecksum,
              reportArtifactId: report.artifactId,
              reportChecksum: report.checksum,
              verdict: "FAIL",
              version: "qualification-owner-response-v2",
            },
            { status: 409 },
          );
        },
      },
    },
    manifest,
    plan,
  );

  expect(result).toMatchObject({
    findings: expect.arrayContaining([
      expect.objectContaining({
        code: "productionQualificationDistributedReportFailed",
        detail: expect.stringContaining("forest_correctness"),
      }),
    ]),
    verdict: "FAIL",
  });
});
