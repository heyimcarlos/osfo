import { Option, Schema } from "effect";

import type { ProductionQualificationManifest } from "./qualification-manifest";
import type { QualificationExecutionRun } from "./execution";
import {
  qualificationAuthoritySources,
  type QualificationAuthoritySource,
} from "./authority-sources";
import {
  QualificationEvaluationLeafInputReceipt,
  QualificationEvaluationSortedRunReceipt,
  QualificationEvaluationSortedRunShard,
  type QualificationEvaluationArtifactBucket,
  qualificationEvaluationSortedRunReceipt,
  qualificationEvaluationSortedRunShard,
  qualificationEvaluationFindingExemplarLimit,
  qualificationEvaluationGlobalSortedDimensions,
  retainQualificationEvaluationArtifact,
} from "./qualification-evaluation-reducer";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import { QualificationAdmissionReceipt } from "./qualification-attempt";
import { FaultControllerReceiptBoundary } from "./qualification-runs";
import {
  LocalProductEvidenceBoundary,
  ProductAuthorityExportBoundary,
  R2ObjectEvidenceBoundary,
  productEvidenceFromAuthorityExport,
  type ProductAuthorityEvidence,
} from "./semantic-evidence";
import {
  isMeasuredStageLane,
  qualificationStageDimensions,
  stageApplicableJourneys,
  stageAuthorityComponents,
} from "./stage-evidence";
import type { QualificationFinding, QualificationVerdict } from "./verdict";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop -- R2 is a Promise-native host boundary and leaf bodies are read in frozen source order. */

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000));
const DecimalCount = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const qualificationEvaluationLeafRootLimit = 256;
// One root can contribute source, component, correlation, stage, and global-identity findings.
// The evaluator's closed loops remain below this bound; retaining more indicates a contract bug.
export const qualificationEvaluationLeafMaximumFindingsPerRoot = 128;
export const qualificationEvaluationLeafMaximumFindingShardCount =
  qualificationEvaluationLeafMaximumFindingsPerRoot;

const ReferenceJourney = Schema.Literals([
  "accountBillingSafetyDataRights",
  "documentBuild",
  "fileAnalysis",
  "gmail",
  "ordinaryConversation",
  "registration",
  "reminder",
  "researchReport",
  "scheduledEmail",
]);

const ArrivalRecord = Schema.Struct({
  admissionReceipt: QualificationAdmissionReceipt,
  arrival: Schema.Struct({
    journey: ReferenceJourney,
    offeredAtEpochMs: Schema.Finite,
    plan: Schema.Literals(["adventurer", "free"]),
    rootId: Identity,
  }),
  attemptId: Identity,
  authorityFactId: Identity,
  executedAtUtc: Identity,
  executionId: Identity,
  rootId: Identity,
  submittedAtUtc: Identity,
});

export const QualificationEvaluationArrivalShard = Schema.Struct({
  bodyChecksum: Identity,
  chunkIndex: NonNegativeInteger,
  executionId: Identity,
  planChecksum: Identity,
  previousArtifactChecksum: Schema.String,
  records: Schema.Array(ArrivalRecord).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  runId: Identity,
  streamChunkIndex: NonNegativeInteger,
});

export const QualificationEvaluationAuthorityShard = Schema.Struct({
  artifactId: Identity,
  authority: Schema.Literals(qualificationAuthoritySources),
  checksum: Identity,
  executionId: Identity,
  exportedAtUtc: Identity,
  index: Schema.Literal(0),
  planChecksum: Identity,
  previousArtifactChecksum: Schema.Literal("NONE"),
  recordCount: NonNegativeInteger,
  records: Schema.Array(Schema.Unknown),
  sourceVersion: Identity,
  streamChunkIndex: NonNegativeInteger,
});

const StageOccurrence = Schema.Struct({
  boundary: Schema.Literals([
    "deliveryAttemptStarted",
    "durableAcceptanceCommitted",
    "followUpAccepted",
    "meaningfulUpdateCommitted",
    "messageObserved",
    "protectedSendStarted",
    "scheduledEmailDue",
    "scheduledEmailOutcomeCommitted",
    "scheduledTaskDue",
    "scheduledTaskHandlerStarted",
    "scheduledTaskSubmissionAccepted",
    "workflowMilestoneCommitted",
    "workflowOutcomeCommitted",
    "workflowStarted",
    "workflowWakeDue",
  ]),
  occurredAt: Identity,
  productFactId: Identity,
});
const BillingAuthorityRecord = Schema.TaggedStruct("BillingFact", {
  record: Schema.Struct({
    basis: Schema.Literals(["conservative", "known_at_start", "observed", "provenNoUse"]),
    occurredAt: Identity,
    quantity: Schema.BigInt,
    rootId: Identity,
    sourceId: Identity,
  }),
});
const BillingLocalAuthorityRecord = Schema.TaggedStruct("LocalEvidence", {
  evidence: Schema.Struct({
    acceptanceReceiptId: Identity,
    allowanceConsumptionId: Identity,
    authority: Schema.Literal("allowance_usage"),
    evidenceId: Identity,
    occurredAt: Identity,
    productFactId: Identity,
    store: Schema.Literal("PostgreSQL"),
  }),
});
const LeafFinding = Schema.Struct({
  code: Identity,
  detail: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  subject: Identity,
  verdict: Schema.Literals(["FAIL", "MISSING"]),
});

export const QualificationEvaluationLeafValueShard = QualificationEvaluationSortedRunShard;

export const QualificationEvaluationLeafFindingShard = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  findings: Schema.Array(LeafFinding).check(Schema.isMaxLength(256)),
  index: NonNegativeInteger,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  previousShardChecksum: Schema.String,
  version: Schema.Literal("qualification-evaluation-leaf-findings-v1"),
});

export const QualificationEvaluationLeafRootAccumulator = Schema.Struct({
  acceptedCount: DecimalCount,
  artifactId: Identity,
  checksum: Identity,
  executionId: Identity,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  rootCount: DecimalCount,
  roots: Schema.Array(
    Schema.Struct({
      activation: Schema.NullOr(
        Schema.Struct({
          activationId: Identity,
          cause: Schema.Literals([
            "deployment",
            "faultRecovery",
            "firstUse",
            "idleEviction",
            "warm",
          ]),
          classification: Schema.Literals(["cold", "warm"]),
          region: Schema.Literals(["americas", "asiaPacific", "europe"]),
        }),
      ),
      correlations: Schema.Array(Schema.Struct({ kind: Identity, value: Identity })),
      decision: Schema.Literals(["accepted", "capacityRejected", "typedStressRejected"]),
      journey: ReferenceJourney,
      plan: Schema.Literals(["adventurer", "free"]),
      productFactChecksum: Identity,
      productFactCount: DecimalCount,
      rootId: Identity,
      terminalState: Schema.Literals(["failed", "missing", "succeeded", "typedRejected"]),
    }),
  ).check(Schema.isMaxLength(256)),
  version: Schema.Literal("qualification-evaluation-leaf-roots-v1"),
});

const LeafDimensionReceipt = QualificationEvaluationSortedRunReceipt;

