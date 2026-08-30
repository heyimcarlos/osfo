import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { Schema } from "effect";

import {
  authenticateQualificationEvaluationSortedRunReceipt,
  qualificationEvaluationReducerFanIn,
  type QualificationEvaluationSortedRunReceipt,
  type QualificationEvaluationDimensionInventoryEntry,
} from "../qualification/qualification-evaluation-reducer";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type {
  QualificationEvaluationReducerWorkflowPayload,
  QualificationOwnerDimensionWorkflowPayload,
} from "../workflow-contracts";
import {
  QualificationDimensionCompletionPage,
  QualificationDimensionIndexSegment,
  QualificationDimensionLaunchPage,
  authenticateQualificationDimensionRoot,
  qualificationDimensionCoordinatorArtifactPrefix,
  qualificationDimensionEvaluation,
  qualificationDimensionPageSize,
  qualificationDimensionCoordinatorCompletionArtifactId,
  qualificationDimensionReducerPayload,
  qualificationDimensionReducerWorkflowId,
  qualificationDimensionSelectedIndexes,
  qualificationDimensionLevelDeadlineMs,
  readQualificationDimensionInventory,
  readQualificationDimensionSelectedValue,
  type QualificationDimensionBucket,
  type QualificationDimensionCoordinatorCompletion,
  type QualificationDimensionEvaluationPage,
  type QualificationDimensionInputReference,
  type QualificationDimensionRootPage,
} from "./qualification-owner-dimensions";
import {
  authenticateQualificationEvaluationLeafCompletion,
  authenticateQualificationEvaluationLeafJoinPage,
  qualificationEvaluationLeafJoinPageArtifactId,
  qualificationEvaluationLeafJoinPagePrefix,
} from "./qualification-owner-leaves";
import { createOrReconcileQualificationWorkflowBatch } from "./qualification-owner-correctness";
import { authenticateQualificationEvaluationCorrectnessReceipt } from "./qualification-evaluation-correctness-reducer";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Cloudflare Workflow, Workflow instance, and R2 APIs are Promise-only durable boundaries; every loop is bounded by the frozen inventory/page/fan-in policy. */

interface WorkflowStatus {
  readonly status:
    | "complete"
    | "errored"
    | "paused"
    | "queued"
    | "running"
    | "terminated"
    | "unknown"
    | "waiting"
    | "waitingForPause";
}

interface ReducerInstance {
  readonly id: string;
  readonly status: () => Promise<WorkflowStatus>;
}

export interface QualificationDimensionCoordinatorEnv {
  readonly ARTIFACTS: QualificationDimensionBucket & {
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
  };
  readonly QUALIFICATION_EVALUATION_REDUCER_WORKFLOW: {
    readonly createBatch: (
      batch: ReadonlyArray<{
        readonly id: string;
        readonly params: QualificationEvaluationReducerWorkflowPayload;
      }>,
    ) => Promise<ReadonlyArray<ReducerInstance>>;
    readonly get: (id: string) => Promise<ReducerInstance>;
  };
}

export interface QualificationDimensionStep {
  readonly do: {
    <Value extends Rpc.Serializable<Value>>(
      name: string,
      callback: () => Promise<Value>,
    ): Promise<Value>;
    <Value extends Rpc.Serializable<Value>>(
      name: string,
      config: WorkflowStepConfig,
      callback: () => Promise<Value>,
    ): Promise<Value>;
  };
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

const padded = (value: number) => value.toString().padStart(8, "0");
const bodySha256 = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const authenticChecksum = (value: { readonly checksum: string }) => {
  const { checksum, ...content } = value;
  return checksum === qualificationChecksum(content);
};
const exactMetadata = (
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
) =>
  actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value);
const dimensionKey = (dimension: string) => qualificationChecksum({ dimension });
const basePrefix = (executionId: string) =>
  qualificationDimensionCoordinatorArtifactPrefix(executionId);
const indexPrefix = (executionId: string, dimension: string) =>
  `${basePrefix(executionId)}/${dimensionKey(dimension)}/index`;
const indexArtifactId = (executionId: string, dimension: string, index: number) =>
  `${indexPrefix(executionId, dimension)}/${padded(index)}.json`;
const levelPrefix = (executionId: string, dimension: string, level: number) =>
  `${basePrefix(executionId)}/${dimensionKey(dimension)}/level-${padded(level)}`;
const launchArtifactId = (executionId: string, dimension: string, level: number, index: number) =>
  `${levelPrefix(executionId, dimension, level)}/launch/${padded(index)}.json`;
const completionArtifactId = (
  executionId: string,
  dimension: string,
  level: number,
  index: number,
) => `${levelPrefix(executionId, dimension, level)}/completion/${padded(index)}.json`;
const rootPageArtifactId = (executionId: string, index: number) =>
  `${basePrefix(executionId)}/root-pages/${padded(index)}.json`;
const evaluationPageArtifactId = (executionId: string, index: number) =>
  `${basePrefix(executionId)}/evaluation-pages/${padded(index)}.json`;

const retainImmutable = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationDimensionBucket;
  readonly encoded: string;
  readonly metadata: Readonly<Record<string, string>>;
}) => {
  const metadata = { ...input.metadata, "osfo-body-sha256": await bodySha256(input.encoded) };
  const retained = await input.bucket.put(input.artifactId, input.encoded, {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return;
  const existing = await input.bucket.get(input.artifactId);
  if (
    existing === null ||
    (await existing.text()) !== input.encoded ||
    !exactMetadata(existing.customMetadata, metadata)
  ) {
    throw new Error(`Retained qualification dimension artifact conflicts: ${input.artifactId}`);
  }
};

const indexMetadata = (
  segment: typeof QualificationDimensionIndexSegment.Type,
  sha256: string,
) => ({
  "osfo-artifact-checksum": segment.checksum,
  "osfo-body-sha256": sha256,
  "osfo-dimension": segment.dimension,
  "osfo-execution-id": segment.executionId,
  "osfo-first-partition-index": String(segment.firstPartitionIndex),
  "osfo-index": String(segment.index),
  "osfo-kind": "qualification-dimension-index-segment-v1",
  "osfo-last-partition-index": String(segment.lastPartitionIndex),
  "osfo-plan-checksum": segment.planChecksum,
  "osfo-previous-checksum": segment.previousSegmentChecksum,
  "osfo-record-count": String(segment.references.length),
});

const retainIndexSegment = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousSegmentChecksum: string;
  readonly receipts: ReadonlyArray<typeof QualificationEvaluationSortedRunReceipt.Type>;
  readonly valueType: "identity" | "latencyMs";
}) => {
  const first = input.receipts[0];
  const last = input.receipts.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.receipts.length > qualificationDimensionPageSize ||
    input.receipts.some(
      (receipt, index) =>
        receipt.dimension !== input.dimension ||
        receipt.valueType !== input.valueType ||
        (index > 0 &&
          receipt.firstPartitionIndex !==
            (input.receipts[index - 1]?.lastPartitionIndex ?? Number.NaN) + 1),
    )
  ) {
    throw new Error("Qualification dimension index receipts conflict");
  }
  const references = input.receipts.map(({ artifactId, checksum }) => ({ artifactId, checksum }));
  const artifactId = indexArtifactId(input.executionId, input.dimension, input.index);
  const content = {
    artifactId,
    dimension: input.dimension,
    executionId: input.executionId,
    firstPartitionIndex: first.firstPartitionIndex,
    index: input.index,
    inputReceiptChainDigest: qualificationChecksum(references.map(({ checksum }) => checksum)),
    lastPartitionIndex: last.lastPartitionIndex,
    planChecksum: input.planChecksum,
    previousSegmentChecksum: input.previousSegmentChecksum,
    references,
    valueType: input.valueType,
    version: "qualification-dimension-index-segment-v1" as const,
  };
  const segment = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(segment);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: indexMetadata(segment, await bodySha256(encoded)),
  });
  return segment;
};

