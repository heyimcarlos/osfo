import { Array, Option, Order, Schema } from "effect";

import { qualificationAuthoritySources } from "./authority-sources";
import type { QualificationExecutionPlan } from "./execution";
import { qualificationChecksum } from "./qualification-checksum";
import { isMeasuredStageLane, qualificationStageDimensionCount } from "./stage-evidence";

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

export const QualificationEvaluationRootRecord = Schema.Struct({
  activation: Schema.NullOr(
    Schema.Struct({
      activationId: Identity,
      cause: Schema.Literals(["deployment", "faultRecovery", "firstUse", "idleEviction", "warm"]),
      classification: Schema.Literals(["cold", "warm"]),
      region: Schema.Literals(["americas", "asiaPacific", "europe"]),
    }),
  ),
  correlations: Schema.Array(Schema.Struct({ kind: Identity, value: Identity })),
  decision: Schema.Literals(["accepted", "capacityRejected", "typedStressRejected"]),
  journey: Schema.Literals([
    "accountBillingSafetyDataRights",
    "documentBuild",
    "fileAnalysis",
    "gmail",
    "ordinaryConversation",
    "registration",
    "reminder",
    "researchReport",
    "scheduledEmail",
  ]),
  plan: Schema.Literals(["adventurer", "free"]),
  productFactChecksum: Identity,
  productFactCount: NonNegativeInteger,
  rootId: Identity,
  terminalState: Schema.Literals(["failed", "missing", "succeeded", "typedRejected"]),
});

export const QualificationEvaluationRootAccumulatorShard = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  lastPartitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousShardChecksum: Schema.String,
  roots: Schema.Array(QualificationEvaluationRootRecord).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationSampleShardLimit),
  ),
  version: Schema.Literal("qualification-evaluation-root-accumulator-v2"),
});

export const QualificationEvaluationRootAccumulatorReceipt = Schema.Struct({
  acceptedCount: NonNegativeInteger,
  artifactId: Identity,
  artifactPrefix: Identity,
  checksum: Identity,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  firstRootId: Schema.NullOr(Identity),
  firstShardChecksum: Identity,
  index: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  inputReceiptChecksums: Schema.Array(Identity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationReducerFanIn),
  ),
  lastPartitionIndex: NonNegativeInteger,
  lastRootId: Schema.NullOr(Identity),
  level: NonNegativeInteger,
  planChecksum: Identity,
  rootCount: NonNegativeInteger,
  shardCount: NonNegativeInteger,
  terminalShardChecksum: Identity,
  version: Schema.Literal("qualification-evaluation-root-accumulator-receipt-v2"),
});

export const QualificationEvaluationCorrectnessReceipt = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  findingSummary: QualificationEvaluationFindingSummary,
  findingSummaryArtifactChecksum: Identity,
  findingSummaryArtifactId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  inputReceiptChecksums: Schema.Array(Identity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationEvaluationReducerFanIn),
  ),
  lastPartitionIndex: NonNegativeInteger,
  level: NonNegativeInteger,
  planChecksum: Identity,
  rootAccumulator: QualificationEvaluationRootAccumulatorReceipt,
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
  version: Schema.Literal("qualification-evaluation-correctness-receipt-v1"),
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
  partitionAuthorityChecksum: Identity,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  streamChunkIndex: NonNegativeInteger,
  version: Schema.Literal("qualification-evaluation-leaf-input-v1"),
});

const QualificationEvaluationSortedRunDescriptorBase = {
  artifactPrefix: Identity,
  denominatorChainDigest: Identity,
  denominatorCount: NonNegativeInteger,
  dimension: Identity,
  firstShardChecksum: Identity,
  firstPartitionIndex: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  lastPartitionIndex: NonNegativeInteger,
  missingRootCount: NonNegativeInteger,
  runId: Identity,
  sampleStatus: Schema.Literals(["COMPLETE", "MISSING"]),
  shardCount: NonNegativeInteger,
  terminalShardChecksum: Identity,
  valueCount: NonNegativeInteger,
} as const;

export const QualificationEvaluationSortedRunDescriptor = Schema.Union([
  Schema.Struct({
    ...QualificationEvaluationSortedRunDescriptorBase,
    maximum: Schema.NullOr(Identity),
    minimum: Schema.NullOr(Identity),
    valueType: Schema.Literal("identity"),
  }),
  Schema.Struct({
    ...QualificationEvaluationSortedRunDescriptorBase,
    maximum: Schema.NullOr(Schema.Finite),
    minimum: Schema.NullOr(Schema.Finite),
    valueType: Schema.Literal("latencyMs"),
  }),
]);

