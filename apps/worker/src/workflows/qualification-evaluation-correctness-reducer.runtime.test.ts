/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Runtime fakes model Promise-native Workflow/R2 boundaries and build predecessor-linked artifacts sequentially. */
import { expect, it } from "vitest";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationEvaluationCorrectnessReducerWorkflowPayload } from "../workflow-contracts";
import { runQualificationEvaluationCorrectnessReducer } from "./qualification-evaluation-correctness-reducer";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const rootRecord = (rootId: string) => ({
  activation: null,
  correlations: [],
  decision: "accepted" as const,
  journey: "ordinaryConversation" as const,
  plan: "free" as const,
  productFactChecksum: `${rootId}-facts`,
  productFactCount: "1",
  rootId,
  terminalState: "succeeded" as const,
});

const runtime = async (options?: {
  readonly closedOutcomes?: readonly ["FAIL" | "MISSING" | null, "FAIL" | "MISSING" | null];
  readonly failFirstOutputPut?: boolean;
  readonly maximumFindings?: boolean;
  readonly partitionIndices?: readonly [number, number];
  readonly rootIds?: readonly [string, string];
  readonly rootCount?: string;
  readonly acceptedCount?: string;
}) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  const executionId = "correctness-execution";
  const planChecksum = "correctness-plan";
  const store = async (
    artifactId: string,
    body: { readonly checksum: string },
    kind: string,
    metadata: Record<string, string>,
  ) => {
    const encoded = canonicalQualificationJson(body);
    retained.set(artifactId, {
      customMetadata: {
        "osfo-artifact-checksum": body.checksum,
        "osfo-body-sha256": await sha256Hex(encoded),
        "osfo-execution-id": executionId,
        "osfo-kind": kind,
        "osfo-plan-checksum": planChecksum,
        ...metadata,
      },
      value: encoded,
    });
  };
  const inputs: Array<{ readonly artifactId: string; readonly checksum: string }> = [];
  let totalAcceptedCount = 0;
  let totalRootCount = 0;
  for (const [position, rootId] of (options?.rootIds ?? ["root-a", "root-b"]).entries()) {
    const partitionIndex = options?.partitionIndices?.[position] ?? position;
    const prefix = `qualification/executions/${executionId}/evaluation-leaves/${partitionIndex
      .toString()
      .padStart(8, "0")}`;
    const closedStatus = options?.closedOutcomes?.[position] ?? null;
    if (closedStatus !== null) {
      const completionContent = {
        artifactId: `qualification/executions/${executionId}/evaluation-leaf-completions/${partitionIndex
          .toString()
          .padStart(8, "0")}.json`,
        executionId,
        leafInputArtifactId: `leaf-input/${partitionIndex}.json`,
        leafInputChecksum: `leaf-input-${partitionIndex}`,
        manifestChecksum: "manifest",
        outcome: {
          artifactId: `authority/${partitionIndex}.json`,
          code:
            closedStatus === "FAIL"
              ? ("qualificationEvaluationAuthorityConflict" as const)
              : ("qualificationEvaluationAuthorityMissing" as const),
          source: "worker_admission_receipts" as const,
          status: closedStatus,
        },
        partitionIndex,
        planChecksum,
        runId: `run-${partitionIndex}`,
        version: "qualification-evaluation-leaf-completion-v1" as const,
      };
      const completion = {
        ...completionContent,
        checksum: qualificationChecksum(completionContent),
      };
      await store(
        completion.artifactId,
        completion,
        "qualification-evaluation-leaf-completion-v1",
        {
          "osfo-leaf-input-checksum": completion.leafInputChecksum,
          "osfo-outcome": closedStatus,
          "osfo-partition-index": String(partitionIndex),
          "osfo-record-count": "0",
          "osfo-run-id": completion.runId,
        },
      );
      inputs.push({ artifactId: completion.artifactId, checksum: completion.checksum });
      continue;
    }
    const partitionRoots =
      options?.maximumFindings === true && position === 0
        ? Array.from({ length: 256 }, (_, index) => `root-a-${index.toString().padStart(8, "0")}`)
        : [rootId];
    const retainedRootCount = options?.rootCount ?? String(partitionRoots.length);
    const retainedAcceptedCount = options?.acceptedCount ?? String(partitionRoots.length);
    totalRootCount += partitionRoots.length;
    totalAcceptedCount += partitionRoots.length;
    const rootContent = {
      acceptedCount: retainedAcceptedCount,
      artifactId: `${prefix}/roots.json`,
      executionId,
      partitionIndex,
      planChecksum,
      rootCount: retainedRootCount,
      roots: partitionRoots.map(rootRecord),
      version: "qualification-evaluation-leaf-roots-v1" as const,
    };
    const roots = { ...rootContent, checksum: qualificationChecksum(rootContent) };
    await store(roots.artifactId, roots, "qualification-evaluation-leaf-roots-v1", {
      "osfo-record-count": retainedRootCount,
    });
    const findingCount = options?.maximumFindings === true && position === 0 ? 32_768 : 1;
    const findingShardCount = Math.ceil(findingCount / 256);
    const findingExemplars: Array<{
      readonly code: string;
      readonly detail: string;
      readonly subject: string;
      readonly verdict: "FAIL" | "MISSING";
    }> = [];
    let findingFirstShardChecksum = "ZERO";
    let findingTerminalShardChecksum = "NONE";
    for (let index = 0; index < findingShardCount; index += 1) {
      const shardCount = Math.min(256, findingCount - index * 256);
      const retainedFindings = Array.from({ length: shardCount }, (_, offset) => ({
        code: `${position === 0 ? "terminalFailure" : "authorityMissing"}:${(index * 256 + offset).toString().padStart(8, "0")}`,
        detail: position === 0 ? "root failed" : "authority missing",
        subject: partitionRoots[(index * 256 + offset) % partitionRoots.length] ?? rootId,
        verdict: position === 0 ? ("FAIL" as const) : ("MISSING" as const),
      }));
      findingExemplars.push(
        ...retainedFindings.slice(0, Math.max(0, 32 - findingExemplars.length)),
      );
      const findingContent = {
        artifactId: `${prefix}/findings/${index.toString().padStart(8, "0")}.json`,
        executionId,
        findings: retainedFindings,
        index,
        partitionIndex,
        planChecksum,
        previousShardChecksum: findingTerminalShardChecksum,
        version: "qualification-evaluation-leaf-findings-v1" as const,
      };
      const findings = { ...findingContent, checksum: qualificationChecksum(findingContent) };
      await store(findings.artifactId, findings, "qualification-evaluation-leaf-findings-v1", {
        "osfo-index": String(index),
        "osfo-previous-checksum": findingTerminalShardChecksum,
        "osfo-record-count": String(retainedFindings.length),
      });
      if (index === 0) findingFirstShardChecksum = findings.checksum;
      findingTerminalShardChecksum = findings.checksum;
    }
    const leafContent = {
      artifactId: `${prefix}/receipt.json`,
      dimensions: [],
      executionId,
      failCount: position === 0 ? String(findingCount) : "0",
      findingExemplars,
      findingFirstShardChecksum,
      findingShardCount: String(findingShardCount),
      findingShardPrefix: `${prefix}/findings`,
      findingTerminalShardChecksum,
      leafInputChecksum: `leaf-input-${partitionIndex}`,
      missingCount: position === 0 ? "0" : String(findingCount),
      partitionIndex,
      planChecksum,
      rootAccumulatorChecksum: roots.checksum,
      rootAccumulatorId: roots.artifactId,
      rootCount: retainedRootCount,
      streamChunkIndex: partitionIndex,
      verdict: position === 0 ? ("FAIL" as const) : ("MISSING" as const),
      version: "qualification-evaluation-leaf-v1" as const,
    };
    const leaf = { ...leafContent, checksum: qualificationChecksum(leafContent) };
    await store(leaf.artifactId, leaf, "qualification-evaluation-leaf-v1", {
      "osfo-record-count": "0",
      "osfo-verdict": leaf.verdict,
    });
    const completionContent = {
      artifactId: `qualification/executions/${executionId}/evaluation-leaf-completions/${partitionIndex
        .toString()
        .padStart(8, "0")}.json`,
      executionId,
      leafInputArtifactId: `leaf-input/${partitionIndex}.json`,
      leafInputChecksum: leaf.leafInputChecksum,
      manifestChecksum: "manifest",
      outcome: { receipt: leaf, status: "COMPLETE" as const },
      partitionIndex,
      planChecksum,
      runId: `run-${partitionIndex}`,
      version: "qualification-evaluation-leaf-completion-v1" as const,
    };
    const completion = {
      ...completionContent,
      checksum: qualificationChecksum(completionContent),
    };
    await store(completion.artifactId, completion, "qualification-evaluation-leaf-completion-v1", {
      "osfo-leaf-input-checksum": completion.leafInputChecksum,
      "osfo-outcome": "COMPLETE",
      "osfo-partition-index": String(partitionIndex),
      "osfo-record-count": retainedRootCount,
      "osfo-run-id": completion.runId,
    });
    inputs.push({ artifactId: completion.artifactId, checksum: completion.checksum });
  }
  let outputWrites = 0;
  let failFirstOutputPut = options?.failFirstOutputPut === true;
  const bucket = {
    get: (key: string) => {
      const object = retained.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : { customMetadata: object.customMetadata, text: () => Promise.resolve(object.value) },
      );
    },
    put: (
      key: string,
      value: string,
      putOptions: { readonly customMetadata?: Record<string, string> },
    ) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, { customMetadata: putOptions.customMetadata ?? {}, value });
      outputWrites += 1;
      if (failFirstOutputPut) {
        failFirstOutputPut = false;
        return Promise.reject(new Error("lost R2 response after committed output"));
      }
      return Promise.resolve({ etag: key });
    },
  };
  const payload: QualificationEvaluationCorrectnessReducerWorkflowPayload = {
    acceptedCount: totalAcceptedCount,
    executionId,
    firstPartitionIndex: options?.partitionIndices?.[0] ?? 0,
    index: 0,
    inputKind: "leafCompletion",
    inputReceiptChainDigest: qualificationChecksum(inputs.map(({ checksum }) => checksum)),
    inputs,
    lastPartitionIndex: options?.partitionIndices?.[1] ?? 1,
    level: 1,
    outputArtifactPrefix: `qualification/executions/${executionId}/evaluation-correctness/level-1/00000000`,
    planChecksum,
    rootCount: totalRootCount,
  };
  const step = { do: <Value>(_name: string, callback: () => Promise<Value>) => callback() };
  return { bucket, outputWrites: () => outputWrites, payload, retained, step };
};

