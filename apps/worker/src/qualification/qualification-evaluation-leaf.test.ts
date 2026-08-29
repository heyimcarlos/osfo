/* oxlint-disable effecttsgo/async-function -- These tests exercise Promise-native Web Crypto and R2 adapter replay boundaries. */
import { Option, Schema } from "effect";
import { expect, it } from "vitest";

import { AgentId } from "../domain";
import {
  completeProductionEvidence,
  manifestVersions,
} from "../../test/support/qualification-fixtures";
import {
  qualificationAuthoritySources,
  type QualificationAuthoritySource,
} from "./authority-sources";
import { createQualificationExecutionPlan } from "./execution";
import { QualificationAdmissionReceipt } from "./qualification-attempt";
import {
  evaluateQualificationLeaf,
  qualificationEvaluationLeafDimension,
  QualificationEvaluationArrivalShard,
  QualificationEvaluationAuthorityShard,
  runQualificationEvaluationLeaf,
} from "./qualification-evaluation-leaf";
import {
  qualificationEvaluationLeafInputReceipt,
  type QualificationEvaluationArtifactBucket,
} from "./qualification-evaluation-reducer";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import { createBoundedBetaManifest } from "./qualification-manifest";
import { ProductAuthorityExportBoundary, assessSemanticEvidence } from "./semantic-evidence";

const manifest = createBoundedBetaManifest(manifestVersions);
const plan = createQualificationExecutionPlan(manifest, 0, "leaf-evaluation");
const run = plan.runs.find((candidate) => candidate.kind === "lane" && candidate.lane === "stress");
if (run === undefined) throw new Error("Expected a stress run");

const occurredAt = "2026-08-29T17:00:01.000Z";

const isSemanticFinding = (code: string) =>
  code.includes("Component") ||
  code.includes("component") ||
  code.includes("Correlation") ||
  code.includes("correlation") ||
  code.includes("Stage") ||
  code.includes("stage");

const RetainedFindingShard = Schema.Struct({ findings: Schema.Array(Schema.Unknown) });

const admissionReceipt = (
  rootId: string,
  decision: "accepted" | "capacityRejected" | "typedStressRejected",
  identities: {
    readonly acceptanceReceiptId?: string;
    readonly productFactId?: string;
    readonly thinkSubmissionId?: string | null;
    readonly userMessageId?: string;
    readonly userUpdateId?: string;
  } = {},
) => {
  const attemptId = qualificationChecksum({
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    rootId,
    runId: run.runId,
  });
  const productFactId =
    identities.productFactId ??
    qualificationChecksum({
      admissionDecision: decision,
      agentId: AgentId.make("qualification-agent"),
      attemptId,
      executionId: plan.executionId,
      planChecksum: plan.planChecksum,
      rootId,
      runId: run.runId,
    });
  const content = {
    acceptanceReceiptId: identities.acceptanceReceiptId ?? productFactId,
    admissionDecision: decision,
    agentId: AgentId.make("qualification-agent"),
    attemptId,
    executionId: plan.executionId,
    occurredAt,
    planChecksum: plan.planChecksum,
    productFactId,
    rootId,
    runId: run.runId,
    thinkSubmissionId:
      identities.thinkSubmissionId ?? (decision === "accepted" ? `think-${rootId}` : null),
    userMessageId: identities.userMessageId ?? `message-${rootId}`,
    userUpdateId: identities.userUpdateId ?? `update-${rootId}`,
  };
  return Schema.decodeSync(QualificationAdmissionReceipt)({
    ...content,
    artifactChecksum: qualificationChecksum(content),
  });
};

const authorityShard = (source: QualificationAuthoritySource, records: ReadonlyArray<unknown>) => {
  const content = {
    artifactId: `qualification/executions/${plan.executionId}/producer-authority/${source}/partitions/00000000/00000000.json`,
    authority: source,
    executionId: plan.executionId,
    exportedAtUtc: occurredAt,
    index: 0 as const,
    planChecksum: plan.planChecksum,
    previousArtifactChecksum: "NONE" as const,
    recordCount: records.length,
    records,
    sourceVersion: manifest.sourceVersion,
    streamChunkIndex: 0,
  };
  return Schema.decodeSync(QualificationEvaluationAuthorityShard)({
    ...content,
    checksum: qualificationChecksum(content),
  });
};