const QualificationEvaluationSortedRunReceiptBase = {
  ...QualificationEvaluationSortedRunDescriptorBase,
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
  version: Schema.Literal("qualification-evaluation-sorted-run-receipt-v2"),
} as const;

export const QualificationEvaluationSortedRunReceipt = Schema.Union([
  Schema.Struct({
    ...QualificationEvaluationSortedRunReceiptBase,
    maximum: Schema.NullOr(Identity),
    minimum: Schema.NullOr(Identity),
    valueType: Schema.Literal("identity"),
  }),
  Schema.Struct({
    ...QualificationEvaluationSortedRunReceiptBase,
    maximum: Schema.NullOr(Schema.Finite),
    minimum: Schema.NullOr(Schema.Finite),
    valueType: Schema.Literal("latencyMs"),
  }),
]);

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

const QualificationEvaluationSortedRunShardBase = {
  artifactId: Identity,
  checksum: Identity,
  denominatorChainDigest: Identity,
  denominatorCount: NonNegativeInteger,
  dimension: Identity,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  lastPartitionIndex: NonNegativeInteger,
  missingRootCount: NonNegativeInteger,
  planChecksum: Identity,
  previousShardChecksum: Schema.String,
  runId: Identity,
  sampleStatus: Schema.Literals(["COMPLETE", "MISSING"]),
  version: Schema.Literal("qualification-evaluation-sorted-run-v2"),
} as const;

export const QualificationEvaluationSortedRunShard = Schema.Union([
  Schema.Struct({
    ...QualificationEvaluationSortedRunShardBase,
    maximum: Identity,
    minimum: Identity,
    values: Schema.Array(Identity).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(qualificationEvaluationSampleShardLimit),
    ),
    valueType: Schema.Literal("identity"),
  }),
  Schema.Struct({
    ...QualificationEvaluationSortedRunShardBase,
    maximum: Schema.Finite,
    minimum: Schema.Finite,
    values: Schema.Array(Schema.Finite).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(qualificationEvaluationSampleShardLimit),
    ),
    valueType: Schema.Literal("latencyMs"),
  }),
]);

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
  readonly partitionAuthorityChecksum: string;
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
    partitionAuthorityChecksum: input.partitionAuthorityChecksum,
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

