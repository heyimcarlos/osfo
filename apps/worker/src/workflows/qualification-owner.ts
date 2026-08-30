import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import { QualificationEvaluationLeafInputReceipt } from "../qualification/qualification-evaluation-reducer";
import {
  QualificationProductAuthorityMissing,
  QualificationProductAuthorityPreflight,
  QualificationProductAuthoritySourceChunkComplete,
  QualificationProductAuthoritySourceChunkInvocation,
  QualificationProductAuthoritySourceChunkPending,
  type QualificationProductAuthorityInvocation,
  type QualificationProductAuthoritySourceChunkSource,
} from "../qualification/product-authority-contract";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type {
  QualificationEvaluationLeafWorkflowPayload,
  QualificationOwnerPartitionWorkflowPayload,
  QualificationOwnerWorkflowPayload,
} from "../workflow-contracts";
import {
  retainFailedQualificationReport,
  retainMissingQualificationReport,
} from "./qualification-owner-report";
import {
  retainQualificationEvaluationLeafLaunchPage,
  runQualificationOwnerLeafFanout,
} from "./qualification-owner-leaves";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Cloudflare Workflow APIs are Promise-only host boundaries; source polling must run as ordered, durable, uniquely named tagged steps. */

interface QualificationOwnerWorkflowEnv {
  readonly ARTIFACTS: QualificationOwnerArtifactBucket;
  readonly PRODUCT_AUTHORITY: Pick<Fetcher, "fetch">;
  readonly QUALIFICATION_OWNER_PARTITION_WORKFLOW: {
    readonly createBatch: (
      batch: ReadonlyArray<{
        readonly id: string;
        readonly params: QualificationOwnerPartitionWorkflowPayload;
      }>,
    ) => Promise<ReadonlyArray<{ readonly id: string }>>;
    readonly get: (id: string) => Promise<{ readonly id: string }>;
  };
  readonly QUALIFICATION_EVALUATION_LEAF_WORKFLOW: {
    readonly createBatch: (
      batch: ReadonlyArray<{
        readonly id: string;
        readonly params: QualificationEvaluationLeafWorkflowPayload;
      }>,
    ) => Promise<ReadonlyArray<{ readonly id: string }>>;
    readonly get: (id: string) => Promise<{ readonly id: string }>;
  };
}

const RetainedOwnerRequest = Schema.Struct({
  artifactChecksum: Schema.String,
  authoritySources: Schema.Array(Schema.String),
  cohortArtifactChecksum: Schema.String,
  cohortArtifactId: Schema.String,
  executionId: Schema.String,
  manifest: Schema.Unknown,
  manifestChecksum: Schema.String,
  plan: Schema.Unknown,
  planChecksum: Schema.String,
  protocolVersion: Schema.Literal("qualification-owner-v1"),
  shardRecordLimit: Schema.Literal(256),
});
const decodeRetainedOwnerRequest = Schema.decodeUnknownPromise(
  Schema.fromJsonString(RetainedOwnerRequest),
);

const decodePreflight = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthorityPreflight),
);
const decodeSourceComplete = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthoritySourceChunkComplete),
);
const decodeSourceMissing = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthorityMissing),
);
const decodeSourcePending = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthoritySourceChunkPending),
);
const QualificationSourceCollectionStepResult = Schema.TaggedUnion({
  Complete: { outcome: QualificationProductAuthoritySourceChunkComplete },
  Missing: { outcome: QualificationProductAuthorityMissing },
  Pending: { outcome: QualificationProductAuthoritySourceChunkPending },
});
type QualificationSourceCollectionStepResult = typeof QualificationSourceCollectionStepResult.Type;
const decodeSourceStepResult = Schema.decodePromise(QualificationSourceCollectionStepResult);

