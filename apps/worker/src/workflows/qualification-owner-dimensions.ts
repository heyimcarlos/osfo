import { Option, Schema } from "effect";

import { decodeFrozenQualificationExecution } from "../qualification/frozen-execution";
import {
  qualificationEvaluationDimensionInventory,
  qualificationEvaluationReducerFanIn,
  authenticateQualificationEvaluationSortedRunReceipt,
  QualificationEvaluationSortedRunShard,
  qualificationOrderStatisticIndex,
  type QualificationEvaluationArtifactBucket,
  type QualificationEvaluationDimensionInventoryEntry,
  type QualificationEvaluationSortedRunReceipt,
} from "../qualification/qualification-evaluation-reducer";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { stageObjectives } from "../qualification/stage-evidence";
import type {
  QualificationEvaluationReducerWorkflowPayload,
  QualificationOwnerDimensionWorkflowPayload,
} from "../workflow-contracts";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Cloudflare Workflow, Workflow instance, and R2 APIs are Promise-only durable host boundaries; loops are bounded by frozen page and fan-in limits. */

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const SortedReference = Schema.Struct({ artifactId: Identity, checksum: Identity });
const QualificationDimensionReducerPayload = Schema.Struct({
  denominatorChainDigest: Identity,
  denominatorCount: NonNegativeInteger,
  dimension: Identity,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  inputs: Schema.Array(SortedReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationReducerFanIn),
  ),
  lastPartitionIndex: NonNegativeInteger,
  level: PositiveInteger,
  missingRootCount: NonNegativeInteger,
  outputArtifactPrefix: Identity,
  outputRunId: Identity,
  planChecksum: Identity,
  valueType: Schema.Literals(["identity", "latencyMs"]),
});
const padded = (value: number) => value.toString().padStart(8, "0");
const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const qualificationDimensionPageSize = 50;
export const qualificationDimensionLevelDeadlineMs = 24 * 60 * 60_000;

export const QualificationDimensionIndexSegment = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  dimension: Identity,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  lastPartitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousSegmentChecksum: Schema.String,
  references: Schema.Array(SortedReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationDimensionPageSize),
  ),
  valueType: Schema.Literals(["identity", "latencyMs"]),
  version: Schema.Literal("qualification-dimension-index-segment-v1"),
});

export const QualificationDimensionLaunchPage = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  dimension: Identity,
  executionId: Identity,
  firstNodeIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  lastNodeIndex: NonNegativeInteger,
  level: PositiveInteger,
  payloads: Schema.Array(QualificationDimensionReducerPayload).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationDimensionPageSize),
  ),
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  version: Schema.Literal("qualification-dimension-launch-page-v1"),
});

export const QualificationDimensionCompletionPage = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  dimension: Identity,
  executionId: Identity,
  firstNodeIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  lastNodeIndex: NonNegativeInteger,
  launchPageChecksum: Identity,
  level: PositiveInteger,
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  references: Schema.Array(SortedReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationDimensionPageSize),
  ),
  version: Schema.Literal("qualification-dimension-completion-page-v1"),
});

export const QualificationDimensionEvaluation = Schema.Struct({
  denominatorCount: NonNegativeInteger,
  dimension: Identity,
  firstPartitionIndex: NonNegativeInteger,
  lastPartitionIndex: NonNegativeInteger,
  maximum: Schema.NullOr(Schema.Finite),
  missingRootCount: NonNegativeInteger,
  objectiveMaximumLatencyMs: Schema.NullOr(NonNegativeInteger),
  objectiveRequiredRatio: Schema.NullOr(Schema.Finite),
  p50: Schema.NullOr(Schema.Finite),
  p95: Schema.NullOr(Schema.Finite),
  p99: Schema.NullOr(Schema.Finite),
  receiptArtifactId: Identity,
  receiptChecksum: Identity,
  sampleStatus: Schema.Literals(["COMPLETE", "MISSING"]),
  thresholdOrderStatistic: Schema.NullOr(Schema.Finite),
  valueCount: NonNegativeInteger,
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
});

