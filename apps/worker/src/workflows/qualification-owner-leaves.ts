import { Schema } from "effect";

import {
  QualificationEvaluationLeafReceipt,
  QualificationEvaluationLeafRootAccumulator,
} from "../qualification/qualification-evaluation-leaf";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import {
  qualificationLeafCompletionHorizonMs,
  qualificationLeafFanoutMaximumDurationMs,
} from "../qualification/owner-partitions";
import type {
  QualificationEvaluationLeafWorkflowPayload,
  QualificationOwnerWorkflowPayload,
} from "../workflow-contracts";
import { QualificationEvaluationLeafCompletion } from "./qualification-evaluation-leaf";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Cloudflare Workflow and R2 are Promise-only durable host boundaries; page order is authoritative. */

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const qualificationLeafPageSize = 50;
export { qualificationLeafCompletionHorizonMs, qualificationLeafFanoutMaximumDurationMs };

export const QualificationEvaluationLeafLaunchInput = Schema.Struct({
  leafInputArtifactId: Identity,
  leafInputChecksum: Identity,
  partitionIndex: NonNegativeInteger,
  runId: Identity,
});

export const QualificationEvaluationLeafLaunchPage = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  inputs: Schema.Array(QualificationEvaluationLeafLaunchInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationLeafPageSize),
  ),
  lastPartitionIndex: NonNegativeInteger,
  manifestChecksum: Identity,
  pageIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  version: Schema.Literal("qualification-evaluation-leaf-launch-page-v1"),
});

const QualificationEvaluationLeafCompletionReference = Schema.Struct({
  acceptedCount: NonNegativeInteger,
  artifactId: Identity,
  checksum: Identity,
  leafInputArtifactId: Identity,
  leafInputChecksum: Identity,
  outcome: Schema.Literals(["COMPLETE", "FAIL", "MISSING"]),
  partitionIndex: NonNegativeInteger,
  rootCount: NonNegativeInteger,
  runId: Identity,
});

export const QualificationEvaluationLeafCompletionJoinPage = Schema.Struct({
  acceptedCount: NonNegativeInteger,
  artifactId: Identity,
  checksum: Identity,
  completeOutcomeCount: NonNegativeInteger,
  executionId: Identity,
  expectedFirstPartitionIndex: NonNegativeInteger,
  expectedLastPartitionIndex: NonNegativeInteger,
  failOutcomeCount: NonNegativeInteger,
  launchPageChecksum: Identity,
  manifestChecksum: Identity,
  missingCompletionCount: NonNegativeInteger,
  observedFirstPartitionIndex: Schema.NullOr(NonNegativeInteger),
  observedLastPartitionIndex: Schema.NullOr(NonNegativeInteger),
  outcomeMissingCount: NonNegativeInteger,
  pageIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  references: Schema.Array(QualificationEvaluationLeafCompletionReference).check(
    Schema.isMaxLength(qualificationLeafPageSize),
  ),
  rootCount: NonNegativeInteger,
  version: Schema.Literal("qualification-evaluation-leaf-completion-page-v1"),
});