const readIndexSegment = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly dimension: QualificationEvaluationDimensionInventoryEntry;
  readonly executionId: string;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousSegmentChecksum: string;
}) => {
  const artifactId = indexArtifactId(input.executionId, input.dimension.dimension, input.index);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return { status: "MISSING" as const };
  const encoded = await retained.text();
  let segment: typeof QualificationDimensionIndexSegment.Type;
  try {
    segment = Schema.decodeSync(Schema.fromJsonString(QualificationDimensionIndexSegment))(encoded);
  } catch {
    return { status: "FAIL" as const };
  }
  return authenticChecksum(segment) &&
    segment.artifactId === artifactId &&
    segment.dimension === input.dimension.dimension &&
    segment.executionId === input.executionId &&
    segment.index === input.index &&
    segment.planChecksum === input.planChecksum &&
    segment.previousSegmentChecksum === input.previousSegmentChecksum &&
    segment.valueType === input.dimension.valueType &&
    segment.inputReceiptChainDigest ===
      qualificationChecksum(segment.references.map(({ checksum }) => checksum)) &&
    new Set(segment.references.map(({ checksum }) => checksum)).size ===
      segment.references.length &&
    exactMetadata(retained.customMetadata, indexMetadata(segment, await bodySha256(encoded)))
    ? { segment, status: "COMPLETE" as const }
    : { status: "FAIL" as const };
};

export interface IndexDescriptor {
  readonly count: number;
  readonly terminalChecksum: string;
}

const inventoryLeafJoinPages = async (input: {
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
  readonly step: QualificationDimensionStep;
}) => {
  let cursor: string | undefined;
  let count = 0;
  let previousIndex = -1;
  let inventoryPage = 0;
  do {
    const result = await input.step.do(
      `inventory dimension leaf joins ${inventoryPage}`,
      async () => {
        const options = {
          include: ["customMetadata"] as const,
          limit: 1_000,
          prefix: `${qualificationEvaluationLeafJoinPagePrefix(input.payload.executionId)}/`,
        };
        const listed = await input.env.ARTIFACTS.list(
          cursor === undefined ? options : { ...options, cursor },
        );
        let conflict = false;
        let lastIndex = previousIndex;
        for (const object of listed.objects) {
          const suffix = object.key.slice(options.prefix.length);
          if (!/^[0-9]{8}\.json$/.test(suffix)) {
            conflict = true;
            continue;
          }
          const index = Number(suffix.slice(0, 8));
          if (index <= lastIndex || index >= input.payload.leafCompletionPageCount) conflict = true;
          lastIndex = index;
        }
        if (listed.truncated && (listed.cursor === undefined || listed.objects.length === 0)) {
          throw new Error("Qualification dimension leaf inventory did not advance");
        }
        return {
          conflict,
          count: listed.objects.length,
          lastIndex,
          nextCursor: listed.truncated ? listed.cursor : null,
        };
      },
    );
    if (result.conflict) return "FAIL" as const;
    count += result.count;
    previousIndex = result.lastIndex;
    cursor = result.nextCursor ?? undefined;
    inventoryPage += 1;
  } while (cursor !== undefined);
  return count === input.payload.leafCompletionPageCount
    ? ("COMPLETE" as const)
    : ("MISSING" as const);
};

const inventoryIndexedArtifacts = async (input: {
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly expectedCount: number;
  readonly kind: string;
  readonly prefix: string;
  readonly step: QualificationDimensionStep;
}) => {
  let cursor: string | undefined;
  let count = 0;
  let previousIndex = -1;
  let inventoryPage = 0;
  do {
    const result = await input.step.do(`inventory ${input.kind} ${inventoryPage}`, async () => {
      const options = {
        include: ["customMetadata"] as const,
        limit: 1_000,
        prefix: `${input.prefix}/`,
      };
      const listed = await input.env.ARTIFACTS.list(
        cursor === undefined ? options : { ...options, cursor },
      );
      let conflict = false;
      let lastIndex = previousIndex;
      for (const object of listed.objects) {
        const suffix = object.key.slice(options.prefix.length);
        if (!/^[0-9]{8}\.json$/.test(suffix)) {
          conflict = true;
          continue;
        }
        const index = Number(suffix.slice(0, 8));
        if (index <= lastIndex || index >= input.expectedCount) conflict = true;
        lastIndex = index;
      }
      if (listed.truncated && (listed.cursor === undefined || listed.objects.length === 0)) {
        throw new Error(`Qualification ${input.kind} inventory did not advance`);
      }
      return {
        conflict,
        count: listed.objects.length,
        lastIndex,
        nextCursor: listed.truncated ? listed.cursor : null,
      };
    });
    if (result.conflict) return "FAIL" as const;
    count += result.count;
    previousIndex = result.lastIndex;
    cursor = result.nextCursor ?? undefined;
    inventoryPage += 1;
  } while (cursor !== undefined);
  return count === input.expectedCount ? ("COMPLETE" as const) : ("MISSING" as const);
};