it("authenticates leaf completions and reduces exact roots and findings", async () => {
  const test = await runtime();
  const receipt = await runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(receipt).toMatchObject({
    findingSummary: { failCount: 1, missingCount: 1 },
    firstPartitionIndex: 0,
    lastPartitionIndex: 1,
    verdict: "FAIL",
  });
  expect(receipt.rootAccumulator).toMatchObject({
    acceptedCount: 2,
    firstRootId: "root-a",
    lastRootId: "root-b",
    rootCount: 2,
  });
  const writes = test.outputWrites();
  expect(
    await runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: test.bucket },
      payload: test.payload,
      step: test.step,
    }),
  ).toEqual(receipt);
  expect(test.outputWrites()).toBe(writes);
});

const run = (test: Awaited<ReturnType<typeof runtime>>) =>
  runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });

const higherPayload = (
  test: Awaited<ReturnType<typeof runtime>>,
  receipt: Awaited<ReturnType<typeof run>>,
): QualificationEvaluationCorrectnessReducerWorkflowPayload => ({
  acceptedCount: receipt.rootAccumulator.acceptedCount,
  executionId: test.payload.executionId,
  firstPartitionIndex: receipt.firstPartitionIndex,
  index: 0,
  inputKind: "correctness",
  inputReceiptChainDigest: qualificationChecksum([receipt.checksum]),
  inputs: [{ artifactId: receipt.artifactId, checksum: receipt.checksum }],
  lastPartitionIndex: receipt.lastPartitionIndex,
  level: 2,
  outputArtifactPrefix: `${test.payload.outputArtifactPrefix}/level-2`,
  planChecksum: test.payload.planChecksum,
  rootCount: receipt.rootAccumulator.rootCount,
});