export const QualificationEvaluationLeafReceipt = Schema.Struct({
  artifactId: Identity,
  checksum: Identity,
  dimensions: Schema.Array(LeafDimensionReceipt),
  executionId: Identity,
  failCount: DecimalCount,
  findingExemplars: Schema.Array(LeafFinding).check(
    Schema.isMaxLength(qualificationEvaluationFindingExemplarLimit),
  ),
  findingFirstShardChecksum: Schema.String,
  findingShardCount: DecimalCount,
  findingShardPrefix: Identity,
  findingTerminalShardChecksum: Schema.String,
  leafInputChecksum: Identity,
  missingCount: DecimalCount,
  partitionIndex: NonNegativeInteger,
  planChecksum: Identity,
  rootAccumulatorChecksum: Identity,
  rootAccumulatorId: Identity,
  rootCount: DecimalCount,
  streamChunkIndex: NonNegativeInteger,
  verdict: Schema.Literals(["PASS", "FAIL", "MISSING"]),
  version: Schema.Literal("qualification-evaluation-leaf-v1"),
});

const QualificationEvaluationLeafFailureCode = Schema.Literals([
  "qualificationEvaluationArrivalConflict",
  "qualificationEvaluationAuthorityConflict",
  "qualificationEvaluationLeafInputConflict",
  "qualificationEvaluationOwnerRequestConflict",
  "qualificationEvaluationOutputConflict",
]);
const QualificationEvaluationLeafMissingCode = Schema.Literals([
  "qualificationEvaluationArrivalMissing",
  "qualificationEvaluationAuthorityMissing",
  "qualificationEvaluationLeafInputMissing",
  "qualificationEvaluationOwnerRequestMissing",
]);

/** Closed material outcome retained by the bounded leaf-evaluation Workflow. */
export const QualificationEvaluationLeafOutcome = Schema.Union([
  Schema.Struct({
    receipt: QualificationEvaluationLeafReceipt,
    status: Schema.Literal("COMPLETE"),
  }),
  Schema.Struct({
    artifactId: Identity,
    code: QualificationEvaluationLeafFailureCode,
    source: Schema.NullOr(Schema.Literals(qualificationAuthoritySources)),
    status: Schema.Literal("FAIL"),
  }),
  Schema.Struct({
    artifactId: Identity,
    code: QualificationEvaluationLeafMissingCode,
    source: Schema.NullOr(Schema.Literals(qualificationAuthoritySources)),
    status: Schema.Literal("MISSING"),
  }),
]);

export type QualificationEvaluationLeafOutcome = typeof QualificationEvaluationLeafOutcome.Type;

export type QualificationEvaluationLeafBucket = QualificationEvaluationArtifactBucket;

interface NormalizedAuthorityRecord {
  readonly acceptanceReceiptId: string | null;
  readonly activationCause:
    | "deployment"
    | "faultRecovery"
    | "firstUse"
    | "idleEviction"
    | "warm"
    | null;
  readonly activation: ProductAuthorityEvidence["activation"];
  readonly componentEvidence: boolean;
  readonly correlations: ProductAuthorityEvidence["correlations"];
  readonly effects: ReadonlyArray<{
    readonly effectId: string;
    readonly kind: "providerEffects" | "thinkSubmissions" | "workflowStarts";
  }>;
  readonly failed: boolean;
  readonly pending: boolean;
  readonly productFactId: string;
  readonly rootId: string;
  readonly stageOccurrences: ReadonlyArray<typeof StageOccurrence.Type>;
  readonly usageIds: ReadonlyArray<string>;
}

const productAuthoritySources = new Set<QualificationAuthoritySource>([
  "gmail_provider_receipts",
  "memory_commit_receipts",
  "model_access_receipts",
  "osfo_agent_activation_log",
  "provider_delivery_receipts",
  "task_compute_receipts",
  "think_submission_receipts",
  "whatsapp_delivery_receipts",
  "worker_admission_receipts",
  "workflow_instance_receipts",
]);

const sourceComponent = {
  allowance_and_billing_ledger: "PostgreSQL",
  gmail_provider_receipts: "Gmail",
  memory_commit_receipts: "Memory",
  model_access_receipts: "ModelAccess",
  osfo_agent_activation_log: "AgentActivation",
  osfo_committed_turns: "AgentSQLite",
  provider_delivery_receipts: "Provider",
  r2_object_metadata: "R2",
  task_compute_receipts: "TaskCompute",
  think_submission_receipts: "Think",
  whatsapp_delivery_receipts: "WhatsApp",
  worker_admission_receipts: "Worker",
  workflow_instance_receipts: "Workflow",
} as const;

const finding = (
  code: string,
  detail: string,
  subject: string,
  verdict: "FAIL" | "MISSING",
): QualificationFinding => ({ code, detail, subject, verdict });

const authorityShardArtifactId = (
  executionId: string,
  source: QualificationAuthoritySource,
  streamChunkIndex: number,
) =>
  `qualification/executions/${encodeURIComponent(executionId)}/producer-authority/${source}/partitions/${streamChunkIndex.toString().padStart(8, "0")}/00000000.json`;

