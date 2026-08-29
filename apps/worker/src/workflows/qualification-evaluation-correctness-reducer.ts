import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";

import {
  QualificationEvaluationLeafFindingShard,
  QualificationEvaluationLeafReceipt,
  QualificationEvaluationLeafRootAccumulator,
  qualificationEvaluationLeafMaximumFindingShardCount,
  qualificationEvaluationLeafMaximumFindingsPerRoot,
  qualificationEvaluationLeafRootLimit,
} from "../qualification/qualification-evaluation-leaf";
import { qualificationCorrectnessRootVerificationPageSize } from "../qualification/qualification-evaluation-limits";
import {
  QualificationEvaluationCorrectnessReceipt,
  QualificationEvaluationFindingSummaryShard,
  QualificationEvaluationRootAccumulatorReceipt,
  QualificationEvaluationRootAccumulatorShard,
  qualificationEvaluationCorrectnessReceipt,
  qualificationEvaluationFindingSummaryShard,
  qualificationEvaluationMaximumDimensionValues,
  qualificationEvaluationRootAccumulatorReceipt,
  qualificationEvaluationRootAccumulatorShard,
  qualificationEvaluationSampleShardLimit,
  mergeQualificationFindingSummaries,
  retainQualificationEvaluationArtifact,
  type QualificationEvaluationArtifactBucket,
} from "../qualification/qualification-evaluation-reducer";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import type { QualificationEvaluationCorrectnessReducerWorkflowPayload } from "../workflow-contracts";
import { QualificationEvaluationLeafCompletion } from "./qualification-evaluation-leaf";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Cloudflare Workflow and R2 are Promise-only durable host boundaries; each loop iteration is a bounded durable page. */

const maximumRootPages = 6_840;
const padded = (value: number) => value.toString().padStart(8, "0");

interface QualificationEvaluationCorrectnessReducerEnv {
  readonly ARTIFACTS: QualificationEvaluationArtifactBucket;
}

export interface QualificationEvaluationCorrectnessReducerStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
}

interface RootDescriptor {
  readonly acceptedCount: number;
  readonly artifactPrefix: string;
  readonly firstRootId: string | null;
  readonly firstShardChecksum: string;
  readonly kind: "leaf" | "reduced";
  readonly lastRootId: string | null;
  readonly rootCount: number;
  readonly shardCount: number;
  readonly terminalShardChecksum: string;
}

interface VerifiedChild {
  readonly checksum: string;
  readonly findingSummary: (typeof QualificationEvaluationFindingSummaryShard.Type)["summary"];
  readonly firstPartitionIndex: number;
  readonly lastPartitionIndex: number;
  readonly root: RootDescriptor;
}

interface RootCursor {
  readonly consumedCount: number;
  readonly previousRootId: string | null;
  readonly previousShardChecksum: string;
  readonly shardIndex: number;
  readonly valueOffset: number;
}

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readDecoded = async <A extends { readonly checksum: string }>(input: {
  readonly artifactId: string;
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly checksum?: string | undefined;
  readonly executionId: string;
  readonly kind: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly planChecksum: string;
  readonly schema: Schema.Codec<A, string>;
}): Promise<{
  readonly customMetadata: Readonly<Record<string, string>>;
  readonly encoded: string;
  readonly value: A;
} | null> => {
  const retained = await input.bucket.get(input.artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let value: A;
  try {
    value = Schema.decodeSync(input.schema)(encoded);
  } catch {
    return null;
  }
  if (
    retained.customMetadata?.["osfo-artifact-checksum"] !== value.checksum ||
    (input.checksum !== undefined && value.checksum !== input.checksum) ||
    retained.customMetadata?.["osfo-body-sha256"] !== (await sha256Hex(encoded)) ||
    retained.customMetadata?.["osfo-execution-id"] !== input.executionId ||
    retained.customMetadata?.["osfo-kind"] !== input.kind ||
    retained.customMetadata?.["osfo-plan-checksum"] !== input.planChecksum ||
    Object.entries(input.metadata ?? {}).some(
      ([key, expected]) => retained.customMetadata?.[key] !== expected,
    )
  ) {
    return null;
  }
  return { customMetadata: retained.customMetadata ?? {}, encoded, value };
};

const authenticChecksum = (value: { readonly checksum: string }) => {
  const { checksum, ...content } = value;
  return checksum === qualificationChecksum(content);
};

const safeDecimalCount = (value: string, maximum: number) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
};

const normalizeLeafRoots = (
  accumulator: typeof QualificationEvaluationLeafRootAccumulator.Type,
) => {
  const roots = accumulator.roots.map((root) => {
    const productFactCount = safeDecimalCount(root.productFactCount, Number.MAX_SAFE_INTEGER);
    return productFactCount === null ? null : { ...root, productFactCount };
  });
  return roots.some((root) => root === null)
    ? null
    : roots.flatMap((root) => (root === null ? [] : [root]));
};

const exactMetadata = (
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
) => Object.entries(expected).every(([key, value]) => actual[key] === value);

const verdictFromSummary = (summary: {
  readonly failCount: number;
  readonly missingCount: number;
}) => (summary.failCount > 0 ? "FAIL" : summary.missingCount > 0 ? "MISSING" : "PASS");

const validRootDescriptor = (descriptor: RootDescriptor) =>
  Number.isSafeInteger(descriptor.acceptedCount) &&
  descriptor.acceptedCount >= 0 &&
  Number.isSafeInteger(descriptor.rootCount) &&
  descriptor.rootCount >= 0 &&
  descriptor.rootCount <= qualificationEvaluationMaximumDimensionValues &&
  descriptor.acceptedCount <= descriptor.rootCount &&
  Number.isSafeInteger(descriptor.shardCount) &&
  descriptor.shardCount >= 0 &&
  descriptor.shardCount <= maximumRootPages &&
  (descriptor.rootCount === 0
    ? descriptor.shardCount === 0 &&
      descriptor.firstRootId === null &&
      descriptor.lastRootId === null &&
      descriptor.firstShardChecksum === "ZERO" &&
      descriptor.terminalShardChecksum === "ZERO"
    : descriptor.shardCount ===
        Math.ceil(descriptor.rootCount / qualificationEvaluationSampleShardLimit) &&
      descriptor.firstRootId !== null &&
      descriptor.lastRootId !== null &&
      descriptor.firstRootId.localeCompare(descriptor.lastRootId) <= 0 &&
      descriptor.firstShardChecksum !== "ZERO" &&
      descriptor.terminalShardChecksum !== "ZERO");