export const qualificationEvaluationRootAccumulatorShard = (input: {
  readonly artifactId: string;
  readonly executionId: string;
  readonly firstPartitionIndex: number;
  readonly index: number;
  readonly lastPartitionIndex: number;
  readonly planChecksum: string;
  readonly previousShardChecksum: string;
  readonly roots: ReadonlyArray<typeof QualificationEvaluationRootRecord.Type>;
}): typeof QualificationEvaluationRootAccumulatorShard.Type | null => {
  if (
    input.firstPartitionIndex > input.lastPartitionIndex ||
    input.roots.length === 0 ||
    input.roots.length > qualificationEvaluationSampleShardLimit ||
    input.roots.some((root, index, roots) => {
      const previous = roots[index - 1];
      return (
        (previous !== undefined && root.rootId.localeCompare(previous.rootId) <= 0) ||
        root.correlations.some((correlation, correlationIndex, correlations) => {
          const previousCorrelation = correlations[correlationIndex - 1];
          return (
            previousCorrelation !== undefined &&
            correlation.kind.localeCompare(previousCorrelation.kind) <= 0
          );
        })
      );
    })
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    executionId: input.executionId,
    firstPartitionIndex: input.firstPartitionIndex,
    index: input.index,
    lastPartitionIndex: input.lastPartitionIndex,
    planChecksum: input.planChecksum,
    previousShardChecksum: input.previousShardChecksum,
    roots: [...input.roots],
    version: "qualification-evaluation-root-accumulator-v2" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

export const qualificationEvaluationRootAccumulatorReceipt = (input: {
  readonly artifactId: string;
  readonly artifactPrefix: string;
  readonly executionId: string;
  readonly firstPartitionIndex: number;
  readonly firstRootId: string | null;
  readonly firstShardChecksum: string;
  readonly index: number;
  readonly inputReceiptChecksums: ReadonlyArray<string>;
  readonly lastPartitionIndex: number;
  readonly lastRootId: string | null;
  readonly level: number;
  readonly planChecksum: string;
  readonly rootCount: number;
  readonly acceptedCount: number;
  readonly shardCount: number;
  readonly terminalShardChecksum: string;
}): typeof QualificationEvaluationRootAccumulatorReceipt.Type | null => {
  const empty = input.rootCount === 0;
  if (
    input.firstPartitionIndex > input.lastPartitionIndex ||
    !Number.isSafeInteger(input.acceptedCount) ||
    input.acceptedCount < 0 ||
    !Number.isSafeInteger(input.rootCount) ||
    input.rootCount < 0 ||
    !Number.isSafeInteger(input.shardCount) ||
    input.shardCount < 0 ||
    input.acceptedCount > input.rootCount ||
    input.inputReceiptChecksums.length === 0 ||
    input.inputReceiptChecksums.length > qualificationEvaluationReducerFanIn ||
    new Set(input.inputReceiptChecksums).size !== input.inputReceiptChecksums.length ||
    (empty
      ? input.shardCount !== 0 ||
        input.firstRootId !== null ||
        input.lastRootId !== null ||
        input.firstShardChecksum !== "ZERO" ||
        input.terminalShardChecksum !== "ZERO"
      : input.shardCount === 0 ||
        input.firstRootId === null ||
        input.lastRootId === null ||
        input.firstRootId.localeCompare(input.lastRootId) > 0)
  ) {
    return null;
  }
  const content = {
    acceptedCount: input.acceptedCount,
    artifactId: input.artifactId,
    artifactPrefix: input.artifactPrefix,
    executionId: input.executionId,
    firstPartitionIndex: input.firstPartitionIndex,
    firstRootId: input.firstRootId,
    firstShardChecksum: input.firstShardChecksum,
    index: input.index,
    inputReceiptChainDigest: qualificationChecksum(input.inputReceiptChecksums),
    inputReceiptChecksums: [...input.inputReceiptChecksums],
    lastPartitionIndex: input.lastPartitionIndex,
    lastRootId: input.lastRootId,
    level: input.level,
    planChecksum: input.planChecksum,
    rootCount: input.rootCount,
    shardCount: input.shardCount,
    terminalShardChecksum: input.terminalShardChecksum,
    version: "qualification-evaluation-root-accumulator-receipt-v2" as const,
  };
  return { ...content, checksum: qualificationChecksum(content) };
};

/** Root-only correctness reduction; dimension Workflows carry no duplicated finding summaries. */
export const qualificationEvaluationCorrectnessReceipt = (input: {
  readonly artifactId: string;
  readonly executionId: string;
  readonly findingSummary: typeof QualificationEvaluationFindingSummary.Type;
  readonly findingSummaryArtifactChecksum: string;
  readonly findingSummaryArtifactId: string;
  readonly index: number;
  readonly inputReceiptChecksums: ReadonlyArray<string>;
  readonly level: number;
  readonly planChecksum: string;
  readonly rootAccumulator: typeof QualificationEvaluationRootAccumulatorReceipt.Type;
}): typeof QualificationEvaluationCorrectnessReceipt.Type | null => {
  const checksums = input.inputReceiptChecksums;
  const verdict =
    input.findingSummary.failCount > 0
      ? ("FAIL" as const)
      : input.findingSummary.missingCount > 0
        ? ("MISSING" as const)
        : ("PASS" as const);
  if (
    checksums.length === 0 ||
    checksums.length > qualificationEvaluationReducerFanIn ||
    new Set(checksums).size !== checksums.length ||
    input.rootAccumulator.executionId !== input.executionId ||
    input.rootAccumulator.planChecksum !== input.planChecksum ||
    input.rootAccumulator.level !== input.level ||
    input.rootAccumulator.index !== input.index ||
    input.rootAccumulator.inputReceiptChecksums.length !== checksums.length ||
    input.rootAccumulator.inputReceiptChecksums.some(
      (checksum, index) => checksum !== checksums[index],
    )
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    executionId: input.executionId,
    findingSummary: input.findingSummary,
    findingSummaryArtifactChecksum: input.findingSummaryArtifactChecksum,
    findingSummaryArtifactId: input.findingSummaryArtifactId,
    firstPartitionIndex: input.rootAccumulator.firstPartitionIndex,
    index: input.index,
    inputReceiptChainDigest: qualificationChecksum(checksums),
    inputReceiptChecksums: [...checksums],
    lastPartitionIndex: input.rootAccumulator.lastPartitionIndex,
    level: input.level,
    planChecksum: input.planChecksum,
    rootAccumulator: input.rootAccumulator,
    verdict,
    version: "qualification-evaluation-correctness-receipt-v1" as const,
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
  const descriptor = input.descriptor;
  const empty = descriptor.valueCount === 0;
  const stageDimension = descriptor.dimension.startsWith("stage:");
  const expectedSampleStatus = descriptor.missingRootCount > 0 ? "MISSING" : "COMPLETE";
  if (
    input.inputReceiptChecksums.length === 0 ||
    input.inputReceiptChecksums.length > qualificationEvaluationReducerFanIn ||
    new Set(input.inputReceiptChecksums).size !== input.inputReceiptChecksums.length ||
    descriptor.firstPartitionIndex > descriptor.lastPartitionIndex ||
    descriptor.inputReceiptChainDigest !== qualificationChecksum(input.inputReceiptChecksums) ||
    descriptor.missingRootCount > descriptor.denominatorCount ||
    (stageDimension &&
      (descriptor.valueCount > descriptor.denominatorCount ||
        descriptor.missingRootCount !== descriptor.denominatorCount - descriptor.valueCount)) ||
    descriptor.sampleStatus !== expectedSampleStatus ||
    (empty
      ? descriptor.shardCount !== 0 ||
        descriptor.firstShardChecksum !== "ZERO" ||
        descriptor.terminalShardChecksum !== "ZERO" ||
        descriptor.minimum !== null ||
        descriptor.maximum !== null
      : descriptor.shardCount === 0 ||
        descriptor.firstShardChecksum === "ZERO" ||
        descriptor.terminalShardChecksum === "ZERO" ||
        descriptor.minimum === null ||
        descriptor.maximum === null)
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
    version: "qualification-evaluation-sorted-run-receipt-v2" as const,
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
  readonly valueType: "identity" | "latencyMs";
  readonly values: ReadonlyArray<number | string>;
}

/** Identity runs are globally unique; numeric samples preserve legitimate equal observations. */
export const qualificationSortedValueFollows = (
  valueType: "identity" | "latencyMs",
  current: number | string,
  previous: number | string,
): boolean =>
  valueType === "identity"
    ? Schema.is(Identity)(current) &&
      Schema.is(Identity)(previous) &&
      current.localeCompare(previous) > 0
    : Schema.is(Schema.Finite)(current) &&
      Schema.is(Schema.Finite)(previous) &&
      current >= previous;

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
    input.descriptor.denominatorChainDigest === shard.denominatorChainDigest &&
    input.descriptor.denominatorCount === shard.denominatorCount &&
    input.descriptor.firstPartitionIndex === shard.firstPartitionIndex &&
    input.descriptor.inputReceiptChainDigest === shard.inputReceiptChainDigest &&
    input.descriptor.lastPartitionIndex === shard.lastPartitionIndex &&
    input.descriptor.missingRootCount === shard.missingRootCount &&
    input.descriptor.sampleStatus === shard.sampleStatus &&
    input.descriptor.valueType === shard.valueType &&
    (shard.index === 0 ? shard.checksum === input.descriptor.firstShardChecksum : true) &&
    (shard.index === input.descriptor.shardCount - 1
      ? shard.checksum === input.descriptor.terminalShardChecksum
      : true) &&
    input.valueOffset >= 0 &&
    input.valueOffset < shard.values.length &&
    shard.values.every((value, index, values) => {
      const previous = values[index - 1];
      if (previous === undefined) return true;
      return shard.valueType === "identity"
        ? String(value).localeCompare(String(previous)) > 0
        : Number(value) >= Number(previous);
    }) &&
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
  const firstInput = inputs[0];
  if (
    firstInput === undefined ||
    inputs.length === 0 ||
    inputs.length > qualificationEvaluationReducerFanIn ||
    inputs.some(
      ({ descriptor }) =>
        descriptor.dimension !== firstInput.descriptor.dimension ||
        descriptor.valueType !== firstInput.descriptor.valueType,
    ) ||
    inputs.some((input) => !validInput(input))
  ) {
    return null;
  }
  const offsets = inputs.map(({ valueOffset }) => valueOffset);
  const values = new globalThis.Array<number | string>();
  while (values.length < qualificationEvaluationSampleShardLimit) {
    let selected = -1;
    let selectedValue: number | string | undefined;
    for (const [index, input] of inputs.entries()) {
      const value = input.shard?.values[offsets[index] ?? 0];
      if (value === undefined) continue;
      const comparison =
        selectedValue === undefined
          ? -1
          : firstInput.descriptor.valueType === "identity"
            ? String(value).localeCompare(String(selectedValue))
            : Number(value) - Number(selectedValue);
      if (comparison < 0 || (comparison === 0 && selected === -1)) {
        selected = index;
        selectedValue = value;
      }
    }
    if (selected === -1 || selectedValue === undefined) break;
    if (firstInput.descriptor.valueType === "identity" && values.at(-1) === selectedValue)
      return null;
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
    valueType: firstInput.descriptor.valueType,
    values,
  };
};

export interface QualificationEvaluationRootMergeInput {
  readonly receipt: typeof QualificationEvaluationRootAccumulatorReceipt.Type;
  readonly rootOffset: number;
  readonly shard: typeof QualificationEvaluationRootAccumulatorShard.Type | null;
}

const validRootMergeInput = ({
  receipt,
  rootOffset,
  shard,
}: QualificationEvaluationRootMergeInput): boolean => {
  if (shard === null) return receipt.rootCount === 0 && rootOffset === 0;
  const { checksum, ...content } = shard;
  return (
    shard.executionId === receipt.executionId &&
    shard.firstPartitionIndex === receipt.firstPartitionIndex &&
    shard.lastPartitionIndex === receipt.lastPartitionIndex &&
    shard.planChecksum === receipt.planChecksum &&
    rootOffset >= 0 &&
    rootOffset < shard.roots.length &&
    qualificationChecksum(content) === checksum
  );
};

/** Exact bounded root merge. Equal IDs across any leaves are a structural conflict. */
export const mergeQualificationRootAccumulatorPage = (
  inputs: ReadonlyArray<QualificationEvaluationRootMergeInput>,
): ReadonlyArray<typeof QualificationEvaluationRootRecord.Type> | null => {
  const first = inputs[0];
  if (
    first === undefined ||
    inputs.length > qualificationEvaluationReducerFanIn ||
    inputs.some(({ receipt }, index, receipts) =>
      index === 0
        ? false
        : receipt.firstPartitionIndex !==
          (receipts[index - 1]?.receipt.lastPartitionIndex ?? Number.NaN) + 1,
    ) ||
    inputs.some((input) => !validRootMergeInput(input))
  ) {
    return null;
  }
  const offsets = inputs.map(({ rootOffset }) => rootOffset);
  const roots = new globalThis.Array<typeof QualificationEvaluationRootRecord.Type>();
  while (roots.length < qualificationEvaluationSampleShardLimit) {
    let selected = -1;
    let selectedRoot: typeof QualificationEvaluationRootRecord.Type | undefined;
    for (const [index, input] of inputs.entries()) {
      const candidate = input.shard?.roots[offsets[index] ?? 0];
      if (
        candidate !== undefined &&
        (selectedRoot === undefined || candidate.rootId.localeCompare(selectedRoot.rootId) < 0)
      ) {
        selected = index;
        selectedRoot = candidate;
      }
    }
    if (selected === -1 || selectedRoot === undefined) break;
    if (roots.at(-1)?.rootId === selectedRoot.rootId) return null;
    roots.push(selectedRoot);
    offsets[selected] = (offsets[selected] ?? 0) + 1;
  }
  return roots;
};

interface QualificationEvaluationSortedRunShardBaseInput {
  readonly artifactId: string;
  readonly denominatorChainDigest: string;
  readonly denominatorCount: number;
  readonly dimension: string;
  readonly executionId: string;
  readonly firstPartitionIndex: number;
  readonly index: number;
  readonly inputReceiptChainDigest: string;
  readonly lastPartitionIndex: number;
  readonly missingRootCount: number;
  readonly planChecksum: string;
  readonly previousShardChecksum: string;
  readonly runId: string;
  readonly sampleStatus: "COMPLETE" | "MISSING";
}

type QualificationEvaluationSortedRunShardInput = QualificationEvaluationSortedRunShardBaseInput &
  (
    | { readonly values: ReadonlyArray<string>; readonly valueType: "identity" }
    | { readonly values: ReadonlyArray<number>; readonly valueType: "latencyMs" }
  );

/** Freeze one homogeneous body-authenticated output shard from a reducer continuation. */
export const qualificationEvaluationSortedRunShard = (
  input: QualificationEvaluationSortedRunShardInput,
): typeof QualificationEvaluationSortedRunShard.Type | null => {
  const identities =
    input.valueType === "identity"
      ? Schema.decodeOption(Schema.Array(Identity))(input.values)
      : Option.none<ReadonlyArray<string>>();
  const latencies =
    input.valueType === "latencyMs"
      ? Schema.decodeOption(Schema.Array(Schema.Finite))(input.values)
      : Option.none<ReadonlyArray<number>>();
  const values = Option.isSome(identities)
    ? identities.value
    : Option.isSome(latencies)
      ? latencies.value
      : [];
  if (
    values.length === 0 ||
    values.length > qualificationEvaluationSampleShardLimit ||
    input.firstPartitionIndex > input.lastPartitionIndex ||
    values.some((value, index, sorted) => {
      const previous = sorted[index - 1];
      if (previous === undefined) return false;
      return input.valueType === "identity"
        ? String(value).localeCompare(String(previous)) <= 0
        : Number(value) < Number(previous);
    })
  ) {
    return null;
  }
  const content = {
    artifactId: input.artifactId,
    denominatorChainDigest: input.denominatorChainDigest,
    denominatorCount: input.denominatorCount,
    dimension: input.dimension,
    executionId: input.executionId,
    firstPartitionIndex: input.firstPartitionIndex,
    index: input.index,
    inputReceiptChainDigest: input.inputReceiptChainDigest,
    lastPartitionIndex: input.lastPartitionIndex,
    missingRootCount: input.missingRootCount,
    maximum: values.at(-1),
    minimum: values[0],
    planChecksum: input.planChecksum,
    previousShardChecksum: input.previousShardChecksum,
    runId: input.runId,
    sampleStatus: input.sampleStatus,
    values: [...values],
    valueType: input.valueType,
    version: "qualification-evaluation-sorted-run-v2" as const,
  };
  return Option.getOrNull(
    Schema.decodeUnknownOption(QualificationEvaluationSortedRunShard)({
      ...content,
      checksum: qualificationChecksum(content),
    }),
  );
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

export const qualificationEvaluationGlobalSortedDimensions = [
  "acceptedRootIds",
  "billUsageIds",
  "operation:file",
  "operation:memory",
  "operation:modelStep",
  "operation:search",
  "operation:tool",
  "operation:workflowStep",
  "productFactIds",
  "providerEffectIds",
  "publicPromotionRootIds",
  "thinkSubmissionIds",
  "usageIds",
  "workflowStartIds",
] as const;
export const qualificationEvaluationReducerCreateBatchLimit = 50;

const mergeWorkflowCount = (leafWidth: number): number => {
  let count = 0;
  let width = leafWidth;
  while (width > 1) {
    width = Math.ceil(width / qualificationEvaluationReducerFanIn);
    count += width;
  }
  return count;
};

export interface QualificationEvaluationForestBudget {
  readonly createBatchCount: number;
  readonly maximumDimensionValues: number;
  readonly maximumOwnerSteps: number;
  readonly reducerWorkflowCount: number;
  readonly sortedDimensionCount: number;
}

/** Exact Workflow fan-out budget for every sorted gate dimension in one frozen plan. */
export const qualificationEvaluationForestBudget = (
  plan: QualificationExecutionPlan,
): QualificationEvaluationForestBudget => {
  const totalArrivalChunks = plan.runs.reduce(
    (total, run) => total + Math.ceil(run.arrivalCount / qualificationEvaluationSampleShardLimit),
    0,
  );
  const globalDimensions = qualificationEvaluationGlobalSortedDimensions.length;
  const globalWorkflows = mergeWorkflowCount(totalArrivalChunks) * globalDimensions;
  let stageDimensions = 0;
  let stageWorkflows = 0;
  for (const run of plan.runs) {
    if (run.kind !== "lane" || !isMeasuredStageLane(run.lane)) continue;
    const dimensions = qualificationStageDimensionCount(run.lane);
    stageDimensions += dimensions;
    stageWorkflows +=
      mergeWorkflowCount(Math.ceil(run.arrivalCount / qualificationEvaluationSampleShardLimit)) *
      dimensions;
  }
  const reducerWorkflowCount = globalWorkflows + stageWorkflows;
  const createBatchCount = Math.ceil(
    reducerWorkflowCount / qualificationEvaluationReducerCreateBatchLimit,
  );
  return {
    createBatchCount,
    maximumDimensionValues: plan.runs.reduce((total, run) => total + run.arrivalCount, 0),
    maximumOwnerSteps: createBatchCount + Math.max(0, createBatchCount - 1) + 4,
    reducerWorkflowCount,
    sortedDimensionCount: globalDimensions + stageDimensions,
  };
};

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