const arrivalShardArtifactId = (executionId: string, streamChunkIndex: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/authority-streams/arrivals/partitions/${streamChunkIndex.toString().padStart(8, "0")}/00000000.json`;

const leafArtifactPrefix = (executionId: string, streamChunkIndex: number) =>
  `qualification/executions/${encodeURIComponent(executionId)}/evaluation-leaves/${streamChunkIndex.toString().padStart(8, "0")}`;

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return globalThis.Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const exactMetadata = async (
  object: { readonly customMetadata?: Readonly<Record<string, string>> },
  encoded: string,
  expected: Readonly<Record<string, string>>,
): Promise<boolean> => {
  const metadata = object.customMetadata;
  return (
    metadata !== undefined &&
    Object.entries(expected).every(([key, value]) => metadata[key] === value) &&
    metadata["osfo-body-sha256"] === (await sha256Hex(encoded))
  );
};

const validateAndNormalizeSource = (
  source: QualificationAuthoritySource,
  shard: typeof QualificationEvaluationAuthorityShard.Type,
): ReadonlyArray<NormalizedAuthorityRecord> | null => {
  if (productAuthoritySources.has(source)) {
    const decoded = Schema.decodeUnknownOption(ProductAuthorityExportBoundary)(shard);
    if (Option.isNone(decoded) || decoded.value.authority !== source) return null;
    const usageIdsByFact = new Map<string, ReadonlyArray<string>>(
      decoded.value.records.map((record) => [
        String(record.productFactId),
        record.usageFacts.map(({ usageId }) => usageId),
      ]),
    );
    return productEvidenceFromAuthorityExport(decoded.value).map((record) => ({
      acceptanceReceiptId: record.correlations.acceptanceReceiptId ?? null,
      activation: record.activation,
      activationCause: record.activation?.cause ?? null,
      componentEvidence: true,
      correlations: record.correlations,
      effects: record.effectReceipts,
      failed: record.terminalObserved && !record.terminalFact,
      pending: !record.terminalObserved,
      productFactId: record.productFactId,
      rootId: record.rootId,
      stageOccurrences: record.stageOccurrences,
      usageIds: usageIdsByFact.get(record.productFactId) ?? [],
    }));
  }
  if (source === "osfo_committed_turns") {
    const decoded = shard.records.map((record) =>
      Schema.decodeUnknownOption(LocalProductEvidenceBoundary)(record),
    );
    if (decoded.some(Option.isNone)) return null;
    return decoded.flatMap((candidate) =>
      Option.isSome(candidate) && candidate.value.store === "AgentSQLite"
        ? [
            {
              acceptanceReceiptId: candidate.value.acceptanceReceiptId,
              activation: null,
              activationCause: null,
              componentEvidence: true,
              correlations: {
                acceptanceReceiptId: candidate.value.acceptanceReceiptId,
                thinkRequestId: candidate.value.thinkRequestId,
              },
              effects: [],
              failed: false,
              pending: false,
              productFactId: candidate.value.productFactId,
              rootId: candidate.value.rootId,
              stageOccurrences: [],
              usageIds: [],
            } satisfies NormalizedAuthorityRecord,
          ]
        : [],
    );
  }
  if (source === "allowance_and_billing_ledger") {
    const normalized = shard.records.flatMap((record): ReadonlyArray<NormalizedAuthorityRecord> => {
      const local = Schema.decodeUnknownOption(BillingLocalAuthorityRecord)(record);
      if (Option.isSome(local)) {
        return [
          {
            acceptanceReceiptId: local.value.evidence.acceptanceReceiptId,
            activation: null,
            activationCause: null,
            componentEvidence: true,
            correlations: {
              acceptanceReceiptId: local.value.evidence.acceptanceReceiptId,
              allowanceConsumptionId: local.value.evidence.allowanceConsumptionId,
            },
            effects: [],
            failed: false,
            pending: false,
            productFactId: local.value.evidence.productFactId,
            rootId: local.value.evidence.acceptanceReceiptId,
            stageOccurrences: [],
            usageIds: [local.value.evidence.allowanceConsumptionId],
          },
        ];
      }
      const billing = Schema.decodeUnknownOption(BillingAuthorityRecord)(record);
      return Option.isNone(billing)
        ? []
        : [
            {
              acceptanceReceiptId: null,
              activation: null,
              activationCause: null,
              componentEvidence: false,
              correlations: {},
              effects: [],
              failed: false,
              pending: false,
              productFactId: billing.value.record.sourceId,
              rootId: billing.value.record.rootId,
              stageOccurrences: [],
              usageIds: [billing.value.record.sourceId],
            },
          ];
    });
    return normalized.length === shard.records.length ? normalized : null;
  }
  if (source === "r2_object_metadata") {
    const decoded = shard.records.map((record) =>
      Schema.decodeUnknownOption(R2ObjectEvidenceBoundary)(record),
    );
    if (decoded.some(Option.isNone)) return null;
    return decoded.flatMap((candidate) =>
      Option.isSome(candidate)
        ? [
            {
              acceptanceReceiptId: null,
              activation: null,
              activationCause: null,
              componentEvidence: true,
              correlations: { r2ObjectId: candidate.value.objectId },
              effects: [],
              failed: false,
              pending: false,
              productFactId: candidate.value.objectId,
              rootId: candidate.value.rootId,
              stageOccurrences: [],
              usageIds: [],
            } satisfies NormalizedAuthorityRecord,
          ]
        : [],
    );
  }
  const faults = shard.records.map((record) =>
    Schema.decodeUnknownOption(FaultControllerReceiptBoundary)(record),
  );
  return faults.some(Option.isNone) ? null : [];
};

const verdictFromFindings = (
  findings: ReadonlyArray<QualificationFinding>,
): QualificationVerdict =>
  findings.some(({ verdict }) => verdict === "FAIL")
    ? "FAIL"
    : findings.some(({ verdict }) => verdict === "MISSING")
      ? "MISSING"
      : "PASS";

interface QualificationEvaluationLeafDimensionOutput {
  readonly receipt: typeof LeafDimensionReceipt.Type;
  readonly shards: ReadonlyArray<typeof QualificationEvaluationLeafValueShard.Type>;
}

export interface QualificationEvaluationLeafResult {
  readonly dimensions: ReadonlyArray<QualificationEvaluationLeafDimensionOutput>;
  readonly findings: ReadonlyArray<QualificationFinding>;
  readonly rootAccumulator: typeof QualificationEvaluationLeafRootAccumulator.Type;
  readonly verdict: QualificationVerdict;
}

interface QualificationEvaluationLeafDimensionBase {
  readonly artifactId: string;
  readonly denominatorRootIds: ReadonlyArray<string>;
  readonly dimension: string;
  readonly executionId: string;
  readonly leafInputChecksum: string;
  readonly missingRootCount: number;
  readonly partitionIndex: number;
  readonly planChecksum: string;
}

type QualificationEvaluationLeafDimensionInput = QualificationEvaluationLeafDimensionBase & {
  readonly valueType: "identity" | "latencyMs";
  readonly values: ReadonlyArray<unknown>;
};

export const qualificationEvaluationLeafDimension = (
  input: QualificationEvaluationLeafDimensionInput,
): QualificationEvaluationLeafDimensionOutput | null => {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh copy.
  const denominatorRootIds = [...input.denominatorRootIds].sort();
  if (
    new Set(denominatorRootIds).size !== denominatorRootIds.length ||
    input.missingRootCount < 0 ||
    input.missingRootCount > denominatorRootIds.length
  )
    return null;
  const identityValues = Schema.decodeUnknownOption(Schema.Array(Schema.String))(input.values);
  const latencyValues = Schema.decodeUnknownOption(Schema.Array(Schema.Finite))(input.values);
  if (input.valueType === "identity" && Option.isNone(identityValues)) return null;
  if (input.valueType === "latencyMs" && Option.isNone(latencyValues)) return null;
  const values =
    input.valueType === "identity" && Option.isSome(identityValues)
      ? // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh copy.
        [...identityValues.value].sort((left, right) => left.localeCompare(right))
      : Option.isSome(latencyValues)
        ? // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh copy.
          [...latencyValues.value].sort((left, right) => left - right)
        : [];
  if (
    input.valueType === "identity"
      ? values.some((value) => String(value).length === 0)
      : values.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)
  )
    return null;
  const denominatorChainDigest = qualificationChecksum([
    {
      contentDigest: qualificationChecksum(denominatorRootIds),
      count: denominatorRootIds.length,
      partitionIndex: input.partitionIndex,
    },
  ]);
  const inputReceiptChecksums = [input.leafInputChecksum];
  const inputReceiptChainDigest = qualificationChecksum(inputReceiptChecksums);
  const runId = `leaf:${input.partitionIndex.toString().padStart(8, "0")}`;
  const sampleStatus = input.missingRootCount > 0 ? ("MISSING" as const) : ("COMPLETE" as const);
  const shards = new globalThis.Array<typeof QualificationEvaluationLeafValueShard.Type>();
  let previousShardChecksum = "NONE";
  for (let index = 0; index * 256 < values.length; index += 1) {
    const chunk = values.slice(index * 256, (index + 1) * 256);
    const shardInput = {
      artifactId: `${input.artifactId}/${index.toString().padStart(8, "0")}.json`,
      denominatorChainDigest,
      denominatorCount: denominatorRootIds.length,
      dimension: input.dimension,
      executionId: input.executionId,
      firstPartitionIndex: input.partitionIndex,
      index,
      inputReceiptChainDigest,
      lastPartitionIndex: input.partitionIndex,
      missingRootCount: input.missingRootCount,
      planChecksum: input.planChecksum,
      previousShardChecksum,
      runId,
      sampleStatus,
    };
    const shard =
      input.valueType === "identity"
        ? qualificationEvaluationSortedRunShard({
            ...shardInput,
            valueType: "identity",
            values: chunk.map(String),
          })
        : qualificationEvaluationSortedRunShard({
            ...shardInput,
            valueType: "latencyMs",
            values: chunk.map(Number),
          });
    if (shard === null) return null;
    shards.push(shard);
    previousShardChecksum = shard.checksum;
  }
  const descriptorBase = {
    artifactPrefix: input.artifactId,
    denominatorChainDigest,
    denominatorCount: denominatorRootIds.length,
    dimension: input.dimension,
    firstPartitionIndex: input.partitionIndex,
    firstShardChecksum: shards[0]?.checksum ?? "ZERO",
    inputReceiptChainDigest,
    lastPartitionIndex: input.partitionIndex,
    maximum: shards.at(-1)?.maximum ?? null,
    minimum: shards[0]?.minimum ?? null,
    missingRootCount: input.missingRootCount,
    runId,
    sampleStatus,
    shardCount: shards.length,
    terminalShardChecksum: shards.at(-1)?.checksum ?? "ZERO",
    valueCount: values.length,
  };
  const receipt = qualificationEvaluationSortedRunReceipt({
    artifactId: `${input.artifactId}/receipt.json`,
    descriptor:
      input.valueType === "identity"
        ? {
            ...descriptorBase,
            maximum: String(descriptorBase.maximum ?? "") || null,
            minimum: String(descriptorBase.minimum ?? "") || null,
            valueType: "identity",
          }
        : {
            ...descriptorBase,
            maximum: descriptorBase.maximum === null ? null : Number(descriptorBase.maximum),
            minimum: descriptorBase.minimum === null ? null : Number(descriptorBase.minimum),
            valueType: "latencyMs",
          },
    executionId: input.executionId,
    index: input.partitionIndex,
    inputReceiptChecksums,
    level: 0,
    planChecksum: input.planChecksum,
  });
  return receipt === null ? null : { receipt, shards };
};

/** Evaluate one authenticated <=256-root authority leaf without retaining corpus-sized state. */
export const evaluateQualificationLeaf = (input: {
  readonly arrivalShard: typeof QualificationEvaluationArrivalShard.Type;
  readonly authorityShards: ReadonlyArray<typeof QualificationEvaluationAuthorityShard.Type>;
  readonly leafInput: typeof QualificationEvaluationLeafInputReceipt.Type;
  readonly manifest: ProductionQualificationManifest;
  readonly partitionIndex: number;
  readonly run: QualificationExecutionRun;
}): QualificationEvaluationLeafResult => {
  const findings = new globalThis.Array<QualificationFinding>();
  const roots = input.arrivalShard.records.map(({ rootId }) => rootId);
  for (const record of input.arrivalShard.records) {
    const { artifactChecksum, ...receiptContent } = record.admissionReceipt;
    const expectedAttemptId = qualificationChecksum({
      executionId: input.arrivalShard.executionId,
      planChecksum: input.arrivalShard.planChecksum,
      rootId: record.rootId,
      runId: input.arrivalShard.runId,
    });
    if (
      artifactChecksum !== qualificationChecksum(receiptContent) ||
      record.admissionReceipt.attemptId !== record.attemptId ||
      record.admissionReceipt.executionId !== input.arrivalShard.executionId ||
      record.admissionReceipt.planChecksum !== input.arrivalShard.planChecksum ||
      record.admissionReceipt.productFactId !== record.authorityFactId ||
      record.admissionReceipt.rootId !== record.rootId ||
      record.admissionReceipt.runId !== input.arrivalShard.runId ||
      record.arrival.rootId !== record.rootId ||
      record.attemptId !== expectedAttemptId ||
      record.executionId !== input.arrivalShard.executionId ||
      !Number.isFinite(Date.parse(record.submittedAtUtc)) ||
      !Number.isFinite(Date.parse(record.executedAtUtc)) ||
      Date.parse(record.submittedAtUtc) < record.arrival.offeredAtEpochMs ||
      Date.parse(record.executedAtUtc) < Date.parse(record.submittedAtUtc)
    ) {
      findings.push(
        finding(
          "arrivalAuthorityIdentityConflict",
          `${record.rootId} does not match its frozen admission identity`,
          record.rootId,
          "FAIL",
        ),
      );
    }
  }
  if (new Set(roots).size !== roots.length) {
    findings.push(
      finding(
        "duplicateLeafRoot",
        "Arrival leaf contains duplicate roots",
        input.run.runId,
        "FAIL",
      ),
    );
  }
  const sourceRecords = new Map<
    QualificationAuthoritySource,
    ReadonlyArray<NormalizedAuthorityRecord>
  >();
  for (const [index, source] of qualificationAuthoritySources.entries()) {
    const shard = input.authorityShards[index];
    const leafAuthority = input.leafInput.authorityInputs[index];
    if (
      shard === undefined ||
      leafAuthority === undefined ||
      shard.authority !== source ||
      leafAuthority.source !== source ||
      shard.checksum !== leafAuthority.checksum ||
      shard.recordCount !== leafAuthority.recordCount
    ) {
      findings.push(
        finding(
          "leafAuthoritySourceMismatch",
          `${source} is missing or substituted`,
          source,
          "FAIL",
        ),
      );
      continue;
    }
    const normalized = validateAndNormalizeSource(source, shard);
    if (normalized === null) {
      findings.push(
        finding(
          "leafAuthorityRecordInvalid",
          `${source} contains malformed authority facts`,
          source,
          "FAIL",
        ),
      );
      continue;
    }
    if (
      normalized.some(
        ({ rootId }) => !roots.includes(rootId) && source !== "allowance_and_billing_ledger",
      )
    ) {
      findings.push(
        finding("leafAuthorityRootMismatch", `${source} contains a foreign root`, source, "FAIL"),
      );
    }
    sourceRecords.set(source, normalized);
  }
  const workerRecords = sourceRecords.get("worker_admission_receipts") ?? [];
  const correlationOwners = new Map<string, string>();
  for (const arrival of input.arrivalShard.records) {
    const exactWorker = workerRecords.filter(
      (record) =>
        record.rootId === arrival.rootId && record.productFactId === arrival.authorityFactId,
    );
    if (exactWorker.length !== 1) {
      findings.push(
        finding(
          exactWorker.length === 0 ? "admissionAuthorityMissing" : "admissionAuthorityDuplicate",
          `${arrival.rootId} does not have exactly one matching admission fact`,
          arrival.rootId,
          exactWorker.length === 0 ? "MISSING" : "FAIL",
        ),
      );
    }
    if (arrival.admissionReceipt.admissionDecision !== "accepted") continue;
    const requirement = input.manifest.semanticRequirements[arrival.arrival.journey];
    for (const component of new Set(requirement.requiredComponents)) {
      const source = Object.entries(sourceComponent).find(
        ([, candidate]) => candidate === component,
      )?.[0];
      if (source === undefined) continue;
      const records =
        sourceRecords
          .get(Schema.decodeUnknownSync(Schema.Literals(qualificationAuthoritySources))(source))
          ?.filter(
            (record) =>
              record.componentEvidence &&
              (record.rootId === arrival.rootId ||
                record.acceptanceReceiptId === arrival.admissionReceipt.acceptanceReceiptId),
          ) ?? [];
      if (records.length === 0) {
        findings.push(
          finding(
            "componentProductAuthorityMissing",
            `${arrival.rootId} has no ${component} authority`,
            `${arrival.rootId}:${component}`,
            "MISSING",
          ),
        );
      } else if (records.length > 1) {
        findings.push(
          finding(
            "duplicateComponentEvidence",
            `${arrival.rootId} has duplicate ${component} authority`,
            `${arrival.rootId}:${component}`,
            "FAIL",
          ),
        );
      } else if (records.some(({ failed }) => failed)) {
        findings.push(
          finding(
            "componentProductAuthorityInvalid",
            `${arrival.rootId} has terminal failed ${component} authority`,
            `${arrival.rootId}:${component}`,
            "FAIL",
          ),
        );
      } else if (records.some(({ pending }) => pending)) {
        findings.push(
          finding(
            "componentProductAuthorityMissing",
            `${arrival.rootId} has unsettled ${component} authority`,
            `${arrival.rootId}:${component}`,
            "MISSING",
          ),
        );
      }
    }
    const rootRecords = [...sourceRecords.values()]
      .flat()
      .filter(
        (record) =>
          record.rootId === arrival.rootId ||
          record.acceptanceReceiptId === arrival.admissionReceipt.acceptanceReceiptId,
      );
    for (const correlation of requirement.requiredCorrelations) {
      const values = [
        ...new Set(
          rootRecords.flatMap((record) => {
            const value = record.correlations[correlation];
            return value === undefined ? [] : [value];
          }),
        ),
      ];
      if (values.length === 0) {
        findings.push(
          finding(
            "rootCorrelationMissing",
            `${arrival.rootId} has no ${correlation} correlation identity`,
            `${arrival.rootId}:${correlation}`,
            "MISSING",
          ),
        );
        continue;
      }
      if (values.length > 1) {
        findings.push(
          finding(
            "rootCorrelationConflict",
            `${arrival.rootId} has conflicting ${correlation} identities`,
            `${arrival.rootId}:${correlation}`,
            "FAIL",
          ),
        );
        continue;
      }
      const value = values[0];
      if (value === undefined) continue;
      const identity = `${correlation}:${value}`;
      const priorRoot = correlationOwners.get(identity);
      if (priorRoot !== undefined && priorRoot !== arrival.rootId) {
        findings.push(
          finding(
            "crossRootCorrelationConflict",
            `${correlation} ${value} is reused by ${priorRoot} and ${arrival.rootId}`,
            value,
            "FAIL",
          ),
        );
      } else {
        correlationOwners.set(identity, arrival.rootId);
      }
    }
  }
  const acceptedRoots = input.arrivalShard.records
    .filter(({ admissionReceipt }) => admissionReceipt.admissionDecision === "accepted")
    .map(({ rootId }) => rootId);
  const allRecords = [...sourceRecords.values()].flat();
  const dimensions = new globalThis.Array<QualificationEvaluationLeafDimensionOutput>();
  const prefix = leafArtifactPrefix(
    input.arrivalShard.executionId,
    input.arrivalShard.streamChunkIndex,
  );
  const authorityEffects = allRecords.flatMap(({ effects: recordEffects }) => recordEffects);
  const identityValues = new Map<string, ReadonlyArray<string>>([
    ["acceptedRootIds", acceptedRoots],
    ["billUsageIds", allRecords.flatMap(({ usageIds }) => usageIds)],
    ["productFactIds", allRecords.map(({ productFactId }) => productFactId)],
    [
      "providerEffectIds",
      authorityEffects
        .filter(({ kind }) => kind === "providerEffects")
        .map(({ effectId }) => effectId),
    ],
    [
      "thinkSubmissionIds",
      authorityEffects
        .filter(({ kind }) => kind === "thinkSubmissions")
        .map(({ effectId }) => effectId),
    ],
    ["usageIds", allRecords.flatMap(({ usageIds }) => usageIds)],
    [
      "workflowStartIds",
      authorityEffects
        .filter(({ kind }) => kind === "workflowStarts")
        .map(({ effectId }) => effectId),
    ],
  ]);
  for (const dimension of qualificationEvaluationGlobalSortedDimensions) {
    const base = {
      artifactId: `${prefix}/dimensions/${encodeURIComponent(dimension)}`,
      denominatorRootIds: acceptedRoots,
      dimension,
      executionId: input.arrivalShard.executionId,
      leafInputChecksum: input.leafInput.checksum,
      missingRootCount:
        dimension.startsWith("operation:") ||
        (dimension === "publicPromotionRootIds" &&
          input.manifest.acceptanceLevel === "ScaleQualifiedPublic")
          ? acceptedRoots.length
          : 0,
      partitionIndex: input.partitionIndex,
      planChecksum: input.arrivalShard.planChecksum,
    };
    const output = dimension.startsWith("operation:")
      ? qualificationEvaluationLeafDimension({ ...base, valueType: "latencyMs", values: [] })
      : qualificationEvaluationLeafDimension({
          ...base,
          valueType: "identity",
          values: identityValues.get(dimension) ?? [],
        });
    if (output === null) {
      findings.push(
        finding(
          "leafDimensionInvalid",
          `${dimension} cannot be represented exactly`,
          dimension,
          "FAIL",
        ),
      );
      continue;
    }
    if (
      acceptedRoots.length > 0 &&
      (dimension.startsWith("operation:") ||
        (dimension === "publicPromotionRootIds" &&
          input.manifest.acceptanceLevel === "ScaleQualifiedPublic")) &&
      output.receipt.valueCount === 0
    ) {
      findings.push(
        finding(
          "leafDimensionMissing",
          `${dimension} has no producer-authority values`,
          dimension,
          "MISSING",
        ),
      );
    }
    dimensions.push(output);
  }
  if (input.run.kind === "lane" && isMeasuredStageLane(input.run.lane)) {
    const activationByRoot = new Map(
      (sourceRecords.get("osfo_agent_activation_log") ?? []).map((record) => [
        record.rootId,
        record.activationCause,
      ]),
    );
    for (const dimension of qualificationStageDimensions(input.run.lane)) {
      const applicableJourneys = stageApplicableJourneys(dimension.stage);
      const eligible = input.arrivalShard.records.filter(
        ({ admissionReceipt, arrival }) =>
          admissionReceipt.admissionDecision === "accepted" &&
          (applicableJourneys === null || applicableJourneys.includes(arrival.journey)) &&
          (dimension.coldCause === undefined ||
            activationByRoot.get(arrival.rootId) === dimension.coldCause),
      );
      const denominator = eligible.map(({ rootId }) => rootId);
      const pair = stageAuthorityComponents(dimension.stage);
      const values = new globalThis.Array<number>();
      for (const arrival of eligible) {
        const rootRecords = allRecords.filter(({ rootId }) => rootId === arrival.rootId);
        const starts = rootRecords.flatMap(({ stageOccurrences }) =>
          stageOccurrences.filter(({ boundary }) => boundary === pair.start),
        );
        const ends = rootRecords.flatMap(({ stageOccurrences }) =>
          stageOccurrences.filter(({ boundary }) => boundary === pair.end),
        );
        if (starts.length !== 1 || ends.length !== 1) {
          findings.push(
            finding(
              starts.length > 1 || ends.length > 1
                ? "duplicateProductStageAuthority"
                : "productStageAuthorityMissing",
              `${arrival.rootId} cannot reproduce ${dimension.stage}`,
              `${arrival.rootId}:${dimension.stage}`,
              starts.length > 1 || ends.length > 1 ? "FAIL" : "MISSING",
            ),
          );
          continue;
        }
        const start = Date.parse(starts[0]?.occurredAt ?? "");
        const end = Date.parse(ends[0]?.occurredAt ?? "");
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
          findings.push(
            finding(
              "stageIntervalInvalid",
              `${arrival.rootId} has an invalid ${dimension.stage} interval`,
              `${arrival.rootId}:${dimension.stage}`,
              "FAIL",
            ),
          );
          continue;
        }
        values.push(end - start);
      }
      const cause = dimension.coldCause ?? "all";
      const name = `stage:${input.run.lane}:${input.run.region}:${input.run.repetition}:${dimension.stage}:${cause}`;
      const output = qualificationEvaluationLeafDimension({
        artifactId: `${prefix}/dimensions/${encodeURIComponent(name)}`,
        denominatorRootIds: denominator,
        dimension: name,
        executionId: input.arrivalShard.executionId,
        leafInputChecksum: input.leafInput.checksum,
        missingRootCount: denominator.length - values.length,
        partitionIndex: input.partitionIndex,
        planChecksum: input.arrivalShard.planChecksum,
        valueType: "latencyMs",
        values,
      });
      if (output === null) {
        findings.push(
          finding("leafDimensionInvalid", `${name} cannot be represented exactly`, name, "FAIL"),
        );
      } else {
        dimensions.push(output);
      }
    }
  }
  const rootAccumulatorContent = {
    acceptedCount: String(acceptedRoots.length),
    artifactId: `${prefix}/roots.json`,
    executionId: input.arrivalShard.executionId,
    partitionIndex: input.partitionIndex,
    planChecksum: input.arrivalShard.planChecksum,
    rootCount: String(input.arrivalShard.records.length),
    roots: input.arrivalShard.records.map((arrival) => {
      const rootRecords = allRecords.filter(
        (record) =>
          record.rootId === arrival.rootId ||
          record.acceptanceReceiptId === arrival.admissionReceipt.acceptanceReceiptId,
      );
      const correlationValues = new Map<string, string>();
      for (const record of rootRecords) {
        for (const [kind, value] of Object.entries(record.correlations)) {
          if (value !== undefined && value.length > 0) correlationValues.set(kind, value);
        }
      }
      const retainedCorrelations = [...correlationValues].map(([kind, value]) => ({ kind, value }));
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh array.
      retainedCorrelations.sort((left, right) => left.kind.localeCompare(right.kind));
      const rootFindings = findings.filter(
        ({ subject }) => subject === arrival.rootId || subject.startsWith(`${arrival.rootId}:`),
      );
      const terminalState =
        arrival.admissionReceipt.admissionDecision !== "accepted"
          ? ("typedRejected" as const)
          : rootFindings.some(({ verdict }) => verdict === "FAIL")
            ? ("failed" as const)
            : rootFindings.some(({ verdict }) => verdict === "MISSING")
              ? ("missing" as const)
              : ("succeeded" as const);
      const productFactIds = rootRecords.map(({ productFactId }) => productFactId);
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh array.
      productFactIds.sort();
      return {
        activation:
          rootRecords.flatMap(({ activation }) => (activation === null ? [] : [activation]))[0] ??
          null,
        correlations: retainedCorrelations,
        decision: arrival.admissionReceipt.admissionDecision,
        journey: arrival.arrival.journey,
        plan: arrival.arrival.plan,
        productFactChecksum: qualificationChecksum(productFactIds),
        productFactCount: String(productFactIds.length),
        rootId: arrival.rootId,
        terminalState,
      };
    }),
    version: "qualification-evaluation-leaf-roots-v1" as const,
  };
  const rootAccumulator = {
    ...rootAccumulatorContent,
    checksum: qualificationChecksum(rootAccumulatorContent),
  };
  return {
    dimensions,
    findings,
    rootAccumulator,
    verdict: verdictFromFindings(findings),
  };
};

const failedLeafOutcome = (
  code: typeof QualificationEvaluationLeafFailureCode.Type,
  artifactId: string,
  source: QualificationAuthoritySource | null = null,
): QualificationEvaluationLeafOutcome => ({ artifactId, code, source, status: "FAIL" });

const missingLeafOutcome = (
  code: typeof QualificationEvaluationLeafMissingCode.Type,
  artifactId: string,
  source: QualificationAuthoritySource | null = null,
): QualificationEvaluationLeafOutcome => ({ artifactId, code, source, status: "MISSING" });

/** Read, authenticate, evaluate, and retain exactly one bounded leaf result. */
export const runQualificationEvaluationLeaf = async (input: {
  readonly bucket: QualificationEvaluationLeafBucket;
  readonly executionId: string;
  readonly leafInputArtifactId: string;
  readonly leafInputChecksum: string;
  readonly manifest: ProductionQualificationManifest;
  readonly partitionIndex: number;
  readonly planChecksum: string;
  readonly run: QualificationExecutionRun;
}): Promise<QualificationEvaluationLeafOutcome> => {
  const retainedLeafObject = await input.bucket.get(input.leafInputArtifactId);
  if (retainedLeafObject === null)
    return missingLeafOutcome("qualificationEvaluationLeafInputMissing", input.leafInputArtifactId);
  const leafEncoded = await retainedLeafObject.text();
  if (
    !(await exactMetadata(retainedLeafObject, leafEncoded, {
      "osfo-artifact-checksum": input.leafInputChecksum,
      "osfo-execution-id": input.executionId,
      "osfo-kind": "qualification-evaluation-leaf-input-v1",
      "osfo-plan-checksum": input.planChecksum,
    }))
  )
    return failedLeafOutcome("qualificationEvaluationLeafInputConflict", input.leafInputArtifactId);
  const decodedLeaf = Schema.decodeOption(
    Schema.fromJsonString(QualificationEvaluationLeafInputReceipt),
  )(leafEncoded);
  if (Option.isNone(decodedLeaf))
    return failedLeafOutcome("qualificationEvaluationLeafInputConflict", input.leafInputArtifactId);
  const leaf = decodedLeaf.value;
  const { checksum: leafChecksum, ...leafContent } = leaf;
  if (
    leafChecksum !== input.leafInputChecksum ||
    leafChecksum !== qualificationChecksum(leafContent) ||
    leaf.artifactId !== input.leafInputArtifactId ||
    leaf.executionId !== input.executionId ||
    leaf.partitionIndex !== input.partitionIndex ||
    leaf.planChecksum !== input.planChecksum ||
    leaf.authorityInputs.length !== qualificationAuthoritySources.length ||
    leaf.authorityInputs.some(
      ({ source }, index) => source !== qualificationAuthoritySources[index],
    ) ||
    leaf.partitionAuthorityChecksum !==
      qualificationChecksum({
        arrivalChecksum: leaf.arrivalChecksum,
        executionId: leaf.executionId,
        partitionIndex: leaf.partitionIndex,
        planChecksum: leaf.planChecksum,
        sourceChecksums: leaf.authorityInputs,
        streamChunkIndex: leaf.streamChunkIndex,
      })
  )
    return failedLeafOutcome("qualificationEvaluationLeafInputConflict", input.leafInputArtifactId);
  const arrivalId = arrivalShardArtifactId(leaf.executionId, leaf.streamChunkIndex);
  const arrivalObject = await input.bucket.get(arrivalId);
  if (arrivalObject === null)
    return missingLeafOutcome("qualificationEvaluationArrivalMissing", arrivalId);
  const arrivalEncoded = await arrivalObject.text();
  const decodedArrival = Schema.decodeOption(
    Schema.fromJsonString(QualificationEvaluationArrivalShard),
  )(arrivalEncoded);
  if (Option.isNone(decodedArrival))
    return failedLeafOutcome("qualificationEvaluationArrivalConflict", arrivalId);
  const arrival = decodedArrival.value;
  const { bodyChecksum, ...arrivalContent } = arrival;
  const arrivalBodySha256 = await sha256Hex(arrivalEncoded);
  const arrivalArtifactChecksum = qualificationChecksum({
    bodySha256: arrivalBodySha256,
    component: "arrivals",
    executionId: leaf.executionId,
    index: 0,
    planChecksum: input.planChecksum,
    previousArtifactChecksum: arrival.previousArtifactChecksum,
    recordCount: arrival.records.length,
    sourceVersion: input.manifest.sourceVersion,
  });
  if (
    bodyChecksum !== qualificationChecksum(arrivalContent) ||
    bodyChecksum !== leaf.arrivalChecksum ||
    arrival.executionId !== leaf.executionId ||
    arrival.planChecksum !== input.planChecksum ||
    arrival.runId !== input.run.runId ||
    arrival.streamChunkIndex !== leaf.streamChunkIndex ||
    !(await exactMetadata(arrivalObject, arrivalEncoded, {
      "osfo-artifact-checksum": arrivalArtifactChecksum,
      "osfo-execution-id": leaf.executionId,
      "osfo-kind": "qualification-authority-stream-v1",
      "osfo-plan-checksum": input.planChecksum,
      "osfo-record-count": String(arrival.records.length),
      "osfo-stream-chunk-index": String(leaf.streamChunkIndex),
    }))
  )
    return failedLeafOutcome("qualificationEvaluationArrivalConflict", arrivalId);
  const authorityShards = new globalThis.Array<typeof QualificationEvaluationAuthorityShard.Type>();
  const sourceOutcomes = new globalThis.Array<QualificationEvaluationLeafOutcome>();
  for (const authorityInput of leaf.authorityInputs) {
    const artifactId = authorityShardArtifactId(
      leaf.executionId,
      authorityInput.source,
      leaf.streamChunkIndex,
    );
    const object = await input.bucket.get(artifactId);
    if (object === null) {
      sourceOutcomes.push(
        missingLeafOutcome(
          "qualificationEvaluationAuthorityMissing",
          artifactId,
          authorityInput.source,
        ),
      );
      continue;
    }
    const encoded = await object.text();
    const decoded = Schema.decodeOption(
      Schema.fromJsonString(QualificationEvaluationAuthorityShard),
    )(encoded);
    if (Option.isNone(decoded)) {
      sourceOutcomes.push(
        failedLeafOutcome(
          "qualificationEvaluationAuthorityConflict",
          artifactId,
          authorityInput.source,
        ),
      );
      continue;
    }
    const shard = decoded.value;
    const { checksum, ...content } = shard;
    if (
      checksum !== qualificationChecksum(content) ||
      checksum !== authorityInput.checksum ||
      shard.artifactId !== artifactId ||
      shard.authority !== authorityInput.source ||
      shard.executionId !== leaf.executionId ||
      shard.planChecksum !== input.planChecksum ||
      shard.recordCount !== shard.records.length ||
      shard.recordCount !== authorityInput.recordCount ||
      shard.streamChunkIndex !== leaf.streamChunkIndex ||
      !(await exactMetadata(object, encoded, {
        "osfo-artifact-checksum": checksum,
        "osfo-execution-id": leaf.executionId,
        "osfo-kind": "qualification-product-authority-export-v1",
        "osfo-plan-checksum": input.planChecksum,
        "osfo-record-count": String(shard.recordCount),
        "osfo-source": authorityInput.source,
        "osfo-stream-chunk-index": String(leaf.streamChunkIndex),
      }))
    ) {
      sourceOutcomes.push(
        failedLeafOutcome(
          "qualificationEvaluationAuthorityConflict",
          artifactId,
          authorityInput.source,
        ),
      );
      continue;
    }
    authorityShards.push(shard);
  }
  const failedSource = sourceOutcomes.find(({ status }) => status === "FAIL");
  if (failedSource !== undefined) return failedSource;
  const missingSource = sourceOutcomes.find(({ status }) => status === "MISSING");
  if (missingSource !== undefined) return missingSource;
  const evaluated = evaluateQualificationLeaf({
    arrivalShard: arrival,
    authorityShards,
    leafInput: leaf,
    manifest: input.manifest,
    partitionIndex: input.partitionIndex,
    run: input.run,
  });
  const prefix = leafArtifactPrefix(leaf.executionId, leaf.streamChunkIndex);
  for (const dimension of evaluated.dimensions) {
    for (const shard of dimension.shards) {
      if (
        (await retainQualificationEvaluationArtifact({
          artifactId: shard.artifactId,
          bucket: input.bucket,
          checksum: shard.checksum,
          encoded: canonicalQualificationJson(shard),
          executionId: leaf.executionId,
          kind: "qualification-evaluation-sorted-run-v2",
          metadata: {
            "osfo-denominator-chain-digest": shard.denominatorChainDigest,
            "osfo-denominator-count": String(shard.denominatorCount),
            "osfo-dimension": shard.dimension,
            "osfo-first-partition-index": String(shard.firstPartitionIndex),
            "osfo-index": String(shard.index),
            "osfo-input-receipt-chain-digest": shard.inputReceiptChainDigest,
            "osfo-last-partition-index": String(shard.lastPartitionIndex),
            "osfo-missing-root-count": String(shard.missingRootCount),
            "osfo-previous-checksum": shard.previousShardChecksum,
            "osfo-record-count": String(shard.values.length),
            "osfo-run-id": shard.runId,
            "osfo-sample-status": shard.sampleStatus,
            "osfo-value-type": shard.valueType,
          },
          planChecksum: input.planChecksum,
        })) === "CONFLICT"
      )
        return failedLeafOutcome("qualificationEvaluationOutputConflict", shard.artifactId);
    }
    const receipt = dimension.receipt;
    if (
      (await retainQualificationEvaluationArtifact({
        artifactId: receipt.artifactId,
        bucket: input.bucket,
        checksum: receipt.checksum,
        encoded: canonicalQualificationJson(receipt),
        executionId: leaf.executionId,
        kind: "qualification-evaluation-sorted-run-receipt-v2",
        metadata: {
          "osfo-denominator-chain-digest": receipt.denominatorChainDigest,
          "osfo-denominator-count": String(receipt.denominatorCount),
          "osfo-dimension": receipt.dimension,
          "osfo-first-partition-index": String(receipt.firstPartitionIndex),
          "osfo-input-checksum": qualificationChecksum(receipt.inputReceiptChecksums),
          "osfo-input-receipt-chain-digest": receipt.inputReceiptChainDigest,
          "osfo-last-partition-index": String(receipt.lastPartitionIndex),
          "osfo-missing-root-count": String(receipt.missingRootCount),
          "osfo-record-count": String(receipt.valueCount),
          "osfo-run-id": receipt.runId,
          "osfo-sample-status": receipt.sampleStatus,
          "osfo-terminal-checksum": receipt.terminalShardChecksum,
          "osfo-value-type": receipt.valueType,
        },
        planChecksum: input.planChecksum,
      })) === "CONFLICT"
    )
      return failedLeafOutcome("qualificationEvaluationOutputConflict", receipt.artifactId);
  }
  if (
    (await retainQualificationEvaluationArtifact({
      artifactId: evaluated.rootAccumulator.artifactId,
      bucket: input.bucket,
      checksum: evaluated.rootAccumulator.checksum,
      encoded: canonicalQualificationJson(evaluated.rootAccumulator),
      executionId: leaf.executionId,
      kind: "qualification-evaluation-leaf-roots-v1",
      metadata: { "osfo-record-count": evaluated.rootAccumulator.rootCount },
      planChecksum: input.planChecksum,
    })) === "CONFLICT"
  )
    return failedLeafOutcome(
      "qualificationEvaluationOutputConflict",
      evaluated.rootAccumulator.artifactId,
    );
  const sortedFindings = [...evaluated.findings];
  if (
    sortedFindings.length >
    qualificationEvaluationLeafRootLimit * qualificationEvaluationLeafMaximumFindingsPerRoot
  ) {
    return failedLeafOutcome(
      "qualificationEvaluationOutputConflict",
      `${prefix}/findings/overflow`,
    );
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside the Worker target. This is a fresh copy.
  sortedFindings.sort((left, right) =>
    [left.verdict, left.code, left.subject, left.detail]
      .join("\u0000")
      .localeCompare([right.verdict, right.code, right.subject, right.detail].join("\u0000")),
  );
  const findingShards = new globalThis.Array<typeof QualificationEvaluationLeafFindingShard.Type>();
  let previousFindingChecksum = "NONE";
  for (let index = 0; index * 256 < sortedFindings.length; index += 1) {
    const findingContent = {
      artifactId: `${prefix}/findings/${index.toString().padStart(8, "0")}.json`,
      executionId: leaf.executionId,
      findings: sortedFindings.slice(index * 256, (index + 1) * 256),
      index,
      partitionIndex: input.partitionIndex,
      planChecksum: input.planChecksum,
      previousShardChecksum: previousFindingChecksum,
      version: "qualification-evaluation-leaf-findings-v1" as const,
    };
    const findingShard = {
      ...findingContent,
      checksum: qualificationChecksum(findingContent),
    };
    if (
      (await retainQualificationEvaluationArtifact({
        artifactId: findingShard.artifactId,
        bucket: input.bucket,
        checksum: findingShard.checksum,
        encoded: canonicalQualificationJson(findingShard),
        executionId: leaf.executionId,
        kind: "qualification-evaluation-leaf-findings-v1",
        metadata: {
          "osfo-index": String(index),
          "osfo-previous-checksum": previousFindingChecksum,
          "osfo-record-count": String(findingShard.findings.length),
        },
        planChecksum: input.planChecksum,
      })) === "CONFLICT"
    )
      return failedLeafOutcome("qualificationEvaluationOutputConflict", findingShard.artifactId);
    findingShards.push(findingShard);
    previousFindingChecksum = findingShard.checksum;
  }
  const failCount = sortedFindings.filter(({ verdict }) => verdict === "FAIL").length;
  const missingCount = sortedFindings.filter(({ verdict }) => verdict === "MISSING").length;
  const receiptContent = {
    artifactId: `${prefix}/receipt.json`,
    dimensions: evaluated.dimensions.map(({ receipt }) => receipt),
    executionId: leaf.executionId,
    failCount: String(failCount),
    findingExemplars: sortedFindings.slice(0, qualificationEvaluationFindingExemplarLimit),
    findingFirstShardChecksum: findingShards[0]?.checksum ?? "ZERO",
    findingShardCount: String(findingShards.length),
    findingShardPrefix: `${prefix}/findings`,
    findingTerminalShardChecksum: findingShards.at(-1)?.checksum ?? "ZERO",
    leafInputChecksum: leaf.checksum,
    missingCount: String(missingCount),
    partitionIndex: input.partitionIndex,
    planChecksum: input.planChecksum,
    rootAccumulatorChecksum: evaluated.rootAccumulator.checksum,
    rootAccumulatorId: evaluated.rootAccumulator.artifactId,
    rootCount: evaluated.rootAccumulator.rootCount,
    streamChunkIndex: leaf.streamChunkIndex,
    verdict: evaluated.verdict,
    version: "qualification-evaluation-leaf-v1" as const,
  };
  const receipt = { ...receiptContent, checksum: qualificationChecksum(receiptContent) };
  const retainedReceipt = await retainQualificationEvaluationArtifact({
    artifactId: receipt.artifactId,
    bucket: input.bucket,
    checksum: receipt.checksum,
    encoded: canonicalQualificationJson(receipt),
    executionId: leaf.executionId,
    kind: "qualification-evaluation-leaf-v1",
    metadata: {
      "osfo-record-count": String(receipt.dimensions.length),
      "osfo-verdict": receipt.verdict,
    },
    planChecksum: input.planChecksum,
  });
  return retainedReceipt === "CONFLICT"
    ? failedLeafOutcome("qualificationEvaluationOutputConflict", receipt.artifactId)
    : { receipt, status: "COMPLETE" };
};