const summaryFromLeafFindings = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly receipt: typeof QualificationEvaluationLeafReceipt.Type;
}) => {
  const findingShardCount = safeDecimalCount(
    input.receipt.findingShardCount,
    qualificationEvaluationLeafMaximumFindingShardCount,
  );
  const expectedFailCount = safeDecimalCount(
    input.receipt.failCount,
    qualificationEvaluationLeafRootLimit * qualificationEvaluationLeafMaximumFindingsPerRoot,
  );
  const expectedMissingCount = safeDecimalCount(
    input.receipt.missingCount,
    qualificationEvaluationLeafRootLimit * qualificationEvaluationLeafMaximumFindingsPerRoot,
  );
  if (findingShardCount === null || expectedFailCount === null || expectedMissingCount === null) {
    return null;
  }
  let summary: (typeof QualificationEvaluationFindingSummaryShard.Type)["summary"] = {
    exemplars: [],
    failCount: 0,
    missingCount: 0,
  };
  let previousShardChecksum = "NONE";
  for (let index = 0; index < findingShardCount; index += 1) {
    const artifactId = `${input.receipt.findingShardPrefix}/${padded(index)}.json`;
    const decoded = await readDecoded({
      artifactId,
      bucket: input.bucket,
      checksum: index === 0 ? input.receipt.findingFirstShardChecksum : undefined,
      executionId: input.executionId,
      kind: "qualification-evaluation-leaf-findings-v1",
      metadata: {
        "osfo-index": String(index),
        "osfo-previous-checksum": previousShardChecksum,
      },
      planChecksum: input.planChecksum,
      schema: Schema.fromJsonString(QualificationEvaluationLeafFindingShard),
    });
    if (decoded === null || !authenticChecksum(decoded.value)) return null;
    const shard = decoded.value;
    if (
      shard.artifactId !== artifactId ||
      shard.executionId !== input.executionId ||
      shard.index !== index ||
      shard.partitionIndex !== input.receipt.partitionIndex ||
      shard.planChecksum !== input.planChecksum ||
      shard.previousShardChecksum !== previousShardChecksum ||
      !exactMetadata(decoded.customMetadata, {
        "osfo-index": String(index),
        "osfo-previous-checksum": previousShardChecksum,
        "osfo-record-count": String(shard.findings.length),
      })
    ) {
      return null;
    }
    const localFindings = [...shard.findings];
    localFindings.sort((left, right) =>
      [left.verdict, left.code, left.subject, left.detail]
        .join("\u0000")
        .localeCompare([right.verdict, right.code, right.subject, right.detail].join("\u0000")),
    );
    summary = mergeQualificationFindingSummaries([
      summary,
      {
        exemplars: localFindings.slice(0, 32),
        failCount: localFindings.filter(({ verdict }) => verdict === "FAIL").length,
        missingCount: localFindings.filter(({ verdict }) => verdict === "MISSING").length,
      },
    ]);
    previousShardChecksum = shard.checksum;
  }
  if (
    (findingShardCount === 0
      ? input.receipt.findingFirstShardChecksum !== "ZERO" ||
        input.receipt.findingTerminalShardChecksum !== "ZERO"
      : previousShardChecksum !== input.receipt.findingTerminalShardChecksum) ||
    summary.failCount !== expectedFailCount ||
    summary.missingCount !== expectedMissingCount ||
    input.receipt.verdict !== verdictFromSummary(summary) ||
    canonicalQualificationJson(summary.exemplars) !==
      canonicalQualificationJson(input.receipt.findingExemplars)
  ) {
    return null;
  }
  return summary;
};