export const QualificationDimensionRootPage = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  firstDimensionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  lastDimensionIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  references: Schema.Array(
    Schema.Struct({
      dimension: Identity,
      receiptArtifactId: Identity,
      receiptChecksum: Identity,
      valueType: Schema.Literals(["identity", "latencyMs"]),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(qualificationDimensionPageSize)),
  version: Schema.Literal("qualification-dimension-root-page-v1"),
});

export const QualificationDimensionEvaluationPage = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  evaluations: Schema.Array(QualificationDimensionEvaluation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationDimensionPageSize),
  ),
  executionId: Identity,
  failCount: NonNegativeInteger,
  firstDimensionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  lastDimensionIndex: NonNegativeInteger,
  missingCount: NonNegativeInteger,
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  version: Schema.Literal("qualification-dimension-evaluation-page-v1"),
});

export const QualificationDimensionCoordinatorCompletion = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  dimensionCount: NonNegativeInteger,
  evaluationPageCount: NonNegativeInteger,
  executionId: Identity,
  identityDimensionCount: NonNegativeInteger,
  numericDimensionCount: NonNegativeInteger,
  planChecksum: Identity,
  rootPageCount: NonNegativeInteger,
  terminalEvaluationPageChecksum: Schema.String,
  terminalRootPageChecksum: Schema.String,
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
  version: Schema.Literal("qualification-dimension-coordinator-completion-v1"),
});

export interface QualificationDimensionInputReference {
  readonly artifactId: string;
  readonly checksum: string;
  readonly denominatorChainDigest: string;
  readonly denominatorCount: number;
  readonly firstPartitionIndex: number;
  readonly lastPartitionIndex: number;
  readonly missingRootCount: number;
  readonly valueType: "identity" | "latencyMs";
}