const fixture = (
  arrivals: ReadonlyArray<{
    readonly decision: "accepted" | "capacityRejected" | "typedStressRejected";
    readonly journey?: "ordinaryConversation";
    readonly rootId: string;
    readonly receipt?: ReturnType<typeof admissionReceipt>;
  }>,
  overrides: Readonly<Partial<Record<QualificationAuthoritySource, ReadonlyArray<unknown>>>> = {},
) => {
  const records = arrivals.map(
    ({ decision, journey = "ordinaryConversation", receipt: retainedReceipt, rootId }) => {
      const receipt = retainedReceipt ?? admissionReceipt(rootId, decision);
      return {
        admissionReceipt: receipt,
        arrival: { journey, offeredAtEpochMs: 0, plan: "free" as const, rootId },
        attemptId: receipt.attemptId,
        authorityFactId: receipt.productFactId,
        executedAtUtc: occurredAt,
        executionId: plan.executionId,
        rootId,
        submittedAtUtc: occurredAt,
      };
    },
  );
  const arrivalContent = {
    chunkIndex: 0,
    executionId: plan.executionId,
    planChecksum: plan.planChecksum,
    previousArtifactChecksum: "NONE",
    records,
    runId: run.runId,
    streamChunkIndex: 0,
  };
  const arrivalShard = Schema.decodeSync(QualificationEvaluationArrivalShard)({
    ...arrivalContent,
    bodyChecksum: qualificationChecksum(arrivalContent),
  });
  const workerRecords = records.map(({ admissionReceipt: receipt }) => ({
    acceptanceReceiptId: receipt.acceptanceReceiptId,
    admissionDecision: receipt.admissionDecision,
    effectReceipts: [],
    occurredAt: receipt.occurredAt,
    productFactId: receipt.productFactId,
    rootId: receipt.rootId,
    stageOccurrences: [
      {
        boundary: "durableAcceptanceCommitted",
        occurredAt: receipt.occurredAt,
        productFactId: receipt.productFactId,
      },
    ],
    usageFacts: [],
    userMessageId: receipt.userMessageId,
    userUpdateId: receipt.userUpdateId,
  }));
  const authorityShards = qualificationAuthoritySources.map((source) =>
    authorityShard(
      source,
      overrides[source] ?? (source === "worker_admission_receipts" ? workerRecords : []),
    ),
  );
  const authorityInputs = authorityShards.map(({ authority, checksum, recordCount }) => ({
    checksum,
    recordCount,
    source: authority,
  }));
  const leafInput = qualificationEvaluationLeafInputReceipt({
    artifactId: `qualification/executions/${plan.executionId}/evaluation-leaf-inputs/00000000.json`,
    arrivalChecksum: arrivalShard.bodyChecksum,
    arrivalRecordCount: records.length,
    authorityInputs,
    executionId: plan.executionId,
    partitionAuthorityChecksum: qualificationChecksum({
      arrivalChecksum: arrivalShard.bodyChecksum,
      executionId: plan.executionId,
      partitionIndex: 0,
      planChecksum: plan.planChecksum,
      sourceChecksums: authorityInputs,
      streamChunkIndex: 0,
    }),
    partitionIndex: 0,
    planChecksum: plan.planChecksum,
    streamChunkIndex: 0,
  });
  if (leafInput === null) throw new Error("Expected leaf input");
  return { arrivalShard, authorityShards, leafInput };
};