const readLeafCompletion = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly reference: QualificationEvaluationCorrectnessReducerWorkflowPayload["inputs"][number];
}): Promise<VerifiedChild | null> => {
  const decoded = await readDecoded({
    artifactId: input.reference.artifactId,
    bucket: input.bucket,
    checksum: input.reference.checksum,
    executionId: input.executionId,
    kind: "qualification-evaluation-leaf-completion-v1",
    planChecksum: input.planChecksum,
    schema: Schema.fromJsonString(QualificationEvaluationLeafCompletion),
  });
  if (decoded === null || !authenticChecksum(decoded.value)) return null;
  const completion = decoded.value;
  if (
    completion.artifactId !== input.reference.artifactId ||
    completion.checksum !== input.reference.checksum ||
    completion.executionId !== input.executionId ||
    completion.planChecksum !== input.planChecksum ||
    !exactMetadata(decoded.customMetadata, {
      "osfo-leaf-input-checksum": completion.leafInputChecksum,
      "osfo-outcome": completion.outcome.status,
      "osfo-partition-index": String(completion.partitionIndex),
      "osfo-record-count":
        completion.outcome.status === "COMPLETE" ? completion.outcome.receipt.rootCount : "0",
      "osfo-run-id": completion.runId,
    })
  ) {
    return null;
  }
  if (completion.outcome.status !== "COMPLETE") {
    return {
      checksum: completion.checksum,
      findingSummary: {
        exemplars: [
          {
            code: completion.outcome.code,
            detail: `Leaf partition ${completion.partitionIndex} completed ${completion.outcome.status}`,
            subject: completion.outcome.artifactId,
            verdict: completion.outcome.status,
          },
        ],
        failCount: completion.outcome.status === "FAIL" ? 1 : 0,
        missingCount: completion.outcome.status === "MISSING" ? 1 : 0,
      },
      firstPartitionIndex: completion.partitionIndex,
      lastPartitionIndex: completion.partitionIndex,
      root: {
        acceptedCount: 0,
        artifactPrefix: completion.artifactId,
        firstRootId: null,
        firstShardChecksum: "ZERO",
        kind: "leaf",
        lastRootId: null,
        rootCount: 0,
        shardCount: 0,
        terminalShardChecksum: "ZERO",
      },
    };
  }
  const receipt = completion.outcome.receipt;
  const receiptRootCount = safeDecimalCount(
    receipt.rootCount,
    qualificationEvaluationLeafRootLimit,
  );
  if (!authenticChecksum(receipt) || receiptRootCount === null) return null;
  const retainedReceipt = await readDecoded({
    artifactId: receipt.artifactId,
    bucket: input.bucket,
    checksum: receipt.checksum,
    executionId: input.executionId,
    kind: "qualification-evaluation-leaf-v1",
    metadata: {
      "osfo-record-count": String(receipt.dimensions.length),
      "osfo-verdict": receipt.verdict,
    },
    planChecksum: input.planChecksum,
    schema: Schema.fromJsonString(QualificationEvaluationLeafReceipt),
  });
  if (retainedReceipt === null || retainedReceipt.encoded !== canonicalQualificationJson(receipt)) {
    return null;
  }
  const rootDecoded = await readDecoded({
    artifactId: receipt.rootAccumulatorId,
    bucket: input.bucket,
    checksum: receipt.rootAccumulatorChecksum,
    executionId: input.executionId,
    kind: "qualification-evaluation-leaf-roots-v1",
    metadata: { "osfo-record-count": receipt.rootCount },
    planChecksum: input.planChecksum,
    schema: Schema.fromJsonString(QualificationEvaluationLeafRootAccumulator),
  });
  const findingSummary = await summaryFromLeafFindings({
    bucket: input.bucket,
    executionId: input.executionId,
    planChecksum: input.planChecksum,
    receipt,
  });
  if (rootDecoded === null || findingSummary === null || !authenticChecksum(rootDecoded.value)) {
    return null;
  }
  const roots = normalizeLeafRoots(rootDecoded.value);
  const accumulatorRootCount = safeDecimalCount(
    rootDecoded.value.rootCount,
    qualificationEvaluationLeafRootLimit,
  );
  const acceptedCount = safeDecimalCount(
    rootDecoded.value.acceptedCount,
    qualificationEvaluationLeafRootLimit,
  );
  if (
    roots === null ||
    accumulatorRootCount === null ||
    acceptedCount === null ||
    acceptedCount > accumulatorRootCount ||
    rootDecoded.value.artifactId !== receipt.rootAccumulatorId ||
    rootDecoded.value.checksum !== receipt.rootAccumulatorChecksum ||
    rootDecoded.value.executionId !== input.executionId ||
    rootDecoded.value.partitionIndex !== completion.partitionIndex ||
    rootDecoded.value.planChecksum !== input.planChecksum ||
    accumulatorRootCount !== receiptRootCount ||
    roots.length !== receiptRootCount ||
    roots.filter(({ decision }) => decision === "accepted").length !== acceptedCount ||
    roots.some((root, index) => {
      const previous = roots[index - 1];
      return (
        !Number.isSafeInteger(root.productFactCount) ||
        root.productFactCount < 0 ||
        (previous !== undefined && root.rootId.localeCompare(previous.rootId) <= 0)
      );
    })
  ) {
    return null;
  }
  const rootDescriptor = {
    acceptedCount,
    artifactPrefix: rootDecoded.value.artifactId,
    firstRootId: roots[0]?.rootId ?? null,
    firstShardChecksum: roots.length === 0 ? "ZERO" : rootDecoded.value.checksum,
    kind: "leaf" as const,
    lastRootId: roots.at(-1)?.rootId ?? null,
    rootCount: roots.length,
    shardCount: roots.length === 0 ? 0 : 1,
    terminalShardChecksum: roots.length === 0 ? "ZERO" : rootDecoded.value.checksum,
  };
  if (!validRootDescriptor(rootDescriptor)) return null;
  return {
    checksum: completion.checksum,
    findingSummary,
    firstPartitionIndex: completion.partitionIndex,
    lastPartitionIndex: completion.partitionIndex,
    root: rootDescriptor,
  };
};