export const retainQualificationDimensionIndexes = async (input: {
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly inventory: ReadonlyArray<QualificationEvaluationDimensionInventoryEntry>;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
  readonly step: QualificationDimensionStep;
}): Promise<
  | { readonly descriptors: ReadonlyMap<string, IndexDescriptor>; readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" }
> => {
  const inventoryStatus = await inventoryLeafJoinPages(input);
  if (inventoryStatus !== "COMPLETE") return { status: inventoryStatus };
  const byName = new Map(input.inventory.map((dimension) => [dimension.dimension, dimension]));
  const state = new Map<string, { count: number; leafCount: number; terminalChecksum: string }>();
  let previousLeafChecksum = "NONE";
  for (let pageIndex = 0; pageIndex < input.payload.leafCompletionPageCount; pageIndex += 1) {
    const result = await input.step.do(
      `retain dimension index page ${pageIndex}`,
      { retries: { delay: "5 seconds", limit: 3 }, timeout: "30 minutes" },
      async () => {
        const artifactId = qualificationEvaluationLeafJoinPageArtifactId(
          input.payload.executionId,
          pageIndex,
        );
        const retainedJoin = await input.env.ARTIFACTS.get(artifactId);
        if (retainedJoin === null) return { status: "MISSING" as const };
        const page = await authenticateQualificationEvaluationLeafJoinPage({
          bucket: input.env.ARTIFACTS,
          expectedPreviousChecksum: previousLeafChecksum,
          pageIndex,
          payload: input.payload,
        });
        if (page === null) return { status: "FAIL" as const };
        if (page.missingCompletionCount > 0) return { status: "MISSING" as const };
        const receipts = new Array<typeof QualificationEvaluationSortedRunReceipt.Type>();
        for (const reference of page.references) {
          let completion;
          try {
            completion = await authenticateQualificationEvaluationLeafCompletion({
              bucket: input.env.ARTIFACTS,
              launchInput: {
                leafInputArtifactId: reference.leafInputArtifactId,
                leafInputChecksum: reference.leafInputChecksum,
                partitionIndex: reference.partitionIndex,
                runId: reference.runId,
              },
              payload: input.payload,
            });
          } catch (cause) {
            if (cause instanceof Error && cause.message.startsWith("Qualification")) {
              return { status: "FAIL" as const };
            }
            throw cause;
          }
          if (completion === undefined) return { status: "MISSING" as const };
          if (completion.receipt === null) return { status: "FAIL" as const };
          const expectedDimensions = input.inventory.filter(
            ({ firstPartitionIndex, lastPartitionIndex }) =>
              reference.partitionIndex >= firstPartitionIndex &&
              reference.partitionIndex <= lastPartitionIndex,
          );
          if (
            completion.receipt.dimensions.length !== expectedDimensions.length ||
            expectedDimensions.some(
              (expected, index) =>
                completion.receipt?.dimensions[index]?.dimension !== expected.dimension,
            )
          ) {
            return { status: "FAIL" as const };
          }
          receipts.push(...completion.receipt.dimensions);
        }
        const grouped = new Map<
          string,
          Array<typeof QualificationEvaluationSortedRunReceipt.Type>
        >();
        for (const receipt of receipts) {
          const values = grouped.get(receipt.dimension) ?? [];
          values.push(receipt);
          grouped.set(receipt.dimension, values);
        }
        const retained = new Array<{
          readonly checksum: string;
          readonly count: number;
          readonly dimension: string;
        }>();
        for (const [dimension, values] of grouped) {
          const expected = byName.get(dimension);
          if (expected === undefined) throw new Error("Unexpected qualification dimension");
          const prior = state.get(dimension) ?? {
            count: 0,
            leafCount: 0,
            terminalChecksum: "NONE",
          };
          const segment = await retainIndexSegment({
            bucket: input.env.ARTIFACTS,
            dimension,
            executionId: input.payload.executionId,
            index: prior.count,
            planChecksum: input.payload.planChecksum,
            previousSegmentChecksum: prior.terminalChecksum,
            receipts: values,
            valueType: expected.valueType,
          });
          retained.push({ checksum: segment.checksum, count: values.length, dimension });
        }
        return { checksum: page.checksum, retained, status: "COMPLETE" as const };
      },
    );
    if (result.status !== "COMPLETE") return result;
    previousLeafChecksum = result.checksum;
    for (const item of result.retained) {
      const prior = state.get(item.dimension) ?? {
        count: 0,
        leafCount: 0,
        terminalChecksum: "NONE",
      };
      state.set(item.dimension, {
        count: prior.count + 1,
        leafCount: prior.leafCount + item.count,
        terminalChecksum: item.checksum,
      });
    }
  }
  if (previousLeafChecksum !== input.payload.leafCompletionTerminalPageChecksum) {
    return { status: "FAIL" };
  }
  const descriptors = new Map<string, IndexDescriptor>();
  for (const dimension of input.inventory) {
    const value = state.get(dimension.dimension);
    if (value === undefined || value.leafCount !== dimension.leafCount) {
      return { status: "FAIL" };
    }
    descriptors.set(dimension.dimension, {
      count: value.count,
      terminalChecksum: value.terminalChecksum,
    });
  }
  return { descriptors, status: "COMPLETE" };
};

const launchMetadata = (page: typeof QualificationDimensionLaunchPage.Type, sha256: string) => ({
  "osfo-artifact-checksum": page.checksum,
  "osfo-body-sha256": sha256,
  "osfo-dimension": page.dimension,
  "osfo-execution-id": page.executionId,
  "osfo-first-node-index": String(page.firstNodeIndex),
  "osfo-index": String(page.index),
  "osfo-kind": "qualification-dimension-launch-page-v1",
  "osfo-last-node-index": String(page.lastNodeIndex),
  "osfo-level": String(page.level),
  "osfo-plan-checksum": page.planChecksum,
  "osfo-previous-checksum": page.previousPageChecksum,
  "osfo-record-count": String(page.payloads.length),
});

const retainLaunchPage = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly level: number;
  readonly payloads: ReadonlyArray<QualificationEvaluationReducerWorkflowPayload>;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const first = input.payloads[0];
  const last = input.payloads.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.payloads.length > qualificationDimensionPageSize ||
    input.payloads.some(
      (payload, index) =>
        payload.dimension !== input.dimension ||
        payload.executionId !== input.executionId ||
        payload.index !== first.index + index ||
        payload.level !== input.level ||
        payload.planChecksum !== input.planChecksum,
    )
  ) {
    throw new Error("Qualification dimension launch payload conflicts");
  }
  const artifactId = launchArtifactId(input.executionId, input.dimension, input.level, input.index);
  const content = {
    artifactId,
    dimension: input.dimension,
    executionId: input.executionId,
    firstNodeIndex: first.index,
    index: input.index,
    lastNodeIndex: last.index,
    level: input.level,
    payloads: input.payloads,
    planChecksum: input.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    version: "qualification-dimension-launch-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(page);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: launchMetadata(page, await bodySha256(encoded)),
  });
  return page;
};

const readLaunchPage = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly level: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const artifactId = launchArtifactId(input.executionId, input.dimension, input.level, input.index);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let page: typeof QualificationDimensionLaunchPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationDimensionLaunchPage))(encoded);
  } catch {
    return null;
  }
  return authenticChecksum(page) &&
    page.artifactId === artifactId &&
    page.dimension === input.dimension &&
    page.executionId === input.executionId &&
    page.index === input.index &&
    page.level === input.level &&
    page.planChecksum === input.planChecksum &&
    page.previousPageChecksum === input.previousPageChecksum &&
    page.lastNodeIndex === page.firstNodeIndex + page.payloads.length - 1 &&
    page.payloads.every(
      (payload, index) =>
        payload.dimension === input.dimension &&
        payload.executionId === input.executionId &&
        payload.index === page.firstNodeIndex + index &&
        payload.level === input.level &&
        payload.planChecksum === input.planChecksum &&
        qualificationDimensionReducerWorkflowId(payload).length <= 100,
    ) &&
    exactMetadata(retained.customMetadata, launchMetadata(page, await bodySha256(encoded)))
    ? page
    : null;
};

const dimensionCompletionMetadata = (
  page: typeof QualificationDimensionCompletionPage.Type,
  sha256: string,
) => ({
  "osfo-artifact-checksum": page.checksum,
  "osfo-body-sha256": sha256,
  "osfo-dimension": page.dimension,
  "osfo-execution-id": page.executionId,
  "osfo-first-node-index": String(page.firstNodeIndex),
  "osfo-index": String(page.index),
  "osfo-kind": "qualification-dimension-completion-page-v1",
  "osfo-last-node-index": String(page.lastNodeIndex),
  "osfo-launch-page-checksum": page.launchPageChecksum,
  "osfo-level": String(page.level),
  "osfo-plan-checksum": page.planChecksum,
  "osfo-previous-checksum": page.previousPageChecksum,
  "osfo-record-count": String(page.references.length),
});