it("matches the semantic oracle for an authoritative typed rejection and emits every zero split", () => {
  const input = fixture([{ decision: "typedStressRejected", rootId: "root-1" }]);
  const evaluated = evaluateQualificationLeaf({ ...input, manifest, partitionIndex: 0, run });
  const productAuthorityExports = input.authorityShards.flatMap((shard) => {
    const decoded = Schema.decodeUnknownOption(ProductAuthorityExportBoundary)(shard);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const oracle = assessSemanticEvidence(
    {
      acceptedRootIds: [],
      localEvidence: [],
      productAuthorityExports,
      r2Evidence: [],
      telemetry: [],
      traces: [],
    },
    manifest.semanticRequirements,
  );
  expect(evaluated.verdict).toBe(oracle.verdict);
  expect(evaluated.findings).toEqual(oracle.findings);
  expect(evaluated.dimensions).toHaveLength(29);
  expect(
    evaluated.dimensions
      .filter(
        ({ receipt }) =>
          receipt.dimension === "acceptedRootIds" || receipt.dimension.startsWith("stage:"),
      )
      .every(({ receipt, shards }) => receipt.valueCount === "0" && shards.length === 0),
  ).toBe(true);
});

it("fails a substituted source and a duplicate arrival identity", () => {
  const input = fixture([
    { decision: "typedStressRejected", rootId: "root-1" },
    { decision: "typedStressRejected", rootId: "root-1" },
  ]);
  const [first, second, ...rest] = input.authorityShards;
  if (first === undefined || second === undefined) throw new Error("Expected source shards");
  const evaluated = evaluateQualificationLeaf({
    ...input,
    authorityShards: [second, first, ...rest],
    manifest,
    partitionIndex: 0,
    run,
  });
  expect(evaluated.verdict).toBe("FAIL");
  expect(evaluated.findings.map(({ code }) => code)).toEqual(
    expect.arrayContaining(["duplicateLeafRoot", "leafAuthoritySourceMismatch"]),
  );
});

it("fails malformed producer unions, foreign roots, and inconsistent admission identities", () => {
  const malformed = fixture([{ decision: "accepted", rootId: "root-1" }], {
    provider_delivery_receipts: [
      {
        effectReceipts: [],
        occurredAt,
        productFactId: "malformed-provider",
        rootId: "root-1",
        stageOccurrences: [],
        usageFacts: [],
      },
    ],
  });
  expect(
    evaluateQualificationLeaf({ ...malformed, manifest, partitionIndex: 0, run }).findings,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "leafAuthorityRecordInvalid", verdict: "FAIL" }),
    ]),
  );

  const foreign = fixture([{ decision: "accepted", rootId: "root-1" }], {
    provider_delivery_receipts: [
      {
        deliveryId: "foreign-delivery",
        effectReceipts: [],
        occurredAt,
        outcomeId: "foreign-outcome",
        productFactId: "foreign-provider",
        providerStatus: "succeeded",
        rootId: "foreign-root",
        stageOccurrences: [],
        usageFacts: [],
      },
    ],
  });
  expect(
    evaluateQualificationLeaf({ ...foreign, manifest, partitionIndex: 0, run }).findings,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "leafAuthorityRootMismatch", verdict: "FAIL" }),
    ]),
  );

  const inconsistent = fixture([{ decision: "accepted", rootId: "root-1" }]);
  const first = inconsistent.arrivalShard.records[0];
  if (first === undefined) throw new Error("Expected arrival");
  const changedContent = {
    ...inconsistent.arrivalShard,
    records: [{ ...first, attemptId: "another-attempt" }],
  };
  const { bodyChecksum: _bodyChecksum, ...body } = changedContent;
  const changedArrival = Schema.decodeSync(QualificationEvaluationArrivalShard)({
    ...body,
    bodyChecksum: qualificationChecksum(body),
  });
  expect(
    evaluateQualificationLeaf({
      ...inconsistent,
      arrivalShard: changedArrival,
      manifest,
      partitionIndex: 0,
      run,
    }).findings,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "arrivalAuthorityIdentityConflict", verdict: "FAIL" }),
    ]),
  );
});

it("distinguishes missing terminal authority from a proven terminal component failure", () => {
  const missing = fixture([{ decision: "accepted", rootId: "root-1" }]);
  expect(evaluateQualificationLeaf({ ...missing, manifest, partitionIndex: 0, run }).verdict).toBe(
    "MISSING",
  );

  const receipt = admissionReceipt("root-1", "accepted");
  const failedThink = {
    acceptanceReceiptId: receipt.acceptanceReceiptId,
    effectReceipts: [{ effectId: "think-root-1", kind: "thinkSubmissions" }],
    occurredAt,
    productFactId: "think-failure",
    rootId: "root-1",
    stageOccurrences: [],
    submissionStatus: "failed",
    thinkSubmissionId: "think-root-1",
    usageFacts: [],
  };
  const failed = fixture([{ decision: "accepted", rootId: "root-1" }], {
    think_submission_receipts: [failedThink],
  });
  const evaluated = evaluateQualificationLeaf({ ...failed, manifest, partitionIndex: 0, run });
  expect(evaluated.verdict).toBe("FAIL");
  expect(evaluated.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "componentProductAuthorityInvalid", verdict: "FAIL" }),
    ]),
  );
});