const readCorrectnessChild = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly expectedLevel: number;
  readonly reference: QualificationEvaluationCorrectnessReducerWorkflowPayload["inputs"][number];
}): Promise<VerifiedChild | null> => {
  const decoded = await readDecoded({
    artifactId: input.reference.artifactId,
    bucket: input.bucket,
    checksum: input.reference.checksum,
    executionId: input.executionId,
    kind: "qualification-evaluation-correctness-receipt-v1",
    planChecksum: input.planChecksum,
    schema: Schema.fromJsonString(QualificationEvaluationCorrectnessReceipt),
  });
  if (decoded === null || !authenticChecksum(decoded.value)) return null;
  const receipt = decoded.value;
  const rootCount = receipt.rootAccumulator.rootCount;
  const acceptedCount = receipt.rootAccumulator.acceptedCount;
  const maximumFindingCount =
    qualificationEvaluationMaximumDimensionValues *
    qualificationEvaluationLeafMaximumFindingsPerRoot;
  const summaryDecoded = await readDecoded({
    artifactId: receipt.findingSummaryArtifactId,
    bucket: input.bucket,
    checksum: receipt.findingSummaryArtifactChecksum,
    executionId: input.executionId,
    kind: "qualification-evaluation-finding-summary-v1",
    planChecksum: input.planChecksum,
    schema: Schema.fromJsonString(QualificationEvaluationFindingSummaryShard),
  });
  const rootsDecoded = await readDecoded({
    artifactId: receipt.rootAccumulator.artifactId,
    bucket: input.bucket,
    checksum: receipt.rootAccumulator.checksum,
    executionId: input.executionId,
    kind: "qualification-evaluation-root-accumulator-receipt-v2",
    planChecksum: input.planChecksum,
    schema: Schema.fromJsonString(QualificationEvaluationRootAccumulatorReceipt),
  });
  if (summaryDecoded === null || rootsDecoded === null) return null;
  const reconstructedRootReceipt = qualificationEvaluationRootAccumulatorReceipt({
    acceptedCount: receipt.rootAccumulator.acceptedCount,
    artifactId: receipt.rootAccumulator.artifactId,
    artifactPrefix: receipt.rootAccumulator.artifactPrefix,
    executionId: receipt.rootAccumulator.executionId,
    firstPartitionIndex: receipt.rootAccumulator.firstPartitionIndex,
    firstRootId: receipt.rootAccumulator.firstRootId,
    firstShardChecksum: receipt.rootAccumulator.firstShardChecksum,
    index: receipt.rootAccumulator.index,
    inputReceiptChecksums: receipt.rootAccumulator.inputReceiptChecksums,
    lastPartitionIndex: receipt.rootAccumulator.lastPartitionIndex,
    lastRootId: receipt.rootAccumulator.lastRootId,
    level: receipt.rootAccumulator.level,
    planChecksum: receipt.rootAccumulator.planChecksum,
    rootCount: receipt.rootAccumulator.rootCount,
    shardCount: receipt.rootAccumulator.shardCount,
    terminalShardChecksum: receipt.rootAccumulator.terminalShardChecksum,
  });
  const reconstructedSummary = qualificationEvaluationFindingSummaryShard({
    artifactId: summaryDecoded.value.artifactId,
    executionId: input.executionId,
    index: receipt.index,
    inputChecksums: receipt.inputReceiptChecksums,
    level: receipt.level,
    planChecksum: input.planChecksum,
    summary: receipt.findingSummary,
  });
  const reconstructedReceipt =
    reconstructedRootReceipt === null
      ? null
      : qualificationEvaluationCorrectnessReceipt({
          artifactId: receipt.artifactId,
          executionId: receipt.executionId,
          findingSummary: receipt.findingSummary,
          findingSummaryArtifactChecksum: receipt.findingSummaryArtifactChecksum,
          findingSummaryArtifactId: receipt.findingSummaryArtifactId,
          index: receipt.index,
          inputReceiptChecksums: receipt.inputReceiptChecksums,
          level: receipt.level,
          planChecksum: receipt.planChecksum,
          rootAccumulator: reconstructedRootReceipt,
        });
  if (
    receipt.artifactId !== input.reference.artifactId ||
    receipt.checksum !== input.reference.checksum ||
    receipt.executionId !== input.executionId ||
    receipt.planChecksum !== input.planChecksum ||
    receipt.level !== input.expectedLevel ||
    !Number.isSafeInteger(rootCount) ||
    rootCount < 0 ||
    rootCount > qualificationEvaluationMaximumDimensionValues ||
    !Number.isSafeInteger(acceptedCount) ||
    acceptedCount < 0 ||
    acceptedCount > rootCount ||
    !authenticChecksum(summaryDecoded.value) ||
    !authenticChecksum(rootsDecoded.value) ||
    canonicalQualificationJson(receipt.findingSummary) !==
      canonicalQualificationJson(summaryDecoded.value.summary) ||
    canonicalQualificationJson(receipt.rootAccumulator) !==
      canonicalQualificationJson(rootsDecoded.value) ||
    !Number.isSafeInteger(receipt.findingSummary.failCount) ||
    receipt.findingSummary.failCount < 0 ||
    receipt.findingSummary.failCount > maximumFindingCount ||
    !Number.isSafeInteger(receipt.findingSummary.missingCount) ||
    receipt.findingSummary.missingCount < 0 ||
    receipt.findingSummary.missingCount > maximumFindingCount ||
    reconstructedRootReceipt === null ||
    reconstructedSummary === null ||
    reconstructedReceipt === null ||
    canonicalQualificationJson(reconstructedRootReceipt) !==
      canonicalQualificationJson(receipt.rootAccumulator) ||
    canonicalQualificationJson(reconstructedSummary) !==
      canonicalQualificationJson(summaryDecoded.value) ||
    canonicalQualificationJson(reconstructedReceipt) !== canonicalQualificationJson(receipt) ||
    !exactMetadata(decoded.customMetadata, {
      "osfo-first-partition-index": String(receipt.firstPartitionIndex),
      "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
      "osfo-last-partition-index": String(receipt.lastPartitionIndex),
      "osfo-record-count": String(receipt.rootAccumulator.rootCount),
      "osfo-root-receipt-checksum": receipt.rootAccumulator.checksum,
      "osfo-summary-checksum": receipt.findingSummaryArtifactChecksum,
      "osfo-verdict": receipt.verdict,
    }) ||
    !exactMetadata(summaryDecoded.customMetadata, {
      "osfo-fail-count": String(receipt.findingSummary.failCount),
      "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
      "osfo-missing-count": String(receipt.findingSummary.missingCount),
      "osfo-record-count": String(receipt.findingSummary.exemplars.length),
    }) ||
    !exactMetadata(rootsDecoded.customMetadata, {
      "osfo-accepted-count": String(receipt.rootAccumulator.acceptedCount),
      "osfo-first-partition-index": String(receipt.rootAccumulator.firstPartitionIndex),
      "osfo-first-root-id": receipt.rootAccumulator.firstRootId ?? "ZERO",
      "osfo-input-receipt-chain-digest": receipt.rootAccumulator.inputReceiptChainDigest,
      "osfo-last-partition-index": String(receipt.rootAccumulator.lastPartitionIndex),
      "osfo-last-root-id": receipt.rootAccumulator.lastRootId ?? "ZERO",
      "osfo-record-count": String(receipt.rootAccumulator.rootCount),
      "osfo-shard-count": String(receipt.rootAccumulator.shardCount),
      "osfo-terminal-checksum": receipt.rootAccumulator.terminalShardChecksum,
    })
  ) {
    return null;
  }
  const rootDescriptor = {
    acceptedCount: receipt.rootAccumulator.acceptedCount,
    artifactPrefix: receipt.rootAccumulator.artifactPrefix,
    firstRootId: receipt.rootAccumulator.firstRootId,
    firstShardChecksum: receipt.rootAccumulator.firstShardChecksum,
    kind: "reduced" as const,
    lastRootId: receipt.rootAccumulator.lastRootId,
    rootCount: receipt.rootAccumulator.rootCount,
    shardCount: receipt.rootAccumulator.shardCount,
    terminalShardChecksum: receipt.rootAccumulator.terminalShardChecksum,
  };
  if (!validRootDescriptor(rootDescriptor)) return null;
  return {
    checksum: receipt.checksum,
    findingSummary: receipt.findingSummary,
    firstPartitionIndex: receipt.firstPartitionIndex,
    lastPartitionIndex: receipt.lastPartitionIndex,
    root: rootDescriptor,
  };
};