it("retains closed FAIL and MISSING leaf outcomes without inventing roots", async () => {
  const allClosed = await runtime({ closedOutcomes: ["FAIL", "MISSING"] });
  const receipt = await runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: allClosed.bucket },
    payload: allClosed.payload,
    step: allClosed.step,
  });
  expect(receipt).toMatchObject({
    findingSummary: { failCount: 1, missingCount: 1 },
    verdict: "FAIL",
  });
  expect(receipt.rootAccumulator).toMatchObject({
    acceptedCount: 0,
    firstRootId: null,
    firstShardChecksum: "ZERO",
    lastRootId: null,
    rootCount: 0,
    shardCount: 0,
    terminalShardChecksum: "ZERO",
  });

  const mixed = await runtime({ closedOutcomes: [null, "MISSING"] });
  const mixedReceipt = await runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: mixed.bucket },
    payload: mixed.payload,
    step: mixed.step,
  });
  expect(mixedReceipt.rootAccumulator).toMatchObject({
    acceptedCount: 1,
    firstRootId: "root-a",
    lastRootId: "root-a",
    rootCount: 1,
  });
  expect(mixedReceipt.findingSummary.missingCount).toBe(1);

  const reducedClosed = await runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: allClosed.bucket },
    payload: higherPayload(allClosed, receipt),
    step: allClosed.step,
  });
  expect(reducedClosed).toMatchObject({
    findingSummary: { failCount: 1, missingCount: 1 },
    verdict: "FAIL",
  });
});

