import { Schema } from "effect";

import {
  qualificationCorrectnessForestDeadlineMs,
  qualificationCorrectnessLaunchPageSize,
  qualificationCorrectnessPollCount,
  qualificationCorrectnessPollIntervalMs,
  qualificationCorrectnessReducerFanIn,
  qualificationOwnerCorrectnessLevelCounts,
} from "../qualification/owner-partitions";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { qualificationEvaluationMaximumDimensionValues } from "../qualification/qualification-evaluation-reducer";
import type {
  QualificationEvaluationCorrectnessReducerWorkflowPayload,
  QualificationOwnerWorkflowPayload,
} from "../workflow-contracts";
import {
  authenticateQualificationEvaluationCorrectnessReceipt,
  type AuthenticatedQualificationEvaluationCorrectnessReceipt,
} from "./qualification-evaluation-correctness-reducer";
import {
  authenticateQualificationEvaluationLeafJoinPage,
  qualificationEvaluationLeafJoinPageArtifactId,
  qualificationEvaluationLeafJoinPagePrefix,
  type QualificationOwnerLeafFanoutComplete,
} from "./qualification-owner-leaves";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- Cloudflare Workflow, Workflow instance, and R2 APIs are Promise-only durable host boundaries; every loop is bounded by a frozen page/poll limit. */

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const padded = (value: number) => value.toString().padStart(8, "0");

const CorrectnessInputReference = Schema.Struct({ artifactId: Identity, checksum: Identity });
const CorrectnessPayload = Schema.Struct({
  acceptedCount: NonNegativeInteger,
  executionId: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputKind: Schema.Literals(["correctness", "leafCompletion"]),
  inputReceiptChainDigest: Identity,
  inputs: Schema.Array(CorrectnessInputReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationCorrectnessReducerFanIn),
  ),
  lastPartitionIndex: NonNegativeInteger,
  level: PositiveInteger,
  outputArtifactPrefix: Identity,
  planChecksum: Identity,
  rootCount: NonNegativeInteger,
});

export const QualificationCorrectnessLaunchPage = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  firstNodeIndex: NonNegativeInteger,
  lastNodeIndex: NonNegativeInteger,
  level: PositiveInteger,
  pageIndex: NonNegativeInteger,
  payloads: Schema.Array(CorrectnessPayload).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationCorrectnessLaunchPageSize),
  ),
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  version: Schema.Literal("qualification-correctness-launch-page-v1"),
});

const CorrectnessCompletionReference = Schema.Struct({
  acceptedCount: NonNegativeInteger,
  artifactId: Identity,
  checksum: Identity,
  firstPartitionIndex: NonNegativeInteger,
  index: NonNegativeInteger,
  inputReceiptChainDigest: Identity,
  lastPartitionIndex: NonNegativeInteger,
  level: PositiveInteger,
  rootCount: NonNegativeInteger,
  rootReceiptArtifactId: Identity,
  rootReceiptChecksum: Identity,
  summaryArtifactId: Identity,
  summaryChecksum: Identity,
  verdict: Schema.Literals(["FAIL", "MISSING", "PASS"]),
});

export const QualificationCorrectnessCompletionPage = Schema.Struct({
  acceptedCount: NonNegativeInteger,
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  failCount: NonNegativeInteger,
  firstNodeIndex: NonNegativeInteger,
  lastNodeIndex: NonNegativeInteger,
  launchPageChecksum: Identity,
  level: PositiveInteger,
  missingCount: NonNegativeInteger,
  pageIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousPageChecksum: Schema.String,
  references: Schema.Array(CorrectnessCompletionReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(qualificationCorrectnessLaunchPageSize),
  ),
  rootCount: NonNegativeInteger,
  version: Schema.Literal("qualification-correctness-completion-page-v1"),
});

interface QualificationCorrectnessBucket {
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

interface CorrectnessWorkflowInstance {
  readonly id: string;
  readonly status: () => Promise<WorkflowStatus>;
}

interface QualificationCorrectnessEnv {
  readonly ARTIFACTS: QualificationCorrectnessBucket;
  readonly QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW: {
    readonly createBatch: (
      batch: ReadonlyArray<{
        readonly id: string;
        readonly params: QualificationEvaluationCorrectnessReducerWorkflowPayload;
      }>,
    ) => Promise<ReadonlyArray<CorrectnessWorkflowInstance>>;
    readonly get: (id: string) => Promise<CorrectnessWorkflowInstance>;
  };
}

interface QualificationCorrectnessStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

/** Reconcile one ambiguous Workflow create response without exceeding connection limits. */
export const createOrReconcileQualificationWorkflowBatch = async <
  Params,
  Instance extends { readonly id: string },
>(input: {
  readonly batch: ReadonlyArray<{ readonly id: string; readonly params: Params }>;
  readonly createBatch: (
    batch: ReadonlyArray<{ readonly id: string; readonly params: Params }>,
  ) => Promise<ReadonlyArray<Instance>>;
  readonly get: (id: string) => Promise<Instance>;
}): Promise<
  | { readonly instances: ReadonlyArray<Instance>; readonly status: "COMPLETE" }
  | { readonly status: "CONFLICT" }
> => {
  let instances: ReadonlyArray<Instance>;
  try {
    instances = await input.createBatch(input.batch);
  } catch (cause) {
    try {
      const reconciled = new Array<Instance>();
      for (const { id } of input.batch) reconciled.push(await input.get(id));
      instances = reconciled;
    } catch {
      throw cause;
    }
  }
  return instances.length === input.batch.length &&
    instances.every(({ id }, index) => id === input.batch[index]?.id)
    ? { instances, status: "COMPLETE" }
    : { status: "CONFLICT" };
};

export interface QualificationOwnerCorrectnessComplete {
  readonly acceptedCount: number;
  readonly artifactId: string;
  readonly checksum: string;
  readonly levelCount: number;
  readonly rootCount: number;
  readonly rootReceiptArtifactId: string;
  readonly rootReceiptChecksum: string;
  readonly status: "COMPLETE";
  readonly summaryArtifactId: string;
  readonly summaryChecksum: string;
  readonly verdict: "FAIL" | "MISSING" | "PASS";
}

export type QualificationOwnerCorrectnessOutcome =
  | QualificationOwnerCorrectnessComplete
  | { readonly code: string; readonly status: "FAIL" | "MISSING" };

interface InputReference {
  readonly acceptedCount: number;
  readonly artifactId: string;
  readonly checksum: string;
  readonly firstPartitionIndex: number;
  readonly lastPartitionIndex: number;
  readonly rootCount: number;
}

interface LevelDescriptor {
  readonly inputKind: "correctness" | "leafCompletion";
  readonly level: number;
  readonly nodeCount: number;
  readonly pageCount: number;
  readonly terminalLaunchPageChecksum: string;
}

interface SettledLevelDescriptor extends LevelDescriptor {
  readonly terminalCompletionPageChecksum: string;
}

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

const safeSum = (values: ReadonlyArray<number>) => {
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) && sum <= qualificationEvaluationMaximumDimensionValues
    ? sum
    : null;
};