const rootShardArtifactId = (descriptor: RootDescriptor, index: number) =>
  descriptor.kind === "leaf"
    ? descriptor.artifactPrefix
    : `${descriptor.artifactPrefix}/${padded(index)}.json`;

const readRootShard = async (input: {
  readonly bucket: QualificationEvaluationArtifactBucket;
  readonly descriptor: RootDescriptor;
  readonly executionId: string;
  readonly firstPartitionIndex: number;
  readonly index: number;
  readonly lastPartitionIndex: number;
  readonly planChecksum: string;
  readonly previousShardChecksum: string;
}) => {
  const artifactId = rootShardArtifactId(input.descriptor, input.index);
  if (input.descriptor.kind === "leaf") {
    const decoded = await readDecoded({
      artifactId,
      bucket: input.bucket,
      checksum: input.descriptor.firstShardChecksum,
      executionId: input.executionId,
      kind: "qualification-evaluation-leaf-roots-v1",
      metadata: { "osfo-record-count": String(input.descriptor.rootCount) },
      planChecksum: input.planChecksum,
      schema: Schema.fromJsonString(QualificationEvaluationLeafRootAccumulator),
    });
    if (decoded === null || !authenticChecksum(decoded.value)) return null;
    const roots = normalizeLeafRoots(decoded.value);
    if (
      roots === null ||
      input.index !== 0 ||
      decoded.value.executionId !== input.executionId ||
      decoded.value.partitionIndex !== input.firstPartitionIndex ||
      input.firstPartitionIndex !== input.lastPartitionIndex ||
      decoded.value.planChecksum !== input.planChecksum ||
      roots.length !== input.descriptor.rootCount
    ) {
      return null;
    }
    return {
      checksum: decoded.value.checksum,
      roots,
    };
  }
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let shard: typeof QualificationEvaluationRootAccumulatorShard.Type;
  try {
    shard = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationRootAccumulatorShard))(
      encoded,
    );
  } catch {
    return null;
  }
  const { checksum, ...content } = shard;
  if (
    shard.artifactId !== artifactId ||
    shard.executionId !== input.executionId ||
    shard.firstPartitionIndex !== input.firstPartitionIndex ||
    shard.index !== input.index ||
    shard.lastPartitionIndex !== input.lastPartitionIndex ||
    shard.planChecksum !== input.planChecksum ||
    shard.previousShardChecksum !== input.previousShardChecksum ||
    checksum !== qualificationChecksum(content) ||
    retained.customMetadata?.["osfo-artifact-checksum"] !== checksum ||
    retained.customMetadata?.["osfo-body-sha256"] !== (await sha256Hex(encoded)) ||
    retained.customMetadata?.["osfo-execution-id"] !== input.executionId ||
    retained.customMetadata?.["osfo-first-partition-index"] !== String(input.firstPartitionIndex) ||
    retained.customMetadata?.["osfo-index"] !== String(input.index) ||
    retained.customMetadata?.["osfo-kind"] !== "qualification-evaluation-root-accumulator-v2" ||
    retained.customMetadata?.["osfo-last-partition-index"] !== String(input.lastPartitionIndex) ||
    retained.customMetadata?.["osfo-plan-checksum"] !== input.planChecksum ||
    retained.customMetadata?.["osfo-previous-checksum"] !== input.previousShardChecksum ||
    retained.customMetadata?.["osfo-record-count"] !== String(shard.roots.length)
  ) {
    return null;
  }
  if (
    (input.index === 0 && checksum !== input.descriptor.firstShardChecksum) ||
    shard.roots.some((root) =>
      root.correlations.some((correlation, index, correlations) => {
        const previous = correlations[index - 1];
        return previous !== undefined && correlation.kind.localeCompare(previous.kind) <= 0;
      }),
    )
  ) {
    return null;
  }
  return { checksum, roots: shard.roots };
};

const validateChildren = (
  payload: QualificationEvaluationCorrectnessReducerWorkflowPayload,
  children: ReadonlyArray<VerifiedChild>,
) => {
  const first = children[0];
  const last = children.at(-1);
  const acceptedCount = children.reduce((total, child) => total + child.root.acceptedCount, 0);
  const rootCount = children.reduce((total, child) => total + child.root.rootCount, 0);
  return (
    first !== undefined &&
    last !== undefined &&
    Number.isSafeInteger(payload.acceptedCount) &&
    payload.acceptedCount >= 0 &&
    Number.isSafeInteger(payload.rootCount) &&
    payload.rootCount >= 0 &&
    payload.rootCount <= qualificationEvaluationMaximumDimensionValues &&
    payload.acceptedCount <= payload.rootCount &&
    Number.isSafeInteger(acceptedCount) &&
    Number.isSafeInteger(rootCount) &&
    children.length === payload.inputs.length &&
    children.every(
      (child, index) =>
        child.checksum === payload.inputs[index]?.checksum &&
        (index === 0 ||
          child.firstPartitionIndex ===
            (children[index - 1]?.lastPartitionIndex ?? Number.NaN) + 1),
    ) &&
    first.firstPartitionIndex === payload.firstPartitionIndex &&
    last.lastPartitionIndex === payload.lastPartitionIndex &&
    acceptedCount === payload.acceptedCount &&
    rootCount === payload.rootCount &&
    payload.inputReceiptChainDigest ===
      qualificationChecksum(children.map(({ checksum }) => checksum))
  );
};