it("replays byte-identically after an R2 response is lost", async () => {
  const test = await runtime({ failFirstOutputPut: true });
  await expect(
    runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: test.bucket },
      payload: test.payload,
      step: test.step,
    }),
  ).rejects.toThrow("lost R2 response");
  const before = new Map(test.retained);
  const receipt = await runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: test.bucket },
    payload: test.payload,
    step: test.step,
  });
  expect(receipt.verdict).toBe("FAIL");
  for (const [key, object] of before) expect(test.retained.get(key)).toEqual(object);
});

it("rejects unsafe leaf counts before they can control retained reads", async () => {
  const unsafe = await runtime({ rootCount: "9007199254740992" });
  await expect(run(unsafe)).rejects.toThrow("child receipt conflicts");

  const oversized = await runtime({ rootCount: "257" });
  await expect(run(oversized)).rejects.toThrow("child receipt conflicts");

  const impossibleAccepted = await runtime({ acceptedCount: "2" });
  await expect(run(impossibleAccepted)).rejects.toThrow("child receipt conflicts");
});

it("rejects receipt-specific metadata disagreement and missing material", async () => {
  const metadataConflict = await runtime();
  const firstInput = metadataConflict.payload.inputs[0];
  if (firstInput === undefined) throw new Error("missing fixture input");
  const retainedCompletion = metadataConflict.retained.get(firstInput.artifactId);
  if (retainedCompletion === undefined) throw new Error("missing fixture completion");
  retainedCompletion.customMetadata["osfo-record-count"] = "999";
  await expect(run(metadataConflict)).rejects.toThrow("child receipt conflicts");

  const missing = await runtime();
  const missingInput = missing.payload.inputs[1];
  if (missingInput === undefined) throw new Error("missing fixture input");
  missing.retained.delete(missingInput.artifactId);
  await expect(run(missing)).rejects.toThrow("child receipt conflicts");
});

it("rejects reordered, duplicated, cross-execution, and cross-plan inputs", async () => {
  const reordered = await runtime();
  const reversed = Array.from({ length: reordered.payload.inputs.length }, (_, index) => {
    const input = reordered.payload.inputs[reordered.payload.inputs.length - index - 1];
    if (input === undefined) throw new Error("missing fixture input");
    return input;
  });
  await expect(
    runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: reordered.bucket },
      payload: {
        ...reordered.payload,
        inputReceiptChainDigest: qualificationChecksum(reversed.map(({ checksum }) => checksum)),
        inputs: reversed,
      },
      step: reordered.step,
    }),
  ).rejects.toThrow("child range conflicts");

  const gapped = await runtime({ partitionIndices: [0, 2] });
  await expect(run(gapped)).rejects.toThrow("child range conflicts");

  const duplicated = await runtime();
  const first = duplicated.payload.inputs[0];
  if (first === undefined) throw new Error("missing fixture input");
  await expect(
    runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: duplicated.bucket },
      payload: { ...duplicated.payload, inputs: [first, first] },
      step: duplicated.step,
    }),
  ).rejects.toThrow("inputs conflict");

  const substituted = await runtime();
  await expect(
    runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: substituted.bucket },
      payload: { ...substituted.payload, executionId: "other-execution" },
      step: substituted.step,
    }),
  ).rejects.toThrow("child receipt conflicts");
  await expect(
    runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: substituted.bucket },
      payload: { ...substituted.payload, planChecksum: "other-plan" },
      step: substituted.step,
    }),
  ).rejects.toThrow("child receipt conflicts");
});

it("rejects duplicate root identities across leaf boundaries", async () => {
  const duplicate = await runtime({ rootIds: ["same-root", "same-root"] });
  await expect(run(duplicate)).rejects.toThrow("duplicate root conflicts");
});