const outputPrefix = (executionId: string, dimension: string, level: number, index: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-dimensions/${qualificationChecksum({ dimension })}/level-${padded(level)}/nodes/${padded(index)}`;

/** Construct one reducer payload only from authenticated, contiguous child receipts. */
export const qualificationDimensionReducerPayload = (input: {
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly level: number;
  readonly planChecksum: string;
  readonly references: ReadonlyArray<QualificationDimensionInputReference>;
}): QualificationEvaluationReducerWorkflowPayload | null => {
  const first = input.references[0];
  const last = input.references.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.references.length > qualificationEvaluationReducerFanIn ||
    new Set(input.references.map(({ checksum }) => checksum)).size !== input.references.length ||
    input.references.some(
      (reference, index) =>
        reference.valueType !== first.valueType ||
        reference.firstPartitionIndex > reference.lastPartitionIndex ||
        (index > 0 &&
          reference.firstPartitionIndex !==
            (input.references[index - 1]?.lastPartitionIndex ?? Number.NaN) + 1),
    )
  ) {
    return null;
  }
  const denominatorCount = input.references.reduce(
    (sum, reference) => sum + reference.denominatorCount,
    0,
  );
  const missingRootCount = input.references.reduce(
    (sum, reference) => sum + reference.missingRootCount,
    0,
  );
  if (
    !Number.isSafeInteger(denominatorCount) ||
    !Number.isSafeInteger(missingRootCount) ||
    denominatorCount < 0 ||
    missingRootCount < 0
  ) {
    return null;
  }
  const references = input.references.map(({ artifactId, checksum }) => ({
    artifactId,
    checksum,
  }));
  const outputRunId = `qdr:${qualificationChecksum({
    dimension: input.dimension,
    executionId: input.executionId,
    index: input.index,
    level: input.level,
  })}`;
  return {
    denominatorChainDigest: qualificationChecksum(
      input.references.map((reference) => ({
        checksum: reference.checksum,
        denominatorChainDigest: reference.denominatorChainDigest,
        denominatorCount: reference.denominatorCount,
        firstPartitionIndex: reference.firstPartitionIndex,
        lastPartitionIndex: reference.lastPartitionIndex,
      })),
    ),
    denominatorCount,
    dimension: input.dimension,
    executionId: input.executionId,
    firstPartitionIndex: first.firstPartitionIndex,
    index: input.index,
    inputReceiptChainDigest: qualificationChecksum(references.map(({ checksum }) => checksum)),
    inputs: references,
    lastPartitionIndex: last.lastPartitionIndex,
    level: input.level,
    missingRootCount,
    outputArtifactPrefix: outputPrefix(
      input.executionId,
      input.dimension,
      input.level,
      input.index,
    ),
    outputRunId,
    planChecksum: input.planChecksum,
    valueType: first.valueType,
  };
};

const objectiveForDimension = (dimension: string) => {
  if (!dimension.startsWith("stage:")) return null;
  const stage = dimension.split(":")[4];
  return stageObjectives.find((candidate) => candidate.stage === stage) ?? null;
};

/** Exact unique sorted-run offsets needed for percentile and SLO evaluation. */
export const qualificationDimensionSelectedIndexes = (
  receipt: typeof QualificationEvaluationSortedRunReceipt.Type,
): ReadonlyArray<number> => {
  if (receipt.valueType !== "latencyMs") return [];
  const objective = objectiveForDimension(receipt.dimension);
  return [
    qualificationOrderStatisticIndex(receipt.valueCount, 0.5),
    qualificationOrderStatisticIndex(receipt.valueCount, 0.95),
    qualificationOrderStatisticIndex(receipt.valueCount, 0.99),
    objective === null || receipt.sampleStatus === "MISSING" || receipt.missingRootCount > 0
      ? null
      : qualificationOrderStatisticIndex(receipt.denominatorCount, objective.requiredRatio),
  ]
    .filter((index): index is number => index !== null)
    .filter((index, position, all) => all.indexOf(index) === position);
};

/** Evaluate exact numeric order statistics after the final sorted receipt is authenticated. */
export const qualificationDimensionEvaluation = (input: {
  readonly receipt: typeof QualificationEvaluationSortedRunReceipt.Type;
  readonly selectedValues: ReadonlyArray<number>;
}): typeof QualificationDimensionEvaluation.Type | null => {
  if (input.receipt.valueType !== "latencyMs") return null;
  const indexes = [0.5, 0.95, 0.99].map((percentile) =>
    qualificationOrderStatisticIndex(input.receipt.valueCount, percentile),
  );
  const objective = objectiveForDimension(input.receipt.dimension);
  const thresholdIndex =
    objective === null
      ? null
      : qualificationOrderStatisticIndex(input.receipt.denominatorCount, objective.requiredRatio);
  const expectedIndexes = qualificationDimensionSelectedIndexes(input.receipt);
  if (
    input.selectedValues.length !== expectedIndexes.length ||
    input.selectedValues.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return null;
  }
  const byIndex = new Map(
    expectedIndexes.map((index, position) => [index, input.selectedValues[position]]),
  );
  const [p50Index = null, p95Index = null, p99Index = null] = indexes;
  const p50 = p50Index === null ? null : (byIndex.get(p50Index) ?? null);
  const p95 = p95Index === null ? null : (byIndex.get(p95Index) ?? null);
  const p99 = p99Index === null ? null : (byIndex.get(p99Index) ?? null);
  const thresholdOrderStatistic =
    thresholdIndex === null || !expectedIndexes.includes(thresholdIndex)
      ? null
      : (byIndex.get(thresholdIndex) ?? null);
  const verdict =
    input.receipt.sampleStatus === "MISSING" ||
    input.receipt.missingRootCount > 0 ||
    input.receipt.valueCount === 0
      ? "MISSING"
      : objective !== null &&
          (thresholdOrderStatistic === null || thresholdOrderStatistic > objective.maximumLatencyMs)
        ? "FAIL"
        : "PASS";
  return Option.getOrNull(
    Schema.decodeOption(QualificationDimensionEvaluation)({
      denominatorCount: input.receipt.denominatorCount,
      dimension: input.receipt.dimension,
      firstPartitionIndex: input.receipt.firstPartitionIndex,
      lastPartitionIndex: input.receipt.lastPartitionIndex,
      maximum: input.receipt.maximum,
      missingRootCount: input.receipt.missingRootCount,
      objectiveMaximumLatencyMs: objective?.maximumLatencyMs ?? null,
      objectiveRequiredRatio: objective?.requiredRatio ?? null,
      p50,
      p95,
      p99,
      receiptArtifactId: input.receipt.artifactId,
      receiptChecksum: input.receipt.checksum,
      sampleStatus: input.receipt.sampleStatus,
      thresholdOrderStatistic,
      valueCount: input.receipt.valueCount,
      verdict,
    }),
  );
};

export type QualificationDimensionInventory =
  ReadonlyArray<QualificationEvaluationDimensionInventoryEntry>;

/** Reconstruct the exact server-owned dimension inventory from the retained request. */
export const readQualificationDimensionInventory = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly payload: QualificationOwnerDimensionWorkflowPayload;
}): Promise<QualificationDimensionMaterialOutcome<QualificationDimensionInventory>> => {
  const retained = await input.bucket.get(input.payload.requestArtifactId);
  if (retained === null) return { status: "MISSING" };
  const frozen = decodeFrozenQualificationExecution(await retained.text(), input.payload);
  return frozen === null
    ? { status: "FAIL" }
    : { status: "COMPLETE", value: qualificationEvaluationDimensionInventory(frozen.plan) };
};

export const qualificationDimensionReducerWorkflowId = (
  payload: QualificationEvaluationReducerWorkflowPayload,
) =>
  `qdr:${qualificationChecksum({
    dimension: payload.dimension,
    executionId: payload.executionId,
    index: payload.index,
    level: payload.level,
  })}`;

export const qualificationDimensionCoordinatorWorkflowId = (input: {
  readonly executionId: string;
  readonly planChecksum: string;
}) => `qdc:${qualificationChecksum(input)}`;

export const qualificationDimensionCoordinatorArtifactPrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-dimensions`;

export type QualificationDimensionMaterialOutcome<Value> =
  | { readonly status: "COMPLETE"; readonly value: Value }
  | { readonly status: "FAIL" | "MISSING" };

const dimensionRootPageArtifactId = (executionId: string, index: number) =>
  `${qualificationDimensionCoordinatorArtifactPrefix(executionId)}/root-pages/${padded(index)}.json`;
const dimensionEvaluationPageArtifactId = (executionId: string, index: number) =>
  `${qualificationDimensionCoordinatorArtifactPrefix(executionId)}/evaluation-pages/${padded(index)}.json`;

const readDimensionRootPage = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly executionId: string;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const artifactId = dimensionRootPageArtifactId(input.executionId, input.index);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return { status: "MISSING" as const };
  const encoded = await retained.text();
  let page: typeof QualificationDimensionRootPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationDimensionRootPage))(encoded);
  } catch {
    return { status: "FAIL" as const };
  }
  const { checksum, ...content } = page;
  const authentic =
    page.artifactId === artifactId &&
    page.checksum === qualificationChecksum(content) &&
    page.executionId === input.executionId &&
    page.index === input.index &&
    page.planChecksum === input.planChecksum &&
    page.previousPageChecksum === input.previousPageChecksum &&
    page.lastDimensionIndex === page.firstDimensionIndex + page.references.length - 1 &&
    new Set(page.references.map(({ dimension }) => dimension)).size === page.references.length &&
    new Set(page.references.map(({ receiptChecksum }) => receiptChecksum)).size ===
      page.references.length &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-execution-id"] === input.executionId &&
    retained.customMetadata?.["osfo-first-dimension-index"] === String(page.firstDimensionIndex) &&
    retained.customMetadata?.["osfo-index"] === String(page.index) &&
    retained.customMetadata?.["osfo-kind"] === "qualification-dimension-root-page-v1" &&
    retained.customMetadata?.["osfo-last-dimension-index"] === String(page.lastDimensionIndex) &&
    retained.customMetadata?.["osfo-plan-checksum"] === input.planChecksum &&
    retained.customMetadata?.["osfo-previous-checksum"] === page.previousPageChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(page.references.length);
  return authentic ? { page, status: "COMPLETE" as const } : { status: "FAIL" as const };
};