const retainCompletionPage = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly launchPage: typeof QualificationDimensionLaunchPage.Type;
  readonly previousPageChecksum: string;
  readonly references: ReadonlyArray<{ readonly artifactId: string; readonly checksum: string }>;
}) => {
  if (
    input.references.length !== input.launchPage.payloads.length ||
    input.references.some(
      (reference, index) =>
        reference.artifactId !==
        `${input.launchPage.payloads[index]?.outputArtifactPrefix}/receipt.json`,
    )
  ) {
    throw new Error("Qualification dimension completion references conflict");
  }
  const pageIndex = input.launchPage.index;
  const artifactId = completionArtifactId(
    input.launchPage.executionId,
    input.launchPage.dimension,
    input.launchPage.level,
    pageIndex,
  );
  const content = {
    artifactId,
    dimension: input.launchPage.dimension,
    executionId: input.launchPage.executionId,
    firstNodeIndex: input.launchPage.firstNodeIndex,
    index: pageIndex,
    lastNodeIndex: input.launchPage.lastNodeIndex,
    launchPageChecksum: input.launchPage.checksum,
    level: input.launchPage.level,
    planChecksum: input.launchPage.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    references: input.references,
    version: "qualification-dimension-completion-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(page);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: dimensionCompletionMetadata(page, await bodySha256(encoded)),
  });
  return page;
};

const readCompletionPage = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly level: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const artifactId = completionArtifactId(
    input.executionId,
    input.dimension,
    input.level,
    input.index,
  );
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let page: typeof QualificationDimensionCompletionPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationDimensionCompletionPage))(encoded);
  } catch {
    return null;
  }
  return authenticChecksum(page) &&
    page.artifactId === artifactId &&
    page.dimension === input.dimension &&
    page.executionId === input.executionId &&
    page.index === input.index &&
    page.level === input.level &&
    page.planChecksum === input.planChecksum &&
    page.previousPageChecksum === input.previousPageChecksum &&
    page.lastNodeIndex === page.firstNodeIndex + page.references.length - 1 &&
    new Set(page.references.map(({ checksum }) => checksum)).size === page.references.length &&
    exactMetadata(
      retained.customMetadata,
      dimensionCompletionMetadata(page, await bodySha256(encoded)),
    )
    ? page
    : null;
};

export interface LevelDescriptor {
  readonly dimension: string;
  readonly level: number;
  readonly nodeCount: number;
  readonly pageCount: number;
  readonly terminalLaunchPageChecksum: string;
  readonly valueType: "identity" | "latencyMs";
}

export interface SettledLevelDescriptor extends LevelDescriptor {
  readonly terminalCompletionPageChecksum: string;
}

const inputReference = (
  receipt: typeof QualificationEvaluationSortedRunReceipt.Type,
): QualificationDimensionInputReference => ({
  artifactId: receipt.artifactId,
  checksum: receipt.checksum,
  denominatorChainDigest: receipt.denominatorChainDigest,
  denominatorCount: receipt.denominatorCount,
  firstPartitionIndex: receipt.firstPartitionIndex,
  lastPartitionIndex: receipt.lastPartitionIndex,
  missingRootCount: receipt.missingRootCount,
  valueType: receipt.valueType,
});

const buildDimensionLevel = async (input: {
  readonly dimension: QualificationEvaluationDimensionInventoryEntry;
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly index: IndexDescriptor;
  readonly level: number;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
  readonly previous?: SettledLevelDescriptor;
  readonly step: QualificationDimensionStep;
}): Promise<
  | { readonly descriptor: LevelDescriptor; readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" }
> => {
  const sourcePageCount = input.level === 1 ? input.index.count : (input.previous?.pageCount ?? 0);
  let sourcePreviousChecksum = "NONE";
  let expectedFirstPartitionIndex = input.dimension.firstPartitionIndex;
  let nodeIndex = 0;
  let launchPageIndex = 0;
  let launchPreviousChecksum = "NONE";
  let referenceBuffer = new Array<QualificationDimensionInputReference>();
  let payloadBuffer = new Array<QualificationEvaluationReducerWorkflowPayload>();

  const flushLaunchPage = async () => {
    if (payloadBuffer.length === 0) return;
    const pagePayloads = payloadBuffer;
    const page = await input.step.do(
      `retain dimension ${dimensionKey(input.dimension.dimension)} level ${input.level} launch ${launchPageIndex}`,
      () =>
        retainLaunchPage({
          bucket: input.env.ARTIFACTS,
          dimension: input.dimension.dimension,
          executionId: input.payload.executionId,
          index: launchPageIndex,
          level: input.level,
          payloads: pagePayloads,
          planChecksum: input.payload.planChecksum,
          previousPageChecksum: launchPreviousChecksum,
        }),
    );
    launchPreviousChecksum = page.checksum;
    launchPageIndex += 1;
    payloadBuffer = [];
  };
  const flushNode = async () => {
    if (referenceBuffer.length === 0) return;
    const payload = qualificationDimensionReducerPayload({
      dimension: input.dimension.dimension,
      executionId: input.payload.executionId,
      index: nodeIndex,
      level: input.level,
      planChecksum: input.payload.planChecksum,
      references: referenceBuffer,
    });
    if (payload === null) throw new Error("Qualification dimension reducer payload conflicts");
    payloadBuffer.push(payload);
    nodeIndex += 1;
    referenceBuffer = [];
    if (payloadBuffer.length === qualificationDimensionPageSize) await flushLaunchPage();
  };

  for (let pageIndex = 0; pageIndex < sourcePageCount; pageIndex += 1) {
    const source = await input.step.do(
      `read dimension ${dimensionKey(input.dimension.dimension)} level ${input.level} source ${pageIndex}`,
      async () => {
        if (input.level === 1) {
          const result = await readIndexSegment({
            bucket: input.env.ARTIFACTS,
            dimension: input.dimension,
            executionId: input.payload.executionId,
            index: pageIndex,
            planChecksum: input.payload.planChecksum,
            previousSegmentChecksum: sourcePreviousChecksum,
          });
          return result.status === "COMPLETE"
            ? { source: result.segment, status: "COMPLETE" as const }
            : result;
        }
        const artifactId = completionArtifactId(
          input.payload.executionId,
          input.dimension.dimension,
          input.level - 1,
          pageIndex,
        );
        if ((await input.env.ARTIFACTS.get(artifactId)) === null) {
          return { status: "MISSING" as const };
        }
        const page = await readCompletionPage({
          bucket: input.env.ARTIFACTS,
          dimension: input.dimension.dimension,
          executionId: input.payload.executionId,
          index: pageIndex,
          level: input.level - 1,
          planChecksum: input.payload.planChecksum,
          previousPageChecksum: sourcePreviousChecksum,
        });
        return page === null
          ? { status: "FAIL" as const }
          : { source: page, status: "COMPLETE" as const };
      },
    );
    if (source.status !== "COMPLETE") return source;
    sourcePreviousChecksum = source.source.checksum;
    for (const reference of source.source.references) {
      const result = await input.step.do(
        `authenticate dimension ${dimensionKey(input.dimension.dimension)} level ${input.level} input ${nodeIndex}-${referenceBuffer.length}`,
        async () => {
          if ((await input.env.ARTIFACTS.get(reference.artifactId)) === null) {
            return { status: "MISSING" as const };
          }
          const receipt = await authenticateQualificationEvaluationSortedRunReceipt({
            bucket: input.env.ARTIFACTS,
            dimension: input.dimension.dimension,
            executionId: input.payload.executionId,
            planChecksum: input.payload.planChecksum,
            reference,
          });
          return receipt === null
            ? { status: "FAIL" as const }
            : { receipt, status: "COMPLETE" as const };
        },
      );
      if (result.status !== "COMPLETE") return result;
      const receipt = result.receipt;
      if (receipt.firstPartitionIndex !== expectedFirstPartitionIndex) return { status: "FAIL" };
      expectedFirstPartitionIndex = receipt.lastPartitionIndex + 1;
      referenceBuffer.push(inputReference(receipt));
      if (referenceBuffer.length === qualificationEvaluationReducerFanIn) await flushNode();
    }
  }
  await flushNode();
  await flushLaunchPage();
  const expectedNodeCount = input.dimension.levelCounts[input.level - 1];
  if (
    expectedNodeCount === undefined ||
    nodeIndex !== expectedNodeCount ||
    expectedFirstPartitionIndex !== input.dimension.lastPartitionIndex + 1 ||
    (input.level === 1
      ? sourcePreviousChecksum !== input.index.terminalChecksum
      : sourcePreviousChecksum !== input.previous?.terminalCompletionPageChecksum)
  ) {
    return { status: "FAIL" };
  }
  return {
    descriptor: {
      dimension: input.dimension.dimension,
      level: input.level,
      nodeCount: nodeIndex,
      pageCount: launchPageIndex,
      terminalLaunchPageChecksum: launchPreviousChecksum,
      valueType: input.dimension.valueType,
    },
    status: "COMPLETE",
  };
};

const authenticateExpectedReceipt = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly payload: QualificationEvaluationReducerWorkflowPayload;
}) => {
  const artifactId = `${input.payload.outputArtifactPrefix}/receipt.json`;
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return { status: "MISSING" as const };
  const receipt = await authenticateQualificationEvaluationSortedRunReceipt({
    bucket: input.bucket,
    dimension: input.payload.dimension,
    executionId: input.payload.executionId,
    planChecksum: input.payload.planChecksum,
    reference: {
      artifactId,
      checksum: retained.customMetadata?.["osfo-artifact-checksum"] ?? "MISSING",
    },
  });
  if (
    receipt === null ||
    receipt.denominatorChainDigest !== input.payload.denominatorChainDigest ||
    receipt.denominatorCount !== input.payload.denominatorCount ||
    receipt.firstPartitionIndex !== input.payload.firstPartitionIndex ||
    receipt.index !== input.payload.index ||
    receipt.inputReceiptChainDigest !== input.payload.inputReceiptChainDigest ||
    receipt.lastPartitionIndex !== input.payload.lastPartitionIndex ||
    receipt.level !== input.payload.level ||
    receipt.missingRootCount !== input.payload.missingRootCount ||
    receipt.runId !== input.payload.outputRunId ||
    receipt.valueType !== input.payload.valueType
  ) {
    return { status: "FAIL" as const };
  }
  return { receipt, status: "COMPLETE" as const };
};

