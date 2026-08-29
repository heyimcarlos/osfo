import { Array, Order, Schema } from "effect";

import { qualificationAuthoritySources } from "./authority-sources";
import { qualificationChecksum } from "./qualification-checksum";

/* oxlint-disable effecttsgo/async-function -- Web Crypto and R2 are Promise-native adapter boundaries owned by this module. */

export const qualificationEvaluationReducerFanIn = 16;
export const qualificationEvaluationSampleShardLimit = 256;
export const qualificationEvaluationFindingExemplarLimit = 32;
export const qualificationEvaluationReducerStepBudget = 10_000;

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const QualificationEvaluationFinding = Schema.Struct({
  code: Identity,
  detail: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  subject: Identity,
  verdict: Schema.Literals(["FAIL", "MISSING"]),
});

export const QualificationEvaluationFindingSummary = Schema.Struct({
  exemplars: Schema.Array(QualificationEvaluationFinding).check(
    Schema.isMaxLength(qualificationEvaluationFindingExemplarLimit),
  ),
  failCount: NonNegativeInteger,
  missingCount: NonNegativeInteger,
});

export const QualificationEvaluationFindingShard = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  findings: Schema.Array(QualificationEvaluationFinding).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationSampleShardLimit),
  ),
  index: NonNegativeInteger,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousShardChecksum: Schema.String,
  version: Schema.Literal("qualification-evaluation-findings-v1"),
});

const QualificationEvaluationLeafAuthorityInput = Schema.Struct({
  checksum: Identity,
  recordCount: NonNegativeInteger,
  source: Schema.Literals(qualificationAuthoritySources),
});

export const QualificationEvaluationLeafInputReceipt = Schema.Struct({
  artifactId: Identity,
  arrivalChecksum: Identity,
  arrivalRecordCount: Schema.Int.check(Schema.isGreaterThan(0)),
  authorityInputs: Schema.Array(QualificationEvaluationLeafAuthorityInput).check(
    Schema.isMinLength(qualificationAuthoritySources.length),
    Schema.isMaxLength(qualificationAuthoritySources.length),
  ),
  checksum: Identity,
  executionId: Identity,
  partitionCompletionChecksum: Identity,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  streamChunkIndex: NonNegativeInteger,
  version: Schema.Literal("qualification-evaluation-leaf-input-v1"),
});

export const QualificationEvaluationSortedRunDescriptor = Schema.Struct({
  artifactPrefix: Identity,
  dimension: Identity,
  firstShardChecksum: Identity,
  maximum: Schema.Finite,
  minimum: Schema.Finite,
  runId: Identity,
  shardCount: NonNegativeInteger,
  terminalShardChecksum: Identity,
  valueCount: NonNegativeInteger,
});

export const QualificationEvaluationSortedRunReceipt = Schema.Struct({
  ...QualificationEvaluationSortedRunDescriptor.fields,
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  index: NonNegativeInteger,
  inputReceiptChecksums: Schema.Array(Identity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationReducerFanIn),
  ),
  level: NonNegativeInteger,
  planChecksum: Identity,
  version: Schema.Literal("qualification-evaluation-sorted-run-receipt-v1"),
});

const QualificationEvaluationReductionInput = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  firstPartitionIndex: NonNegativeInteger,
  lastPartitionIndex: NonNegativeInteger,
});

export const QualificationEvaluationFindingSummaryShard = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  index: NonNegativeInteger,
  inputChecksums: Schema.Array(Identity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationReducerFanIn),
  ),
  level: NonNegativeInteger,
  planChecksum: Identity,
  summary: QualificationEvaluationFindingSummary,
  version: Schema.Literal("qualification-evaluation-finding-summary-v1"),
});

