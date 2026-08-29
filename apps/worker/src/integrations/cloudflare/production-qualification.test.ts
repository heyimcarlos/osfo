/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generator-backed tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { compactManifest, manifestVersions } from "../../../test/support/qualification-fixtures";
import {
  createQualificationExecutionPlan,
  qualificationRunArrivals,
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
import type { QualificationExecutionBucket } from "./qualification-execution-artifacts";
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
const publicArrivalStream = {
  chunkCount: 6_838,
  manifestChecksum: "sha256:378ad7626f9c5f785de17a98f93cfa5d4df5980263a39036e63fbb514ac54bb2",
  planChecksum: "sha256:8a4ad3607141baceb77e5bbdded891fa3da1ccd7acd343609e2c09fd25c4a74d",
  recordCount: 1_750_422,
  terminalChecksum: "sha256:4325b633e7cffb5e9eb4deb6cbb90321a212f0475b9b5ac3b83d57a270e6a757",
} as const;

const memoryBucket = () => {
  const retained = new Map<string, string>();
  const bucket = {
    get: (key: string) =>
      Promise.resolve(
        retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
      ),
    put: (key: string, value: string) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, value);
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  } satisfies QualificationExecutionBucket;
  return { bucket, retained };
};

const retainedOwner = (
  retained: Map<string, string>,
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
  tamper: "reportInput" | "terminalChecksum" | null = null,
) => ({
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
      const canonicalDigest = qualificationChecksum({ component, executionId, planChecksum });
      return {
        artifactPrefix,
        canonicalDigest,
        chunkCount: Math.ceil(recordCount / 256),
        component,
        recordCount,
        sourceVersion: manifest.sourceVersion,
        terminalChecksum:
          tamper === "terminalChecksum" && component === "arrivals"
            ? "sha256:tampered"
            : canonicalDigest,
        verificationVersion: "qualification-owner-stream-v1" as const,
      };
    });
    const retainedEvaluationInputChecksum = qualificationChecksum({
      authoritySources,
      executionId,
      manifestChecksum,
      planChecksum,
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
});