const maximumSourceCollectionPolls = 100;
const RetainedManifestIdentity = Schema.Struct({ sourceVersion: Schema.String });
const RetainedPlanIdentity = Schema.Struct({ startsAtEpochMs: Schema.Int });
const PartitionCompletion = Schema.Struct({
  arrivalArtifactChecksum: Schema.NullOr(Schema.String),
  arrivalArtifactId: Schema.NullOr(Schema.String),
  artifactId: Schema.String,
  checksum: Schema.String,
  chunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  executionId: Schema.String,
  failureCode: Schema.NullOr(Schema.String),
  leafInputArtifactChecksum: Schema.NullOr(Schema.String),
  leafInputArtifactId: Schema.NullOr(Schema.String),
  missingSources: Schema.Array(Schema.Literals(qualificationAuthoritySources)),
  outcome: Schema.Literals(["COMPLETE", "FAIL", "MISSING"]),
  partitionIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  planChecksum: Schema.String,
  recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.String,
  sourceChecksums: Schema.Array(
    Schema.Struct({
      checksum: Schema.String,
      recordCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      source: Schema.Literals(qualificationAuthoritySources),
    }),
  ),
  streamChunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  version: Schema.Literal("qualification-owner-partition-v1"),
});
const PartitionCompletionMetadata = Schema.Struct({
  "osfo-artifact-checksum": Schema.String,
  "osfo-body-sha256": Schema.String,
  "osfo-execution-id": Schema.String,
  "osfo-index": Schema.String,
  "osfo-kind": Schema.Literal("qualification-owner-partition-v1"),
  "osfo-outcome": Schema.Literals(["COMPLETE", "FAIL", "MISSING"]),
  "osfo-plan-checksum": Schema.String,
  "osfo-record-count": Schema.String,
});
const qualificationPartitionBatchSize = 50;
const qualificationFanoutSafetyMs = 60_000;