const launchDimensionLevels = async (input: {
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly levels: ReadonlyArray<LevelDescriptor>;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
  readonly step: QualificationDimensionStep;
}): Promise<
  | { readonly lastLaunchAtEpochMs: number; readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" }
> => {
  let launchSequence = 0;
  let lastLaunchAtEpochMs = 0;
  for (const level of input.levels) {
    const inventoryStatus = await inventoryIndexedArtifacts({
      env: input.env,
      expectedCount: level.pageCount,
      kind: `dimension ${dimensionKey(level.dimension)} level ${level.level} launch`,
      prefix: `${levelPrefix(input.payload.executionId, level.dimension, level.level)}/launch`,
      step: input.step,
    });
    if (inventoryStatus !== "COMPLETE") return { status: inventoryStatus };
    let previousChecksum = "NONE";
    for (let pageIndex = 0; pageIndex < level.pageCount; pageIndex += 1) {
      const result = await input.step.do(
        `launch dimension ${dimensionKey(level.dimension)} level ${level.level} page ${pageIndex}`,
        async () => {
          const artifactId = launchArtifactId(
            input.payload.executionId,
            level.dimension,
            level.level,
            pageIndex,
          );
          if ((await input.env.ARTIFACTS.get(artifactId)) === null) {
            return { status: "MISSING" as const };
          }
          const page = await readLaunchPage({
            bucket: input.env.ARTIFACTS,
            dimension: level.dimension,
            executionId: input.payload.executionId,
            index: pageIndex,
            level: level.level,
            planChecksum: input.payload.planChecksum,
            previousPageChecksum: previousChecksum,
          });
          if (page === null) return { status: "FAIL" as const };
          const batch = page.payloads.map((params) => ({
            id: qualificationDimensionReducerWorkflowId(params),
            params,
          }));
          const launched = await createOrReconcileQualificationWorkflowBatch({
            batch,
            createBatch: input.env.QUALIFICATION_EVALUATION_REDUCER_WORKFLOW.createBatch.bind(
              input.env.QUALIFICATION_EVALUATION_REDUCER_WORKFLOW,
            ),
            get: input.env.QUALIFICATION_EVALUATION_REDUCER_WORKFLOW.get.bind(
              input.env.QUALIFICATION_EVALUATION_REDUCER_WORKFLOW,
            ),
          });
          if (launched.status === "CONFLICT") return { status: "FAIL" as const };
          // oxlint-disable-next-line effecttsgo/global-date -- The durable launch step freezes the coordinator's rate-limit time.
          return { launchedAtEpochMs: Date.now(), page, status: "COMPLETE" as const };
        },
      );
      if (result.status !== "COMPLETE") return result;
      previousChecksum = result.page.checksum;
      lastLaunchAtEpochMs = result.launchedAtEpochMs;
      launchSequence += 1;
      if (launchSequence > 0) {
        await input.step.sleepUntil(
          `rate limit dimension launch ${launchSequence}`,
          result.launchedAtEpochMs + 1_000,
        );
      }
    }
    if (previousChecksum !== level.terminalLaunchPageChecksum) return { status: "FAIL" };
  }
  return { lastLaunchAtEpochMs, status: "COMPLETE" };
};

const settleDimensionLevel = async (input: {
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly level: LevelDescriptor;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
  readonly step: QualificationDimensionStep;
}): Promise<
  | { readonly descriptor: SettledLevelDescriptor; readonly status: "COMPLETE" }
  | { readonly status: "FAIL" | "MISSING" }
> => {
  let previousLaunchChecksum = "NONE";
  let previousCompletionChecksum = "NONE";
  for (let pageIndex = 0; pageIndex < input.level.pageCount; pageIndex += 1) {
    const settled = await input.step.do(
      `settle dimension ${dimensionKey(input.level.dimension)} level ${input.level.level} page ${pageIndex}`,
      { retries: { delay: "5 seconds", limit: 3 }, timeout: "30 minutes" },
      async () => {
        const launchArtifact = launchArtifactId(
          input.payload.executionId,
          input.level.dimension,
          input.level.level,
          pageIndex,
        );
        if ((await input.env.ARTIFACTS.get(launchArtifact)) === null) {
          return { status: "MISSING" as const };
        }
        const launchPage = await readLaunchPage({
          bucket: input.env.ARTIFACTS,
          dimension: input.level.dimension,
          executionId: input.payload.executionId,
          index: pageIndex,
          level: input.level.level,
          planChecksum: input.payload.planChecksum,
          previousPageChecksum: previousLaunchChecksum,
        });
        if (launchPage === null) return { status: "FAIL" as const };
        const references = new Array<{ readonly artifactId: string; readonly checksum: string }>();
        for (const payload of launchPage.payloads) {
          const receipt = await authenticateExpectedReceipt({
            bucket: input.env.ARTIFACTS,
            payload,
          });
          if (receipt.status === "FAIL") return { status: "FAIL" as const };
          if (receipt.status === "MISSING") {
            const id = qualificationDimensionReducerWorkflowId(payload);
            const instance = await input.env.QUALIFICATION_EVALUATION_REDUCER_WORKFLOW.get(id);
            if (instance.id !== id) return { status: "FAIL" as const };
            const status = await instance.status();
            if (status.status === "errored" || status.status === "terminated") {
              return { status: "FAIL" as const };
            }
            return { status: "MISSING" as const };
          }
          references.push({
            artifactId: receipt.receipt.artifactId,
            checksum: receipt.receipt.checksum,
          });
        }
        const page = await retainCompletionPage({
          bucket: input.env.ARTIFACTS,
          launchPage,
          previousPageChecksum: previousCompletionChecksum,
          references,
        });
        return { launchChecksum: launchPage.checksum, page, status: "COMPLETE" as const };
      },
    );
    if (settled.status !== "COMPLETE") return settled;
    previousLaunchChecksum = settled.launchChecksum;
    previousCompletionChecksum = settled.page.checksum;
  }
  return previousLaunchChecksum === input.level.terminalLaunchPageChecksum
    ? {
        descriptor: {
          ...input.level,
          terminalCompletionPageChecksum: previousCompletionChecksum,
        },
        status: "COMPLETE",
      }
    : { status: "FAIL" };
};

const rootPageMetadata = (page: typeof QualificationDimensionRootPage.Type, sha256: string) => ({
  "osfo-artifact-checksum": page.checksum,
  "osfo-body-sha256": sha256,
  "osfo-execution-id": page.executionId,
  "osfo-first-dimension-index": String(page.firstDimensionIndex),
  "osfo-index": String(page.index),
  "osfo-kind": "qualification-dimension-root-page-v1",
  "osfo-last-dimension-index": String(page.lastDimensionIndex),
  "osfo-plan-checksum": page.planChecksum,
  "osfo-previous-checksum": page.previousPageChecksum,
  "osfo-record-count": String(page.references.length),
});

const retainRootPage = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly executionId: string;
  readonly firstDimensionIndex: number;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
  readonly references: ReadonlyArray<{
    readonly dimension: string;
    readonly receiptArtifactId: string;
    readonly receiptChecksum: string;
    readonly valueType: "identity" | "latencyMs";
  }>;
}) => {
  const artifactId = rootPageArtifactId(input.executionId, input.index);
  const content = {
    artifactId,
    executionId: input.executionId,
    firstDimensionIndex: input.firstDimensionIndex,
    index: input.index,
    lastDimensionIndex: input.firstDimensionIndex + input.references.length - 1,
    planChecksum: input.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    references: input.references,
    version: "qualification-dimension-root-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(page);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: rootPageMetadata(page, await bodySha256(encoded)),
  });
  return page;
};