const readDimensionEvaluationPage = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly executionId: string;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const artifactId = dimensionEvaluationPageArtifactId(input.executionId, input.index);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return { status: "MISSING" as const };
  const encoded = await retained.text();
  let page: typeof QualificationDimensionEvaluationPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationDimensionEvaluationPage))(encoded);
  } catch {
    return { status: "FAIL" as const };
  }
  const { checksum, ...content } = page;
  const authentic =
    page.artifactId === artifactId &&
    page.checksum === qualificationChecksum(content) &&
    page.executionId === input.executionId &&
    page.failCount === page.evaluations.filter(({ verdict }) => verdict === "FAIL").length &&
    page.index === input.index &&
    page.missingCount === page.evaluations.filter(({ verdict }) => verdict === "MISSING").length &&
    page.planChecksum === input.planChecksum &&
    page.previousPageChecksum === input.previousPageChecksum &&
    page.lastDimensionIndex === page.firstDimensionIndex + page.evaluations.length - 1 &&
    new Set(page.evaluations.map(({ dimension }) => dimension)).size === page.evaluations.length &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-execution-id"] === input.executionId &&
    retained.customMetadata?.["osfo-fail-count"] === String(page.failCount) &&
    retained.customMetadata?.["osfo-first-dimension-index"] === String(page.firstDimensionIndex) &&
    retained.customMetadata?.["osfo-index"] === String(page.index) &&
    retained.customMetadata?.["osfo-kind"] === "qualification-dimension-evaluation-page-v1" &&
    retained.customMetadata?.["osfo-last-dimension-index"] === String(page.lastDimensionIndex) &&
    retained.customMetadata?.["osfo-missing-count"] === String(page.missingCount) &&
    retained.customMetadata?.["osfo-plan-checksum"] === input.planChecksum &&
    retained.customMetadata?.["osfo-previous-checksum"] === page.previousPageChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(page.evaluations.length);
  return authentic ? { page, status: "COMPLETE" as const } : { status: "FAIL" as const };
};