const lazyPublicOwner = (
  manifest: ProductionQualificationManifest,
  plan: QualificationExecutionPlan,
) => {
  const retained = new Map<string, string>();
  const arrivalPrefix = `qualification/executions/${plan.executionId}/authority-streams/arrivals`;
  const arrivalRecords = function* () {
    for (const run of plan.runs) {
      for (const arrival of qualificationRunArrivals(manifest, run)) {
        yield {
          attemptId: qualificationChecksum({
            executionId: plan.executionId,
            rootId: arrival.rootId,
            runId: run.runId,
          }),
          authorityFactId: `worker-admission:${arrival.rootId}`,
          executionId: plan.executionId,
          rootId: arrival.rootId,
          runId: run.runId,
        };
      }
    }
  };
  const chunk = (
    component: (typeof components)[number],
    index: number,
    previousArtifactChecksum: string | null,
    records: ReadonlyArray<object>,
  ) => {
    const encodedRecords = canonicalQualificationJson(records);
    const content = {
      component,
      encodedRecords,
      executionId: plan.executionId,
      index,
      planChecksum: plan.planChecksum,
      previousArtifactChecksum,
      recordCount: records.length,
      recordsChecksum: qualificationChecksum({ records }),
      sourceVersion: manifest.sourceVersion,
    };
    const artifactChecksum = qualificationChecksum(content);
    return {
      artifactChecksum,
      encoded: canonicalQualificationJson({ ...content, artifactChecksum }),
    };
  };
  let readSource = arrivalRecords();
  let readChunkIndex = 0;
  let readPreviousChecksum: string | null = null;
  const nextArrivalChunk = () => {
    const records = [];
    while (records.length < 256) {
      const next = readSource.next();
      if (next.done) break;
      records.push(next.value);
    }
    return records.length === 0
      ? null
      : chunk("arrivals", readChunkIndex, readPreviousChecksum, records);
  };
  const bucket = {
    get: (key: string) => {
      const staticValue = retained.get(key);
      if (staticValue !== undefined) {
        return Promise.resolve({ text: () => Promise.resolve(staticValue) });
      }
      const expectedKey = `${arrivalPrefix}/${readChunkIndex}.json`;
      if (key !== expectedKey) return Promise.resolve(null);
      const generated = nextArrivalChunk();
      if (generated === null) return Promise.resolve(null);
      readPreviousChecksum = generated.artifactChecksum;
      readChunkIndex += 1;
      return Promise.resolve({ text: () => Promise.resolve(generated.encoded) });
    },
    put: (key: string, value: string) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, value);
      return Promise.resolve({ etag: qualificationChecksum({ value }) });
    },
  } satisfies QualificationExecutionBucket;
  const owner = {
    fetch: () => {
      const recordsFor = (component: (typeof components)[number]): ReadonlyArray<object> =>
        component === "faults"
          ? plan.runs.flatMap((run) =>
              run.fault === null
                ? []
                : [
                    {
                      applicationAuthorityFactId: `fault-applied:${run.runId}`,
                      kind: run.fault.kind,
                      restorationAuthorityFactId: `fault-restored:${run.runId}`,
                      runId: run.runId,
                    },
                  ],
            )
          : component === "runs"
            ? plan.runs.map(({ runId }) => ({ runId }))
            : component === "externalGates"
              ? manifest.requiredExternalGates.map((gate) => ({ gate }))
              : [{ authorityFactId: `${component}-authority-fact` }];
      const streams = components.map((component) => {
        if (component !== "arrivals") {
          const records = recordsFor(component);
          const retainedChunk = chunk(component, 0, null, records);
          const artifactPrefix = `qualification/executions/${plan.executionId}/authority-streams/${component}`;
          retained.set(`${artifactPrefix}/0.json`, retainedChunk.encoded);
          return {
            artifactPrefix,
            canonicalDigest: retainedChunk.artifactChecksum,
            chunkCount: 1,
            component,
            recordCount: records.length,
            sourceVersion: manifest.sourceVersion,
            terminalChecksum: retainedChunk.artifactChecksum,
            verificationVersion: "qualification-owner-stream-v1" as const,
          };
        }
        if (
          plan.planChecksum !== publicArrivalStream.planChecksum ||
          manifest.manifestChecksum !== publicArrivalStream.manifestChecksum
        ) {
          throw new Error("The frozen public stream digest no longer matches the public fixture");
        }
        readSource = arrivalRecords();
        readChunkIndex = 0;
        readPreviousChecksum = null;
        return {
          artifactPrefix: arrivalPrefix,
          canonicalDigest: publicArrivalStream.terminalChecksum,
          chunkCount: publicArrivalStream.chunkCount,
          component,
          recordCount: publicArrivalStream.recordCount,
          sourceVersion: manifest.sourceVersion,
          terminalChecksum: publicArrivalStream.terminalChecksum,
          verificationVersion: "qualification-owner-stream-v1" as const,
        };
      });
      const evaluationInputChecksum = qualificationChecksum({
        authoritySources,
        executionId: plan.executionId,
        manifestChecksum: manifest.manifestChecksum,
        planChecksum: plan.planChecksum,
        streams,
      });
      const report = {
        adventurerContributionMargin: 0.75,
        costSummaries: [],
        evaluationInputChecksum,
        executionId: plan.executionId,
        findings: [],
        foreignExchangeUsdMicros: "0",
        freeCostPerActivePeriodUsdMicros: "0",
        manifestChecksum: manifest.manifestChecksum,
        planChecksum: plan.planChecksum,
        recoveryReservePerSecond: 2,
        stageSummaries: [],
        taxesUsdMicros: "0",
        verdict: "PASS",
      };
      const encodedReport = canonicalQualificationJson(report);
      const reportArtifactId = `qualification/executions/${plan.executionId}/report.json`;
      retained.set(reportArtifactId, encodedReport);
      const content = {
        authoritySources,
        evaluatorVersion: "production-qualification-v1" as const,
        executionId: plan.executionId,
        manifestChecksum: manifest.manifestChecksum,
        ownerIdentity: "osfo-qualification-owner-v1" as const,
        planChecksum: plan.planChecksum,
        reportArtifactChecksum: qualificationChecksum({ encodedReport }),
        reportArtifactId,
        streams,
      };
      const artifactChecksum = qualificationChecksum(content);
      const bundleArtifactId = `qualification/executions/${plan.executionId}/bundle.json`;
      retained.set(bundleArtifactId, canonicalQualificationJson({ ...content, artifactChecksum }));
      return Promise.resolve(
        Response.json({
          bundleArtifactChecksum: artifactChecksum,
          bundleArtifactId,
          executionId: plan.executionId,
          manifestChecksum: manifest.manifestChecksum,
          planChecksum: plan.planChecksum,
        }),
      );
    },
  };
  return { arrivalReadCount: () => readChunkIndex, bucket, owner };
};

it.effect("reports the exact missing bounded owner binding", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "production-composition-test");
    const { bucket } = memoryBucket();
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
    const { bucket, retained } = memoryBucket();
    const owner = retainedOwner(retained, manifest, plan);
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
    expect([...retained.keys()].filter((key) => key.includes("authority-streams"))).toHaveLength(0);
  }),
);

it.effect("fails when a retained authority stream chain conflicts", () =>
  Effect.gen(function* () {
    const manifest = compactManifest();
    const plan = createQualificationExecutionPlan(manifest, 0, "tampered-owner-test");
    const { bucket, retained } = memoryBucket();
    const owner = retainedOwner(retained, manifest, plan, "terminalChecksum");
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
    const { bucket, retained } = memoryBucket();
    const owner = retainedOwner(retained, manifest, plan, "reportInput");
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
  "accepts the external owner's compact proof for the 1.75m-root public corpus",
  () =>
    Effect.gen(function* () {
      const manifest = createScaleQualifiedPublicManifest(manifestVersions);
      const plan = createQualificationExecutionPlan(manifest, 0, "public-lazy-owner-test");
      const { arrivalReadCount, bucket, owner } = lazyPublicOwner(manifest, plan);
      const report = yield* Effect.promise(() =>
        runProductionQualification(
          { ARTIFACTS: bucket, QUALIFICATION_OWNER: owner },
          manifest,
          plan,
        ),
      );

      expect(plan.runs.reduce((total, run) => total + run.arrivalCount, 0)).toBe(1_750_422);
      expect(arrivalReadCount()).toBe(0);
      expect(report.verdict).toBe("PASS");
    }),
  120_000,
);