const evaluationPageMetadata = (
  page: typeof QualificationDimensionEvaluationPage.Type,
  sha256: string,
) => ({
  "osfo-artifact-checksum": page.checksum,
  "osfo-body-sha256": sha256,
  "osfo-execution-id": page.executionId,
  "osfo-fail-count": String(page.failCount),
  "osfo-first-dimension-index": String(page.firstDimensionIndex),
  "osfo-index": String(page.index),
  "osfo-kind": "qualification-dimension-evaluation-page-v1",
  "osfo-last-dimension-index": String(page.lastDimensionIndex),
  "osfo-missing-count": String(page.missingCount),
  "osfo-plan-checksum": page.planChecksum,
  "osfo-previous-checksum": page.previousPageChecksum,
  "osfo-record-count": String(page.evaluations.length),
});

const retainEvaluationPage = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly evaluations: ReadonlyArray<
    (typeof QualificationDimensionEvaluationPage.Type)["evaluations"][number]
  >;
  readonly executionId: string;
  readonly firstDimensionIndex: number;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const artifactId = evaluationPageArtifactId(input.executionId, input.index);
  const content = {
    artifactId,
    evaluations: input.evaluations,
    executionId: input.executionId,
    failCount: input.evaluations.filter(({ verdict }) => verdict === "FAIL").length,
    firstDimensionIndex: input.firstDimensionIndex,
    index: input.index,
    lastDimensionIndex: input.firstDimensionIndex + input.evaluations.length - 1,
    missingCount: input.evaluations.filter(({ verdict }) => verdict === "MISSING").length,
    planChecksum: input.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    version: "qualification-dimension-evaluation-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(page);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: evaluationPageMetadata(page, await bodySha256(encoded)),
  });
  return page;
};

const coordinatorCompletionMetadata = (
  completion: typeof QualificationDimensionCoordinatorCompletion.Type,
  sha256: string,
) => ({
  "osfo-artifact-checksum": completion.checksum,
  "osfo-body-sha256": sha256,
  "osfo-dimension-count": String(completion.dimensionCount),
  "osfo-execution-id": completion.executionId,
  "osfo-kind": "qualification-dimension-coordinator-completion-v1",
  "osfo-plan-checksum": completion.planChecksum,
  "osfo-record-count": String(completion.evaluationPageCount),
  "osfo-verdict": completion.verdict,
});

const retainCoordinatorCompletion = async (input: {
  readonly bucket: QualificationDimensionBucket;
  readonly dimensionCount: number;
  readonly evaluationPageCount: number;
  readonly executionId: string;
  readonly identityDimensionCount: number;
  readonly numericDimensionCount: number;
  readonly planChecksum: string;
  readonly rootPageCount: number;
  readonly terminalEvaluationPageChecksum: string;
  readonly terminalRootPageChecksum: string;
  readonly verdict: "FAIL" | "MISSING" | "PASS";
}) => {
  const artifactId = qualificationDimensionCoordinatorCompletionArtifactId(input.executionId);
  const content = {
    artifactId,
    dimensionCount: input.dimensionCount,
    evaluationPageCount: input.evaluationPageCount,
    executionId: input.executionId,
    identityDimensionCount: input.identityDimensionCount,
    numericDimensionCount: input.numericDimensionCount,
    planChecksum: input.planChecksum,
    rootPageCount: input.rootPageCount,
    terminalEvaluationPageChecksum: input.terminalEvaluationPageChecksum,
    terminalRootPageChecksum: input.terminalRootPageChecksum,
    verdict: input.verdict,
    version: "qualification-dimension-coordinator-completion-v1" as const,
  };
  const completion = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(completion);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: coordinatorCompletionMetadata(completion, await bodySha256(encoded)),
  });
  return completion;
};

export type QualificationOwnerDimensionCoordinatorOutcome =
  | {
      readonly artifactId: string;
      readonly checksum: string;
      readonly status: "COMPLETE";
      readonly verdict: "FAIL" | "MISSING" | "PASS";
    }
  | { readonly code: string; readonly status: "FAIL" | "MISSING" };