/** Re-authenticate the compact descriptor and every bounded page chain it names. */
export const authenticateQualificationDimensionCoordinatorCompletion = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly checksum: string;
  readonly executionId: string;
  readonly planChecksum: string;
}): Promise<
  QualificationDimensionMaterialOutcome<typeof QualificationDimensionCoordinatorCompletion.Type>
> => {
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  let completion: typeof QualificationDimensionCoordinatorCompletion.Type;
  try {
    completion = Schema.decodeSync(
      Schema.fromJsonString(QualificationDimensionCoordinatorCompletion),
    )(encoded);
  } catch {
    return { status: "FAIL" };
  }
  const { checksum, ...content } = completion;
  const authentic =
    completion.artifactId === input.artifactId &&
    completion.checksum === input.checksum &&
    completion.checksum === qualificationChecksum(content) &&
    completion.executionId === input.executionId &&
    completion.planChecksum === input.planChecksum &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-dimension-count"] === String(completion.dimensionCount) &&
    retained.customMetadata?.["osfo-execution-id"] === input.executionId &&
    retained.customMetadata?.["osfo-kind"] ===
      "qualification-dimension-coordinator-completion-v1" &&
    retained.customMetadata?.["osfo-plan-checksum"] === input.planChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(completion.evaluationPageCount) &&
    retained.customMetadata?.["osfo-verdict"] === completion.verdict &&
    completion.dimensionCount ===
      completion.identityDimensionCount + completion.numericDimensionCount &&
    completion.rootPageCount ===
      Math.ceil(completion.dimensionCount / qualificationDimensionPageSize) &&
    completion.evaluationPageCount ===
      Math.ceil(completion.numericDimensionCount / qualificationDimensionPageSize);
  if (!authentic) return { status: "FAIL" };

  let previousRootChecksum = "NONE";
  let rootReferenceCount = 0;
  const rootReferences = new Map<
    string,
    {
      readonly artifactId: string;
      readonly checksum: string;
      readonly valueType: "identity" | "latencyMs";
    }
  >();
  for (let index = 0; index < completion.rootPageCount; index += 1) {
    const result = await readDimensionRootPage({
      bucket: input.bucket,
      executionId: input.executionId,
      index,
      planChecksum: input.planChecksum,
      previousPageChecksum: previousRootChecksum,
    });
    if (result.status !== "COMPLETE") return result;
    if (result.page.firstDimensionIndex !== rootReferenceCount) return { status: "FAIL" };
    for (const reference of result.page.references) {
      if (rootReferences.has(reference.dimension)) return { status: "FAIL" };
      rootReferences.set(reference.dimension, {
        artifactId: reference.receiptArtifactId,
        checksum: reference.receiptChecksum,
        valueType: reference.valueType,
      });
    }
    rootReferenceCount += result.page.references.length;
    previousRootChecksum = result.page.checksum;
  }
  if (
    rootReferenceCount !== completion.dimensionCount ||
    previousRootChecksum !== completion.terminalRootPageChecksum
  ) {
    return { status: "FAIL" };
  }

  let previousEvaluationChecksum = "NONE";
  let evaluationCount = 0;
  let failCount = 0;
  let missingCount = 0;
  const evaluatedDimensions = new Set<string>();
  for (let index = 0; index < completion.evaluationPageCount; index += 1) {
    const result = await readDimensionEvaluationPage({
      bucket: input.bucket,
      executionId: input.executionId,
      index,
      planChecksum: input.planChecksum,
      previousPageChecksum: previousEvaluationChecksum,
    });
    if (result.status !== "COMPLETE") return result;
    if (result.page.firstDimensionIndex !== evaluationCount) return { status: "FAIL" };
    for (const evaluation of result.page.evaluations) {
      const root = rootReferences.get(evaluation.dimension);
      if (
        root === undefined ||
        root.valueType !== "latencyMs" ||
        root.artifactId !== evaluation.receiptArtifactId ||
        root.checksum !== evaluation.receiptChecksum ||
        evaluatedDimensions.has(evaluation.dimension)
      ) {
        return { status: "FAIL" };
      }
      evaluatedDimensions.add(evaluation.dimension);
    }
    evaluationCount += result.page.evaluations.length;
    failCount += result.page.failCount;
    missingCount += result.page.missingCount;
    previousEvaluationChecksum = result.page.checksum;
  }
  if (
    evaluationCount !== completion.numericDimensionCount ||
    [...rootReferences.values()].filter(({ valueType }) => valueType === "identity").length !==
      completion.identityDimensionCount ||
    [...rootReferences.values()].filter(({ valueType }) => valueType === "latencyMs").length !==
      completion.numericDimensionCount ||
    previousEvaluationChecksum !== completion.terminalEvaluationPageChecksum ||
    (failCount > 0 && completion.verdict !== "FAIL") ||
    (failCount === 0 && missingCount > 0 && completion.verdict === "PASS")
  ) {
    return { status: "FAIL" };
  }
  return { status: "COMPLETE", value: completion };
};