const validReducerPayload = (payload: QualificationEvaluationCorrectnessReducerWorkflowPayload) =>
  payload.acceptedCount <= payload.rootCount &&
  payload.inputs.length > 0 &&
  payload.inputs.length <= qualificationCorrectnessReducerFanIn &&
  new Set(payload.inputs.map(({ checksum }) => checksum)).size === payload.inputs.length &&
  payload.inputReceiptChainDigest ===
    qualificationChecksum(payload.inputs.map(({ checksum }) => checksum)) &&
  ((payload.level === 1 && payload.inputKind === "leafCompletion") ||
    (payload.level > 1 && payload.inputKind === "correctness"));

const correctnessBasePrefix = (executionId: string) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-correctness`;
const levelPrefix = (executionId: string, level: number) =>
  `${correctnessBasePrefix(executionId)}/level-${padded(level)}`;
const launchPagePrefix = (executionId: string, level: number) =>
  `${levelPrefix(executionId, level)}/owner-launch-pages`;
const launchPageArtifactId = (executionId: string, level: number, pageIndex: number) =>
  `${launchPagePrefix(executionId, level)}/${padded(pageIndex)}.json`;
const completionPagePrefix = (executionId: string, level: number) =>
  `${levelPrefix(executionId, level)}/owner-completion-pages`;
const completionPageArtifactId = (executionId: string, level: number, pageIndex: number) =>
  `${completionPagePrefix(executionId, level)}/${padded(pageIndex)}.json`;
const outputPrefix = (executionId: string, level: number, index: number) =>
  `${levelPrefix(executionId, level)}/nodes/${padded(index)}`;
const reducerWorkflowId = (executionId: string, level: number, index: number) =>
  `${executionId}:evaluation-correctness:${level}:${index}`;

const retainImmutable = async (input: {
  readonly artifactId: string;
  readonly bucket: QualificationCorrectnessBucket;
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
    throw new Error(`Retained qualification correctness artifact conflicts: ${input.artifactId}`);
  }
};

const inventoryExactPages = async (input: {
  readonly expectedPageCount: number;
  readonly kind: string;
  readonly prefix: string;
  readonly step: QualificationCorrectnessStep;
  readonly bucket: QualificationCorrectnessBucket;
}): Promise<"COMPLETE" | "FAIL" | "MISSING"> => {
  let cursor: string | undefined;
  let inventoryPage = 0;
  let previousIndex = -1;
  let count = 0;
  do {
    const result = await input.step.do(
      `inventory ${input.kind} page ${inventoryPage}`,
      async () => {
        const options = {
          include: ["customMetadata"] as const,
          limit: 50,
          prefix: `${input.prefix}/`,
        };
        const listed = await input.bucket.list(
          cursor === undefined ? options : { ...options, cursor },
        );
        if (listed.truncated && (listed.cursor === undefined || listed.objects.length === 0)) {
          throw new Error(`Qualification ${input.kind} inventory did not advance`);
        }
        let lastIndex = previousIndex;
        let conflict = false;
        for (const object of listed.objects) {
          const suffix = object.key.slice(input.prefix.length + 1);
          if (!object.key.startsWith(`${input.prefix}/`) || !/^[0-9]{8}\.json$/.test(suffix)) {
            conflict = true;
            continue;
          }
          const index = Number(suffix.slice(0, 8));
          if (index <= lastIndex || index >= input.expectedPageCount) conflict = true;
          lastIndex = index;
        }
        return {
          conflict,
          count: listed.objects.length,
          lastIndex,
          nextCursor: listed.truncated ? listed.cursor : null,
        };
      },
    );
    if (result.conflict) return "FAIL";
    count += result.count;
    previousIndex = result.lastIndex;
    cursor = result.nextCursor ?? undefined;
    inventoryPage += 1;
  } while (cursor !== undefined);
  return count === input.expectedPageCount ? "COMPLETE" : "MISSING";
};

const launchPageMetadata = (
  page: typeof QualificationCorrectnessLaunchPage.Type,
  bodySha256: string,
) => ({
  "osfo-artifact-checksum": page.checksum,
  "osfo-body-sha256": bodySha256,
  "osfo-execution-id": page.executionId,
  "osfo-first-node-index": String(page.firstNodeIndex),
  "osfo-index": String(page.pageIndex),
  "osfo-kind": "qualification-correctness-launch-page-v1",
  "osfo-last-node-index": String(page.lastNodeIndex),
  "osfo-level": String(page.level),
  "osfo-plan-checksum": page.planChecksum,
  "osfo-previous-checksum": page.previousPageChecksum,
  "osfo-record-count": String(page.payloads.length),
});

const retainLaunchPage = async (input: {
  readonly bucket: QualificationCorrectnessBucket;
  readonly executionId: string;
  readonly level: number;
  readonly pageIndex: number;
  readonly payloads: ReadonlyArray<QualificationEvaluationCorrectnessReducerWorkflowPayload>;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
}) => {
  const first = input.payloads[0];
  const last = input.payloads.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.payloads.length > qualificationCorrectnessLaunchPageSize ||
    input.payloads.some(({ index }, offset) => index !== first.index + offset)
  ) {
    throw new Error("Qualification correctness launch page conflicts");
  }
  const artifactId = launchPageArtifactId(input.executionId, input.level, input.pageIndex);
  const content = {
    artifactId,
    executionId: input.executionId,
    firstNodeIndex: first.index,
    lastNodeIndex: last.index,
    level: input.level,
    pageIndex: input.pageIndex,
    payloads: input.payloads,
    planChecksum: input.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    version: "qualification-correctness-launch-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(page);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: launchPageMetadata(page, await sha256Hex(encoded)),
  });
  return page;
};

const readLaunchPage = async (input: {
  readonly bucket: QualificationCorrectnessBucket;
  readonly executionId: string;
  readonly expectedPreviousChecksum: string;
  readonly level: number;
  readonly pageIndex: number;
  readonly planChecksum: string;
}) => {
  const artifactId = launchPageArtifactId(input.executionId, input.level, input.pageIndex);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let page: typeof QualificationCorrectnessLaunchPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationCorrectnessLaunchPage))(encoded);
  } catch {
    return null;
  }
  if (
    !authenticChecksum(page) ||
    page.artifactId !== artifactId ||
    page.executionId !== input.executionId ||
    page.level !== input.level ||
    page.pageIndex !== input.pageIndex ||
    page.planChecksum !== input.planChecksum ||
    page.previousPageChecksum !== input.expectedPreviousChecksum ||
    page.lastNodeIndex !== page.firstNodeIndex + page.payloads.length - 1 ||
    page.payloads.some(
      (payload, offset) =>
        payload.executionId !== input.executionId ||
        payload.index !== page.firstNodeIndex + offset ||
        payload.level !== input.level ||
        payload.planChecksum !== input.planChecksum ||
        payload.outputArtifactPrefix !==
          outputPrefix(input.executionId, input.level, payload.index) ||
        !validReducerPayload(payload) ||
        (offset > 0 &&
          payload.firstPartitionIndex !==
            (page.payloads[offset - 1]?.lastPartitionIndex ?? -2) + 1),
    ) ||
    !exactMetadata(retained.customMetadata, launchPageMetadata(page, await sha256Hex(encoded)))
  ) {
    return null;
  }
  return page;
};

const completionPageMetadata = (
  page: typeof QualificationCorrectnessCompletionPage.Type,
  bodySha256: string,
) => ({
  "osfo-artifact-checksum": page.checksum,
  "osfo-body-sha256": bodySha256,
  "osfo-execution-id": page.executionId,
  "osfo-fail-count": String(page.failCount),
  "osfo-first-node-index": String(page.firstNodeIndex),
  "osfo-index": String(page.pageIndex),
  "osfo-kind": "qualification-correctness-completion-page-v1",
  "osfo-last-node-index": String(page.lastNodeIndex),
  "osfo-launch-page-checksum": page.launchPageChecksum,
  "osfo-level": String(page.level),
  "osfo-missing-count": String(page.missingCount),
  "osfo-plan-checksum": page.planChecksum,
  "osfo-previous-checksum": page.previousPageChecksum,
  "osfo-record-count": String(page.references.length),
});

const retainCompletionPage = async (input: {
  readonly bucket: QualificationCorrectnessBucket;
  readonly executionId: string;
  readonly launchPage: typeof QualificationCorrectnessLaunchPage.Type;
  readonly planChecksum: string;
  readonly previousPageChecksum: string;
  readonly references: ReadonlyArray<AuthenticatedQualificationEvaluationCorrectnessReceipt>;
}) => {
  const acceptedCount = safeSum(input.references.map((reference) => reference.acceptedCount));
  const rootCount = safeSum(input.references.map((reference) => reference.rootCount));
  if (
    acceptedCount === null ||
    rootCount === null ||
    acceptedCount > rootCount ||
    input.references.length !== input.launchPage.payloads.length ||
    input.references.some((reference, offset) => {
      const payload = input.launchPage.payloads[offset];
      return (
        payload === undefined ||
        reference.acceptedCount !== payload.acceptedCount ||
        reference.artifactId !== `${payload.outputArtifactPrefix}/receipt.json` ||
        reference.firstPartitionIndex !== payload.firstPartitionIndex ||
        reference.index !== input.launchPage.firstNodeIndex + offset ||
        reference.inputReceiptChainDigest !== payload.inputReceiptChainDigest ||
        reference.lastPartitionIndex !== payload.lastPartitionIndex ||
        reference.level !== input.launchPage.level ||
        reference.rootCount !== payload.rootCount
      );
    })
  ) {
    throw new Error("Qualification correctness completion counts conflict");
  }
  const pageIndex = input.launchPage.pageIndex;
  const artifactId = completionPageArtifactId(input.executionId, input.launchPage.level, pageIndex);
  const content = {
    acceptedCount,
    artifactId,
    executionId: input.executionId,
    failCount: input.references.filter(({ verdict }) => verdict === "FAIL").length,
    firstNodeIndex: input.launchPage.firstNodeIndex,
    lastNodeIndex: input.launchPage.lastNodeIndex,
    launchPageChecksum: input.launchPage.checksum,
    level: input.launchPage.level,
    missingCount: input.references.filter(({ verdict }) => verdict === "MISSING").length,
    pageIndex,
    planChecksum: input.planChecksum,
    previousPageChecksum: input.previousPageChecksum,
    references: input.references,
    rootCount,
    version: "qualification-correctness-completion-page-v1" as const,
  };
  const page = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(page);
  await retainImmutable({
    artifactId,
    bucket: input.bucket,
    encoded,
    metadata: completionPageMetadata(page, await sha256Hex(encoded)),
  });
  return page;
};

const readCompletionPage = async (input: {
  readonly bucket: QualificationCorrectnessBucket;
  readonly executionId: string;
  readonly expectedPreviousChecksum: string;
  readonly level: number;
  readonly pageIndex: number;
  readonly planChecksum: string;
}) => {
  const artifactId = completionPageArtifactId(input.executionId, input.level, input.pageIndex);
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return null;
  const encoded = await retained.text();
  let page: typeof QualificationCorrectnessCompletionPage.Type;
  try {
    page = Schema.decodeSync(Schema.fromJsonString(QualificationCorrectnessCompletionPage))(
      encoded,
    );
  } catch {
    return null;
  }
  const acceptedCount = safeSum(page.references.map(({ acceptedCount: count }) => count));
  const rootCount = safeSum(page.references.map(({ rootCount: count }) => count));
  if (
    !authenticChecksum(page) ||
    page.artifactId !== artifactId ||
    page.executionId !== input.executionId ||
    page.level !== input.level ||
    page.pageIndex !== input.pageIndex ||
    page.planChecksum !== input.planChecksum ||
    page.previousPageChecksum !== input.expectedPreviousChecksum ||
    page.lastNodeIndex !== page.firstNodeIndex + page.references.length - 1 ||
    page.references.some(
      (reference, offset) =>
        reference.index !== page.firstNodeIndex + offset ||
        reference.level !== input.level ||
        (offset > 0 &&
          reference.firstPartitionIndex !==
            (page.references[offset - 1]?.lastPartitionIndex ?? -2) + 1),
    ) ||
    new Set(page.references.map(({ checksum }) => checksum)).size !== page.references.length ||
    acceptedCount === null ||
    rootCount === null ||
    page.acceptedCount !== acceptedCount ||
    page.rootCount !== rootCount ||
    page.failCount !== page.references.filter(({ verdict }) => verdict === "FAIL").length ||
    page.missingCount !== page.references.filter(({ verdict }) => verdict === "MISSING").length ||
    !exactMetadata(retained.customMetadata, completionPageMetadata(page, await sha256Hex(encoded)))
  ) {
    return null;
  }
  return page;
};

const payloadFromReferences = (input: {
  readonly executionId: string;
  readonly index: number;
  readonly inputKind: "correctness" | "leafCompletion";
  readonly level: number;
  readonly planChecksum: string;
  readonly references: ReadonlyArray<InputReference>;
}): QualificationEvaluationCorrectnessReducerWorkflowPayload => {
  const first = input.references[0];
  const last = input.references.at(-1);
  const acceptedCount = safeSum(input.references.map(({ acceptedCount: count }) => count));
  const rootCount = safeSum(input.references.map(({ rootCount: count }) => count));
  if (
    first === undefined ||
    last === undefined ||
    input.references.length > qualificationCorrectnessReducerFanIn ||
    acceptedCount === null ||
    rootCount === null ||
    acceptedCount > rootCount ||
    new Set(input.references.map(({ checksum }) => checksum)).size !== input.references.length ||
    input.references.some(
      ({ firstPartitionIndex }, index) =>
        index > 0 &&
        firstPartitionIndex !== (input.references[index - 1]?.lastPartitionIndex ?? -2) + 1,
    )
  ) {
    throw new Error("Qualification correctness input range conflicts");
  }
  const inputs = input.references.map(({ artifactId, checksum }) => ({ artifactId, checksum }));
  return {
    acceptedCount,
    executionId: input.executionId,
    firstPartitionIndex: first.firstPartitionIndex,
    index: input.index,
    inputKind: input.inputKind,
    inputReceiptChainDigest: qualificationChecksum(inputs.map(({ checksum }) => checksum)),
    inputs,
    lastPartitionIndex: last.lastPartitionIndex,
    level: input.level,
    outputArtifactPrefix: outputPrefix(input.executionId, input.level, input.index),
    planChecksum: input.planChecksum,
    rootCount,
  };
};

const buildLevelLaunchPages = async (input: {
  readonly env: QualificationCorrectnessEnv;
  readonly executionId: string;
  readonly inputKind: "correctness" | "leafCompletion";
  readonly leaf: QualificationOwnerLeafFanoutComplete;
  readonly level: number;
  readonly payload: QualificationOwnerWorkflowPayload;
  readonly previous?: SettledLevelDescriptor;
  readonly step: QualificationCorrectnessStep;
}): Promise<LevelDescriptor | null> => {
  const sourcePageCount =
    input.inputKind === "leafCompletion" ? input.leaf.pageCount : (input.previous?.pageCount ?? 0);
  let sourcePreviousChecksum = "NONE";
  let sourcePreviousLaunchChecksum = "NONE";
  let sourceExpectedFirstPartitionIndex = 0;
  let nodeIndex = 0;
  let launchPageIndex = 0;
  let launchPreviousChecksum = "NONE";
  let referenceBuffer = new Array<InputReference>();
  let payloadBuffer = new Array<QualificationEvaluationCorrectnessReducerWorkflowPayload>();

  const flushLaunchPage = async () => {
    if (payloadBuffer.length === 0) return;
    const payloads = payloadBuffer;
    const page = await input.step.do(
      `retain correctness level ${input.level} launch page ${launchPageIndex}`,
      () =>
        retainLaunchPage({
          bucket: input.env.ARTIFACTS,
          executionId: input.executionId,
          level: input.level,
          pageIndex: launchPageIndex,
          payloads,
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
    payloadBuffer.push(
      payloadFromReferences({
        executionId: input.executionId,
        index: nodeIndex,
        inputKind: input.inputKind,
        level: input.level,
        planChecksum: input.payload.planChecksum,
        references: referenceBuffer,
      }),
    );
    nodeIndex += 1;
    referenceBuffer = [];
    if (payloadBuffer.length === qualificationCorrectnessLaunchPageSize) await flushLaunchPage();
  };

  for (let pageIndex = 0; pageIndex < sourcePageCount; pageIndex += 1) {
    const source = await input.step.do(
      `read correctness level ${input.level} input page ${pageIndex}`,
      async () => {
        if (input.inputKind === "leafCompletion") {
          return authenticateQualificationEvaluationLeafJoinPage({
            bucket: input.env.ARTIFACTS,
            expectedPreviousChecksum: sourcePreviousChecksum,
            pageIndex,
            payload: input.payload,
          });
        }
        return readCompletionPage({
          bucket: input.env.ARTIFACTS,
          executionId: input.executionId,
          expectedPreviousChecksum: sourcePreviousChecksum,
          level: input.level - 1,
          pageIndex,
          planChecksum: input.payload.planChecksum,
        });
      },
    );
    if (source === null) return null;
    if (source.version === "qualification-correctness-completion-page-v1") {
      const priorLaunch = await input.step.do(
        `authenticate correctness level ${input.level - 1} source launch page ${pageIndex}`,
        () =>
          readLaunchPage({
            bucket: input.env.ARTIFACTS,
            executionId: input.executionId,
            expectedPreviousChecksum: sourcePreviousLaunchChecksum,
            level: input.level - 1,
            pageIndex,
            planChecksum: input.payload.planChecksum,
          }),
      );
      if (
        priorLaunch === null ||
        priorLaunch.checksum !== source.launchPageChecksum ||
        source.references.length !== priorLaunch.payloads.length ||
        source.references.some((reference, offset) => {
          const payload = priorLaunch.payloads[offset];
          return (
            payload === undefined ||
            reference.acceptedCount !== payload.acceptedCount ||
            reference.artifactId !== `${payload.outputArtifactPrefix}/receipt.json` ||
            reference.firstPartitionIndex !== payload.firstPartitionIndex ||
            reference.index !== payload.index ||
            reference.inputReceiptChainDigest !== payload.inputReceiptChainDigest ||
            reference.lastPartitionIndex !== payload.lastPartitionIndex ||
            reference.rootCount !== payload.rootCount
          );
        })
      ) {
        return null;
      }
      sourcePreviousLaunchChecksum = priorLaunch.checksum;
    }
    sourcePreviousChecksum = source.checksum;
    const references: ReadonlyArray<InputReference> =
      source.version === "qualification-evaluation-leaf-completion-page-v1"
        ? source.references.map((reference) => ({
            acceptedCount: reference.acceptedCount,
            artifactId: reference.artifactId,
            checksum: reference.checksum,
            firstPartitionIndex: reference.partitionIndex,
            lastPartitionIndex: reference.partitionIndex,
            rootCount: reference.rootCount,
          }))
        : source.references.map((reference) => ({
            acceptedCount: reference.acceptedCount,
            artifactId: reference.artifactId,
            checksum: reference.checksum,
            firstPartitionIndex: reference.firstPartitionIndex,
            lastPartitionIndex: reference.lastPartitionIndex,
            rootCount: reference.rootCount,
          }));
    const firstReference = references[0];
    const lastReference = references.at(-1);
    if (
      firstReference === undefined ||
      lastReference === undefined ||
      firstReference.firstPartitionIndex !== sourceExpectedFirstPartitionIndex
    ) {
      return null;
    }
    sourceExpectedFirstPartitionIndex = lastReference.lastPartitionIndex + 1;
    for (const reference of references) {
      referenceBuffer.push(reference);
      if (referenceBuffer.length === qualificationCorrectnessReducerFanIn) await flushNode();
    }
  }
  await flushNode();
  await flushLaunchPage();
  const expectedNodeCount = qualificationOwnerCorrectnessLevelCounts(
    input.inputKind === "leafCompletion"
      ? input.leaf.completionCount
      : (input.previous?.nodeCount ?? 0),
  )[0];
  if (
    expectedNodeCount === undefined ||
    nodeIndex !== expectedNodeCount ||
    (input.inputKind === "leafCompletion"
      ? sourcePreviousChecksum !== input.leaf.terminalPageChecksum
      : sourcePreviousChecksum !== input.previous?.terminalCompletionPageChecksum ||
        sourcePreviousLaunchChecksum !== input.previous?.terminalLaunchPageChecksum) ||
    sourceExpectedFirstPartitionIndex !== input.leaf.completionCount
  ) {
    return null;
  }
  return {
    inputKind: input.inputKind,
    level: input.level,
    nodeCount: nodeIndex,
    pageCount: launchPageIndex,
    terminalLaunchPageChecksum: launchPreviousChecksum,
  };
};

const readExpectedReceipt = async (input: {
  readonly bucket: QualificationCorrectnessBucket;
  readonly payload: QualificationEvaluationCorrectnessReducerWorkflowPayload;
}) => {
  const artifactId = `${input.payload.outputArtifactPrefix}/receipt.json`;
  const retained = await input.bucket.get(artifactId);
  if (retained === null) return { status: "MISSING" as const };
  const receipt = await authenticateQualificationEvaluationCorrectnessReceipt({
    bucket: input.bucket,
    executionId: input.payload.executionId,
    expectedLevel: input.payload.level,
    planChecksum: input.payload.planChecksum,
    reference: {
      artifactId,
      checksum: retained.customMetadata?.["osfo-artifact-checksum"] ?? "MISSING",
    },
  });
  if (
    receipt === null ||
    receipt.index !== input.payload.index ||
    receipt.firstPartitionIndex !== input.payload.firstPartitionIndex ||
    receipt.lastPartitionIndex !== input.payload.lastPartitionIndex ||
    receipt.acceptedCount !== input.payload.acceptedCount ||
    receipt.rootCount !== input.payload.rootCount ||
    receipt.inputReceiptChainDigest !== input.payload.inputReceiptChainDigest
  ) {
    return { status: "FAIL" as const };
  }
  return { receipt, status: "COMPLETE" as const };
};

const launchAndSettleLevel = async (input: {
  readonly deadlineEpochMs: number;
  readonly env: QualificationCorrectnessEnv;
  readonly launchSequenceStart: number;
  readonly level: LevelDescriptor;
  readonly payload: QualificationOwnerWorkflowPayload;
  readonly step: QualificationCorrectnessStep;
}): Promise<
  | {
      readonly launchSequence: number;
      readonly level: SettledLevelDescriptor;
      readonly status: "COMPLETE";
    }
  | { readonly code: string; readonly status: "FAIL" | "MISSING" }
> => {
  const inventory = await inventoryExactPages({
    bucket: input.env.ARTIFACTS,
    expectedPageCount: input.level.pageCount,
    kind: `correctness level ${input.level.level} launch`,
    prefix: launchPagePrefix(input.payload.executionId, input.level.level),
    step: input.step,
  });
  if (inventory !== "COMPLETE") {
    return { code: "qualificationCorrectnessLaunchMaterial", status: inventory };
  }
  let previousLaunchChecksum = "NONE";
  let launchSequence = input.launchSequenceStart;
  for (let pageIndex = 0; pageIndex < input.level.pageCount; pageIndex += 1) {
    const launched = await input.step.do(
      `launch correctness level ${input.level.level} page ${pageIndex}`,
      async () => {
        const page = await readLaunchPage({
          bucket: input.env.ARTIFACTS,
          executionId: input.payload.executionId,
          expectedPreviousChecksum: previousLaunchChecksum,
          level: input.level.level,
          pageIndex,
          planChecksum: input.payload.planChecksum,
        });
        if (page === null) return { conflict: true as const };
        const batch = page.payloads.map((params) => ({
          id: reducerWorkflowId(input.payload.executionId, input.level.level, params.index),
          params,
        }));
        const created = await createOrReconcileQualificationWorkflowBatch({
          batch,
          createBatch:
            input.env.QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW.createBatch.bind(
              input.env.QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW,
            ),
          get: input.env.QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW.get.bind(
            input.env.QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW,
          ),
        });
        if (created.status === "CONFLICT") {
          return { conflict: true as const };
        }
        // oxlint-disable-next-line effecttsgo/global-date -- This Workflow step durably captures the successful launch time.
        return { conflict: false as const, launchedAtEpochMs: Date.now(), page };
      },
    );
    if (launched.conflict) {
      return { code: "qualificationCorrectnessLaunchConflict", status: "FAIL" };
    }
    previousLaunchChecksum = launched.page.checksum;
    launchSequence += 1;
    if (pageIndex + 1 < input.level.pageCount) {
      await input.step.sleepUntil(
        `rate limit correctness level ${input.level.level} launch page ${pageIndex + 1}`,
        launched.launchedAtEpochMs + 1_000,
      );
    }
  }
  if (previousLaunchChecksum !== input.level.terminalLaunchPageChecksum) {
    return { code: "qualificationCorrectnessLaunchTerminal", status: "FAIL" };
  }

  let previousCompletionChecksum = "NONE";
  let settlePreviousLaunchChecksum = "NONE";
  for (let pageIndex = 0; pageIndex < input.level.pageCount; pageIndex += 1) {
    const launchPage = await input.step.do(
      `read correctness level ${input.level.level} launched page ${pageIndex}`,
      () =>
        readLaunchPage({
          bucket: input.env.ARTIFACTS,
          executionId: input.payload.executionId,
          expectedPreviousChecksum: settlePreviousLaunchChecksum,
          level: input.level.level,
          pageIndex,
          planChecksum: input.payload.planChecksum,
        }),
    );
    if (launchPage === null) {
      return { code: "qualificationCorrectnessLaunchBody", status: "FAIL" };
    }
    settlePreviousLaunchChecksum = launchPage.checksum;
    let completed = false;
    for (let attempt = 0; attempt < qualificationCorrectnessPollCount; attempt += 1) {
      const statuses = await input.step.do(
        `poll correctness level ${input.level.level} page ${pageIndex} attempt ${attempt + 1}`,
        async () => {
          const values = new Array<WorkflowStatus>();
          for (const payload of launchPage.payloads) {
            const id = reducerWorkflowId(
              input.payload.executionId,
              input.level.level,
              payload.index,
            );
            const instance =
              await input.env.QUALIFICATION_EVALUATION_CORRECTNESS_REDUCER_WORKFLOW.get(id);
            if (instance.id !== id) throw new Error("Qualification correctness instance conflicts");
            values.push(await instance.status());
          }
          // oxlint-disable-next-line effecttsgo/global-date -- The Workflow step captures one replay-stable poll timestamp.
          return { capturedAtEpochMs: Date.now(), values };
        },
      );
      if (statuses.values.some(({ status }) => status === "errored" || status === "terminated")) {
        return { code: "qualificationCorrectnessWorkflowFailed", status: "FAIL" };
      }
      if (statuses.values.every(({ status }) => status === "complete")) {
        completed = true;
        break;
      }
      if (
        statuses.capturedAtEpochMs >= input.deadlineEpochMs ||
        attempt + 1 === qualificationCorrectnessPollCount
      ) {
        return { code: "qualificationCorrectnessWorkflowUnsettled", status: "MISSING" };
      }
      await input.step.sleepUntil(
        `wait correctness level ${input.level.level} page ${pageIndex} attempt ${attempt + 1}`,
        Math.min(
          statuses.capturedAtEpochMs + qualificationCorrectnessPollIntervalMs,
          input.deadlineEpochMs,
        ),
      );
    }
    if (!completed) {
      return { code: "qualificationCorrectnessWorkflowUnsettled", status: "MISSING" };
    }
    const joined = await input.step.do(
      `join correctness level ${input.level.level} page ${pageIndex}`,
      async () => {
        const references = new Array<AuthenticatedQualificationEvaluationCorrectnessReceipt>();
        for (const payload of launchPage.payloads) {
          const result = await readExpectedReceipt({ bucket: input.env.ARTIFACTS, payload });
          if (result.status !== "COMPLETE") return result;
          references.push(result.receipt);
        }
        const page = await retainCompletionPage({
          bucket: input.env.ARTIFACTS,
          executionId: input.payload.executionId,
          launchPage,
          planChecksum: input.payload.planChecksum,
          previousPageChecksum: previousCompletionChecksum,
          references,
        });
        return { page, status: "COMPLETE" as const };
      },
    );
    if (joined.status !== "COMPLETE") {
      return { code: "qualificationCorrectnessReceiptMaterial", status: joined.status };
    }
    previousCompletionChecksum = joined.page.checksum;
  }
  return {
    launchSequence,
    level: {
      ...input.level,
      terminalCompletionPageChecksum: previousCompletionChecksum,
    },
    status: "COMPLETE",
  };
};

/** Build and authenticate the fan-in-16 correctness forest without materializing the corpus. */
export const runQualificationOwnerCorrectnessForest = async (input: {
  readonly env: QualificationCorrectnessEnv;
  readonly leaf: QualificationOwnerLeafFanoutComplete;
  readonly payload: QualificationOwnerWorkflowPayload;
  readonly step: QualificationCorrectnessStep;
}): Promise<QualificationOwnerCorrectnessOutcome> => {
  if (
    !Number.isSafeInteger(input.leaf.completionCount) ||
    input.leaf.completionCount <= 0 ||
    !Number.isSafeInteger(input.leaf.pageCount) ||
    input.leaf.pageCount <= 0 ||
    !Number.isSafeInteger(input.leaf.rootCount) ||
    input.leaf.rootCount < 0 ||
    !Number.isSafeInteger(input.leaf.acceptedCount) ||
    input.leaf.acceptedCount < 0 ||
    input.leaf.acceptedCount > input.leaf.rootCount
  ) {
    return { code: "qualificationEvaluationLeafDescriptor", status: "FAIL" };
  }
  if (input.leaf.missingCompletionCount > 0) {
    return { code: "qualificationEvaluationLeafCompletions", status: "MISSING" };
  }
  const leafInventory = await inventoryExactPages({
    bucket: input.env.ARTIFACTS,
    expectedPageCount: input.leaf.pageCount,
    kind: "evaluation leaf join",
    prefix: qualificationEvaluationLeafJoinPagePrefix(input.payload.executionId),
    step: input.step,
  });
  if (leafInventory !== "COMPLETE") {
    return { code: "qualificationEvaluationLeafJoinMaterial", status: leafInventory };
  }
  let previousLeafChecksum = "NONE";
  let expectedLeafPartitionIndex = 0;
  let acceptedCount = 0;
  let completeOutcomeCount = 0;
  let failOutcomeCount = 0;
  let missingCompletionCount = 0;
  let outcomeMissingCount = 0;
  let completionCount = 0;
  let rootCount = 0;
  for (let pageIndex = 0; pageIndex < input.leaf.pageCount; pageIndex += 1) {
    const page = await input.step.do(`authenticate evaluation leaf join page ${pageIndex}`, () =>
      authenticateQualificationEvaluationLeafJoinPage({
        bucket: input.env.ARTIFACTS,
        expectedPreviousChecksum: previousLeafChecksum,
        pageIndex,
        payload: input.payload,
      }),
    );
    if (page === null) {
      const retained = await input.env.ARTIFACTS.get(
        qualificationEvaluationLeafJoinPageArtifactId(input.payload.executionId, pageIndex),
      );
      return {
        code: "qualificationEvaluationLeafJoinMaterial",
        status: retained === null ? "MISSING" : "FAIL",
      };
    }
    if (page.expectedFirstPartitionIndex !== expectedLeafPartitionIndex) {
      return { code: "qualificationEvaluationLeafJoinRange", status: "FAIL" };
    }
    expectedLeafPartitionIndex = page.expectedLastPartitionIndex + 1;
    previousLeafChecksum = page.checksum;
    acceptedCount += page.acceptedCount;
    completeOutcomeCount += page.completeOutcomeCount;
    failOutcomeCount += page.failOutcomeCount;
    missingCompletionCount += page.missingCompletionCount;
    outcomeMissingCount += page.outcomeMissingCount;
    completionCount += page.references.length;
    rootCount += page.rootCount;
  }
  if (
    previousLeafChecksum !== input.leaf.terminalPageChecksum ||
    expectedLeafPartitionIndex !== input.leaf.completionCount ||
    ![
      acceptedCount,
      completeOutcomeCount,
      failOutcomeCount,
      missingCompletionCount,
      outcomeMissingCount,
      completionCount,
      rootCount,
    ].every(Number.isSafeInteger) ||
    completionCount !== input.leaf.completionCount ||
    acceptedCount !== input.leaf.acceptedCount ||
    completeOutcomeCount !== input.leaf.completeOutcomeCount ||
    failOutcomeCount !== input.leaf.failOutcomeCount ||
    outcomeMissingCount !== input.leaf.outcomeMissingCount ||
    rootCount !== input.leaf.rootCount
  ) {
    return { code: "qualificationEvaluationLeafJoinTerminal", status: "FAIL" };
  }
  if (missingCompletionCount > 0) {
    return { code: "qualificationEvaluationLeafCompletions", status: "MISSING" };
  }

  const forestStartedAtEpochMs = await input.step.do("capture correctness forest start", () =>
    // oxlint-disable-next-line effecttsgo/global-date -- The Workflow step durably captures the forest deadline origin.
    Promise.resolve(Date.now()),
  );
  const deadlineEpochMs = forestStartedAtEpochMs + qualificationCorrectnessForestDeadlineMs;
  const levelCounts = qualificationOwnerCorrectnessLevelCounts(input.leaf.completionCount);
  let previous: SettledLevelDescriptor | undefined;
  let launchSequence = 0;
  for (const [levelOffset, expectedNodeCount] of levelCounts.entries()) {
    const level = levelOffset + 1;
    if (previous !== undefined) {
      const priorCompletionInventory = await inventoryExactPages({
        bucket: input.env.ARTIFACTS,
        expectedPageCount: previous.pageCount,
        kind: `correctness level ${previous.level} completion`,
        prefix: completionPagePrefix(input.payload.executionId, previous.level),
        step: input.step,
      });
      if (priorCompletionInventory !== "COMPLETE") {
        return {
          code: "qualificationCorrectnessCompletionMaterial",
          status: priorCompletionInventory,
        };
      }
    }
    const buildInput = {
      env: input.env,
      executionId: input.payload.executionId,
      inputKind: level === 1 ? "leafCompletion" : "correctness",
      leaf: input.leaf,
      level,
      payload: input.payload,
      step: input.step,
    } as const;
    const built = await buildLevelLaunchPages(
      previous === undefined ? buildInput : { ...buildInput, previous },
    );
    if (built === null || built.nodeCount !== expectedNodeCount) {
      return { code: "qualificationCorrectnessLevelInputs", status: "FAIL" };
    }
    const settled = await launchAndSettleLevel({
      deadlineEpochMs,
      env: input.env,
      launchSequenceStart: launchSequence,
      level: built,
      payload: input.payload,
      step: input.step,
    });
    if (settled.status !== "COMPLETE") return settled;
    launchSequence = settled.launchSequence;
    previous = settled.level;
  }
  if (previous === undefined || previous.nodeCount !== 1 || previous.pageCount !== 1) {
    return { code: "qualificationCorrectnessRootTopology", status: "FAIL" };
  }
  const rootPage = await input.step.do("authenticate correctness forest root", () =>
    readCompletionPage({
      bucket: input.env.ARTIFACTS,
      executionId: input.payload.executionId,
      expectedPreviousChecksum: "NONE",
      level: previous.level,
      pageIndex: 0,
      planChecksum: input.payload.planChecksum,
    }),
  );
  const root = rootPage?.references[0];
  if (rootPage === null || root === undefined || rootPage.references.length !== 1) {
    return { code: "qualificationCorrectnessRootReceipt", status: "FAIL" };
  }
  const authenticatedRoot = await input.step.do("reauthenticate correctness forest root", () =>
    authenticateQualificationEvaluationCorrectnessReceipt({
      bucket: input.env.ARTIFACTS,
      executionId: input.payload.executionId,
      expectedLevel: previous.level,
      planChecksum: input.payload.planChecksum,
      reference: { artifactId: root.artifactId, checksum: root.checksum },
    }),
  );
  if (
    authenticatedRoot === null ||
    canonicalQualificationJson(authenticatedRoot) !== canonicalQualificationJson(root)
  ) {
    return { code: "qualificationCorrectnessRootReceipt", status: "FAIL" };
  }
  return {
    acceptedCount: root.acceptedCount,
    artifactId: root.artifactId,
    checksum: root.checksum,
    levelCount: levelCounts.length,
    rootCount: root.rootCount,
    rootReceiptArtifactId: root.rootReceiptArtifactId,
    rootReceiptChecksum: root.rootReceiptChecksum,
    status: "COMPLETE",
    summaryArtifactId: root.summaryArtifactId,
    summaryChecksum: root.summaryChecksum,
    verdict: root.verdict,
  };
};