it("authenticates higher-level correctness receipts and every referenced chain", async () => {
  const test = await runtime();
  const levelOne = await run(test);
  const levelTwo = await runQualificationEvaluationCorrectnessReducer({
    env: { ARTIFACTS: test.bucket },
    payload: higherPayload(test, levelOne),
    step: test.step,
  });
  expect(levelTwo).toMatchObject({
    findingSummary: { failCount: 1, missingCount: 1 },
    firstPartitionIndex: 0,
    lastPartitionIndex: 1,
    verdict: "FAIL",
  });
  expect(levelTwo.rootAccumulator).toMatchObject({
    acceptedCount: 2,
    firstRootId: "root-a",
    lastRootId: "root-b",
    rootCount: 2,
  });

  const rootShardId = `${test.payload.outputArtifactPrefix}/roots/00000000.json`;
  const rootShard = test.retained.get(rootShardId);
  if (rootShard === undefined) throw new Error("missing reduced root shard");
  rootShard.customMetadata["osfo-previous-checksum"] = "forged-predecessor";
  await expect(
    runQualificationEvaluationCorrectnessReducer({
      env: { ARTIFACTS: test.bucket },
      payload: {
        ...higherPayload(test, levelOne),
        outputArtifactPrefix: `${test.payload.outputArtifactPrefix}/corrupt-level-2`,
      },
      step: test.step,
    }),
  ).rejects.toThrow("root shard conflicts");
});

it("rejects every higher-level receipt metadata substitution", async () => {
  const cases = [
    {
      artifact: (receipt: Awaited<ReturnType<typeof run>>) => receipt.artifactId,
      key: "osfo-verdict",
      value: "PASS",
    },
    {
      artifact: (receipt: Awaited<ReturnType<typeof run>>) => receipt.findingSummaryArtifactId,
      key: "osfo-fail-count",
      value: "999",
    },
    {
      artifact: (receipt: Awaited<ReturnType<typeof run>>) => receipt.rootAccumulator.artifactId,
      key: "osfo-terminal-checksum",
      value: "forged-terminal",
    },
  ] as const;
  for (const entry of cases) {
    const test = await runtime();
    const levelOne = await run(test);
    const artifactId = entry.artifact(levelOne);
    const retained = test.retained.get(artifactId);
    if (retained === undefined) throw new Error(`missing fixture artifact ${artifactId}`);
    retained.customMetadata[entry.key] = entry.value;
    await expect(
      runQualificationEvaluationCorrectnessReducer({
        env: { ARTIFACTS: test.bucket },
        payload: higherPayload(test, levelOne),
        step: test.step,
      }),
    ).rejects.toThrow("child receipt conflicts");
  }
});

it("rejects tampered, missing, and terminal-conflicting higher-level root shards", async () => {
  const cases = ["tampered", "missing", "terminal"] as const;
  for (const kind of cases) {
    const test = await runtime();
    const levelOne = await run(test);
    const rootShardId = `${test.payload.outputArtifactPrefix}/roots/00000000.json`;
    const retained = test.retained.get(rootShardId);
    if (retained === undefined) throw new Error("missing reduced root shard");
    if (kind === "tampered") {
      test.retained.set(rootShardId, { ...retained, value: `${retained.value} ` });
    } else if (kind === "missing") {
      test.retained.delete(rootShardId);
    } else {
      retained.customMetadata["osfo-previous-checksum"] = "forged-terminal-chain";
    }
    await expect(
      runQualificationEvaluationCorrectnessReducer({
        env: { ARTIFACTS: test.bucket },
        payload: higherPayload(test, levelOne),
        step: test.step,
      }),
    ).rejects.toThrow("root shard conflicts");
  }
});

it("rejects an immutable output conflict instead of overwriting it", async () => {
  const test = await runtime();
  const outputId = `${test.payload.outputArtifactPrefix}/roots/00000000.json`;
  test.retained.set(outputId, {
    customMetadata: { "osfo-kind": "forged" },
    value: "forged-output",
  });
  await expect(run(test)).rejects.toThrow("output conflicts");
  expect(test.retained.get(outputId)?.value).toBe("forged-output");
});

it("streams the producer maximum finding chain while retaining bounded exemplars", async () => {
  const test = await runtime({ maximumFindings: true });
  const receipt = await run(test);
  expect(receipt.findingSummary).toMatchObject({
    exemplars: expect.any(Array),
    failCount: 32_768,
    missingCount: 1,
  });
  expect(receipt.findingSummary.exemplars).toHaveLength(32);
});