const verifyRootChains = async (input: {
  readonly children: ReadonlyArray<VerifiedChild>;
  readonly env: QualificationEvaluationCorrectnessReducerEnv;
  readonly payload: QualificationEvaluationCorrectnessReducerWorkflowPayload;
  readonly step: QualificationEvaluationCorrectnessReducerStep;
}) => {
  for (const [childIndex, child] of input.children.entries()) {
    let acceptedCount = 0;
    let firstRootId: string | null = null;
    let previousShardChecksum = "NONE";
    let previousRootId: string | null = null;
    let rootCount = 0;
    for (
      let pageStart = 0;
      pageStart < child.root.shardCount;
      pageStart += qualificationCorrectnessRootVerificationPageSize
    ) {
      const page = await input.step.do(
        `verify correctness child ${childIndex} root page ${Math.floor(pageStart / qualificationCorrectnessRootVerificationPageSize)}`,
        async () => {
          let pagePreviousChecksum = previousShardChecksum;
          let pagePreviousRootId = previousRootId;
          let pageAcceptedCount = 0;
          let pageFirstRootId: string | null = null;
          let pageRootCount = 0;
          const end = Math.min(
            child.root.shardCount,
            pageStart + qualificationCorrectnessRootVerificationPageSize,
          );
          for (let index = pageStart; index < end; index += 1) {
            const shard = await readRootShard({
              bucket: input.env.ARTIFACTS,
              descriptor: child.root,
              executionId: input.payload.executionId,
              firstPartitionIndex: child.firstPartitionIndex,
              index,
              lastPartitionIndex: child.lastPartitionIndex,
              planChecksum: input.payload.planChecksum,
              previousShardChecksum: pagePreviousChecksum,
            });
            if (shard === null) throw new Error("Qualification correctness root shard conflicts");
            if (
              shard.roots.some((root, rootIndex, roots) => {
                const prior = roots[rootIndex - 1]?.rootId ?? pagePreviousRootId;
                return prior !== null && root.rootId.localeCompare(prior) <= 0;
              })
            ) {
              throw new Error("Qualification correctness root order conflicts");
            }
            pagePreviousChecksum = shard.checksum;
            pageFirstRootId ??= shard.roots[0]?.rootId ?? null;
            pagePreviousRootId = shard.roots.at(-1)?.rootId ?? pagePreviousRootId;
            pageAcceptedCount += shard.roots.filter(
              ({ decision }) => decision === "accepted",
            ).length;
            pageRootCount += shard.roots.length;
          }
          return {
            acceptedCount: pageAcceptedCount,
            firstRootId: pageFirstRootId,
            previousRootId: pagePreviousRootId,
            previousShardChecksum: pagePreviousChecksum,
            rootCount: pageRootCount,
          };
        },
      );
      previousShardChecksum = page.previousShardChecksum;
      previousRootId = page.previousRootId;
      acceptedCount += page.acceptedCount;
      firstRootId ??= page.firstRootId;
      rootCount += page.rootCount;
    }
    if (
      rootCount !== child.root.rootCount ||
      acceptedCount !== child.root.acceptedCount ||
      (child.root.rootCount === 0
        ? child.root.shardCount !== 0 ||
          child.root.firstShardChecksum !== "ZERO" ||
          child.root.terminalShardChecksum !== "ZERO"
        : firstRootId !== child.root.firstRootId ||
          previousShardChecksum !== child.root.terminalShardChecksum ||
          previousRootId !== child.root.lastRootId)
    ) {
      throw new Error("Qualification correctness terminal root chain conflicts");
    }
  }
};

const outputRootPrefix = (payload: QualificationEvaluationCorrectnessReducerWorkflowPayload) =>
  `${payload.outputArtifactPrefix}/roots`;

const outputRootReceiptId = (payload: QualificationEvaluationCorrectnessReducerWorkflowPayload) =>
  `${outputRootPrefix(payload)}/receipt.json`;

const outputSummaryId = (payload: QualificationEvaluationCorrectnessReducerWorkflowPayload) =>
  `${payload.outputArtifactPrefix}/finding-summary.json`;

const outputReceiptId = (payload: QualificationEvaluationCorrectnessReducerWorkflowPayload) =>
  `${payload.outputArtifactPrefix}/receipt.json`;