/** Read and authenticate one final reducer receipt for a frozen dimension. */
export const authenticateQualificationDimensionRoot = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly dimension: QualificationEvaluationDimensionInventoryEntry;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly reference: { readonly artifactId: string; readonly checksum: string };
}): Promise<
  QualificationDimensionMaterialOutcome<typeof QualificationEvaluationSortedRunReceipt.Type>
> => {
  const retained = await input.bucket.get(input.reference.artifactId);
  if (retained === null) return { status: "MISSING" };
  const receipt = await authenticateQualificationEvaluationSortedRunReceipt({
    bucket: input.bucket,
    dimension: input.dimension.dimension,
    executionId: input.executionId,
    planChecksum: input.planChecksum,
    reference: input.reference,
  });
  return receipt !== null &&
    receipt.firstPartitionIndex === input.dimension.firstPartitionIndex &&
    receipt.lastPartitionIndex === input.dimension.lastPartitionIndex &&
    receipt.valueType === input.dimension.valueType
    ? { status: "COMPLETE", value: receipt }
    : { status: "FAIL" };
};

/** Canonical body helper shared by the coordinator's create-or-identical artifacts. */
export const encodedQualificationDimensionArtifact = (value: { readonly checksum: string }) =>
  canonicalQualificationJson(value);

export type QualificationDimensionBucket = QualificationEvaluationArtifactBucket;