interface QualificationOwnerArtifactBucket {
  readonly get: (key: string) => Promise<{
    readonly customMetadata?: Readonly<Record<string, string>>;
    readonly text: () => Promise<string>;
  } | null>;
  readonly list: (options: {
    readonly cursor?: string;
    readonly include: ReadonlyArray<"customMetadata">;
    readonly limit: number;
    readonly prefix: string;
  }) => Promise<{
    readonly cursor?: string;
    readonly objects: ReadonlyArray<{
      readonly checksums: { readonly sha256?: ArrayBuffer | ArrayBufferView };
      readonly customMetadata?: Record<string, string>;
      readonly key: string;
    }>;
    readonly truncated: boolean;
  }>;
  readonly put: (
    key: string,
    value: string,
    options: R2PutOptions,
  ) => Promise<{ readonly etag: string } | null>;
}

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const retainImmutableJson = async (
  bucket: QualificationOwnerArtifactBucket,
  artifactId: string,
  encoded: string,
  metadata: Record<string, string>,
): Promise<void> => {
  const retained = await bucket.put(artifactId, encoded, {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return;
  const existing = await bucket.get(artifactId);
  if (existing === null || (await existing.text()) !== encoded) {
    throw new Error(`Retained qualification artifact conflicts: ${artifactId}`);
  }
};

interface FrozenPartition {
  readonly chunkIndex: number;
  readonly firstOfferedAtEpochMs: number;
  readonly partitionIndex: number;
  readonly runId: string;
  readonly streamChunkIndex: number;
}

const frozenPartitions = (
  runs: ReadonlyArray<{
    readonly chunkCount: number;
    readonly chunkStartsAtEpochMs: ReadonlyArray<number>;
    readonly firstStreamChunkIndex: number;
    readonly runId: string;
  }>,
): ReadonlyArray<FrozenPartition> => {
  let partitionIndex = 0;
  return runs.flatMap((run) =>
    Array.from({ length: run.chunkCount }, (_, chunkIndex) => {
      const firstOfferedAtEpochMs = run.chunkStartsAtEpochMs[chunkIndex];
      if (firstOfferedAtEpochMs === undefined) {
        throw new Error("Qualification preflight omits a chunk offer time");
      }
      return {
        chunkIndex,
        firstOfferedAtEpochMs,
        partitionIndex: partitionIndex++,
        runId: run.runId,
        streamChunkIndex: run.firstStreamChunkIndex + chunkIndex,
      };
    }),
  );
};

const fanoutLeadTimeMs = (partitionCount: number) =>
  Math.ceil(partitionCount / qualificationPartitionBatchSize) * 1_000 + qualificationFanoutSafetyMs;

const partitionCompletionPrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/owner-partitions`;
const partitionPagePrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/owner-partition-pages`;

export const verifyPartitionCompletionPages = async (input: {
  readonly bucket: QualificationOwnerArtifactBucket;
  readonly executionId: string;
  readonly manifestChecksum: string;
  readonly partitions: ReadonlyArray<FrozenPartition>;
  readonly planChecksum: string;
  readonly step: QualificationSourceCollectionStep;
}) => {
  const pages = new Array<{
    readonly checksum: string;
    readonly failureCodes: ReadonlyArray<string>;
    readonly firstStreamChunkIndex: number;
    readonly lastStreamChunkIndex: number;
    readonly launchPageChecksum: string | null;
    readonly missingSources: ReadonlyArray<string>;
    readonly recordCount: number;
    readonly sourceDigests: ReadonlyArray<{
      readonly digest: string;
      readonly recordCount: number;
      readonly source: string;
    }>;
  }>();
  let inventoryCursor: string | undefined;
  let inventoryObjectCount = 0;
  let inventoryPageIndex = 0;
  let previousInventoryIndex = -1;
  do {
    const inventory = await input.step.do(
      `inventory partition completion page ${inventoryPageIndex}`,
      async () => {
        const options = {
          include: ["customMetadata"] as const,
          limit: qualificationPartitionBatchSize,
          prefix: `${partitionCompletionPrefix(input.executionId)}/`,
        };
        const listed = await input.bucket.list(
          inventoryCursor === undefined ? options : { ...options, cursor: inventoryCursor },
        );
        if (listed.truncated && (listed.cursor === undefined || listed.objects.length === 0)) {
          throw new Error("Qualification partition completion listing did not advance");
        }
        let lastIndex = previousInventoryIndex;
        for (const object of listed.objects) {
          const prefix = `${partitionCompletionPrefix(input.executionId)}/`;
          const suffix = object.key.slice(prefix.length);
          if (!object.key.startsWith(prefix) || !/^[0-9]{8}\.json$/.test(suffix)) {
            throw new Error("Qualification partition completion has an unexpected object");
          }
          const streamChunkIndex = Number(suffix.slice(0, 8));
          const expected = input.partitions[streamChunkIndex];
          if (
            expected === undefined ||
            expected.streamChunkIndex !== streamChunkIndex ||
            streamChunkIndex <= lastIndex
          ) {
            throw new Error("Qualification partition completion inventory conflicts");
          }
          // oxlint-disable-next-line effecttsgo/prefer-typed-schema-decoder -- R2 custom metadata is optional untrusted input at this boundary.
          const metadata = Schema.decodeUnknownSync(PartitionCompletionMetadata)(
            object.customMetadata,
          );
          if (
            metadata["osfo-execution-id"] !== input.executionId ||
            metadata["osfo-index"] !== String(streamChunkIndex) ||
            metadata["osfo-plan-checksum"] !== input.planChecksum
          ) {
            throw new Error("Qualification partition completion inventory conflicts");
          }
          lastIndex = streamChunkIndex;
        }
        return {
          count: listed.objects.length,
          lastIndex,
          nextCursor: listed.truncated ? listed.cursor : null,
        };
      },
    );
    previousInventoryIndex = inventory.lastIndex;
    inventoryObjectCount += inventory.count;
    inventoryCursor = inventory.nextCursor ?? undefined;
    inventoryPageIndex += 1;
  } while (inventoryCursor !== undefined);

  let observedPartitionCount = 0;
  let previousPageChecksum = "NONE";
  let previousLaunchPageChecksum = "NONE";
  const pageCount = Math.ceil(input.partitions.length / qualificationPartitionBatchSize);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const expectedPartitions = input.partitions.slice(
      pageIndex * qualificationPartitionBatchSize,
      (pageIndex + 1) * qualificationPartitionBatchSize,
    );
    const result = await input.step.do(
      `verify partition completion page ${pageIndex}`,
      async () => {
        const receipts = new Array<typeof PartitionCompletion.Type>();
        for (const expected of expectedPartitions) {
          const artifactId = `${partitionCompletionPrefix(input.executionId)}/${expected.streamChunkIndex.toString().padStart(8, "0")}.json`;
          const listed = await input.bucket.list({
            include: ["customMetadata"],
            limit: 2,
            prefix: artifactId,
          });
          if (
            listed.truncated ||
            listed.objects.length > 1 ||
            listed.objects.some(({ key }) => key !== artifactId)
          ) {
            throw new Error(`Qualification partition ${expected.streamChunkIndex} conflicts`);
          }
          const retained = await input.bucket.get(artifactId);
          if (retained === null && listed.objects.length === 0) continue;
          if (retained === null || listed.objects.length !== 1) {
            throw new Error(`Qualification partition ${expected.streamChunkIndex} conflicts`);
          }
          const encoded = await retained.text();
          const receipt = Schema.decodeSync(Schema.fromJsonString(PartitionCompletion))(encoded);
          const { checksum, ...content } = receipt;
          const bodySha256 = await sha256Hex(encoded);
          // oxlint-disable-next-line effecttsgo/prefer-typed-schema-decoder -- R2 custom metadata is optional untrusted input at this boundary.
          const listedMetadata = Schema.decodeUnknownSync(PartitionCompletionMetadata)(
            listed.objects[0]?.customMetadata,
          );
          // oxlint-disable-next-line effecttsgo/prefer-typed-schema-decoder -- R2 custom metadata is optional untrusted input at this boundary.
          const retainedMetadata = Schema.decodeUnknownSync(PartitionCompletionMetadata)(
            retained.customMetadata,
          );
          const exactSources = new Set<string>(qualificationAuthoritySources);
          const hasExactSources =
            receipt.sourceChecksums.length === exactSources.size &&
            receipt.sourceChecksums.every(({ source }) => exactSources.delete(source));
          let leafInputValid = receipt.outcome !== "COMPLETE";
          if (
            receipt.outcome === "COMPLETE" &&
            receipt.leafInputArtifactId !== null &&
            receipt.leafInputArtifactChecksum !== null
          ) {
            const leafObject = await input.bucket.get(receipt.leafInputArtifactId);
            if (leafObject !== null) {
              const leafEncoded = await leafObject.text();
              try {
                const leaf = Schema.decodeSync(
                  Schema.fromJsonString(QualificationEvaluationLeafInputReceipt),
                )(leafEncoded);
                const { checksum: leafChecksum, ...leafContent } = leaf;
                const expectedPartitionAuthorityChecksum = qualificationChecksum({
                  arrivalChecksum: leaf.arrivalChecksum,
                  executionId: input.executionId,
                  partitionIndex: expected.partitionIndex,
                  planChecksum: input.planChecksum,
                  sourceChecksums: receipt.sourceChecksums,
                  streamChunkIndex: expected.streamChunkIndex,
                });
                leafInputValid =
                  leaf.artifactId === receipt.leafInputArtifactId &&
                  leaf.checksum === receipt.leafInputArtifactChecksum &&
                  leaf.checksum === qualificationChecksum(leafContent) &&
                  leaf.executionId === input.executionId &&
                  leaf.partitionAuthorityChecksum === expectedPartitionAuthorityChecksum &&
                  leaf.partitionIndex === expected.partitionIndex &&
                  leaf.planChecksum === input.planChecksum &&
                  leaf.streamChunkIndex === expected.streamChunkIndex &&
                  qualificationChecksum(leaf.authorityInputs) ===
                    qualificationChecksum(receipt.sourceChecksums) &&
                  leafObject.customMetadata?.["osfo-artifact-checksum"] === leafChecksum &&
                  leafObject.customMetadata?.["osfo-body-sha256"] ===
                    (await sha256Hex(leafEncoded)) &&
                  leafObject.customMetadata?.["osfo-execution-id"] === input.executionId &&
                  leafObject.customMetadata?.["osfo-index"] === String(expected.streamChunkIndex) &&
                  leafObject.customMetadata?.["osfo-kind"] ===
                    "qualification-evaluation-leaf-input-v1" &&
                  leafObject.customMetadata?.["osfo-plan-checksum"] === input.planChecksum &&
                  leafObject.customMetadata?.["osfo-record-count"] ===
                    String(leaf.arrivalRecordCount);
              } catch {
                leafInputValid = false;
              }
            }
          }
          const metadataValues = [listedMetadata, retainedMetadata];
          if (
            receipt.artifactId !== artifactId ||
            receipt.chunkIndex !== expected.chunkIndex ||
            receipt.executionId !== input.executionId ||
            receipt.partitionIndex !== expected.partitionIndex ||
            receipt.planChecksum !== input.planChecksum ||
            receipt.runId !== expected.runId ||
            receipt.streamChunkIndex !== expected.streamChunkIndex ||
            (receipt.outcome === "COMPLETE"
              ? !hasExactSources ||
                receipt.missingSources.length !== 0 ||
                receipt.failureCode !== null ||
                receipt.leafInputArtifactChecksum === null ||
                receipt.leafInputArtifactId === null
              : receipt.sourceChecksums.length !== 0) ||
            !leafInputValid ||
            checksum !== qualificationChecksum(content) ||
            metadataValues.some(
              (metadata) =>
                metadata["osfo-artifact-checksum"] !== checksum ||
                metadata["osfo-body-sha256"] !== bodySha256 ||
                metadata["osfo-execution-id"] !== input.executionId ||
                metadata["osfo-index"] !== String(expected.streamChunkIndex) ||
                metadata["osfo-outcome"] !== receipt.outcome ||
                metadata["osfo-plan-checksum"] !== input.planChecksum ||
                metadata["osfo-record-count"] !== String(receipt.recordCount),
            )
          ) {
            throw new Error(`Qualification partition ${expected.streamChunkIndex} conflicts`);
          }
          receipts.push(receipt);
        }
        const sourceDigests = qualificationAuthoritySources.map((source) => ({
          digest: qualificationChecksum(
            receipts.map(
              (receipt) =>
                receipt.sourceChecksums.find((candidate) => candidate.source === source)?.checksum,
            ),
          ),
          recordCount: receipts.reduce(
            (total, receipt) =>
              total +
              (receipt.sourceChecksums.find((candidate) => candidate.source === source)
                ?.recordCount ?? 0),
            0,
          ),
          source,
        }));
        let launchPageChecksum: string | null = null;
        if (
          inventoryObjectCount === input.partitions.length &&
          receipts.length === expectedPartitions.length &&
          receipts.every(({ outcome }) => outcome === "COMPLETE")
        ) {
          const launchInputs = receipts.map((receipt) => {
            if (
              receipt.leafInputArtifactId === null ||
              receipt.leafInputArtifactChecksum === null
            ) {
              throw new Error("Complete qualification partition omits its leaf input");
            }
            return {
              leafInputArtifactId: receipt.leafInputArtifactId,
              leafInputChecksum: receipt.leafInputArtifactChecksum,
              partitionIndex: receipt.partitionIndex,
              runId: receipt.runId,
            };
          });
          const launchPage = await retainQualificationEvaluationLeafLaunchPage({
            bucket: input.bucket,
            executionId: input.executionId,
            inputs: launchInputs,
            manifestChecksum: input.manifestChecksum,
            pageIndex,
            planChecksum: input.planChecksum,
            previousPageChecksum: previousLaunchPageChecksum,
          });
          launchPageChecksum = launchPage.checksum;
        }
        const pageContent = {
          evaluationLeafInputDigest: qualificationChecksum(
            receipts.map(({ leafInputArtifactChecksum }) => leafInputArtifactChecksum),
          ),
          executionId: input.executionId,
          failureCodes: receipts.flatMap(({ failureCode }) =>
            failureCode === null ? [] : [failureCode],
          ),
          firstStreamChunkIndex: expectedPartitions[0]?.streamChunkIndex ?? -1,
          lastStreamChunkIndex: expectedPartitions.at(-1)?.streamChunkIndex ?? -1,
          launchPageChecksum,
          missingSources: [...new Set(receipts.flatMap(({ missingSources }) => missingSources))],
          pageIndex,
          planChecksum: input.planChecksum,
          previousPageChecksum,
          recordCount: receipts.reduce((total, receipt) => total + receipt.recordCount, 0),
          sourceDigests,
          version: "qualification-owner-partition-page-v1" as const,
        };
        const pageReceipt = { ...pageContent, checksum: qualificationChecksum(pageContent) };
        await retainImmutableJson(
          input.bucket,
          `${partitionPagePrefix(input.executionId)}/${pageIndex.toString().padStart(8, "0")}.json`,
          canonicalQualificationJson(pageReceipt),
          {
            "osfo-artifact-checksum": pageReceipt.checksum,
            "osfo-execution-id": input.executionId,
            "osfo-kind": "qualification-owner-partition-page-v1",
          },
        );
        return { launchPageChecksum, pageReceipt, receiptCount: receipts.length };
      },
    );
    pages.push(result.pageReceipt);
    observedPartitionCount += result.receiptCount;
    previousPageChecksum = result.pageReceipt.checksum;
    if (result.launchPageChecksum !== null) {
      previousLaunchPageChecksum = result.launchPageChecksum;
    }
  }
  const missingPartitionCount = input.partitions.length - observedPartitionCount;
  const launchPageChecksums = pages.flatMap(({ launchPageChecksum }) =>
    launchPageChecksum === null ? [] : [launchPageChecksum],
  );
  return {
    launch:
      missingPartitionCount === 0 && launchPageChecksums.length === pageCount
        ? {
            pageCount,
            partitionCount: input.partitions.length,
            terminalPageChecksum: launchPageChecksums.at(-1) ?? "NONE",
          }
        : null,
    missingPartitionCount,
    pages,
  };
};

export interface QualificationSourceCollectionStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

export type QualificationSourceCollectionOutcome =
  | typeof QualificationProductAuthorityMissing.Type
  | typeof QualificationProductAuthoritySourceChunkComplete.Type;

/** Poll one frozen source shard through its owning service without holding a Worker request open. */
export const collectQualificationSourceChunk = async (input: {
  readonly chunkIndex: number;
  readonly fetcher: Pick<Fetcher, "fetch">;
  readonly invocation: QualificationProductAuthorityInvocation;
  readonly runId: string;
  readonly source: QualificationProductAuthoritySourceChunkSource;
  readonly step: QualificationSourceCollectionStep;
  readonly streamChunkIndex: number;
}): Promise<QualificationSourceCollectionOutcome> => {
  let lastRetryAtEpochMs = -1;
  for (let attempt = 0; attempt < maximumSourceCollectionPolls; attempt += 1) {
    const result = await decodeSourceStepResult(
      await input.step.do(
        `collect ${input.source} chunk ${input.chunkIndex} attempt ${attempt + 1}`,
        async () => {
          const response = await input.fetcher.fetch(
            "https://qualification-product-authority.internal/v1/executions/source-chunks",
            {
              body: JSON.stringify(
                QualificationProductAuthoritySourceChunkInvocation.make({
                  ...input.invocation,
                  chunkIndex: input.chunkIndex,
                  runId: input.runId,
                  source: input.source,
                }),
              ),
              headers: { "content-type": "application/json" },
              method: "POST",
            },
          );
          if (response.status === 200) {
            return QualificationSourceCollectionStepResult.cases.Complete.make({
              outcome: await decodeSourceComplete(await response.text()),
            });
          }
          if (response.status === 424) {
            return QualificationSourceCollectionStepResult.cases.Missing.make({
              outcome: await decodeSourceMissing(await response.text()),
            });
          }
          if (response.status === 202) {
            return QualificationSourceCollectionStepResult.cases.Pending.make({
              outcome: await decodeSourcePending(await response.text()),
            });
          }
          throw new Error(`Product authority source collection returned ${response.status}`);
        },
      ),
    );
    if (result._tag === "Complete") {
      if (
        result.outcome.source !== input.source ||
        result.outcome.streamChunkIndex !== input.streamChunkIndex
      ) {
        throw new Error("Product authority source completion conflicts with the frozen source");
      }
      return result.outcome;
    }
    if (result._tag === "Missing") {
      if (!result.outcome.missingSources.some(({ source }) => source === input.source)) {
        throw new Error("Product authority missing result conflicts with the frozen source");
      }
      return result.outcome;
    }
    const pending = result.outcome;
    if (pending.source !== input.source || pending.retryAtEpochMs <= lastRetryAtEpochMs) {
      throw new Error("Product authority source retry conflicts with the frozen source");
    }
    lastRetryAtEpochMs = pending.retryAtEpochMs;
    await input.step.sleepUntil(
      `wait for ${input.source} chunk ${input.chunkIndex} attempt ${attempt + 1}`,
      pending.retryAtEpochMs,
    );
  }
  return QualificationProductAuthorityMissing.make({
    missingSources: [
      {
        detail: `${input.source} did not settle within the bounded collector`,
        source: input.source,
      },
    ],
    status: "MISSING",
  });
};

type QualificationOwnerWorkflowResult =
  | { readonly status: "COMPLETE"; readonly verdict: "FAIL" | "MISSING" | "PASS" }
  | { readonly status: "MISSING" };

/** Execute one frozen qualification through serializable, replay-safe Workflow phases. */
export const runQualificationOwnerWorkflow = async (input: {
  readonly env: QualificationOwnerWorkflowEnv;
  readonly payload: QualificationOwnerWorkflowPayload;
  readonly step: QualificationSourceCollectionStep;
}): Promise<QualificationOwnerWorkflowResult> => {
  const request = await input.step.do("validate frozen qualification request", async () => {
    const retained = await input.env.ARTIFACTS.get(input.payload.requestArtifactId);
    if (retained === null) throw new Error("Frozen qualification request is missing");
    const decoded = await decodeRetainedOwnerRequest(await retained.text());
    const { artifactChecksum, ...content } = decoded;
    const manifestIdentity = Schema.decodeUnknownSync(RetainedManifestIdentity)(decoded.manifest);
    const planIdentity = Schema.decodeUnknownSync(RetainedPlanIdentity)(decoded.plan);
    if (
      artifactChecksum !== input.payload.requestArtifactChecksum ||
      artifactChecksum !== qualificationChecksum(content) ||
      decoded.executionId !== input.payload.executionId ||
      decoded.manifestChecksum !== input.payload.manifestChecksum ||
      decoded.planChecksum !== input.payload.planChecksum
    ) {
      throw new Error("Frozen qualification request conflicts with the Workflow identity");
    }
    return {
      authoritySources: [...decoded.authoritySources],
      sourceVersion: manifestIdentity.sourceVersion,
      startsAtEpochMs: planIdentity.startsAtEpochMs,
    };
  });
  const preflight = await input.step.do("attempt product authority sources", async () => {
    if (
      request.authoritySources.length !== qualificationAuthoritySources.length ||
      qualificationAuthoritySources.some((source) => !request.authoritySources.includes(source))
    ) {
      throw new Error("Frozen qualification request omits a required authority source");
    }
    const response = await input.env.PRODUCT_AUTHORITY.fetch(
      "https://qualification-product-authority.internal/v1/executions/preflight",
      {
        body: canonicalQualificationJson(input.payload),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (response.status !== 200 && response.status !== 424) {
      throw new Error(`Product authority preflight returned ${response.status}`);
    }
    return decodePreflight(await response.text());
  });
  if (preflight.status === "MISSING") {
    await input.step.do("retain attempted missing qualification authority report", async () => {
      await retainMissingQualificationReport(
        input.env.ARTIFACTS,
        input.payload,
        preflight.missingSources.map(({ source }) => source),
      );
      return { retained: true };
    });
    return { status: "MISSING" };
  }

  const partitions = frozenPartitions(preflight.runs);
  if (
    partitions.length !== preflight.totalArrivalChunks ||
    partitions.some(({ partitionIndex, streamChunkIndex }) => partitionIndex !== streamChunkIndex)
  ) {
    throw new Error("Qualification preflight partition topology conflicts");
  }
  const fanoutStartedAtEpochMs = await input.step.do("capture qualification fanout time", () =>
    // oxlint-disable-next-line effecttsgo/global-date -- The Workflow step durably captures one replay-stable host timestamp.
    Promise.resolve(Date.now()),
  );
  const minimumStartsAtEpochMs = fanoutStartedAtEpochMs + fanoutLeadTimeMs(partitions.length);
  if (request.startsAtEpochMs < minimumStartsAtEpochMs) {
    await input.step.do("retain missing qualification fanout lead time", async () => {
      await retainMissingQualificationReport(input.env.ARTIFACTS, input.payload, [
        "qualification_fault_controller_receipts",
      ]);
      return { retained: true };
    });
    return { status: "MISSING" };
  }
  for (let offset = 0; offset < partitions.length; offset += qualificationPartitionBatchSize) {
    const batch = partitions.slice(offset, offset + qualificationPartitionBatchSize);
    const batchIndex = Math.floor(offset / qualificationPartitionBatchSize);
    await input.step.do(`create qualification partition batch ${batchIndex}`, async () => {
      const instances = batch.map((partition) => ({
        id: `${input.payload.executionId}:partition:${partition.partitionIndex}`,
        params: {
          ...input.payload,
          chunks: [partition],
          firstStreamChunkIndex: partition.streamChunkIndex,
          lastStreamChunkIndex: partition.streamChunkIndex,
          partitionIndex: partition.partitionIndex,
          sourceVersion: request.sourceVersion,
        },
      }));
      try {
        await input.env.QUALIFICATION_OWNER_PARTITION_WORKFLOW.createBatch(instances);
      } catch (cause) {
        try {
          await Promise.all(
            instances.map(({ id }) => input.env.QUALIFICATION_OWNER_PARTITION_WORKFLOW.get(id)),
          );
        } catch {
          throw cause;
        }
      }
      return { count: instances.length };
    });
    if (offset + qualificationPartitionBatchSize < partitions.length) {
      await input.step.sleepUntil(
        `rate limit qualification partition batch ${batchIndex + 1}`,
        fanoutStartedAtEpochMs + (batchIndex + 1) * 1_000,
      );
    }
  }
  const latestOfferedAtEpochMs = Math.max(
    ...partitions.map(({ firstOfferedAtEpochMs }) => firstOfferedAtEpochMs),
  );
  await input.step.sleepUntil(
    "await qualification partition authority horizon",
    latestOfferedAtEpochMs + 8 * 60_000,
  );
  const completion = await verifyPartitionCompletionPages({
    bucket: input.env.ARTIFACTS,
    executionId: input.payload.executionId,
    manifestChecksum: input.payload.manifestChecksum,
    partitions,
    planChecksum: input.payload.planChecksum,
    step: input.step,
  });
  if (completion.missingPartitionCount > 0) {
    await input.step.do("retain missing qualification partitions", async () => {
      await retainMissingQualificationReport(input.env.ARTIFACTS, input.payload, [
        "worker_admission_receipts",
      ]);
      return { retained: true };
    });
    return { status: "MISSING" };
  }
  const completionPages = completion.pages;
  const failureCodes = completionPages.flatMap(({ failureCodes: pageFailures }) => pageFailures);
  if (failureCodes.length > 0) {
    await input.step.do("retain failed qualification partition report", async () => {
      await retainFailedQualificationReport(input.env.ARTIFACTS, input.payload, failureCodes);
      return { retained: true };
    });
    return { status: "COMPLETE", verdict: "FAIL" };
  }
  const missingSources = [
    ...new Set(completionPages.flatMap(({ missingSources: pageMissing }) => pageMissing)),
  ];
  if (missingSources.length > 0) {
    await input.step.do("retain missing qualification partition report", async () => {
      await retainMissingQualificationReport(input.env.ARTIFACTS, input.payload, missingSources);
      return { retained: true };
    });
    return { status: "MISSING" };
  }
  if (completion.launch === null) {
    throw new Error("Complete qualification partitions omit the leaf launch authority");
  }
  const leafCompletion = await runQualificationOwnerLeafFanout({
    env: input.env,
    launch: completion.launch,
    payload: input.payload,
    step: input.step,
  });
  if (leafCompletion.status === "MISSING") {
    await input.step.do("retain missing qualification leaf completions", async () => {
      await retainMissingQualificationReport(input.env.ARTIFACTS, input.payload, [
        "qualification_evaluation_leaf_completions",
      ]);
      return { retained: true };
    });
    return { status: "MISSING" };
  }
  await input.step.do("retain missing bounded qualification reducer", async () => {
    await retainMissingQualificationReport(input.env.ARTIFACTS, input.payload, [
      "bounded_qualification_reducer",
    ]);
    return { retained: true };
  });
  return { status: "MISSING" };
};

/** Durable owner that records exact unavailable authority sources instead of inventing evidence. */
export class QualificationOwnerWorkflow extends WorkflowEntrypoint<
  QualificationOwnerWorkflowEnv,
  QualificationOwnerWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationOwnerWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<QualificationOwnerWorkflowResult> {
    return runQualificationOwnerWorkflow({ env: this.env, payload: event.payload, step });
  }
}
