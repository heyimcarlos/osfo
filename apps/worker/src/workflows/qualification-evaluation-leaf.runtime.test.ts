/* oxlint-disable effecttsgo/async-function -- Runtime fakes model Promise-native Workflow and R2 boundaries. */
import { Schema } from "effect";
import { expect, it } from "vitest";

import { manifestVersions } from "../../test/support/qualification-fixtures";
import { qualificationAuthoritySources } from "../qualification/authority-sources";
import { createQualificationExecutionPlan } from "../qualification/execution";
import {
  QualificationEvaluationLeafReceipt,
  type QualificationEvaluationLeafOutcome,
} from "../qualification/qualification-evaluation-leaf";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { createBoundedBetaManifest } from "../qualification/qualification-manifest";
import type { QualificationEvaluationLeafWorkflowPayload } from "../workflow-contracts";
import {
  QualificationEvaluationLeafCompletion,
  QualificationEvaluationLeafCompletionConflict,
  runQualificationEvaluationLeafWorkflow,
} from "./qualification-evaluation-leaf";

const manifest = createBoundedBetaManifest(manifestVersions);
const plan = createQualificationExecutionPlan(manifest, 0, "leaf-workflow");
const run = plan.runs[0];
if (run === undefined) throw new Error("Expected qualification run");

const ownerRequest = (manifestValue: typeof manifest = manifest, planValue: typeof plan = plan) => {
  const content = {
    authoritySources: qualificationAuthoritySources,
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: `qualification/executions/${plan.executionId}/cohort.json`,
    executionId: plan.executionId,
    manifest: manifestValue,
    manifestChecksum: manifest.manifestChecksum,
    plan: planValue,
    planChecksum: plan.planChecksum,
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  return { ...content, artifactChecksum: qualificationChecksum(content) };
};

const request = ownerRequest();
const requestArtifactId = `qualification/executions/${plan.executionId}/owner-request.json`;

const payload: QualificationEvaluationLeafWorkflowPayload = {
  executionId: plan.executionId,
  leafInputArtifactId: `qualification/executions/${plan.executionId}/evaluation-leaf-inputs/00000000.json`,
  leafInputChecksum: "leaf-input-checksum",
  manifestChecksum: manifest.manifestChecksum,
  partitionIndex: 0,
  planChecksum: plan.planChecksum,
  requestArtifactChecksum: request.artifactChecksum,
  requestArtifactId,
  runId: run.runId,
};

const completeReceipt = () => {
  const content = {
    artifactId: `qualification/executions/${plan.executionId}/evaluation-leaves/00000000/receipt.json`,
    dimensions: [],
    executionId: plan.executionId,
    failCount: "0",
    findingExemplars: [],
    findingFirstShardChecksum: "ZERO",
    findingShardCount: "0",
    findingShardPrefix: `qualification/executions/${plan.executionId}/evaluation-leaves/00000000/findings`,
    findingTerminalShardChecksum: "ZERO",
    leafInputChecksum: payload.leafInputChecksum,
    missingCount: "0",
    partitionIndex: 0,
    planChecksum: plan.planChecksum,
    rootAccumulatorChecksum: "root-checksum",
    rootAccumulatorId: `qualification/executions/${plan.executionId}/evaluation-leaves/00000000/roots.json`,
    rootCount: "1",
    streamChunkIndex: 0,
    verdict: "PASS" as const,
    version: "qualification-evaluation-leaf-v1" as const,
  };
  return Schema.decodeSync(QualificationEvaluationLeafReceipt)({
    ...content,
    checksum: qualificationChecksum(content),
  });
};

const workflowRuntime = (options: {
  readonly crashAfterStep?: string;
  readonly outcome: QualificationEvaluationLeafOutcome;
  readonly retainedRequest?: ReturnType<typeof ownerRequest>;
}) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const authoritativeRequest = options.retainedRequest ?? request;
  retained.set(requestArtifactId, {
    customMetadata: { "osfo-kind": "qualification-execution-v1" },
    value: canonicalQualificationJson(authoritativeRequest),
  });
  const workflowPayload = {
    ...payload,
    requestArtifactChecksum: authoritativeRequest.artifactChecksum,
  };
  let crashAfterStep = options.crashAfterStep;
  let evaluations = 0;
  const bucket = {
    get: (key: string) => {
      const object = retained.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : {
              customMetadata: object.customMetadata,
              text: () => Promise.resolve(object.value),
            },
      );
    },
    put: (
      key: string,
      value: string,
      putOptions: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: putOptions.customMetadata ?? {}, value });
      return Promise.resolve({ etag: key });
    },
  };
  const step = {
    do: async <Value>(name: string, callback: () => Promise<Value>): Promise<Value> => {
      const result = await callback();
      if (crashAfterStep !== undefined && name.includes(crashAfterStep)) {
        crashAfterStep = undefined;
        throw new Error(`lost Workflow result after ${name}`);
      }
      return result;
    },
  };
  const runWorkflow = () =>
    runQualificationEvaluationLeafWorkflow({
      env: { ARTIFACTS: bucket },
      payload: workflowPayload,
      ports: {
        evaluate: () => {
          evaluations += 1;
          return Promise.resolve(options.outcome);
        },
      },
      step,
    });
  return { evaluations: () => evaluations, retained, runWorkflow };
};