it("does not treat an explicit no-obligation record as successful required-component evidence", () => {
  const noProviderObligation = {
    effectReceipts: [],
    occurredAt,
    outcomeId: "provider-not-required",
    productFactId: "provider-not-required-fact",
    providerObligation: "notRequired",
    rootId: "root-1",
    stageOccurrences: [],
    usageFacts: [],
  };
  const input = fixture([{ decision: "accepted", rootId: "root-1" }], {
    provider_delivery_receipts: [noProviderObligation],
  });
  const evaluated = evaluateQualificationLeaf({ ...input, manifest, partitionIndex: 0, run });
  expect(evaluated.verdict).toBe("FAIL");
  expect(evaluated.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "componentProductAuthorityInvalid",
        subject: "root-1:Provider",
        verdict: "FAIL",
      }),
    ]),
  );
});

it("matches accepted-root component, correlation, and stage findings from the compact oracle", () => {
  const complete = completeProductionEvidence();
  const trace = complete.semantic.traces[0];
  if (trace === undefined) throw new Error("Expected one complete semantic trace");
  const rootId = trace.rootId;
  const productExports = complete.semantic.productAuthorityExports.map((artifact) => {
    const records = artifact.records.filter((record) => record.rootId === rootId);
    const { checksum: _checksum, ...content } = artifact;
    const exactContent = { ...content, records };
    return { ...exactContent, checksum: qualificationChecksum(exactContent) };
  });
  const worker = productExports
    .find(({ authority }) => authority === "worker_admission_receipts")
    ?.records.find((record) => "admissionDecision" in record);
  if (worker === undefined || !("acceptanceReceiptId" in worker)) {
    throw new Error("Expected worker authority");
  }
  const retainedReceipt = admissionReceipt(rootId, "accepted", {
    acceptanceReceiptId: worker.acceptanceReceiptId,
    productFactId: worker.productFactId,
    thinkSubmissionId: trace.correlations.thinkSubmissionId,
    userMessageId: trace.correlations.userMessageId,
    userUpdateId: trace.correlations.userUpdateId,
  });
  const localEvidence = complete.semantic.localEvidence.filter((record) =>
    record.store === "AgentSQLite"
      ? record.rootId === rootId
      : record.acceptanceReceiptId === trace.correlations.acceptanceReceiptId,
  );
  const overrides: { [Source in QualificationAuthoritySource]?: ReadonlyArray<unknown> } = {};
  for (const { authority, records } of productExports) overrides[authority] = records;
  overrides.osfo_committed_turns = localEvidence.filter((record) => record.store === "AgentSQLite");
  overrides.allowance_and_billing_ledger = localEvidence
    .filter((record) => record.store === "PostgreSQL")
    .map((evidence) => ({ _tag: "LocalEvidence", evidence }));
  overrides.r2_object_metadata = complete.semantic.r2Evidence.filter(
    (record) => record.rootId === rootId,
  );
  const input = fixture([{ decision: "accepted", receipt: retainedReceipt, rootId }], overrides);
  const evaluated = evaluateQualificationLeaf({ ...input, manifest, partitionIndex: 0, run });
  const oracle = assessSemanticEvidence(
    {
      acceptedRootIds: [rootId],
      localEvidence,
      productAuthorityExports: productExports,
      r2Evidence: complete.semantic.r2Evidence.filter((record) => record.rootId === rootId),
      telemetry: [],
      traces: [trace],
    },
    manifest.semanticRequirements,
  );
  expect(oracle.findings.filter(({ code }) => isSemanticFinding(code))).toEqual([]);
  expect(evaluated.findings.filter(({ code }) => isSemanticFinding(code))).toEqual([]);
  const retainedCorrelations = new Map(
    evaluated.rootAccumulator.roots[0]?.correlations.map(({ kind, value }) => [kind, value]),
  );
  for (const correlation of manifest.semanticRequirements[trace.journey].requiredCorrelations) {
    expect(retainedCorrelations.get(correlation)).toBe(trace.correlations[correlation]);
  }
});