/** Orchestrate every exact sorted dimension through bounded fan-in forests and retained inputs. */
export const runQualificationOwnerDimensionCoordinator = async (input: {
  readonly env: QualificationDimensionCoordinatorEnv;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
  readonly step: QualificationDimensionStep;
}): Promise<QualificationOwnerDimensionCoordinatorOutcome> => {
  const correctnessMaterial = await input.step.do(
    "authenticate correctness root before dimensions",
    async () => {
      if ((await input.env.ARTIFACTS.get(input.payload.correctnessArtifactId)) === null) {
        return { status: "MISSING" as const };
      }
      const receipt = await authenticateQualificationEvaluationCorrectnessReceipt({
        bucket: input.env.ARTIFACTS,
        executionId: input.payload.executionId,
        expectedLevel: input.payload.correctnessLevel,
        planChecksum: input.payload.planChecksum,
        reference: {
          artifactId: input.payload.correctnessArtifactId,
          checksum: input.payload.correctnessChecksum,
        },
      });
      return receipt === null
        ? { status: "FAIL" as const }
        : { receipt, status: "COMPLETE" as const };
    },
  );
  if (correctnessMaterial.status !== "COMPLETE") {
    return { code: "qualificationCorrectnessReceipt", status: correctnessMaterial.status };
  }
  const correctness = correctnessMaterial.receipt;
  if (correctness.verdict === "FAIL") {
    return { code: "qualificationCorrectnessFailed", status: "FAIL" };
  }
  if (correctness.verdict === "MISSING") {
    return { code: "qualificationCorrectnessMissing", status: "MISSING" };
  }
  const inventoryMaterial = await input.step.do("authenticate frozen dimension inventory", () =>
    readQualificationDimensionInventory({ bucket: input.env.ARTIFACTS, payload: input.payload }),
  );
  if (inventoryMaterial.status !== "COMPLETE") {
    return { code: "qualificationDimensionInventory", status: inventoryMaterial.status };
  }
  const inventory = inventoryMaterial.value;
  if (inventory.length === 0) return { code: "qualificationDimensionInventory", status: "FAIL" };
  const indexes = await retainQualificationDimensionIndexes({
    env: input.env,
    inventory,
    payload: input.payload,
    step: input.step,
  });
  if (indexes.status !== "COMPLETE") {
    return { code: "qualificationDimensionLeafMaterial", status: indexes.status };
  }
  const indexDescriptors = indexes.descriptors;
  for (const dimension of inventory) {
    const descriptor = indexDescriptors.get(dimension.dimension);
    if (descriptor === undefined) return { code: "qualificationDimensionIndex", status: "FAIL" };
    const status = await inventoryIndexedArtifacts({
      env: input.env,
      expectedCount: descriptor.count,
      kind: `dimension ${dimensionKey(dimension.dimension)} index`,
      prefix: indexPrefix(input.payload.executionId, dimension.dimension),
      step: input.step,
    });
    if (status !== "COMPLETE") return { code: "qualificationDimensionIndex", status };
  }

  const previousLevels = new Map<string, SettledLevelDescriptor>();
  const roots = new Map<string, typeof QualificationEvaluationSortedRunReceipt.Type>();
  for (const dimension of inventory.filter(({ levelCounts }) => levelCounts.length === 0)) {
    const index = indexDescriptors.get(dimension.dimension);
    if (index === undefined || index.count !== 1) {
      return { code: "qualificationDimensionIndex", status: "FAIL" };
    }
    const segment = await input.step.do(
      `read direct dimension root ${dimensionKey(dimension.dimension)}`,
      () =>
        readIndexSegment({
          bucket: input.env.ARTIFACTS,
          dimension,
          executionId: input.payload.executionId,
          index: 0,
          planChecksum: input.payload.planChecksum,
          previousSegmentChecksum: "NONE",
        }),
    );
    if (segment.status !== "COMPLETE") {
      return { code: "qualificationDimensionDirectRoot", status: segment.status };
    }
    const reference = segment.segment.references[0];
    if (reference === undefined || segment.segment.references.length !== 1) {
      return { code: "qualificationDimensionDirectRoot", status: "FAIL" };
    }
    const receipt = await authenticateQualificationDimensionRoot({
      bucket: input.env.ARTIFACTS,
      dimension,
      executionId: input.payload.executionId,
      planChecksum: input.payload.planChecksum,
      reference,
    });
    if (receipt.status !== "COMPLETE") {
      return { code: "qualificationDimensionDirectRoot", status: receipt.status };
    }
    roots.set(dimension.dimension, receipt.value);
  }

  const maximumLevelCount = Math.max(...inventory.map(({ levelCounts }) => levelCounts.length));
  for (let level = 1; level <= maximumLevelCount; level += 1) {
    const active = inventory.filter(({ levelCounts }) => levelCounts.length >= level);
    const built = new Array<LevelDescriptor>();
    for (const dimension of active) {
      const index = indexDescriptors.get(dimension.dimension);
      if (index === undefined) return { code: "qualificationDimensionIndex", status: "FAIL" };
      const previous = previousLevels.get(dimension.dimension);
      const buildInput = {
        dimension,
        env: input.env,
        index,
        level,
        payload: input.payload,
        step: input.step,
      };
      const builtLevel =
        previous === undefined
          ? await buildDimensionLevel(buildInput)
          : await buildDimensionLevel({ ...buildInput, previous });
      if (builtLevel.status !== "COMPLETE") {
        return { code: "qualificationDimensionLaunchMaterial", status: builtLevel.status };
      }
      built.push(builtLevel.descriptor);
    }
    const launched = await launchDimensionLevels({
      env: input.env,
      levels: built,
      payload: input.payload,
      step: input.step,
    });
    if (launched.status !== "COMPLETE") {
      return { code: "qualificationDimensionLaunchConflict", status: launched.status };
    }
    await input.step.sleepUntil(
      `await dimension reducer level ${level} horizon`,
      launched.lastLaunchAtEpochMs + qualificationDimensionLevelDeadlineMs,
    );
    for (const descriptor of built) {
      const settled = await settleDimensionLevel({
        env: input.env,
        level: descriptor,
        payload: input.payload,
        step: input.step,
      });
      if (settled.status !== "COMPLETE") {
        return {
          code:
            settled.status === "FAIL"
              ? "qualificationDimensionReducerFailed"
              : "qualificationDimensionReducerUnsettled",
          status: settled.status,
        };
      }
      const completionInventory = await inventoryIndexedArtifacts({
        env: input.env,
        expectedCount: settled.descriptor.pageCount,
        kind: `dimension ${dimensionKey(descriptor.dimension)} level ${level} completion`,
        prefix: `${levelPrefix(input.payload.executionId, descriptor.dimension, level)}/completion`,
        step: input.step,
      });
      if (completionInventory !== "COMPLETE") {
        return {
          code: "qualificationDimensionCompletionMaterial",
          status: completionInventory,
        };
      }
      previousLevels.set(descriptor.dimension, settled.descriptor);
      const dimension = inventory.find(({ dimension: name }) => name === descriptor.dimension);
      if (dimension === undefined)
        return { code: "qualificationDimensionInventory", status: "FAIL" };
      if (dimension.levelCounts.length === level) {
        if (settled.descriptor.nodeCount !== 1 || settled.descriptor.pageCount !== 1) {
          return { code: "qualificationDimensionRootTopology", status: "FAIL" };
        }
        const completionMaterial = await input.step.do(
          `authenticate dimension root page ${dimensionKey(dimension.dimension)}`,
          async () => {
            const artifactId = completionArtifactId(
              input.payload.executionId,
              dimension.dimension,
              level,
              0,
            );
            if ((await input.env.ARTIFACTS.get(artifactId)) === null) {
              return { status: "MISSING" as const };
            }
            const page = await readCompletionPage({
              bucket: input.env.ARTIFACTS,
              dimension: dimension.dimension,
              executionId: input.payload.executionId,
              index: 0,
              level,
              planChecksum: input.payload.planChecksum,
              previousPageChecksum: "NONE",
            });
            return page === null
              ? { status: "FAIL" as const }
              : { page, status: "COMPLETE" as const };
          },
        );
        if (completionMaterial.status !== "COMPLETE") {
          return { code: "qualificationDimensionRootMaterial", status: completionMaterial.status };
        }
        const completionPage = completionMaterial.page;
        const reference = completionPage?.references[0];
        if (reference === undefined || completionPage.references.length !== 1) {
          return { code: "qualificationDimensionRootMaterial", status: "FAIL" };
        }
        const receipt = await authenticateQualificationDimensionRoot({
          bucket: input.env.ARTIFACTS,
          dimension,
          executionId: input.payload.executionId,
          planChecksum: input.payload.planChecksum,
          reference,
        });
        if (receipt.status !== "COMPLETE") {
          return { code: "qualificationDimensionRootMaterial", status: receipt.status };
        }
        roots.set(dimension.dimension, receipt.value);
      }
    }
  }
  if (roots.size !== inventory.length) {
    return { code: "qualificationDimensionRootCoverage", status: "FAIL" };
  }
  const acceptedRoots = roots.get("acceptedRootIds");
  if (
    acceptedRoots === undefined ||
    acceptedRoots.denominatorCount !== correctness.acceptedCount ||
    acceptedRoots.valueCount !== correctness.acceptedCount ||
    acceptedRoots.missingRootCount !== 0 ||
    acceptedRoots.sampleStatus !== "COMPLETE"
  ) {
    return { code: "qualificationDimensionAcceptedRootCount", status: "FAIL" };
  }
  for (const dimension of inventory.slice(0, 14)) {
    if (roots.get(dimension.dimension)?.denominatorCount !== correctness.acceptedCount) {
      return { code: "qualificationDimensionGlobalDenominator", status: "FAIL" };
    }
  }

  let rootPreviousChecksum = "NONE";
  let rootPageCount = 0;
  for (let offset = 0; offset < inventory.length; offset += qualificationDimensionPageSize) {
    const slice = inventory.slice(offset, offset + qualificationDimensionPageSize);
    const page = await input.step.do(`retain dimension root page ${rootPageCount}`, () =>
      retainRootPage({
        bucket: input.env.ARTIFACTS,
        executionId: input.payload.executionId,
        firstDimensionIndex: offset,
        index: rootPageCount,
        planChecksum: input.payload.planChecksum,
        previousPageChecksum: rootPreviousChecksum,
        references: slice.map((dimension) => {
          const receipt = roots.get(dimension.dimension);
          if (receipt === undefined) throw new Error("Qualification dimension root is missing");
          return {
            dimension: dimension.dimension,
            receiptArtifactId: receipt.artifactId,
            receiptChecksum: receipt.checksum,
            valueType: dimension.valueType,
          };
        }),
      }),
    );
    rootPreviousChecksum = page.checksum;
    rootPageCount += 1;
  }

  const numeric = inventory.filter(({ valueType }) => valueType === "latencyMs");
  let evaluationPreviousChecksum = "NONE";
  let evaluationPageCount = 0;
  let failCount = 0;
  let missingCount = 0;
  for (let offset = 0; offset < numeric.length; offset += qualificationDimensionPageSize) {
    const slice = numeric.slice(offset, offset + qualificationDimensionPageSize);
    const evaluations = new Array<
      (typeof QualificationDimensionEvaluationPage.Type)["evaluations"][number]
    >();
    for (const dimension of slice) {
      const receipt = roots.get(dimension.dimension);
      if (receipt === undefined)
        return { code: "qualificationDimensionRootCoverage", status: "FAIL" };
      const indexesToRead = qualificationDimensionSelectedIndexes(receipt);
      const selectedValues = new Array<number>();
      for (const index of indexesToRead) {
        const selected = await input.step.do(
          `read dimension statistic ${dimensionKey(dimension.dimension)} ${index}`,
          () =>
            readQualificationDimensionSelectedValue({
              bucket: input.env.ARTIFACTS,
              index,
              receipt,
            }),
        );
        if (selected.status !== "COMPLETE") {
          return { code: "qualificationDimensionStatisticMaterial", status: selected.status };
        }
        selectedValues.push(selected.value);
      }
      const evaluation = qualificationDimensionEvaluation({ receipt, selectedValues });
      if (evaluation === null) return { code: "qualificationDimensionEvaluation", status: "FAIL" };
      evaluations.push(evaluation);
    }
    const page = await input.step.do(
      `retain dimension evaluation page ${evaluationPageCount}`,
      () =>
        retainEvaluationPage({
          bucket: input.env.ARTIFACTS,
          evaluations,
          executionId: input.payload.executionId,
          firstDimensionIndex: offset,
          index: evaluationPageCount,
          planChecksum: input.payload.planChecksum,
          previousPageChecksum: evaluationPreviousChecksum,
        }),
    );
    evaluationPreviousChecksum = page.checksum;
    evaluationPageCount += 1;
    failCount += page.failCount;
    missingCount += page.missingCount;
  }
  const rootInventory = await inventoryIndexedArtifacts({
    env: input.env,
    expectedCount: rootPageCount,
    kind: "dimension roots",
    prefix: `${basePrefix(input.payload.executionId)}/root-pages`,
    step: input.step,
  });
  if (rootInventory !== "COMPLETE") {
    return { code: "qualificationDimensionRootPages", status: rootInventory };
  }
  const evaluationInventory = await inventoryIndexedArtifacts({
    env: input.env,
    expectedCount: evaluationPageCount,
    kind: "dimension evaluations",
    prefix: `${basePrefix(input.payload.executionId)}/evaluation-pages`,
    step: input.step,
  });
  if (evaluationInventory !== "COMPLETE") {
    return { code: "qualificationDimensionEvaluationPages", status: evaluationInventory };
  }
  const identityMissing = inventory
    .filter(({ valueType }) => valueType === "identity")
    .some((dimension) => roots.get(dimension.dimension)?.sampleStatus === "MISSING");
  const verdict = failCount > 0 ? "FAIL" : missingCount > 0 || identityMissing ? "MISSING" : "PASS";
  const completion = await input.step.do("retain dimension coordinator completion", () =>
    retainCoordinatorCompletion({
      bucket: input.env.ARTIFACTS,
      dimensionCount: inventory.length,
      evaluationPageCount,
      executionId: input.payload.executionId,
      identityDimensionCount: inventory.length - numeric.length,
      numericDimensionCount: numeric.length,
      planChecksum: input.payload.planChecksum,
      rootPageCount,
      terminalEvaluationPageChecksum: evaluationPreviousChecksum,
      terminalRootPageChecksum: rootPreviousChecksum,
      verdict,
    }),
  );
  return {
    artifactId: completion.artifactId,
    checksum: completion.checksum,
    status: "COMPLETE",
    verdict,
  };
};

/** Private long-lived coordinator for exact per-dimension reducer forests. */
export class QualificationOwnerDimensionCoordinatorWorkflow extends WorkflowEntrypoint<
  QualificationDimensionCoordinatorEnv,
  QualificationOwnerDimensionWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationOwnerDimensionWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<QualificationOwnerDimensionCoordinatorOutcome> {
    const durableStep: QualificationDimensionStep = {
      do: step.do.bind(step),
      sleepUntil: step.sleepUntil.bind(step),
    };
    return runQualificationOwnerDimensionCoordinator({
      env: this.env,
      payload: event.payload,
      step: durableStep,
    });
  }
}

export {
  buildDimensionLevel as buildQualificationDimensionLevel,
  launchDimensionLevels as launchQualificationDimensionLevels,
  retainIndexSegment as retainQualificationDimensionIndexSegment,
  settleDimensionLevel as settleQualificationDimensionLevel,
};
