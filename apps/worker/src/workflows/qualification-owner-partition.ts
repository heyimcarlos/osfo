import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Data, Schema } from "effect";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import {
  qualificationEvaluationLeafInputReceipt,
  retainQualificationEvaluationArtifact,
} from "../qualification/qualification-evaluation-reducer";
import {
  QualificationProductAuthorityArrivalChunk,
  QualificationProductAuthorityMissing,
  QualificationProductAuthoritySourceBundleComplete,
  QualificationProductAuthoritySourceBundlePending,
} from "../qualification/product-authority-contract";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationOwnerPartitionWorkflowPayload } from "../workflow-contracts";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Cloudflare Workflow and R2 bindings are Promise-only durable host boundaries and tagged results use Effect's _tag discriminator. */

const maximumBundlePolls = 100;
class QualificationPartitionConflict extends Data.TaggedError("QualificationPartitionConflict")<{
  readonly message: string;
}> {}
const decodeArrival = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthorityArrivalChunk),
);
const decodeComplete = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthoritySourceBundleComplete),
);
const decodeMissing = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthorityMissing),
);
const decodePending = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthoritySourceBundlePending),
);
const RetainedSourceShard = Schema.Struct({
  artifactId: Schema.String,
  authority: Schema.Literals(qualificationAuthoritySources),
  checksum: Schema.String,
  executionId: Schema.String,
  exportedAtUtc: Schema.String,
  index: Schema.Literal(0),
  planChecksum: Schema.String,
  previousArtifactChecksum: Schema.Literal("NONE"),
  recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  records: Schema.Array(Schema.Unknown),
  sourceVersion: Schema.String,
  streamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const RetainedArrivalShard = Schema.Struct({
  bodyChecksum: Schema.String,
  chunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  executionId: Schema.String,
  planChecksum: Schema.String,
  previousArtifactChecksum: Schema.Literal("NONE"),
  records: Schema.Array(Schema.Unknown),
  runId: Schema.String,
  streamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const PartitionStepResult = Schema.TaggedUnion({
  Complete: { outcome: QualificationProductAuthoritySourceBundleComplete },
  Missing: { outcome: QualificationProductAuthorityMissing },
  Pending: { outcome: QualificationProductAuthoritySourceBundlePending },
});
const FaultPreparationStepResult = Schema.TaggedUnion({
  Missing: {},
  Ready: {},
});
const decodeStepResult = Schema.decodePromise(PartitionStepResult);
const decodeFaultPreparationStepResult = Schema.decodePromise(FaultPreparationStepResult);

interface PartitionArtifactObject {
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly text: () => Promise<string>;
}

interface QualificationOwnerPartitionEnv {
  readonly ARTIFACTS: {
    readonly get: (key: string) => Promise<PartitionArtifactObject | null>;
    readonly put: (
      key: string,
      value: string,
      options: R2PutOptions,
    ) => Promise<{ readonly etag: string } | null>;
  };
  readonly PRODUCT_AUTHORITY: Pick<Fetcher, "fetch">;
}

export interface QualificationOwnerPartitionStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

const partitionCompletionArtifactId = (executionId: string, streamChunkIndex: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/owner-partitions/${streamChunkIndex.toString().padStart(8, "0")}.json`;
const evaluationLeafInputArtifactId = (executionId: string, streamChunkIndex: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaf-inputs/${streamChunkIndex.toString().padStart(8, "0")}.json`;

const sourceArtifactId = (executionId: string, source: string, streamChunkIndex: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/producer-authority/${source}/partitions/${streamChunkIndex.toString().padStart(8, "0")}/00000000.json`;

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readSourceChecksums = async (
  env: QualificationOwnerPartitionEnv,
  payload: QualificationOwnerPartitionWorkflowPayload,
  streamChunkIndex: number,
) => {
  const checksums = new Array<{
    readonly checksum: string;
    readonly recordCount: number;
    readonly source: string;
  }>();
  for (const source of qualificationAuthoritySources) {
    const artifactId = sourceArtifactId(payload.executionId, source, streamChunkIndex);
    const retained = await env.ARTIFACTS.get(artifactId);
    if (retained === null)
      throw new QualificationPartitionConflict({
        message: `${source} partition authority is missing`,
      });
    const encoded = await retained.text();
    let shard: typeof RetainedSourceShard.Type;
    try {
      shard = Schema.decodeSync(Schema.fromJsonString(RetainedSourceShard))(encoded);
    } catch {
      throw new QualificationPartitionConflict({
        message: `${source} partition authority is invalid`,
      });
    }
    const { checksum, ...content } = shard;
    if (
      shard.artifactId !== artifactId ||
      shard.authority !== source ||
      shard.executionId !== payload.executionId ||
      shard.planChecksum !== payload.planChecksum ||
      shard.recordCount !== shard.records.length ||
      shard.sourceVersion !== payload.sourceVersion ||
      shard.streamChunkIndex !== streamChunkIndex ||
      checksum !== qualificationChecksum(content) ||
      retained.customMetadata?.["osfo-artifact-checksum"] !== checksum ||
      retained.customMetadata?.["osfo-body-sha256"] !== (await sha256Hex(encoded)) ||
      retained.customMetadata?.["osfo-execution-id"] !== payload.executionId ||
      retained.customMetadata?.["osfo-index"] !== "0" ||
      retained.customMetadata?.["osfo-plan-checksum"] !== payload.planChecksum ||
      retained.customMetadata?.["osfo-previous-checksum"] !== "NONE" ||
      retained.customMetadata?.["osfo-record-count"] !== String(shard.recordCount) ||
      retained.customMetadata?.["osfo-source"] !== source ||
      retained.customMetadata?.["osfo-source-version"] !== shard.sourceVersion ||
      retained.customMetadata?.["osfo-stream-chunk-index"] !== String(streamChunkIndex)
    ) {
      throw new QualificationPartitionConflict({
        message: `${source} partition authority conflicts`,
      });
    }
    checksums.push({ checksum, recordCount: shard.recordCount, source });
  }
  return checksums;
};

const verifyArrivalBody = async (
  env: QualificationOwnerPartitionEnv,
  payload: QualificationOwnerPartitionWorkflowPayload,
  arrival: typeof QualificationProductAuthorityArrivalChunk.Type,
) => {
  const retained = await env.ARTIFACTS.get(arrival.artifactId);
  if (retained === null)
    throw new QualificationPartitionConflict({
      message: "Arrival partition authority is missing",
    });
  const encoded = await retained.text();
  let shard: typeof RetainedArrivalShard.Type;
  try {
    shard = Schema.decodeSync(Schema.fromJsonString(RetainedArrivalShard))(encoded);
  } catch {
    throw new QualificationPartitionConflict({
      message: "Arrival partition authority is invalid",
    });
  }
  const { bodyChecksum, ...content } = shard;
  if (
    shard.chunkIndex !== arrival.chunkIndex ||
    shard.executionId !== payload.executionId ||
    shard.planChecksum !== payload.planChecksum ||
    shard.records.length !== arrival.recordCount ||
    shard.runId !== arrival.runId ||
    shard.streamChunkIndex !== arrival.streamChunkIndex ||
    bodyChecksum !== qualificationChecksum(content) ||
    retained.customMetadata?.["osfo-artifact-checksum"] !== arrival.artifactChecksum ||
    retained.customMetadata?.["osfo-body-sha256"] !== (await sha256Hex(encoded)) ||
    retained.customMetadata?.["osfo-component"] !== "arrivals" ||
    retained.customMetadata?.["osfo-execution-id"] !== payload.executionId ||
    retained.customMetadata?.["osfo-index"] !== "0" ||
    retained.customMetadata?.["osfo-plan-checksum"] !== payload.planChecksum ||
    retained.customMetadata?.["osfo-previous-checksum"] !== "NONE" ||
    retained.customMetadata?.["osfo-record-count"] !== String(shard.records.length) ||
    retained.customMetadata?.["osfo-stream-chunk-index"] !== String(arrival.streamChunkIndex)
  ) {
    throw new QualificationPartitionConflict({
      message: "Arrival partition authority conflicts",
    });
  }
  return { bodyChecksum, recordCount: shard.records.length };
};

const retainCompletion = async (
  env: QualificationOwnerPartitionEnv,
  payload: QualificationOwnerPartitionWorkflowPayload,
  outcome: {
    readonly arrival: typeof QualificationProductAuthorityArrivalChunk.Type | null;
    readonly failureCode: string | null;
    readonly leafInputArtifactChecksum: string | null;
    readonly leafInputArtifactId: string | null;
    readonly missingSources: ReadonlyArray<(typeof qualificationAuthoritySources)[number]>;
    readonly sourceChecksums: ReadonlyArray<{
      readonly checksum: string;
      readonly recordCount: number;
      readonly source: string;
    }>;
    readonly status: "COMPLETE" | "FAIL" | "MISSING";
  },
) => {
  const streamChunkIndex = payload.firstStreamChunkIndex;
  const artifactId = partitionCompletionArtifactId(payload.executionId, streamChunkIndex);
  const content = {
    arrivalArtifactChecksum: outcome.arrival?.artifactChecksum ?? null,
    arrivalArtifactId: outcome.arrival?.artifactId ?? null,
    artifactId,
    chunkIndex: payload.chunks[0]?.chunkIndex ?? -1,
    executionId: payload.executionId,
    failureCode: outcome.failureCode,
    leafInputArtifactChecksum: outcome.leafInputArtifactChecksum,
    leafInputArtifactId: outcome.leafInputArtifactId,
    missingSources: outcome.missingSources,
    outcome: outcome.status,
    partitionIndex: payload.partitionIndex,
    planChecksum: payload.planChecksum,
    recordCount: outcome.arrival?.recordCount ?? 0,
    runId: payload.chunks[0]?.runId ?? "",
    sourceChecksums: outcome.sourceChecksums,
    streamChunkIndex,
    version: "qualification-owner-partition-v1" as const,
  };
  const receipt = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(receipt);
  const retained = await env.ARTIFACTS.put(artifactId, encoded, {
    customMetadata: {
      "osfo-artifact-checksum": receipt.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-execution-id": payload.executionId,
      "osfo-index": String(streamChunkIndex),
      "osfo-kind": "qualification-owner-partition-v1",
      "osfo-outcome": outcome.status,
      "osfo-plan-checksum": payload.planChecksum,
      "osfo-record-count": String(outcome.arrival?.recordCount ?? 0),
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return receipt;
  const existing = await env.ARTIFACTS.get(artifactId);
  if (existing === null || (await existing.text()) !== encoded) {
    throw new Error("Qualification partition completion conflicts");
  }
  return receipt;
};

const runQualificationOwnerPartitionAttempt = async (input: {
  readonly env: QualificationOwnerPartitionEnv;
  readonly payload: QualificationOwnerPartitionWorkflowPayload;
  readonly step: QualificationOwnerPartitionStep;
}) => {
  const chunk = input.payload.chunks[0];
  if (
    chunk === undefined ||
    input.payload.chunks.length !== 1 ||
    chunk.streamChunkIndex !== input.payload.firstStreamChunkIndex ||
    chunk.streamChunkIndex !== input.payload.lastStreamChunkIndex
  ) {
    throw new Error("Qualification child must own exactly one frozen arrival chunk");
  }
  const faultPreparation = await decodeFaultPreparationStepResult(
    await input.step.do(`prepare controlled fault ${chunk.streamChunkIndex}`, async () => {
      const response = await input.env.PRODUCT_AUTHORITY.fetch(
        "https://qualification-product-authority.internal/v1/executions/controlled-agent-fault-preparations",
        {
          body: canonicalQualificationJson({
            chunkIndex: chunk.chunkIndex,
            executionId: input.payload.executionId,
            manifestChecksum: input.payload.manifestChecksum,
            planChecksum: input.payload.planChecksum,
            requestArtifactChecksum: input.payload.requestArtifactChecksum,
            requestArtifactId: input.payload.requestArtifactId,
            runId: chunk.runId,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status === 200) return FaultPreparationStepResult.cases.Ready.make({});
      if (response.status === 424) return FaultPreparationStepResult.cases.Missing.make({});
      throw new Error(`Controlled fault preparation returned ${response.status}`);
    }),
  );
  if (faultPreparation._tag === "Missing") {
    return retainCompletion(input.env, input.payload, {
      arrival: null,
      failureCode: null,
      leafInputArtifactChecksum: null,
      leafInputArtifactId: null,
      missingSources: ["qualification_fault_controller_receipts"],
      sourceChecksums: [],
      status: "MISSING",
    });
  }
  await input.step.sleepUntil(
    `await offered chunk ${chunk.streamChunkIndex}`,
    chunk.firstOfferedAtEpochMs,
  );
  const invocation = {
    chunkIndex: chunk.chunkIndex,
    executionId: input.payload.executionId,
    manifestChecksum: input.payload.manifestChecksum,
    planChecksum: input.payload.planChecksum,
    requestArtifactChecksum: input.payload.requestArtifactChecksum,
    requestArtifactId: input.payload.requestArtifactId,
    runId: chunk.runId,
  };
  const arrival = await input.step.do(
    `execute arrival chunk ${chunk.streamChunkIndex}`,
    async () => {
      const response = await input.env.PRODUCT_AUTHORITY.fetch(
        "https://qualification-product-authority.internal/v1/executions/arrival-chunks",
        {
          body: canonicalQualificationJson(invocation),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status !== 200) throw new Error(`Arrival chunk returned ${response.status}`);
      return decodeArrival(await response.text());
    },
  );
  let bundle: typeof QualificationProductAuthoritySourceBundleComplete.Type | null = null;
  let lastRetryAtEpochMs = -1;
  for (let attempt = 0; attempt < maximumBundlePolls; attempt += 1) {
    const result = await decodeStepResult(
      await input.step.do(`collect authority bundle attempt ${attempt + 1}`, async () => {
        const response = await input.env.PRODUCT_AUTHORITY.fetch(
          "https://qualification-product-authority.internal/v1/executions/source-bundles",
          {
            body: canonicalQualificationJson(invocation),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        if (response.status === 200) {
          return PartitionStepResult.cases.Complete.make({
            outcome: await decodeComplete(await response.text()),
          });
        }
        if (response.status === 202) {
          return PartitionStepResult.cases.Pending.make({
            outcome: await decodePending(await response.text()),
          });
        }
        if (response.status === 424) {
          return PartitionStepResult.cases.Missing.make({
            outcome: await decodeMissing(await response.text()),
          });
        }
        throw new Error(`Authority source bundle returned ${response.status}`);
      }),
    );
    if (result._tag === "Missing") {
      return retainCompletion(input.env, input.payload, {
        arrival,
        failureCode: null,
        leafInputArtifactChecksum: null,
        leafInputArtifactId: null,
        missingSources: result.outcome.missingSources.map(({ source }) => source),
        sourceChecksums: [],
        status: "MISSING",
      });
    }
    if (result._tag === "Complete") {
      bundle = result.outcome;
      break;
    }
    if (result.outcome.retryAtEpochMs <= lastRetryAtEpochMs) {
      throw new Error("Authority bundle retry did not advance");
    }
    lastRetryAtEpochMs = result.outcome.retryAtEpochMs;
    await input.step.sleepUntil(
      `wait for authority bundle attempt ${attempt + 1}`,
      result.outcome.retryAtEpochMs,
    );
  }
  if (bundle === null) {
    return retainCompletion(input.env, input.payload, {
      arrival,
      failureCode: null,
      leafInputArtifactChecksum: null,
      leafInputArtifactId: null,
      missingSources: qualificationAuthoritySources,
      sourceChecksums: [],
      status: "MISSING",
    });
  }
  if (
    bundle.streamChunkIndex !== chunk.streamChunkIndex ||
    bundle.recordCounts.length !== qualificationAuthoritySources.length
  ) {
    throw new QualificationPartitionConflict({
      message: "Authority bundle conflicts with its frozen chunk",
    });
  }
  const verifiedAuthority = await input.step.do(
    `verify authority bodies ${chunk.streamChunkIndex}`,
    async () => {
      const arrivalBody = await verifyArrivalBody(input.env, input.payload, arrival);
      const sourceChecksums = await readSourceChecksums(
        input.env,
        input.payload,
        chunk.streamChunkIndex,
      );
      return { arrivalBody, sourceChecksums };
    },
  );
  const sourceChecksums = verifiedAuthority.sourceChecksums;
  const bundledSources = new Set<string>(qualificationAuthoritySources);
  if (
    bundle.recordCounts.some(({ source }) => !bundledSources.delete(source)) ||
    bundle.recordCounts.some(
      (actual) =>
        sourceChecksums.find(({ source }) => source === actual.source)?.recordCount !==
        actual.recordCount,
    )
  ) {
    throw new QualificationPartitionConflict({
      message: "Authority bundle record counts conflict",
    });
  }
  const leafInput = qualificationEvaluationLeafInputReceipt({
    artifactId: evaluationLeafInputArtifactId(input.payload.executionId, chunk.streamChunkIndex),
    arrivalChecksum: verifiedAuthority.arrivalBody.bodyChecksum,
    arrivalRecordCount: verifiedAuthority.arrivalBody.recordCount,
    authorityInputs: sourceChecksums.map(({ checksum, recordCount, source }) => ({
      checksum,
      recordCount,
      source: Schema.decodeUnknownSync(Schema.Literals(qualificationAuthoritySources))(source),
    })),
    executionId: input.payload.executionId,
    partitionAuthorityChecksum: qualificationChecksum({
      arrivalChecksum: verifiedAuthority.arrivalBody.bodyChecksum,
      executionId: input.payload.executionId,
      partitionIndex: input.payload.partitionIndex,
      planChecksum: input.payload.planChecksum,
      sourceChecksums,
      streamChunkIndex: chunk.streamChunkIndex,
    }),
    partitionIndex: input.payload.partitionIndex,
    planChecksum: input.payload.planChecksum,
    streamChunkIndex: chunk.streamChunkIndex,
  });
  if (leafInput === null) {
    throw new QualificationPartitionConflict({
      message: "Evaluation leaf input conflicts with partition authority",
    });
  }
  const leafRetention = await input.step.do(
    `retain evaluation leaf input ${chunk.streamChunkIndex}`,
    () =>
      retainQualificationEvaluationArtifact({
        artifactId: leafInput.artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: leafInput.checksum,
        encoded: canonicalQualificationJson(leafInput),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-leaf-input-v1",
        metadata: {
          "osfo-index": String(chunk.streamChunkIndex),
          "osfo-record-count": String(leafInput.arrivalRecordCount),
        },
        planChecksum: input.payload.planChecksum,
      }),
  );
  if (leafRetention === "CONFLICT") {
    throw new QualificationPartitionConflict({ message: "Evaluation leaf input conflicts" });
  }
  return input.step.do(`retain partition completion ${chunk.streamChunkIndex}`, () =>
    retainCompletion(input.env, input.payload, {
      arrival,
      failureCode: null,
      leafInputArtifactChecksum: leafInput.checksum,
      leafInputArtifactId: leafInput.artifactId,
      missingSources: [],
      sourceChecksums,
      status: "COMPLETE",
    }),
  );
};

export const runQualificationOwnerPartition = async (
  input: Parameters<typeof runQualificationOwnerPartitionAttempt>[0],
) => {
  try {
    return await runQualificationOwnerPartitionAttempt(input);
  } catch (cause) {
    if (!(cause instanceof QualificationPartitionConflict)) throw cause;
    return input.step.do(`retain failed partition ${input.payload.partitionIndex}`, () =>
      retainCompletion(input.env, input.payload, {
        arrival: null,
        failureCode: "qualificationPartitionAuthorityConflict",
        leafInputArtifactChecksum: null,
        leafInputArtifactId: null,
        missingSources: [],
        sourceChecksums: [],
        status: "FAIL",
      }),
    );
  }
};

export class QualificationOwnerPartitionWorkflow extends WorkflowEntrypoint<
  QualificationOwnerPartitionEnv,
  QualificationOwnerPartitionWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationOwnerPartitionWorkflowPayload>>,
    step: WorkflowStep,
  ) {
    return runQualificationOwnerPartition({ env: this.env, payload: event.payload, step });
  }
}
