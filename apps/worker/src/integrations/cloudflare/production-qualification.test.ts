/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generator-backed tests. */
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
  const listed = new Map<string, QualificationExecutionListedObject>();
  const bucket = {
    get: (key: string) =>
      Promise.resolve(
        retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
      ),
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
    put: (key: string, value: string) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, value);
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  } satisfies QualificationExecutionListingBucket;
  return { bucket, listed, retained };
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