it("shards a maximum-amplification identity dimension without truncation", () => {
  const providerRecords = Array.from({ length: 600 }, (_, index) => ({
    deliveryId: `delivery-${index}`,
    effectReceipts: [
      { effectId: `effect-${index.toString().padStart(4, "0")}`, kind: "providerEffects" },
    ],
    occurredAt,
    outcomeId: `outcome-${index}`,
    productFactId: `provider-fact-${index}`,
    providerStatus: "succeeded",
    rootId: "root-1",
    stageOccurrences: [],
    usageFacts: [],
  }));
  const input = fixture([{ decision: "accepted", rootId: "root-1" }], {
    provider_delivery_receipts: providerRecords,
  });
  const evaluated = evaluateQualificationLeaf({ ...input, manifest, partitionIndex: 0, run });
  const effects = evaluated.dimensions.find(
    ({ receipt }) => receipt.dimension === "providerEffectIds",
  );
  expect(effects?.receipt).toMatchObject({ shardCount: "3", valueCount: "600" });
  expect(effects?.shards.map(({ values }) => values.length)).toEqual([256, 256, 88]);
  expect(effects?.shards.at(-1)?.checksum).toBe(effects?.receipt.terminalShardChecksum);
});

it("rejects mixed or mismatched leaf value types", () => {
  expect(
    qualificationEvaluationLeafDimension({
      artifactId: "values",
      denominatorRootIds: ["root-1"],
      dimension: "stage:test",
      executionId: plan.executionId,
      partitionIndex: 0,
      planChecksum: plan.planChecksum,
      valueType: "latencyMs",
      values: [1, "2"],
    }),
  ).toBeNull();
  expect(
    qualificationEvaluationLeafDimension({
      artifactId: "values",
      denominatorRootIds: ["root-1"],
      dimension: "acceptedRootIds",
      executionId: plan.executionId,
      partitionIndex: 0,
      planChecksum: plan.planChecksum,
      valueType: "identity",
      values: [1],
    }),
  ).toBeNull();
});