export const QualificationEvaluationReductionReceipt = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  findingSummaryArtifactChecksum: Identity,
  findingSummaryArtifactId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputs: Schema.Array(QualificationEvaluationReductionInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationReducerFanIn),
  ),
  lastPartitionIndex: NonNegativeInteger,
  level: NonNegativeInteger,
  planChecksum: Identity,
  sortedRuns: Schema.Array(QualificationEvaluationSortedRunReceipt),
  version: Schema.Literal("qualification-evaluation-reduction-v1"),
});

export const QualificationEvaluationSortedRunShard = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  dimension: Identity,
  executionId: Identity,
  index: NonNegativeInteger,
  maximum: Schema.Finite,
  minimum: Schema.Finite,
  planChecksum: Identity,
  previousShardChecksum: Schema.String,
  runId: Identity,
  values: Schema.Array(Schema.Finite).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationSampleShardLimit),
  ),
  version: Schema.Literal("qualification-evaluation-sorted-run-v1"),
});

export interface QualificationEvaluationMergeInput {
  readonly descriptor: typeof QualificationEvaluationSortedRunDescriptor.Type;
  readonly shard: typeof QualificationEvaluationSortedRunShard.Type | null;
  readonly valueOffset: number;
}

/** Bind one evaluator leaf to the exact arrival and ordered producer-authority bodies it read. */
export const qualificationEvaluationLeafInputReceipt = (input: {
  readonly artifactId: string;
  readonly arrivalChecksum: string;
  readonly arrivalRecordCount: number;
  readonly authorityInputs: ReadonlyArray<{
    readonly checksum: string;
    readonly recordCount: number;
    readonly source: (typeof qualificationAuthoritySources)[number];
  }>;
  readonly executionId: string;
  readonly partitionCompletionChecksum: string;
  readonly partitionIndex: number;
  readonly planChecksum: string;
  readonly streamChunkIndex: number;
}): typeof QualificationEvaluationLeafInputReceipt.Type | null => {
  const expected = new Set<string>(qualificationAuthoritySources);
  if (
    input.arrivalChecksum.length === 0 ||
    !Number.isInteger(input.arrivalRecordCount) ||
    input.arrivalRecordCount <= 0 ||
    input.authorityInputs.length !== expected.size ||
    input.authorityInputs.some(
      ({ checksum, recordCount, source }, index) =>
        checksum.length === 0 ||
        !Number.isInteger(recordCount) ||
        recordCount < 0 ||
        source !== qualificationAuthoritySources[index] ||
        !expected.delete(source),
    )
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    arrivalChecksum: input.arrivalChecksum,
    arrivalRecordCount: input.arrivalRecordCount,
    authorityInputs: [...input.authorityInputs],
    executionId: input.executionId,
    partitionCompletionChecksum: input.partitionCompletionChecksum,
    partitionIndex: input.partitionIndex,
    planChecksum: input.planChecksum,
    streamChunkIndex: input.streamChunkIndex,
    version: "qualification-evaluation-leaf-input-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

/** Freeze one bounded full-finding shard; summaries never replace these retained facts. */
export const qualificationEvaluationFindingShard = (input: {
  readonly artifactId: string;
  readonly executionId: string;
  readonly findings: ReadonlyArray<typeof QualificationEvaluationFinding.Type>;
  readonly index: number;
  readonly partitionIndex: number;
  readonly planChecksum: string;
  readonly previousShardChecksum: string;
}): typeof QualificationEvaluationFindingShard.Type | null => {
  if (
    input.findings.length === 0 ||
    input.findings.length > qualificationEvaluationSampleShardLimit
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    executionId: input.executionId,
    findings: [...input.findings],
    index: input.index,
    partitionIndex: input.partitionIndex,
    planChecksum: input.planChecksum,
    previousShardChecksum: input.previousShardChecksum,
    version: "qualification-evaluation-findings-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

export const qualificationEvaluationFindingSummaryShard = (input: {
  readonly artifactId: string;
  readonly executionId: string;
  readonly index: number;
  readonly inputChecksums: ReadonlyArray<string>;
  readonly level: number;
  readonly planChecksum: string;
  readonly summary: typeof QualificationEvaluationFindingSummary.Type;
}): typeof QualificationEvaluationFindingSummaryShard.Type | null => {
  if (
    input.inputChecksums.length === 0 ||
    input.inputChecksums.length > qualificationEvaluationReducerFanIn ||
    new Set(input.inputChecksums).size !== input.inputChecksums.length
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    executionId: input.executionId,
    index: input.index,
    inputChecksums: [...input.inputChecksums],
    level: input.level,
    planChecksum: input.planChecksum,
    summary: input.summary,
    version: "qualification-evaluation-finding-summary-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

/** Freeze a reducer receipt only for one exact ordered, gap-free child range. */
export const qualificationEvaluationReductionReceipt = (input: {
  readonly artifactId: string;
  readonly executionId: string;
  readonly findingSummaryArtifactChecksum: string;
  readonly findingSummaryArtifactId: string;
  readonly index: number;
  readonly inputs: ReadonlyArray<typeof QualificationEvaluationReductionInput.Type>;
  readonly level: number;
  readonly planChecksum: string;
  readonly sortedRuns: ReadonlyArray<typeof QualificationEvaluationSortedRunReceipt.Type>;
}): typeof QualificationEvaluationReductionReceipt.Type | null => {
  const first = input.inputs[0];
  const last = input.inputs.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.inputs.length > qualificationEvaluationReducerFanIn ||
    new Set(input.inputs.map(({ checksum }) => checksum)).size !== input.inputs.length ||
    input.inputs.some(
      ({ firstPartitionIndex, lastPartitionIndex }, index, inputs) =>
        lastPartitionIndex < firstPartitionIndex ||
        (index > 0 && firstPartitionIndex !== (inputs[index - 1]?.lastPartitionIndex ?? -2) + 1),
    )
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    executionId: input.executionId,
    findingSummaryArtifactChecksum: input.findingSummaryArtifactChecksum,
    findingSummaryArtifactId: input.findingSummaryArtifactId,
    firstPartitionIndex: first.firstPartitionIndex,
    index: input.index,
    inputs: [...input.inputs],
    lastPartitionIndex: last.lastPartitionIndex,
    level: input.level,
    planChecksum: input.planChecksum,
    sortedRuns: [...input.sortedRuns],
    version: "qualification-evaluation-reduction-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

export const qualificationEvaluationSortedRunReceipt = (input: {
  readonly artifactId: string;
  readonly descriptor: typeof QualificationEvaluationSortedRunDescriptor.Type;
  readonly executionId: string;
  readonly index: number;
  readonly inputReceiptChecksums: ReadonlyArray<string>;
  readonly level: number;
  readonly planChecksum: string;
}): typeof QualificationEvaluationSortedRunReceipt.Type | null => {
  if (
    input.inputReceiptChecksums.length === 0 ||
    input.inputReceiptChecksums.length > qualificationEvaluationReducerFanIn ||
    new Set(input.inputReceiptChecksums).size !== input.inputReceiptChecksums.length
  ) {
    return null;
  }
  const content = {
    ...input.descriptor,
    artifactId: input.artifactId,
    executionId: input.executionId,
    index: input.index,
    inputReceiptChecksums: [...input.inputReceiptChecksums],
    level: input.level,
    planChecksum: input.planChecksum,
    version: "qualification-evaluation-sorted-run-receipt-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

interface QualificationEvaluationArtifactObject {
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly text: () => Promise<string>;
}

export interface QualificationEvaluationArtifactBucket {
  readonly get: (key: string) => Promise<QualificationEvaluationArtifactObject | null>;
  readonly put: (
    key: string,
    value: string,
    options: R2PutOptions,
  ) => Promise<{ readonly etag: string } | null>;
}

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return globalThis.Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** R2 is immutable transport: success, commit-uncertain replay, and conflict are explicit. */
export const retainQualificationEvaluationArtifact = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly checksum: string;
  readonly encoded: string;
  readonly executionId: string;
  readonly kind: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly planChecksum: string;
}): Promise<"CONFLICT" | "REPLAY" | "RETAINED"> => {
  const bodySha256 = await sha256Hex(input.encoded);
  const metadata = {
    "osfo-artifact-checksum": input.checksum,
    "osfo-body-sha256": bodySha256,
    "osfo-execution-id": input.executionId,
    "osfo-kind": input.kind,
    "osfo-plan-checksum": input.planChecksum,
    ...input.metadata,
  };
  const retained = await input.bucket.put(input.artifactId, input.encoded, {
    customMetadata: metadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return "RETAINED";
  const existing = await input.bucket.get(input.artifactId);
  if (existing === null || (await existing.text()) !== input.encoded) return "CONFLICT";
  return Object.entries(metadata).every(([key, value]) => existing.customMetadata?.[key] === value)
    ? "REPLAY"
    : "CONFLICT";
};

export interface QualificationEvaluationMergePage {
  readonly complete: boolean;
  readonly cursors: ReadonlyArray<{
    readonly runId: string;
    readonly shardIndex: number;
    readonly valueOffset: number;
  }>;
  readonly values: ReadonlyArray<number>;
}

const compareFinding = (
  left: typeof QualificationEvaluationFinding.Type,
  right: typeof QualificationEvaluationFinding.Type,
) => {
  const leftKey = `${left.verdict}\u0000${left.code}\u0000${left.subject}\u0000${left.detail}`;
  const rightKey = `${right.verdict}\u0000${right.code}\u0000${right.subject}\u0000${right.detail}`;
  const comparison = leftKey.localeCompare(rightKey);
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
};

/** Merge bounded finding summaries without growing Workflow state with corpus size. */
export const mergeQualificationFindingSummaries = (
  summaries: ReadonlyArray<typeof QualificationEvaluationFindingSummary.Type>,
): typeof QualificationEvaluationFindingSummary.Type => ({
  exemplars: Array.sort(
    summaries.flatMap(({ exemplars }) => exemplars),
    Order.make(compareFinding),
  ).slice(0, qualificationEvaluationFindingExemplarLimit),
  failCount: summaries.reduce((total, { failCount }) => total + failCount, 0),
  missingCount: summaries.reduce((total, { missingCount }) => total + missingCount, 0),
});

const validInput = (input: QualificationEvaluationMergeInput): boolean => {
  const shard = input.shard;
  if (shard === null) return input.descriptor.valueCount === 0 && input.valueOffset === 0;
  const { checksum, ...content } = shard;
  return (
    input.descriptor.runId === shard.runId &&
    input.descriptor.dimension === shard.dimension &&
    input.valueOffset >= 0 &&
    input.valueOffset < shard.values.length &&
    shard.values.every(
      (value, index, values) => index === 0 || value >= (values[index - 1] ?? value),
    ) &&
    shard.minimum === shard.values[0] &&
    shard.maximum === shard.values.at(-1) &&
    checksum === qualificationChecksum(content)
  );
};

/**
 * Merge one bounded output page from at most sixteen current input pages. The caller persists the
 * returned cursors before requesting the next immutable pages, so interruption never reorders or
 * drops a sample.
 */
export const mergeQualificationSortedPage = (
  inputs: ReadonlyArray<QualificationEvaluationMergeInput>,
): QualificationEvaluationMergePage | null => {
  if (
    inputs.length === 0 ||
    inputs.length > qualificationEvaluationReducerFanIn ||
    inputs.some((input) => !validInput(input))
  ) {
    return null;
  }
  const offsets = inputs.map(({ valueOffset }) => valueOffset);
  const values = new globalThis.Array<number>();
  while (values.length < qualificationEvaluationSampleShardLimit) {
    let selected = -1;
    let selectedValue = Number.POSITIVE_INFINITY;
    for (const [index, input] of inputs.entries()) {
      const value = input.shard?.values[offsets[index] ?? 0];
      if (value === undefined) continue;
      if (value < selectedValue || (value === selectedValue && selected === -1)) {
        selected = index;
        selectedValue = value;
      }
    }
    if (selected === -1) break;
    values.push(selectedValue);
    offsets[selected] = (offsets[selected] ?? 0) + 1;
  }
  return {
    complete: inputs.every(
      (input, index) => input.shard === null || offsets[index] === input.shard.values.length,
    ),
    cursors: inputs.map((input, index) => ({
      runId: input.descriptor.runId,
      shardIndex: input.shard?.index ?? input.descriptor.shardCount,
      valueOffset: offsets[index] ?? 0,
    })),
    values,
  };
};

/** Freeze one body-authenticated output shard from a reducer continuation. */
export const qualificationEvaluationSortedRunShard = (input: {
  readonly artifactId: string;
  readonly dimension: string;
  readonly executionId: string;
  readonly index: number;
  readonly planChecksum: string;
  readonly previousShardChecksum: string;
  readonly runId: string;
  readonly values: ReadonlyArray<number>;
}): typeof QualificationEvaluationSortedRunShard.Type | null => {
  if (
    input.values.length === 0 ||
    input.values.length > qualificationEvaluationSampleShardLimit ||
    input.values.some(
      (value, index, values) =>
        !Number.isFinite(value) || (index > 0 && value < (values[index - 1] ?? value)),
    )
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    dimension: input.dimension,
    executionId: input.executionId,
    index: input.index,
    maximum: input.values.at(-1) ?? 0,
    minimum: input.values[0] ?? 0,
    planChecksum: input.planChecksum,
    previousShardChecksum: input.previousShardChecksum,
    runId: input.runId,
    values: [...input.values],
    version: "qualification-evaluation-sorted-run-v1" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

/** Exact interpolation-free order statistic used by qualification percentiles. */
export const qualificationOrderStatisticIndex = (
  count: number,
  percentile: number,
): number | null =>
  Number.isInteger(count) && count > 0 && percentile > 0 && percentile <= 1
    ? Math.ceil(count * percentile) - 1
    : null;

export interface QualificationEvaluationReducerBudget {
  readonly levelWidths: ReadonlyArray<number>;
  readonly maximumContinuationComparisons: number;
  readonly maximumContinuationInputValues: number;
  readonly maximumContinuationReads: number;
  readonly maximumContinuationResultValues: number;
  readonly maximumContinuationWrites: number;
  readonly rootReceiptCount: number;
}

export const qualificationEvaluationMaximumDimensionValues = 1_750_422;

export const qualificationEvaluationMaximumDimensionContinuations = Math.ceil(
  qualificationEvaluationMaximumDimensionValues / qualificationEvaluationSampleShardLimit,
);
export const qualificationEvaluationMaximumDimensionWorkflowSteps =
  qualificationEvaluationMaximumDimensionContinuations + 2;
export const qualificationEvaluationMaximumContinuationResultBytes = 32_768;

/** Prove a fan-in tree whose individual continuations remain bounded at Public scale. */
export const qualificationEvaluationReducerBudget = (
  leafCount: number,
): QualificationEvaluationReducerBudget | null => {
  if (!Number.isInteger(leafCount) || leafCount <= 0) return null;
  const levelWidths = new globalThis.Array<number>();
  let width = leafCount;
  while (width > 1) {
    width = Math.ceil(width / qualificationEvaluationReducerFanIn);
    levelWidths.push(width);
  }
  return {
    levelWidths,
    maximumContinuationComparisons:
      qualificationEvaluationReducerFanIn * qualificationEvaluationSampleShardLimit,
    maximumContinuationInputValues:
      qualificationEvaluationReducerFanIn * qualificationEvaluationSampleShardLimit,
    maximumContinuationReads: qualificationEvaluationReducerFanIn + 1,
    maximumContinuationResultValues: qualificationEvaluationSampleShardLimit,
    maximumContinuationWrites: 3,
    rootReceiptCount: width,
  };
};