/** Resolve one selected numeric value from a bounded final shard. */
export const readQualificationDimensionSelectedValue = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly index: number;
  readonly receipt: typeof QualificationEvaluationSortedRunReceipt.Type;
}): Promise<QualificationDimensionMaterialOutcome<number>> => {
  if (
    input.receipt.valueType !== "latencyMs" ||
    input.index < 0 ||
    input.index >= input.receipt.valueCount
  ) {
    return { status: "FAIL" };
  }
  const shardIndex = Math.floor(input.index / 256);
  const artifactId = `${input.receipt.artifactPrefix}/${padded(shardIndex)}.json`;
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return { status: "MISSING" };
  const encoded = await retained.text();
  let shard: typeof QualificationEvaluationSortedRunShard.Type;
  try {
    shard = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationSortedRunShard))(
      encoded,
    );
  } catch {
    return { status: "FAIL" };
  }
  const { checksum, ...content } = shard;
  const candidate = shard.values[input.index % 256];
  const value = Schema.is(Schema.Finite)(candidate) ? candidate : undefined;
  return shard.artifactId === artifactId &&
    shard.checksum === qualificationChecksum(content) &&
    shard.denominatorChainDigest === input.receipt.denominatorChainDigest &&
    shard.denominatorCount === input.receipt.denominatorCount &&
    shard.dimension === input.receipt.dimension &&
    shard.executionId === input.receipt.executionId &&
    shard.firstPartitionIndex === input.receipt.firstPartitionIndex &&
    shard.index === shardIndex &&
    shard.inputReceiptChainDigest === input.receipt.inputReceiptChainDigest &&
    shard.lastPartitionIndex === input.receipt.lastPartitionIndex &&
    shard.missingRootCount === input.receipt.missingRootCount &&
    shard.planChecksum === input.receipt.planChecksum &&
    shard.runId === input.receipt.runId &&
    shard.sampleStatus === input.receipt.sampleStatus &&
    shard.valueType === "latencyMs" &&
    (shard.index === 0 ? shard.checksum === input.receipt.firstShardChecksum : true) &&
    (shard.index === input.receipt.shardCount - 1
      ? shard.checksum === input.receipt.terminalShardChecksum
      : true) &&
    retained.customMetadata?.["osfo-artifact-checksum"] === checksum &&
    retained.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(encoded)) &&
    retained.customMetadata?.["osfo-denominator-chain-digest"] === shard.denominatorChainDigest &&
    retained.customMetadata?.["osfo-denominator-count"] === String(shard.denominatorCount) &&
    retained.customMetadata?.["osfo-dimension"] === shard.dimension &&
    retained.customMetadata?.["osfo-execution-id"] === shard.executionId &&
    retained.customMetadata?.["osfo-first-partition-index"] === String(shard.firstPartitionIndex) &&
    retained.customMetadata?.["osfo-index"] === String(shard.index) &&
    retained.customMetadata?.["osfo-input-receipt-chain-digest"] ===
      shard.inputReceiptChainDigest &&
    retained.customMetadata?.["osfo-kind"] === "qualification-evaluation-sorted-run-v2" &&
    retained.customMetadata?.["osfo-last-partition-index"] === String(shard.lastPartitionIndex) &&
    retained.customMetadata?.["osfo-missing-root-count"] === String(shard.missingRootCount) &&
    retained.customMetadata?.["osfo-plan-checksum"] === shard.planChecksum &&
    retained.customMetadata?.["osfo-previous-checksum"] === shard.previousShardChecksum &&
    retained.customMetadata?.["osfo-record-count"] === String(shard.values.length) &&
    retained.customMetadata?.["osfo-run-id"] === shard.runId &&
    retained.customMetadata?.["osfo-sample-status"] === shard.sampleStatus &&
    retained.customMetadata?.["osfo-value-type"] === shard.valueType &&
    value !== undefined
    ? { status: "COMPLETE", value }
    : { status: "FAIL" };
};
export const qualificationDimensionCoordinatorCompletionArtifactId = (executionId: string) =>
  `${qualificationDimensionCoordinatorArtifactPrefix(executionId)}/completion.json`;