it("emits the exact 15/4 stage names and binds cold denominators to activation cause", () => {
  const activation = {
    activationId: "activation-1",
    cause: "firstUse",
    classification: "cold",
    effectReceipts: [],
    occurredAt: "2026-08-29T17:00:00.000Z",
    productFactId: "activation-fact",
    region: "americas",
    rootId: "root-1",
    stageOccurrences: [
      {
        boundary: "messageObserved",
        occurredAt: "2026-08-29T17:00:00.000Z",
        productFactId: "message-observed-fact",
      },
    ],
    usageFacts: [],
  };
  const input = fixture([{ decision: "accepted", rootId: "root-1" }], {
    osfo_agent_activation_log: [activation],
  });
  const evaluated = evaluateQualificationLeaf({ ...input, manifest, partitionIndex: 0, run });
  const stageDimensions = evaluated.dimensions.filter(({ receipt }) =>
    receipt.dimension.startsWith("stage:"),
  );
  expect(stageDimensions).toHaveLength(15);
  expect(new Set(stageDimensions.map(({ receipt }) => receipt.dimension)).size).toBe(15);
  expect(
    stageDimensions.find(({ receipt }) =>
      receipt.dimension.endsWith("coldDurableAcceptance:firstUse"),
    )?.receipt,
  ).toMatchObject({ denominatorCount: "1", valueCount: "1" });
  expect(
    stageDimensions.find(({ receipt }) =>
      receipt.dimension.endsWith("coldDurableAcceptance:deployment"),
    )?.receipt,
  ).toMatchObject({ denominatorCount: "0", valueCount: "0" });

  const allCold = plan.runs.find(
    (candidate) => candidate.kind === "lane" && candidate.lane === "allCold",
  );
  if (allCold === undefined) throw new Error("Expected all-cold run");
  const allColdEvaluated = evaluateQualificationLeaf({
    ...input,
    manifest,
    partitionIndex: 0,
    run: allCold,
  });
  expect(
    allColdEvaluated.dimensions.filter(({ receipt }) => receipt.dimension.startsWith("stage:")),
  ).toHaveLength(4);
});

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const retainedLeafRuntime = async (
  input: ReturnType<typeof fixture>,
  tamper: "leafMetadata" | "sourceMetadata" | null = null,
  options: { readonly failAfterFirstOutputPut?: boolean } = {},
) => {
  const retained = new Map<
    string,
    { readonly customMetadata: Record<string, string>; readonly value: string }
  >();
  let failAfterFirstOutputPut = options.failAfterFirstOutputPut === true;
  const store = async (
    artifactId: string,
    encoded: string,
    customMetadata: Record<string, string>,
  ) => {
    retained.set(artifactId, {
      customMetadata: {
        ...customMetadata,
        "osfo-body-sha256": await sha256Hex(encoded),
      },
      value: encoded,
    });
  };
  await store(input.leafInput.artifactId, canonicalQualificationJson(input.leafInput), {
    "osfo-artifact-checksum": tamper === "leafMetadata" ? "substituted" : input.leafInput.checksum,
    "osfo-execution-id": plan.executionId,
    "osfo-kind": "qualification-evaluation-leaf-input-v1",
    "osfo-plan-checksum": plan.planChecksum,
  });
  const arrivalEncoded = canonicalQualificationJson(input.arrivalShard);
  const arrivalBodySha256 = await sha256Hex(arrivalEncoded);
  const arrivalArtifactChecksum = qualificationChecksum({
    bodySha256: arrivalBodySha256,
    component: "arrivals",
    executionId: plan.executionId,
    index: 0,
    planChecksum: plan.planChecksum,
    previousArtifactChecksum: input.arrivalShard.previousArtifactChecksum,
    recordCount: input.arrivalShard.records.length,
    sourceVersion: manifest.sourceVersion,
  });
  const arrivalId = `qualification/executions/${plan.executionId}/authority-streams/arrivals/partitions/00000000/00000000.json`;
  await store(arrivalId, arrivalEncoded, {
    "osfo-artifact-checksum": arrivalArtifactChecksum,
    "osfo-component": "arrivals",
    "osfo-execution-id": plan.executionId,
    "osfo-kind": "qualification-authority-stream-v1",
    "osfo-plan-checksum": plan.planChecksum,
    "osfo-record-count": String(input.arrivalShard.records.length),
    "osfo-stream-chunk-index": "0",
  });
  await Promise.all(
    input.authorityShards.map((shard) =>
      store(shard.artifactId, canonicalQualificationJson(shard), {
        "osfo-artifact-checksum": shard.checksum,
        "osfo-execution-id": plan.executionId,
        "osfo-kind": "qualification-product-authority-export-v1",
        "osfo-plan-checksum": plan.planChecksum,
        "osfo-record-count": String(shard.recordCount),
        "osfo-source": shard.authority,
        "osfo-stream-chunk-index":
          tamper === "sourceMetadata" && shard.authority === "worker_admission_receipts"
            ? "7"
            : "0",
      }),
    ),
  );
  const bucket: QualificationEvaluationArtifactBucket = {
    get: (key) => {
      const value = retained.get(key);
      return Promise.resolve(
        value === undefined
          ? null
          : {
              customMetadata: value.customMetadata,
              text: () => Promise.resolve(value.value),
            },
      );
    },
    put: (key, value, putOptions) => {
      if (retained.has(key)) return Promise.resolve(null);
      retained.set(key, {
        customMetadata: putOptions.customMetadata ?? {},
        value,
      });
      if (failAfterFirstOutputPut && key.includes("/evaluation-leaves/")) {
        failAfterFirstOutputPut = false;
        return Promise.reject(new Error("lost host response after immutable output put"));
      }
      return Promise.resolve({ etag: key });
    },
  };
  const runLeaf = () =>
    runQualificationEvaluationLeaf({
      bucket,
      executionId: plan.executionId,
      leafInputArtifactId: input.leafInput.artifactId,
      leafInputChecksum: input.leafInput.checksum,
      manifest,
      partitionIndex: 0,
      planChecksum: plan.planChecksum,
      run,
    });
  return { retained, runLeaf };
};