it("retains byte-identical bounded COMPLETE, MISSING, and FAIL envelopes", async () => {
  const outcomes: ReadonlyArray<QualificationEvaluationLeafOutcome> = [
    { receipt: completeReceipt(), status: "COMPLETE" },
    {
      artifactId: payload.leafInputArtifactId,
      code: "qualificationEvaluationLeafInputMissing",
      source: null,
      status: "MISSING",
    },
    {
      artifactId: payload.leafInputArtifactId,
      code: "qualificationEvaluationLeafInputConflict",
      source: null,
      status: "FAIL",
    },
  ];
  await Promise.all(
    outcomes.map(async (outcome) => {
      const runtime = workflowRuntime({ outcome });
      const first = await runtime.runWorkflow();
      const second = await runtime.runWorkflow();
      expect(second).toEqual(first);
      expect(first.outcome).toEqual(outcome);
      const retained = runtime.retained.get(first.artifactId);
      expect(retained?.value).toBe(canonicalQualificationJson(first));
      expect(
        Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationLeafCompletion))(
          retained?.value ?? "",
        ),
      ).toEqual(first);
    }),
  );
});

it("replays evaluation after its durable result is lost before completion retention", async () => {
  const runtime = workflowRuntime({
    crashAfterStep: "evaluate qualification leaf",
    outcome: { receipt: completeReceipt(), status: "COMPLETE" },
  });
  await expect(runtime.runWorkflow()).rejects.toThrow("lost Workflow result");
  const replay = await runtime.runWorkflow();
  expect(replay.outcome.status).toBe("COMPLETE");
  expect(runtime.evaluations()).toBe(2);
  expect(runtime.retained).toHaveLength(2);
});

it("replays an identical completion after its conditional put response is lost", async () => {
  const runtime = workflowRuntime({
    crashAfterStep: "retain qualification leaf completion",
    outcome: { receipt: completeReceipt(), status: "COMPLETE" },
  });
  await expect(runtime.runWorkflow()).rejects.toThrow("lost Workflow result");
  expect(runtime.retained).toHaveLength(2);
  const replay = await runtime.runWorkflow();
  expect(replay.outcome.status).toBe("COMPLETE");
  expect(runtime.retained).toHaveLength(2);
});

it("surfaces a conflicting terminal envelope as a Workflow failure", async () => {
  const runtime = workflowRuntime({
    outcome: { receipt: completeReceipt(), status: "COMPLETE" },
  });
  const first = await runtime.runWorkflow();
  const retained = runtime.retained.get(first.artifactId);
  if (retained === undefined) throw new Error("Expected retained completion");
  runtime.retained.set(first.artifactId, { ...retained, value: `${retained.value} ` });
  await expect(runtime.runWorkflow()).rejects.toBeInstanceOf(
    QualificationEvaluationLeafCompletionConflict,
  );
});

it("rejects a self-checksummed manifest that differs from server-owned policy", async () => {
  const tamperedManifest = { ...manifest, workloadSeed: manifest.workloadSeed + 1 };
  const runtime = workflowRuntime({
    outcome: { receipt: completeReceipt(), status: "COMPLETE" },
    retainedRequest: ownerRequest(tamperedManifest, plan),
  });
  const completion = await runtime.runWorkflow();
  expect(completion.outcome).toMatchObject({
    code: "qualificationEvaluationOwnerRequestConflict",
    status: "FAIL",
  });
  expect(runtime.evaluations()).toBe(0);
});

it("rejects a self-checksummed plan whose frozen run was substituted", async () => {
  const tamperedPlan = {
    ...plan,
    runs: [{ ...run, seed: run.seed + 1 }, ...plan.runs.slice(1)],
  };
  const runtime = workflowRuntime({
    outcome: { receipt: completeReceipt(), status: "COMPLETE" },
    retainedRequest: ownerRequest(manifest, tamperedPlan),
  });
  const completion = await runtime.runWorkflow();
  expect(completion.outcome).toMatchObject({
    code: "qualificationEvaluationOwnerRequestConflict",
    status: "FAIL",
  });
  expect(runtime.evaluations()).toBe(0);
});