/** Authenticate, merge, and retain one bounded correctness-reduction node. */
export const runQualificationEvaluationCorrectnessReducer = async (input: {
  readonly env: QualificationEvaluationCorrectnessReducerEnv;
  readonly payload: QualificationEvaluationCorrectnessReducerWorkflowPayload;
  readonly step: QualificationEvaluationCorrectnessReducerStep;
}): Promise<typeof QualificationEvaluationCorrectnessReceipt.Type> => {
  if (
    !Number.isSafeInteger(input.payload.level) ||
    input.payload.level < 1 ||
    !Number.isSafeInteger(input.payload.index) ||
    input.payload.index < 0 ||
    !Number.isSafeInteger(input.payload.firstPartitionIndex) ||
    input.payload.firstPartitionIndex < 0 ||
    !Number.isSafeInteger(input.payload.lastPartitionIndex) ||
    input.payload.lastPartitionIndex < input.payload.firstPartitionIndex ||
    (input.payload.inputKind === "leafCompletion" && input.payload.level !== 1) ||
    (input.payload.inputKind === "correctness" && input.payload.level < 2) ||
    input.payload.inputs.length === 0 ||
    input.payload.inputs.length > 16 ||
    new Set(input.payload.inputs.map(({ checksum }) => checksum)).size !==
      input.payload.inputs.length
  ) {
    throw new Error("Qualification correctness inputs conflict");
  }
  const children = new Array<VerifiedChild>();
  for (const [index, reference] of input.payload.inputs.entries()) {
    const child = await input.step.do(`authenticate correctness child receipt ${index}`, () =>
      input.payload.inputKind === "leafCompletion"
        ? readLeafCompletion({
            bucket: input.env.ARTIFACTS,
            executionId: input.payload.executionId,
            planChecksum: input.payload.planChecksum,
            reference,
          })
        : readCorrectnessChild({
            bucket: input.env.ARTIFACTS,
            executionId: input.payload.executionId,
            expectedLevel: input.payload.level - 1,
            planChecksum: input.payload.planChecksum,
            reference,
          }),
    );
    if (child === null) {
      throw new Error("Qualification correctness child receipt conflicts");
    }
    children.push(child);
  }
  if (!validateChildren(input.payload, children)) {
    throw new Error("Qualification correctness child range conflicts");
  }
  await verifyRootChains({ children, env: input.env, payload: input.payload, step: input.step });

  let cursors = children.map(({ root }): RootCursor => ({
    consumedCount: 0,
    previousRootId: null,
    previousShardChecksum: root.rootCount === 0 ? "ZERO" : "NONE",
    shardIndex: 0,
    valueOffset: 0,
  }));
  let firstOutputRootId: string | null = null;
  let firstOutputShardChecksum = "ZERO";
  let lastOutputRootId: string | null = null;
  let outputCount = 0;
  let outputIndex = 0;
  let outputPreviousShardChecksum = "NONE";
  for (let page = 0; page < maximumRootPages; page += 1) {
    if (
      cursors.every((cursor, index) => cursor.consumedCount === children[index]?.root.rootCount)
    ) {
      break;
    }
    const merged = await input.step.do(`merge correctness root page ${page}`, async () => {
      const shards = new Array<Awaited<ReturnType<typeof readRootShard>> | null>();
      for (const [index, child] of children.entries()) {
        const cursor = cursors[index];
        shards.push(
          cursor === undefined || cursor.consumedCount === child.root.rootCount
            ? null
            : await readRootShard({
                bucket: input.env.ARTIFACTS,
                descriptor: child.root,
                executionId: input.payload.executionId,
                firstPartitionIndex: child.firstPartitionIndex,
                index: cursor.shardIndex,
                lastPartitionIndex: child.lastPartitionIndex,
                planChecksum: input.payload.planChecksum,
                previousShardChecksum: cursor.previousShardChecksum,
              }),
        );
      }
      if (
        shards.some(
          (shard, index) =>
            (shard === null || shard === undefined) &&
            cursors[index]?.consumedCount !== children[index]?.root.rootCount,
        )
      ) {
        throw new Error("Qualification correctness merge input conflicts");
      }
      const offsets = cursors.map(({ valueOffset }) => valueOffset);
      const roots = new Array<
        (typeof QualificationEvaluationRootAccumulatorShard.Type)["roots"][number]
      >();
      while (roots.length < qualificationEvaluationSampleShardLimit) {
        let selected = -1;
        let selectedRoot: (typeof roots)[number] | undefined;
        for (const [index, shard] of shards.entries()) {
          const candidate = shard?.roots[offsets[index] ?? 0];
          if (
            candidate !== undefined &&
            (selectedRoot === undefined || candidate.rootId.localeCompare(selectedRoot.rootId) < 0)
          ) {
            selected = index;
            selectedRoot = candidate;
          }
        }
        if (selected === -1 || selectedRoot === undefined) break;
        const prior = roots.at(-1)?.rootId ?? lastOutputRootId;
        if (prior !== null && selectedRoot.rootId.localeCompare(prior) <= 0) {
          throw new Error("Qualification correctness duplicate root conflicts");
        }
        roots.push(selectedRoot);
        offsets[selected] = (offsets[selected] ?? 0) + 1;
      }
      if (roots.length === 0) throw new Error("Qualification correctness produced no root page");
      const artifactId = `${outputRootPrefix(input.payload)}/${padded(outputIndex)}.json`;
      const output = qualificationEvaluationRootAccumulatorShard({
        artifactId,
        executionId: input.payload.executionId,
        firstPartitionIndex: input.payload.firstPartitionIndex,
        index: outputIndex,
        lastPartitionIndex: input.payload.lastPartitionIndex,
        planChecksum: input.payload.planChecksum,
        previousShardChecksum: outputPreviousShardChecksum,
        roots,
      });
      if (output === null) throw new Error("Qualification correctness output root invalid");
      const retained = await retainQualificationEvaluationArtifact({
        artifactId,
        bucket: input.env.ARTIFACTS,
        checksum: output.checksum,
        encoded: canonicalQualificationJson(output),
        executionId: input.payload.executionId,
        kind: "qualification-evaluation-root-accumulator-v2",
        metadata: {
          "osfo-first-partition-index": String(input.payload.firstPartitionIndex),
          "osfo-index": String(outputIndex),
          "osfo-last-partition-index": String(input.payload.lastPartitionIndex),
          "osfo-previous-checksum": outputPreviousShardChecksum,
          "osfo-record-count": String(roots.length),
        },
        planChecksum: input.payload.planChecksum,
      });
      if (retained === "CONFLICT") throw new Error("Qualification correctness output conflicts");
      const nextCursors = cursors.map((cursor, index): RootCursor => {
        const shard = shards[index];
        if (shard === null || shard === undefined) return cursor;
        const consumed = (offsets[index] ?? 0) - cursor.valueOffset;
        return offsets[index] === shard.roots.length
          ? {
              consumedCount: cursor.consumedCount + consumed,
              previousRootId: shard.roots.at(-1)?.rootId ?? cursor.previousRootId,
              previousShardChecksum: shard.checksum,
              shardIndex: cursor.shardIndex + 1,
              valueOffset: 0,
            }
          : {
              ...cursor,
              consumedCount: cursor.consumedCount + consumed,
              valueOffset: offsets[index] ?? cursor.valueOffset,
            };
      });
      return {
        cursors: nextCursors,
        outputChecksum: output.checksum,
        outputFirstRootId: output.roots[0]?.rootId ?? null,
        outputLastRootId: output.roots.at(-1)?.rootId ?? null,
        outputRootCount: output.roots.length,
      };
    });
    cursors = merged.cursors;
    firstOutputRootId ??= merged.outputFirstRootId;
    if (outputIndex === 0) firstOutputShardChecksum = merged.outputChecksum;
    lastOutputRootId = merged.outputLastRootId ?? lastOutputRootId;
    outputCount += merged.outputRootCount;
    outputIndex += 1;
    outputPreviousShardChecksum = merged.outputChecksum;
  }
  if (
    outputCount !== input.payload.rootCount ||
    cursors.some((cursor, index) => cursor.consumedCount !== children[index]?.root.rootCount)
  ) {
    throw new Error("Qualification correctness root merge budget exhausted");
  }
  const inputChecksums = children.map(({ checksum }) => checksum);
  const rootReceipt = qualificationEvaluationRootAccumulatorReceipt({
    acceptedCount: input.payload.acceptedCount,
    artifactId: outputRootReceiptId(input.payload),
    artifactPrefix: outputRootPrefix(input.payload),
    executionId: input.payload.executionId,
    firstPartitionIndex: input.payload.firstPartitionIndex,
    firstRootId: firstOutputRootId,
    firstShardChecksum: outputCount === 0 ? "ZERO" : firstOutputShardChecksum,
    index: input.payload.index,
    inputReceiptChecksums: inputChecksums,
    lastPartitionIndex: input.payload.lastPartitionIndex,
    lastRootId: lastOutputRootId,
    level: input.payload.level,
    planChecksum: input.payload.planChecksum,
    rootCount: outputCount,
    shardCount: outputIndex,
    terminalShardChecksum: outputCount === 0 ? "ZERO" : outputPreviousShardChecksum,
  });
  if (rootReceipt === null) throw new Error("Qualification correctness root receipt invalid");
  const retainedRootReceipt = await input.step.do("retain correctness root receipt", () =>
    retainQualificationEvaluationArtifact({
      artifactId: rootReceipt.artifactId,
      bucket: input.env.ARTIFACTS,
      checksum: rootReceipt.checksum,
      encoded: canonicalQualificationJson(rootReceipt),
      executionId: input.payload.executionId,
      kind: "qualification-evaluation-root-accumulator-receipt-v2",
      metadata: {
        "osfo-accepted-count": String(rootReceipt.acceptedCount),
        "osfo-first-partition-index": String(rootReceipt.firstPartitionIndex),
        "osfo-first-root-id": rootReceipt.firstRootId ?? "ZERO",
        "osfo-input-receipt-chain-digest": rootReceipt.inputReceiptChainDigest,
        "osfo-last-partition-index": String(rootReceipt.lastPartitionIndex),
        "osfo-last-root-id": rootReceipt.lastRootId ?? "ZERO",
        "osfo-record-count": String(rootReceipt.rootCount),
        "osfo-shard-count": String(rootReceipt.shardCount),
        "osfo-terminal-checksum": rootReceipt.terminalShardChecksum,
      },
      planChecksum: input.payload.planChecksum,
    }),
  );
  if (retainedRootReceipt === "CONFLICT") throw new Error("Qualification root receipt conflicts");

  const summary = mergeQualificationFindingSummaries(
    children.map(({ findingSummary }) => findingSummary),
  );
  const maximumFindingCount =
    input.payload.rootCount * qualificationEvaluationLeafMaximumFindingsPerRoot +
    (input.payload.lastPartitionIndex - input.payload.firstPartitionIndex + 1);
  if (
    !Number.isSafeInteger(summary.failCount) ||
    summary.failCount < 0 ||
    summary.failCount > maximumFindingCount ||
    !Number.isSafeInteger(summary.missingCount) ||
    summary.missingCount < 0 ||
    summary.missingCount > maximumFindingCount
  ) {
    throw new Error("Qualification finding summary count conflicts");
  }
  const summaryArtifact = qualificationEvaluationFindingSummaryShard({
    artifactId: outputSummaryId(input.payload),
    executionId: input.payload.executionId,
    index: input.payload.index,
    inputChecksums,
    level: input.payload.level,
    planChecksum: input.payload.planChecksum,
    summary,
  });
  if (summaryArtifact === null) throw new Error("Qualification finding summary invalid");
  const retainedSummary = await input.step.do("retain correctness finding summary", () =>
    retainQualificationEvaluationArtifact({
      artifactId: summaryArtifact.artifactId,
      bucket: input.env.ARTIFACTS,
      checksum: summaryArtifact.checksum,
      encoded: canonicalQualificationJson(summaryArtifact),
      executionId: input.payload.executionId,
      kind: "qualification-evaluation-finding-summary-v1",
      metadata: {
        "osfo-fail-count": String(summary.failCount),
        "osfo-input-receipt-chain-digest": qualificationChecksum(inputChecksums),
        "osfo-missing-count": String(summary.missingCount),
        "osfo-record-count": String(summary.exemplars.length),
      },
      planChecksum: input.payload.planChecksum,
    }),
  );
  if (retainedSummary === "CONFLICT") throw new Error("Qualification finding summary conflicts");

  const receipt = qualificationEvaluationCorrectnessReceipt({
    artifactId: outputReceiptId(input.payload),
    executionId: input.payload.executionId,
    findingSummary: summary,
    findingSummaryArtifactChecksum: summaryArtifact.checksum,
    findingSummaryArtifactId: summaryArtifact.artifactId,
    index: input.payload.index,
    inputReceiptChecksums: inputChecksums,
    level: input.payload.level,
    planChecksum: input.payload.planChecksum,
    rootAccumulator: rootReceipt,
  });
  if (receipt === null) throw new Error("Qualification correctness receipt invalid");
  const retainedReceipt = await input.step.do("retain correctness receipt", () =>
    retainQualificationEvaluationArtifact({
      artifactId: receipt.artifactId,
      bucket: input.env.ARTIFACTS,
      checksum: receipt.checksum,
      encoded: canonicalQualificationJson(receipt),
      executionId: input.payload.executionId,
      kind: "qualification-evaluation-correctness-receipt-v1",
      metadata: {
        "osfo-first-partition-index": String(receipt.firstPartitionIndex),
        "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
        "osfo-last-partition-index": String(receipt.lastPartitionIndex),
        "osfo-record-count": String(receipt.rootAccumulator.rootCount),
        "osfo-root-receipt-checksum": receipt.rootAccumulator.checksum,
        "osfo-summary-checksum": receipt.findingSummaryArtifactChecksum,
        "osfo-verdict": receipt.verdict,
      },
      planChecksum: input.payload.planChecksum,
    }),
  );
  if (retainedReceipt === "CONFLICT")
    throw new Error("Qualification correctness receipt conflicts");
  return receipt;
};

export class QualificationEvaluationCorrectnessReducerWorkflow extends WorkflowEntrypoint<
  QualificationEvaluationCorrectnessReducerEnv,
  QualificationEvaluationCorrectnessReducerWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationEvaluationCorrectnessReducerWorkflowPayload>>,
    step: WorkflowStep,
  ) {
    return runQualificationEvaluationCorrectnessReducer({
      env: this.env,
      payload: event.payload,
      step,
    });
  }
}