it("re-authenticates retained leaf/source metadata and replays create-or-identical outputs", async () => {
  const input = fixture([{ decision: "typedStressRejected", rootId: "root-1" }]);
  const runtime = await retainedLeafRuntime(input);
  const first = await runtime.runLeaf();
  const second = await runtime.runLeaf();
  expect(first.status).toBe("COMPLETE");
  expect(second).toEqual(first);
  expect((await (await retainedLeafRuntime(input, "leafMetadata")).runLeaf()).status).toBe("FAIL");
  expect((await (await retainedLeafRuntime(input, "sourceMetadata")).runLeaf()).status).toBe(
    "FAIL",
  );

  const substitutedBody = await retainedLeafRuntime(input);
  const workerArtifactId = input.authorityShards.find(
    ({ authority }) => authority === "worker_admission_receipts",
  )?.artifactId;
  if (workerArtifactId === undefined) throw new Error("Expected Worker source body");
  const workerBody = substitutedBody.retained.get(workerArtifactId);
  if (workerBody === undefined) throw new Error("Expected retained Worker source body");
  substitutedBody.retained.set(workerArtifactId, {
    ...workerBody,
    value: `${workerBody.value} `,
  });
  expect((await substitutedBody.runLeaf()).status).toBe("FAIL");

  if (first.status !== "COMPLETE") throw new Error("Expected retained leaf receipt");
  const root = runtime.retained.get(first.receipt.rootAccumulatorId);
  if (root === undefined) throw new Error("Expected root accumulator");
  runtime.retained.set(first.receipt.rootAccumulatorId, { ...root, value: `${root.value} ` });
  expect((await runtime.runLeaf()).status).toBe("FAIL");
});

it("makes authenticated source failure outrank absence and absence outrank complete sources", async () => {
  const input = fixture([{ decision: "typedStressRejected", rootId: "root-1" }]);
  const missingRuntime = await retainedLeafRuntime(input);
  const missingSource = input.authorityShards[0];
  if (missingSource === undefined) throw new Error("Expected authority source");
  missingRuntime.retained.delete(missingSource.artifactId);
  const missing = await missingRuntime.runLeaf();
  expect(missing).toMatchObject({
    artifactId: missingSource.artifactId,
    code: "qualificationEvaluationAuthorityMissing",
    status: "MISSING",
  });

  const mixedRuntime = await retainedLeafRuntime(input);
  mixedRuntime.retained.delete(missingSource.artifactId);
  const conflictingSource = input.authorityShards[1];
  if (conflictingSource === undefined) throw new Error("Expected second authority source");
  const conflictingBody = mixedRuntime.retained.get(conflictingSource.artifactId);
  if (conflictingBody === undefined) throw new Error("Expected retained source");
  mixedRuntime.retained.set(conflictingSource.artifactId, {
    ...conflictingBody,
    value: `${conflictingBody.value} `,
  });
  expect(await mixedRuntime.runLeaf()).toMatchObject({
    artifactId: conflictingSource.artifactId,
    code: "qualificationEvaluationAuthorityConflict",
    status: "FAIL",
  });
});

it("replays an immutable partial output after a lost host response", async () => {
  const input = fixture([{ decision: "typedStressRejected", rootId: "root-1" }]);
  const runtime = await retainedLeafRuntime(input, null, { failAfterFirstOutputPut: true });
  await expect(runtime.runLeaf()).rejects.toThrow("lost host response");
  const replay = await runtime.runLeaf();
  expect(replay.status).toBe("COMPLETE");
});

it("retains more than 256 findings as a deterministic bounded chain", async () => {
  const input = fixture(
    Array.from({ length: 256 }, (_, index) => ({
      decision: "accepted" as const,
      rootId: `root-${index.toString().padStart(3, "0")}`,
    })),
  );
  const runtime = await retainedLeafRuntime(input);
  const outcome = await runtime.runLeaf();
  expect(outcome.status).toBe("COMPLETE");
  if (outcome.status !== "COMPLETE") throw new Error("Expected retained finding chain");
  const receipt = outcome.receipt;
  expect(Number(receipt.findingShardCount)).toBeGreaterThan(1);
  expect(receipt.findingExemplars).toEqual(
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh copy.
    [...receipt.findingExemplars].sort((left, right) =>
      [left.verdict, left.code, left.subject, left.detail]
        .join("\u0000")
        .localeCompare([right.verdict, right.code, right.subject, right.detail].join("\u0000")),
    ),
  );
  const findingBodies = [...runtime.retained.entries()].filter(([key]) =>
    key.startsWith(receipt.findingShardPrefix),
  );
  expect(findingBodies).toHaveLength(Number(receipt.findingShardCount));
  expect(
    findingBodies.every(([, { value }]) => {
      const decoded = Schema.decodeSync(Schema.fromJsonString(RetainedFindingShard))(value);
      return decoded.findings.length <= 256;
    }),
  ).toBe(true);
});