interface QualificationOwnerLeafBucket {
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

interface QualificationOwnerLeafEnv {
  readonly ARTIFACTS: QualificationOwnerLeafBucket;
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

interface QualificationOwnerLeafStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

export interface QualificationEvaluationLeafLaunchDescriptor {
  readonly pageCount: number;
  readonly partitionCount: number;
  readonly terminalPageChecksum: string;
}

export interface QualificationOwnerLeafFanoutComplete {
  readonly acceptedCount: number;
  readonly completeOutcomeCount: number;
  readonly completionCount: number;
  readonly failOutcomeCount: number;
  readonly lastBatchLaunchedAtEpochMs: number;
  readonly missingCompletionCount: number;
  readonly outcomeMissingCount: number;
  readonly pageCount: number;
  readonly rootCount: number;
  readonly status: "COMPLETE";
  readonly terminalPageChecksum: string;
}

export interface QualificationOwnerLeafFanoutMissing {
  readonly acceptedCount: number;
  readonly completeOutcomeCount: number;
  readonly completionCount: number;
  readonly failOutcomeCount: number;
  readonly lastBatchLaunchedAtEpochMs: number;
  readonly missingCompletionCount: number;
  readonly outcomeMissingCount: number;
  readonly pageCount: number;
  readonly rootCount: number;
  readonly status: "MISSING";
  readonly terminalPageChecksum: string;
}

const padded = (value: number) => value.toString().padStart(8, "0");
const launchPagePrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaf-launch-pages`;
const launchPageArtifactId = (executionId: string, pageIndex: number) =>
  `${launchPagePrefix(executionId)}/${padded(pageIndex)}.json`;
const completionPrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaf-completions`;
const completionArtifactId = (executionId: string, partitionIndex: number) =>
  `${completionPrefix(executionId)}/${padded(partitionIndex)}.json`;
const joinPagePrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaf-completion-pages`;
const joinPageArtifactId = (executionId: string, pageIndex: number) =>
  `${joinPagePrefix(executionId)}/${padded(pageIndex)}.json`;

const sha256Hex = async (encoded: string) => {
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

const retainImmutable = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationOwnerLeafBucket;
  readonly encoded: string;
  readonly metadata: Readonly<Record<string, string>>;
}) => {
  const metadata = { ...input.metadata, "osfo-body-sha256": await sha256Hex(input.encoded) };
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
    throw new Error(`Retained qualification leaf artifact conflicts: ${input.artifactId}`);
  }
};

/** Retain one exact bounded page of leaf inputs authenticated by partition completions. */
export const retainQualificationEvaluationLeafLaunchPage = async (input: {
  readonly bucket: QualificationOwnerLeafBucket;
  readonly executionId: string;
  readonly inputs: ReadonlyArray<typeof QualificationEvaluationLeafLaunchInput.Type>;
  readonly manifestChecksum: string;
  readonly pageIndex: number;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const first = input.inputs[0];
  const last = input.inputs.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.inputs.length > qualificationLeafPageSize ||
    input.inputs.some(
      ({ partitionIndex }, index) => partitionIndex !== first.partitionIndex + index,
    )
  ) {
    throw new Error("Qualification leaf launch inputs conflict");
  }
  const firstPartitionIndex = first.partitionIndex;
  const lastPartitionIndex = last.partitionIndex;
  const artifactId = launchPageArtifactId(input.executionId, input.pageIndex);
  const content = {
    artifactId,
    executionId: input.executionId,
    firstPartitionIndex,
    inputs: input.inputs,
    lastPartitionIndex,
    manifestChecksum: input.manifestChecksum,
    pageIndex: input.pageIndex,
    planChecksum: input.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    version: "qualification-evaluation-leaf-launch-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded: canonicalQualificationJson(page),
    metadata: {
      "osfo-artifact-checksum": page.checksum,
      "osfo-execution-id": input.executionId,
      "osfo-first-partition-index": String(firstPartitionIndex),
      "osfo-index": String(input.pageIndex),
      "osfo-kind": "qualification-evaluation-leaf-launch-page-v1",
      "osfo-last-partition-index": String(lastPartitionIndex),
      "osfo-manifest-checksum": input.manifestChecksum,
      "osfo-plan-checksum": input.planChecksum,
      "osfo-previous-checksum": input.previousPageChecksum,
      "osfo-record-count": String(input.inputs.length),
    },
  });
  return page;
};

const readLaunchPage = async (input: {
  readonly bucket: QualificationOwnerLeafBucket;
  readonly expectedPreviousChecksum: string;
  readonly pageIndex: number;
  readonly payload: QualificationOwnerWorkflowPayload;
}) => {
  const artifactId = launchPageArtifactId(input.payload.executionId, input.pageIndex);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let page: typeof QualificationEvaluationLeafLaunchPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationLeafLaunchPage))(encoded);
  } catch {
    return null;
  }
  if (
    !authenticChecksum(page) ||
    page.artifactId !== artifactId ||
    page.executionId !== input.payload.executionId ||
    page.manifestChecksum !== input.payload.manifestChecksum ||
    page.pageIndex !== input.pageIndex ||
    page.planChecksum !== input.payload.planChecksum ||
    page.previousPageChecksum !== input.expectedPreviousChecksum ||
    page.inputs.some(
      ({ partitionIndex }, index) => partitionIndex !== page.firstPartitionIndex + index,
    ) ||
    page.lastPartitionIndex !== page.firstPartitionIndex + page.inputs.length - 1 ||
    !exactMetadata(retained.customMetadata, {
      "osfo-artifact-checksum": page.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-execution-id": input.payload.executionId,
      "osfo-first-partition-index": String(page.firstPartitionIndex),
      "osfo-index": String(input.pageIndex),
      "osfo-kind": "qualification-evaluation-leaf-launch-page-v1",
      "osfo-last-partition-index": String(page.lastPartitionIndex),
      "osfo-manifest-checksum": input.payload.manifestChecksum,
      "osfo-plan-checksum": input.payload.planChecksum,
      "osfo-previous-checksum": input.expectedPreviousChecksum,
      "osfo-record-count": String(page.inputs.length),
    })
  ) {
    return null;
  }
  return page;
};

const safeDecimalCount = (value: string, maximum: number) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
};

const readCompletion = async (input: {
  readonly bucket: QualificationOwnerLeafBucket;
  readonly launchInput: typeof QualificationEvaluationLeafLaunchInput.Type;
  readonly payload: QualificationOwnerWorkflowPayload;
}): Promise<typeof QualificationEvaluationLeafCompletionReference.Type | undefined> => {
  const artifactId = completionArtifactId(
    input.payload.executionId,
    input.launchInput.partitionIndex,
  );
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
    throw new Error("Qualification leaf completion inventory conflicts");
  }
  const retained = await input.bucket.get(artifactId);
  if (retained === null && listed.objects.length === 0) return undefined;
  if (retained === null || listed.objects.length !== 1) {
    throw new Error("Qualification leaf completion inventory conflicts");
  }
  const encoded = await retained.text();
  let completion: typeof QualificationEvaluationLeafCompletion.Type;
  try {
    completion = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationLeafCompletion))(
      encoded,
    );
  } catch {
    throw new Error("Qualification leaf completion body conflicts");
  }
  const bodySha256 = await sha256Hex(encoded);
  if (
    !authenticChecksum(completion) ||
    completion.artifactId !== artifactId ||
    completion.executionId !== input.payload.executionId ||
    completion.leafInputArtifactId !== input.launchInput.leafInputArtifactId ||
    completion.leafInputChecksum !== input.launchInput.leafInputChecksum ||
    completion.manifestChecksum !== input.payload.manifestChecksum ||
    completion.partitionIndex !== input.launchInput.partitionIndex ||
    completion.planChecksum !== input.payload.planChecksum ||
    completion.runId !== input.launchInput.runId ||
    ![retained.customMetadata, listed.objects[0]?.customMetadata].every((metadata) =>
      exactMetadata(metadata, {
        "osfo-artifact-checksum": completion.checksum,
        "osfo-body-sha256": bodySha256,
        "osfo-execution-id": input.payload.executionId,
        "osfo-kind": "qualification-evaluation-leaf-completion-v1",
        "osfo-leaf-input-checksum": input.launchInput.leafInputChecksum,
        "osfo-outcome": completion.outcome.status,
        "osfo-partition-index": String(input.launchInput.partitionIndex),
        "osfo-plan-checksum": input.payload.planChecksum,
        "osfo-record-count":
          completion.outcome.status === "COMPLETE" ? completion.outcome.receipt.rootCount : "0",
        "osfo-run-id": input.launchInput.runId,
      }),
    )
  ) {
    throw new Error("Qualification leaf completion conflicts");
  }
  if (completion.outcome.status === "COMPLETE") {
    const receipt = completion.outcome.receipt;
    const retainedReceipt = await input.bucket.get(receipt.artifactId);
    if (retainedReceipt === null) return undefined;
    const receiptEncoded = await retainedReceipt.text();
    let decodedReceipt: typeof QualificationEvaluationLeafReceipt.Type;
    try {
      decodedReceipt = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationLeafReceipt))(
        receiptEncoded,
      );
    } catch {
      throw new Error("Qualification leaf receipt body conflicts");
    }
    const rootCount = safeDecimalCount(receipt.rootCount, 256);
    if (
      rootCount === null ||
      !authenticChecksum(receipt) ||
      canonicalQualificationJson(decodedReceipt) !== canonicalQualificationJson(receipt) ||
      receipt.executionId !== input.payload.executionId ||
      receipt.leafInputChecksum !== input.launchInput.leafInputChecksum ||
      receipt.partitionIndex !== input.launchInput.partitionIndex ||
      receipt.planChecksum !== input.payload.planChecksum ||
      !exactMetadata(retainedReceipt.customMetadata, {
        "osfo-artifact-checksum": receipt.checksum,
        "osfo-body-sha256": await sha256Hex(receiptEncoded),
        "osfo-execution-id": input.payload.executionId,
        "osfo-kind": "qualification-evaluation-leaf-v1",
        "osfo-plan-checksum": input.payload.planChecksum,
        "osfo-record-count": String(receipt.dimensions.length),
        "osfo-verdict": receipt.verdict,
      })
    ) {
      throw new Error("Qualification leaf receipt conflicts");
    }
    const retainedRoots = await input.bucket.get(receipt.rootAccumulatorId);
    if (retainedRoots === null) return undefined;
    const rootsEncoded = await retainedRoots.text();
    let roots: typeof QualificationEvaluationLeafRootAccumulator.Type;
    try {
      roots = Schema.decodeSync(Schema.fromJsonString(QualificationEvaluationLeafRootAccumulator))(
        rootsEncoded,
      );
    } catch {
      throw new Error("Qualification leaf roots body conflicts");
    }
    const acceptedCount = safeDecimalCount(roots.acceptedCount, 256);
    const accumulatorRootCount = safeDecimalCount(roots.rootCount, 256);
    if (
      acceptedCount === null ||
      accumulatorRootCount === null ||
      acceptedCount > accumulatorRootCount ||
      !authenticChecksum(roots) ||
      roots.artifactId !== receipt.rootAccumulatorId ||
      roots.checksum !== receipt.rootAccumulatorChecksum ||
      roots.executionId !== input.payload.executionId ||
      roots.partitionIndex !== input.launchInput.partitionIndex ||
      roots.planChecksum !== input.payload.planChecksum ||
      roots.roots.length !== accumulatorRootCount ||
      accumulatorRootCount !== rootCount ||
      roots.roots.filter(({ decision }) => decision === "accepted").length !== acceptedCount ||
      !exactMetadata(retainedRoots.customMetadata, {
        "osfo-artifact-checksum": roots.checksum,
        "osfo-body-sha256": await sha256Hex(rootsEncoded),
        "osfo-execution-id": input.payload.executionId,
        "osfo-kind": "qualification-evaluation-leaf-roots-v1",
        "osfo-plan-checksum": input.payload.planChecksum,
        "osfo-record-count": roots.rootCount,
      })
    ) {
      throw new Error("Qualification leaf roots conflict");
    }
    return {
      acceptedCount,
      artifactId: completion.artifactId,
      checksum: completion.checksum,
      leafInputArtifactId: completion.leafInputArtifactId,
      leafInputChecksum: completion.leafInputChecksum,
      outcome: completion.outcome.status,
      partitionIndex: completion.partitionIndex,
      rootCount,
      runId: completion.runId,
    };
  }
  return {
    acceptedCount: 0,
    artifactId: completion.artifactId,
    checksum: completion.checksum,
    leafInputArtifactId: completion.leafInputArtifactId,
    leafInputChecksum: completion.leafInputChecksum,
    outcome: completion.outcome.status,
    partitionIndex: completion.partitionIndex,
    rootCount: 0,
    runId: completion.runId,
  };
};

const joinPage = async (input: {
  readonly bucket: QualificationOwnerLeafBucket;
  readonly launchPage: typeof QualificationEvaluationLeafLaunchPage.Type;
  readonly pageIndex: number;
  readonly payload: QualificationOwnerWorkflowPayload;
  readonly previousPageChecksum: string;
  readonly references: ReadonlyArray<typeof QualificationEvaluationLeafCompletionReference.Type>;
}) => {
  const referencedPartitions = new Set(
    input.references.map(({ partitionIndex }) => partitionIndex),
  );
  const missingCompletionCount = input.launchPage.inputs.filter(
    ({ partitionIndex }) => !referencedPartitions.has(partitionIndex),
  ).length;
  const content = {
    acceptedCount: input.references.reduce(
      (total, reference) => total + reference.acceptedCount,
      0,
    ),
    artifactId: joinPageArtifactId(input.payload.executionId, input.pageIndex),
    completeOutcomeCount: input.references.filter(({ outcome }) => outcome === "COMPLETE").length,
    executionId: input.payload.executionId,
    expectedFirstPartitionIndex: input.launchPage.firstPartitionIndex,
    expectedLastPartitionIndex: input.launchPage.lastPartitionIndex,
    failOutcomeCount: input.references.filter(({ outcome }) => outcome === "FAIL").length,
    launchPageChecksum: input.launchPage.checksum,
    manifestChecksum: input.payload.manifestChecksum,
    missingCompletionCount,
    observedFirstPartitionIndex: input.references[0]?.partitionIndex ?? null,
    observedLastPartitionIndex: input.references.at(-1)?.partitionIndex ?? null,
    outcomeMissingCount: input.references.filter(({ outcome }) => outcome === "MISSING").length,
    pageIndex: input.pageIndex,
    planChecksum: input.payload.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    references: input.references,
    rootCount: input.references.reduce((total, reference) => total + reference.rootCount, 0),
    version: "qualification-evaluation-leaf-completion-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  await retainImmutable({
    artifactId: page.artifactId,
    bucket: input.bucket,
    encoded: canonicalQualificationJson(page),
    metadata: {
      "osfo-artifact-checksum": page.checksum,
      "osfo-execution-id": input.payload.executionId,
      "osfo-expected-first-partition-index": String(page.expectedFirstPartitionIndex),
      "osfo-expected-last-partition-index": String(page.expectedLastPartitionIndex),
      "osfo-index": String(page.pageIndex),
      "osfo-kind": "qualification-evaluation-leaf-completion-page-v1",
      "osfo-launch-page-checksum": page.launchPageChecksum,
      "osfo-manifest-checksum": input.payload.manifestChecksum,
      "osfo-missing-completion-count": String(page.missingCompletionCount),
      "osfo-plan-checksum": input.payload.planChecksum,
      "osfo-previous-checksum": input.previousPageChecksum,
      "osfo-record-count": String(page.references.length),
    },
  });
  return page;
};

/** Fan out exact retained leaf inputs and join one bounded pass over their terminal material. */
export const runQualificationOwnerLeafFanout = async (input: {
  readonly env: QualificationOwnerLeafEnv;
  readonly launch: QualificationEvaluationLeafLaunchDescriptor;
  readonly payload: QualificationOwnerWorkflowPayload;
  readonly step: QualificationOwnerLeafStep;
}): Promise<QualificationOwnerLeafFanoutComplete | QualificationOwnerLeafFanoutMissing> => {
  if (
    !Number.isSafeInteger(input.launch.pageCount) ||
    input.launch.pageCount <= 0 ||
    !Number.isSafeInteger(input.launch.partitionCount) ||
    input.launch.partitionCount <= 0 ||
    input.launch.pageCount !== Math.ceil(input.launch.partitionCount / qualificationLeafPageSize)
  ) {
    throw new Error("Qualification leaf launch descriptor conflicts");
  }
  const fanoutStartedAtEpochMs = await input.step.do("capture qualification leaf fanout time", () =>
    // oxlint-disable-next-line effecttsgo/global-date -- The Workflow step durably captures one replay-stable host timestamp.
    Promise.resolve(Date.now()),
  );
  let previousLaunchPageChecksum = "NONE";
  let launchedCount = 0;
  let lastBatchLaunchedAtEpochMs = fanoutStartedAtEpochMs;
  for (let pageIndex = 0; pageIndex < input.launch.pageCount; pageIndex += 1) {
    const launched = await input.step.do(
      `create qualification leaf batch ${pageIndex}`,
      async () => {
        const page = await readLaunchPage({
          bucket: input.env.ARTIFACTS,
          expectedPreviousChecksum: previousLaunchPageChecksum,
          pageIndex,
          payload: input.payload,
        });
        if (page === null) throw new Error("Qualification leaf launch page conflicts");
        const instances = page.inputs.map((launchInput) => ({
          id: `${input.payload.executionId}:evaluation-leaf:${launchInput.partitionIndex}`,
          params: {
            executionId: input.payload.executionId,
            leafInputArtifactId: launchInput.leafInputArtifactId,
            leafInputChecksum: launchInput.leafInputChecksum,
            manifestChecksum: input.payload.manifestChecksum,
            partitionIndex: launchInput.partitionIndex,
            planChecksum: input.payload.planChecksum,
            requestArtifactChecksum: input.payload.requestArtifactChecksum,
            requestArtifactId: input.payload.requestArtifactId,
            runId: launchInput.runId,
          },
        }));
        let created: ReadonlyArray<{ readonly id: string }> | null = null;
        try {
          created = await input.env.QUALIFICATION_EVALUATION_LEAF_WORKFLOW.createBatch(instances);
        } catch (cause) {
          for (const { id } of instances) {
            const existing = await input.env.QUALIFICATION_EVALUATION_LEAF_WORKFLOW.get(id);
            if (existing.id !== id) throw cause;
          }
        }
        if (created !== null) {
          if (
            created.length !== instances.length ||
            created.some(({ id }, index) => id !== instances[index]?.id)
          ) {
            throw new Error("Qualification leaf createBatch result conflicts");
          }
        }
        return {
          count: instances.length,
          // oxlint-disable-next-line effecttsgo/global-date -- The Workflow step durably captures the replay-stable batch completion time.
          launchedAtEpochMs: Date.now(),
          pageChecksum: page.checksum,
        };
      },
    );
    launchedCount += launched.count;
    lastBatchLaunchedAtEpochMs = launched.launchedAtEpochMs;
    previousLaunchPageChecksum = launched.pageChecksum;
    if (pageIndex + 1 < input.launch.pageCount) {
      await input.step.sleepUntil(
        `rate limit qualification leaf batch ${pageIndex + 1}`,
        fanoutStartedAtEpochMs + (pageIndex + 1) * 1_000,
      );
    }
  }
  if (
    launchedCount !== input.launch.partitionCount ||
    previousLaunchPageChecksum !== input.launch.terminalPageChecksum
  ) {
    throw new Error("Qualification leaf launch terminal conflicts");
  }
  if (
    lastBatchLaunchedAtEpochMs - fanoutStartedAtEpochMs >
    qualificationLeafFanoutMaximumDurationMs
  ) {
    return {
      acceptedCount: 0,
      completeOutcomeCount: 0,
      completionCount: 0,
      failOutcomeCount: 0,
      lastBatchLaunchedAtEpochMs,
      missingCompletionCount: input.launch.partitionCount,
      outcomeMissingCount: 0,
      pageCount: 0,
      rootCount: 0,
      status: "MISSING",
      terminalPageChecksum: "ZERO",
    };
  }
  await input.step.sleepUntil(
    "await qualification leaf completion horizon",
    lastBatchLaunchedAtEpochMs + qualificationLeafCompletionHorizonMs,
  );

  let cursor: string | undefined;
  let inventoryPageIndex = 0;
  let previousInventoryPartitionIndex = -1;
  do {
    const inventory = await input.step.do(
      `inventory qualification leaf completion page ${inventoryPageIndex}`,
      async () => {
        const options = {
          include: ["customMetadata"] as const,
          limit: qualificationLeafPageSize,
          prefix: `${completionPrefix(input.payload.executionId)}/`,
        };
        const listed = await input.env.ARTIFACTS.list(
          cursor === undefined ? options : { ...options, cursor },
        );
        if (listed.truncated && (listed.cursor === undefined || listed.objects.length === 0)) {
          throw new Error("Qualification leaf completion inventory did not advance");
        }
        let lastPartitionIndex = previousInventoryPartitionIndex;
        for (const object of listed.objects) {
          const prefix = `${completionPrefix(input.payload.executionId)}/`;
          const suffix = object.key.slice(prefix.length);
          if (!object.key.startsWith(prefix) || !/^[0-9]{8}\.json$/.test(suffix)) {
            throw new Error("Qualification leaf completion is extra");
          }
          const partitionIndex = Number(suffix.slice(0, 8));
          if (
            partitionIndex <= lastPartitionIndex ||
            partitionIndex >= input.launch.partitionCount ||
            !exactMetadata(object.customMetadata, {
              "osfo-execution-id": input.payload.executionId,
              "osfo-kind": "qualification-evaluation-leaf-completion-v1",
              "osfo-partition-index": String(partitionIndex),
              "osfo-plan-checksum": input.payload.planChecksum,
            })
          ) {
            throw new Error("Qualification leaf completion inventory conflicts");
          }
          lastPartitionIndex = partitionIndex;
        }
        return {
          lastPartitionIndex,
          nextCursor: listed.truncated ? listed.cursor : null,
        };
      },
    );
    previousInventoryPartitionIndex = inventory.lastPartitionIndex;
    cursor = inventory.nextCursor ?? undefined;
    inventoryPageIndex += 1;
  } while (cursor !== undefined);

  let expectedIndex = 0;
  let joinPageIndex = 0;
  let previousJoinPageChecksum = "NONE";
  let joinPreviousLaunchPageChecksum = "NONE";
  let acceptedCount = 0;
  let completeOutcomeCount = 0;
  let completionCount = 0;
  let failOutcomeCount = 0;
  let missingCompletionCount = 0;
  let outcomeMissingCount = 0;
  let rootCount = 0;
  while (joinPageIndex < input.launch.pageCount) {
    const page = await input.step.do(
      `join qualification leaf completion page ${joinPageIndex}`,
      async () => {
        const launchPage = await readLaunchPage({
          bucket: input.env.ARTIFACTS,
          expectedPreviousChecksum: joinPreviousLaunchPageChecksum,
          pageIndex: joinPageIndex,
          payload: input.payload,
        });
        if (launchPage === null) throw new Error("Qualification leaf join launch page conflicts");
        const references = new Array<typeof QualificationEvaluationLeafCompletionReference.Type>();
        for (const launchInput of launchPage.inputs) {
          const reference = await readCompletion({
            bucket: input.env.ARTIFACTS,
            launchInput,
            payload: input.payload,
          });
          if (reference !== undefined) references.push(reference);
        }
        return joinPage({
          bucket: input.env.ARTIFACTS,
          launchPage,
          pageIndex: joinPageIndex,
          payload: input.payload,
          previousPageChecksum: previousJoinPageChecksum,
          references,
        });
      },
    );
    acceptedCount += page.acceptedCount;
    completeOutcomeCount += page.completeOutcomeCount;
    completionCount += page.references.length;
    failOutcomeCount += page.failOutcomeCount;
    missingCompletionCount += page.missingCompletionCount;
    outcomeMissingCount += page.outcomeMissingCount;
    rootCount += page.rootCount;
    previousJoinPageChecksum = page.checksum;
    joinPreviousLaunchPageChecksum = page.launchPageChecksum;
    expectedIndex += page.expectedLastPartitionIndex - page.expectedFirstPartitionIndex + 1;
    joinPageIndex += 1;
  }
  if (expectedIndex !== input.launch.partitionCount) {
    throw new Error("Qualification leaf completion expected range conflicts");
  }
  return {
    acceptedCount,
    completeOutcomeCount,
    completionCount,
    failOutcomeCount,
    lastBatchLaunchedAtEpochMs,
    missingCompletionCount,
    outcomeMissingCount,
    pageCount: joinPageIndex,
    rootCount,
    status: missingCompletionCount > 0 ? "MISSING" : "COMPLETE",
    terminalPageChecksum: previousJoinPageChecksum,
  };
};
