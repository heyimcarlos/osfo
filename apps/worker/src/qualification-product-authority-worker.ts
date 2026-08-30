import { getAgentByName } from "agents";
import { createDb } from "@osfo/db";
import postgres from "postgres";
import { Clock, Data, Duration, Effect, Exit, Option, Predicate, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "./agents/osfo/directory";
import type { OsfoDirectory } from "./agents/osfo/directory";
import { QualificationActivationReceipt } from "./agents/osfo/db/qualification-activations";
import { BillingDb } from "./db/billing";
import { AgentId, AllowancePeriodId, ThinkSubmissionId, UserId } from "./domain";
import { ContentId } from "./domain/client-content";
import { DocumentArtifacts } from "./integrations/cloudflare/document-artifacts";
import { QualificationContext, sameQualificationContext } from "./domain/qualification-context";
import { DocumentQualificationAuthority } from "./integrations/cloudflare/document-qualification-authority";
import {
  contentKeyFor,
  qualificationReceiptKeyFor,
} from "./integrations/cloudflare/document-storage-keys";
import { readQualificationDocumentBuildAuthority } from "./integrations/postgres/document-build";
import { makeQualificationCohortAuthority } from "./integrations/postgres/qualification-cohort";
import { makeQualificationAttemptIndex } from "./integrations/postgres/qualification-attempt-index";
import { readQualificationScheduledEmailAuthority } from "./integrations/postgres/scheduled-email";
import { project } from "./services/authorization-context";
import type { DocumentBuild } from "./services/document-build";
import { ScheduledEmail } from "./services/scheduled-email";
import {
  scheduledEmailWorkflowEvidenceArtifactId,
  ScheduledEmailWorkflowEvidence,
} from "./workflows/scheduled-email";
import {
  isQualificationAgentPostgresAuthoritySource,
  isQualificationArrivalReadbackAuthoritySource,
  isQualificationControlledAgentFaultAuthoritySource,
  isQualificationDocumentR2ObjectAuthoritySource,
  qualificationAuthorityCoverageGaps,
  qualificationAuthoritySourcesRequiring,
  qualificationAuthoritySources,
  type QualificationAgentPostgresAuthoritySource,
  type QualificationArrivalReadbackAuthoritySource,
  type QualificationAuthoritySource,
} from "./qualification/authority-sources";
import {
  qualificationRunArrivalAt,
  type QualificationExecutionPlan,
  type QualificationExecutionRun,
} from "./qualification/execution";
import { decodeFrozenQualificationExecution } from "./qualification/frozen-execution";
import {
  QualificationProductAuthorityArrivalChunk,
  QualificationProductAuthorityInvocation,
  QualificationProductAuthoritySourceBundleComplete,
  QualificationProductAuthoritySourceBundlePending,
  QualificationProductAuthoritySourceChunkComplete,
  QualificationProductAuthoritySourceChunkInvocation,
  QualificationProductAuthoritySourceChunkPending,
} from "./qualification/product-authority-contract";
import {
  qualificationAttemptArtifactId,
  QualificationAdmissionReceipt,
  QualificationConversationAttemptArtifact,
} from "./qualification/qualification-attempt";
import {
  QualificationControlledAgentAbort,
  QualificationControlledAgentRecoveryReceipt,
  qualificationControlledAgentAbortOperationId,
  qualificationControlledAgentFaultReceipt,
} from "./qualification/controlled-agent-fault";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import type { ProductionQualificationManifest } from "./qualification/qualification-manifest";
import {
  decodeQualificationCohortManifest,
  decodeQualificationParticipantGrant,
  qualificationCohortArtifactId,
  qualificationParticipantGrantArtifactId,
  type QualificationCohortManifest,
} from "./qualification/qualification-cohort";
import {
  approveQualificationScheduledEmail,
  hasExactRetainedQualificationScheduledEmail,
  hasConnectedQualificationGmail,
  QualificationIntegrationConnectionSummary,
  qualificationScheduledEmailMessage,
  QualificationScheduledEmailApprovalConflict,
} from "./qualification/scheduled-email-journey";
import { ProductAuthorityExportBoundary } from "./qualification/semantic-evidence";
import { r2ObjectEvidence } from "./qualification/r2-object-evidence";
import { FaultControllerReceiptBoundary } from "./qualification/qualification-runs";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and qualification contracts use _tag as their closed-union discriminator. */
/* oxlint-disable effecttsgo/async-function -- Cloudflare, R2, and postgres.js are Promise-native host boundaries. */
/* oxlint-disable effecttsgo/global-date -- This authorized Worker boundary observes host time and adapts frozen epoch timestamps. */

type QualificationAuthorityRecord = object;

const QualificationAuthorityOccurredAt = Schema.Struct({ occurredAt: Schema.String });
const ControlledAgentFaultAuthorityShard = Schema.Struct({
  artifactId: Schema.String,
  authority: Schema.Literal("qualification_fault_controller_receipts"),
  checksum: Schema.String,
  executionId: Schema.String,
  exportedAtUtc: Schema.String,
  index: Schema.Literal(0),
  planChecksum: Schema.String,
  previousArtifactChecksum: Schema.Literal("NONE"),
  recordCount: Schema.Int,
  records: Schema.Array(FaultControllerReceiptBoundary),
  sourceVersion: Schema.String,
  streamChunkIndex: Schema.Int,
});

const ExecuteArrivalInvocation = Schema.Struct({
  ...QualificationProductAuthorityInvocation.fields,
  arrivalIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.String,
});
const ExecuteArrivalChunkInvocation = Schema.Struct({
  ...QualificationProductAuthorityInvocation.fields,
  chunkIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.String,
});
const ExecuteArrivalComplete = Schema.Struct({
  receipt: QualificationAdmissionReceipt,
  status: Schema.Literal("COMPLETE"),
});
const AuthorityArrivalRecord = Schema.Struct({
  admissionReceipt: QualificationAdmissionReceipt,
  arrival: Schema.Unknown,
  attemptId: Schema.String,
  authorityFactId: Schema.String,
  executedAtUtc: Schema.String,
  executionId: Schema.String,
  rootId: Schema.String,
  submittedAtUtc: Schema.String,
});
const AuthorityArrivalShard = Schema.Struct({
  bodyChecksum: Schema.String,
  chunkIndex: Schema.Int,
  executionId: Schema.String,
  planChecksum: Schema.String,
  previousArtifactChecksum: Schema.String,
  records: Schema.Array(AuthorityArrivalRecord),
  runId: Schema.String,
  streamChunkIndex: Schema.Int,
});
const decodeInvocation = Schema.decodeUnknownOption(
  Schema.fromJsonString(QualificationProductAuthorityInvocation),
);
const decodeExecuteArrival = Schema.decodeUnknownOption(
  Schema.fromJsonString(ExecuteArrivalInvocation),
);
const decodeExecuteArrivalChunk = Schema.decodeUnknownOption(
  Schema.fromJsonString(ExecuteArrivalChunkInvocation),
);
const decodeCollectSourceChunk = Schema.decodeUnknownOption(
  Schema.fromJsonString(QualificationProductAuthoritySourceChunkInvocation),
);
const decodeQualificationJourney = Schema.decodeUnknownOption(QualificationContext.fields.journey);
const decodeExecuteArrivalComplete = Schema.decodeUnknownOption(ExecuteArrivalComplete);
const decodeAuthorityArrivalShard = Schema.decodeUnknownOption(
  Schema.fromJsonString(AuthorityArrivalShard),
);
const QualificationCohortInventoryReceipt = Schema.Struct({
  artifactChecksum: Schema.String,
  artifactId: Schema.String,
  cohortChecksum: Schema.String,
  executionId: Schema.String,
  inventoryChecksum: Schema.String,
  manifestChecksum: Schema.String,
  participantCounts: Schema.Struct({ adventurer: Schema.Int, free: Schema.Int }),
  planChecksum: Schema.String,
  verifiedAtUtc: Schema.String,
});
const decodeInventoryReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(QualificationCohortInventoryReceipt),
);
const decodeDocumentObjectReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(DocumentQualificationAuthority.QualificationDocumentObjectReceipt),
);

interface FrozenExecution {
  readonly cohortArtifactChecksum: string;
  readonly cohortArtifactId: string;
  readonly invocation: QualificationProductAuthorityInvocation;
  readonly manifest: ProductionQualificationManifest;
  readonly plan: QualificationExecutionPlan;
}

export interface QualificationProductAuthorityEnv {
  readonly ARTIFACTS: QualificationProductAuthorityArtifactBucket;
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly OSFO_DIRECTORY?: DurableObjectNamespace<OsfoDirectory>;
}

export interface QualificationProductAuthorityArtifactBucket {
  readonly head?: (key: string) => Promise<QualificationProductAuthorityHeadObject | null>;
  readonly get: (key: string) => Promise<{
    readonly customMetadata?: Readonly<Record<string, string>> | undefined;
    readonly text: () => Promise<string>;
  } | null>;
  readonly list: (options: {
    readonly cursor?: string;
    readonly include?: Array<"customMetadata" | "httpMetadata">;
    readonly limit: number;
    readonly prefix: string;
  }) => Promise<{
    readonly cursor?: string | undefined;
    readonly objects: ReadonlyArray<{
      readonly checksums: { readonly toJSON: () => { readonly sha256?: string | undefined } };
      readonly customMetadata?: Readonly<Record<string, string>> | undefined;
      readonly key: string;
    }>;
    readonly truncated: boolean;
  }>;
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Record<string, string>;
      readonly httpMetadata: { readonly contentType: string };
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
    },
  ) => Promise<object | null>;
}

interface QualificationProductAuthorityHeadObject {
  readonly checksums: {
    readonly sha256?: ArrayBuffer;
    readonly toJSON: () => { readonly sha256?: string };
  };
  readonly customMetadata?: Record<string, string>;
  readonly etag: string;
  readonly key: string;
  readonly size: number;
  readonly storageClass: string;
  readonly uploaded: Date;
  readonly version: string;
}

interface MissingSource {
  readonly detail: string;
  readonly source: (typeof qualificationAuthoritySources)[number];
}

type QualificationDocumentR2AuthorityOutcome =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing"; readonly rootId: string }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Ready"; readonly records: ReadonlyArray<QualificationAuthorityRecord> };

type QualificationDocumentR2Build = Pick<
  DocumentBuild.Record,
  | "artifactAccountedAt"
  | "artifactContentId"
  | "qualificationContext"
  | "request"
  | "state"
  | "workflowId"
>;

interface QualificationDocumentAttemptIdentity {
  readonly admissionDecision: string | null;
  readonly admissionFactId: string | null;
  readonly agentId: string;
  readonly allowancePeriodId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly journey: string;
  readonly offeredAt: Date;
  readonly planChecksum: string;
  readonly rootId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly state: string;
  readonly submissionId: string;
  readonly userId: string;
}

const cohortInventoryReceiptArtifactId = (executionId: string): string =>
  `qualification/executions/${encodeURIComponent(executionId)}/cohort/inventory-receipt.json`;

const authorityArrivalStreamPrefix = (executionId: string): string =>
  `qualification/executions/${encodeURIComponent(executionId)}/authority-streams/arrivals`;

const authorityArrivalStreamArtifactId = (executionId: string, streamChunkIndex: number): string =>
  `${authorityArrivalStreamPrefix(executionId)}/partitions/${streamChunkIndex.toString().padStart(8, "0")}/00000000.json`;

const productAuthorityShardArtifactId = (
  executionId: string,
  source: (typeof qualificationAuthoritySources)[number],
  streamChunkIndex: number,
): string =>
  `qualification/executions/${encodeURIComponent(executionId)}/producer-authority/${source}/partitions/${streamChunkIndex.toString().padStart(8, "0")}/00000000.json`;

const sha256Hex = async (encoded: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const workerAuthorityRecordsFromArrivals = (
  records: ReadonlyArray<typeof AuthorityArrivalRecord.Type>,
) =>
  records.map(({ admissionReceipt: receipt }) => ({
    acceptanceReceiptId: receipt.acceptanceReceiptId,
    admissionDecision: receipt.admissionDecision,
    effectReceipts: [],
    occurredAt: receipt.occurredAt,
    productFactId: receipt.productFactId,
    rootId: receipt.rootId,
    stageOccurrences: [
      {
        boundary: "durableAcceptanceCommitted" as const,
        occurredAt: receipt.occurredAt,
        productFactId: receipt.productFactId,
      },
    ],
    usageFacts: [],
    userMessageId: receipt.userMessageId,
    userUpdateId: receipt.userUpdateId,
  }));

const thinkAuthorityRecordsFromArrivals = (
  records: ReadonlyArray<typeof AuthorityArrivalRecord.Type>,
) =>
  records.flatMap(({ admissionReceipt: receipt }) =>
    receipt.admissionDecision === "accepted" && receipt.thinkSubmissionId !== null
      ? [
          {
            acceptanceReceiptId: receipt.acceptanceReceiptId,
            effectReceipts: [
              { effectId: receipt.thinkSubmissionId, kind: "thinkSubmissions" as const },
            ],
            occurredAt: receipt.occurredAt,
            productFactId: qualificationChecksum({
              acceptanceReceiptId: receipt.acceptanceReceiptId,
              source: "think_submission_receipts",
              thinkSubmissionId: receipt.thinkSubmissionId,
            }),
            rootId: receipt.rootId,
            stageOccurrences: [],
            submissionStatus: "accepted" as const,
            thinkSubmissionId: receipt.thinkSubmissionId,
            usageFacts: [],
          },
        ]
      : [],
  );

export const retainQualificationProductAuthorityShard = async (input: {
  readonly bucket: QualificationProductAuthorityArtifactBucket;
  readonly executionId: string;
  readonly planChecksum: string;
  readonly records: ReadonlyArray<QualificationAuthorityRecord>;
  readonly source: (typeof qualificationAuthoritySources)[number];
  readonly sourceVersion: string;
  readonly startsAtEpochMs: number;
  readonly streamChunkIndex: number;
}): Promise<boolean> => {
  const artifactId = productAuthorityShardArtifactId(
    input.executionId,
    input.source,
    input.streamChunkIndex,
  );
  const exportedAtUtc = input.records.reduce((latest, record) => {
    const decoded = Schema.decodeUnknownOption(QualificationAuthorityOccurredAt)(record);
    return Option.isSome(decoded) && decoded.value.occurredAt > latest
      ? decoded.value.occurredAt
      : latest;
  }, new Date(input.startsAtEpochMs).toISOString());
  const previousArtifactChecksum = "NONE";
  const content = {
    artifactId,
    authority: input.source,
    executionId: input.executionId,
    exportedAtUtc,
    index: 0,
    planChecksum: input.planChecksum,
    previousArtifactChecksum,
    recordCount: input.records.length,
    records: input.records,
    sourceVersion: input.sourceVersion,
    streamChunkIndex: input.streamChunkIndex,
  };
  const artifact = { ...content, checksum: qualificationChecksum(content) };
  const encoded = canonicalQualificationJson(artifact);
  const retained = await input.bucket.put(artifactId, encoded, {
    customMetadata: {
      "osfo-artifact-checksum": artifact.checksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-execution-id": input.executionId,
      "osfo-index": "0",
      "osfo-kind": "qualification-product-authority-export-v1",
      "osfo-plan-checksum": input.planChecksum,
      "osfo-previous-checksum": previousArtifactChecksum,
      "osfo-record-count": String(input.records.length),
      "osfo-source": input.source,
      "osfo-source-version": input.sourceVersion,
      "osfo-stream-chunk-index": String(input.streamChunkIndex),
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained === null) {
    const conflicted = await input.bucket.get(artifactId);
    return conflicted !== null && (await conflicted.text()) === encoded;
  }
  const existing = await input.bucket.get(artifactId);
  return existing !== null && (await existing.text()) === encoded;
};

type RetainedProductAuthorityShard =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Ready";
      readonly recordCount: number;
      readonly records: (typeof ProductAuthorityExportBoundary.Type)["records"];
    };

const readRetainedProductAuthorityShard = async (input: {
  readonly env: QualificationProductAuthorityEnv;
  readonly frozen: FrozenExecution;
  readonly runId: string;
  readonly chunkIndex: number;
  readonly source: QualificationArrivalReadbackAuthoritySource;
  readonly streamChunkIndex: number;
}): Promise<RetainedProductAuthorityShard> => {
  const { env, frozen, source, streamChunkIndex } = input;
  const artifactId = productAuthorityShardArtifactId(
    frozen.plan.executionId,
    source,
    streamChunkIndex,
  );
  const prefix = artifactId.slice(0, artifactId.lastIndexOf("/") + 1);
  const inventory = await env.ARTIFACTS.list({
    include: ["customMetadata"],
    limit: 2,
    prefix,
  });
  if (
    inventory.truncated ||
    inventory.objects.length > 1 ||
    (inventory.objects.length === 1 && inventory.objects[0]?.key !== artifactId)
  ) {
    return { _tag: "Conflict" };
  }
  if (inventory.objects.length === 0) return { _tag: "Missing" };
  const object = await env.ARTIFACTS.get(artifactId);
  if (object === null) return { _tag: "Missing" };
  const encoded = await object.text();
  const decoded = Schema.decodeOption(Schema.fromJsonString(ProductAuthorityExportBoundary))(
    encoded,
  );
  if (Option.isNone(decoded)) return { _tag: "Conflict" };
  const shard = decoded.value;
  const { checksum, ...content } = shard;
  const expectedBodySha256 = await sha256Hex(encoded);
  const metadataMatches = (metadata: Readonly<Record<string, string>> | undefined) =>
    metadata?.["osfo-artifact-checksum"] === checksum &&
    metadata["osfo-body-sha256"] === expectedBodySha256 &&
    metadata["osfo-execution-id"] === frozen.plan.executionId &&
    metadata["osfo-index"] === "0" &&
    metadata["osfo-kind"] === "qualification-product-authority-export-v1" &&
    metadata["osfo-plan-checksum"] === frozen.plan.planChecksum &&
    metadata["osfo-previous-checksum"] === "NONE" &&
    metadata["osfo-record-count"] === String(shard.records.length) &&
    metadata["osfo-source"] === source &&
    metadata["osfo-source-version"] === frozen.manifest.sourceVersion &&
    metadata["osfo-stream-chunk-index"] === String(streamChunkIndex);
  const exact =
    shard.artifactId === artifactId &&
    shard.authority === source &&
    shard.executionId === frozen.plan.executionId &&
    shard.planChecksum === frozen.plan.planChecksum &&
    shard.index === 0 &&
    shard.previousArtifactChecksum === "NONE" &&
    shard.recordCount === shard.records.length &&
    shard.sourceVersion === frozen.manifest.sourceVersion &&
    shard.streamChunkIndex === streamChunkIndex &&
    checksum === qualificationChecksum(content) &&
    metadataMatches(object.customMetadata) &&
    metadataMatches(inventory.objects[0]?.customMetadata);
  if (!exact) return { _tag: "Conflict" };

  const run = frozen.plan.runs.find(({ runId }) => runId === input.runId);
  if (run === undefined) return { _tag: "Conflict" };
  const firstArrivalIndex = input.chunkIndex * 256;
  const expectedArrivals = Array.from(
    { length: Math.min(256, run.arrivalCount - firstArrivalIndex) },
    (_, offset) => qualificationRunArrivalAt(frozen.manifest, run, firstArrivalIndex + offset),
  );
  if (expectedArrivals.some((expectedArrival) => expectedArrival === undefined)) {
    return { _tag: "Conflict" };
  }
  const arrivalObject = await env.ARTIFACTS.get(
    authorityArrivalStreamArtifactId(frozen.plan.executionId, streamChunkIndex),
  );
  if (arrivalObject === null) return { _tag: "Missing" };
  const encodedArrival = await arrivalObject.text();
  const arrival = decodeAuthorityArrivalShard(encodedArrival);
  if (
    Option.isNone(arrival) ||
    arrival.value.chunkIndex !== input.chunkIndex ||
    arrival.value.executionId !== frozen.plan.executionId ||
    arrival.value.planChecksum !== frozen.plan.planChecksum ||
    arrival.value.runId !== input.runId ||
    arrival.value.streamChunkIndex !== streamChunkIndex ||
    arrival.value.records.length !== expectedArrivals.length ||
    arrival.value.records.some((record, index) => {
      const expectedArrival = expectedArrivals[index];
      const receipt = record.admissionReceipt;
      const { artifactChecksum: _artifactChecksum, ...receiptContent } = receipt;
      const expectedProductFactId = qualificationChecksum({
        admissionDecision: receipt.admissionDecision,
        agentId: receipt.agentId,
        attemptId: receipt.attemptId,
        executionId: receipt.executionId,
        planChecksum: receipt.planChecksum,
        rootId: receipt.rootId,
        runId: receipt.runId,
      });
      return (
        expectedArrival === undefined ||
        !Predicate.isObject(record.arrival) ||
        qualificationChecksum(record.arrival) !== qualificationChecksum(expectedArrival) ||
        record.attemptId !==
          qualificationChecksum({
            executionId: frozen.plan.executionId,
            planChecksum: frozen.plan.planChecksum,
            rootId: expectedArrival.rootId,
            runId: input.runId,
          }) ||
        record.authorityFactId !== receipt.productFactId ||
        record.executionId !== frozen.plan.executionId ||
        record.rootId !== expectedArrival.rootId ||
        receipt.artifactChecksum !== qualificationChecksum(receiptContent) ||
        receipt.acceptanceReceiptId !== expectedProductFactId ||
        receipt.attemptId !== record.attemptId ||
        receipt.executionId !== frozen.plan.executionId ||
        receipt.planChecksum !== frozen.plan.planChecksum ||
        receipt.productFactId !== expectedProductFactId ||
        receipt.rootId !== expectedArrival.rootId ||
        receipt.runId !== input.runId ||
        receipt.userUpdateId !== expectedProductFactId ||
        (receipt.admissionDecision === "accepted") !== (receipt.thinkSubmissionId !== null) ||
        Date.parse(record.submittedAtUtc) < expectedArrival.offeredAtEpochMs ||
        Date.parse(record.executedAtUtc) < Date.parse(record.submittedAtUtc)
      );
    }) ||
    (await authorityShardDescriptor(frozen, encodedArrival, arrival.value)) === null
  ) {
    return { _tag: "Conflict" };
  }
  const expectedRecords =
    source === "worker_admission_receipts"
      ? workerAuthorityRecordsFromArrivals(arrival.value.records)
      : thinkAuthorityRecordsFromArrivals(arrival.value.records);
  if (
    expectedRecords.length !== shard.records.length ||
    expectedRecords.some((record, index) => {
      const retainedRecord = shard.records[index];
      return (
        retainedRecord === undefined ||
        qualificationChecksum(record) !== qualificationChecksum(retainedRecord)
      );
    })
  ) {
    return { _tag: "Conflict" };
  }
  const expectedRootIds = expectedArrivals.map((expectedArrival) => expectedArrival?.rootId);
  const actualRootIds = shard.records.map(({ rootId }) => rootId);
  const rootsAreExact =
    source === "worker_admission_receipts"
      ? actualRootIds.length === expectedRootIds.length &&
        actualRootIds.every((rootId, index) => rootId === expectedRootIds[index])
      : new Set(actualRootIds).size === actualRootIds.length &&
        actualRootIds.every((rootId) => expectedRootIds.includes(rootId));
  return rootsAreExact
    ? { _tag: "Ready", recordCount: shard.records.length, records: shard.records }
    : { _tag: "Conflict" };
};

const retainProductAuthorityShard = (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  source: (typeof qualificationAuthoritySources)[number],
  streamChunkIndex: number,
  records: ReadonlyArray<QualificationAuthorityRecord>,
) =>
  retainQualificationProductAuthorityShard({
    bucket: env.ARTIFACTS,
    executionId: frozen.plan.executionId,
    planChecksum: frozen.plan.planChecksum,
    records,
    source,
    sourceVersion: frozen.manifest.sourceVersion,
    startsAtEpochMs: frozen.plan.startsAtEpochMs,
    streamChunkIndex,
  });

const streamRuns = (
  plan: QualificationExecutionPlan,
  manifest: ProductionQualificationManifest,
) => {
  let firstStreamChunkIndex = 0;
  return plan.runs.map((run) => {
    const chunkCount = Math.ceil(run.arrivalCount / 256);
    const descriptor = {
      arrivalCount: run.arrivalCount,
      chunkStartsAtEpochMs: Array.from(
        { length: chunkCount },
        (_, chunkIndex) =>
          qualificationRunArrivalAt(manifest, run, chunkIndex * 256)?.offeredAtEpochMs ??
          run.startsAtEpochMs,
      ),
      chunkCount,
      firstStreamChunkIndex,
      runId: run.runId,
    };
    firstStreamChunkIndex += chunkCount;
    return descriptor;
  });
};

const readExactCohort = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
): Promise<QualificationCohortManifest | null> => {
  const expectedArtifactId = qualificationCohortArtifactId(frozen.plan.executionId);
  if (frozen.cohortArtifactId !== expectedArtifactId) return null;
  const object = await env.ARTIFACTS.get(expectedArtifactId);
  if (object === null) return null;
  const cohort = decodeQualificationCohortManifest(await object.text());
  if (cohort === null) return null;
  const now = Date.now();
  return cohort.artifactChecksum === frozen.cohortArtifactChecksum &&
    cohort.executionId === frozen.plan.executionId &&
    cohort.manifestChecksum === frozen.manifest.manifestChecksum &&
    cohort.planChecksum === frozen.plan.planChecksum &&
    cohort.sourceVersion === frozen.manifest.sourceVersion &&
    cohort.participantCounts.adventurer === frozen.manifest.corpus.registeredUsers / 10 &&
    cohort.participantCounts.free ===
      frozen.manifest.corpus.registeredUsers - frozen.manifest.corpus.registeredUsers / 10 &&
    Date.parse(cohort.notBeforeUtc) <= now &&
    now < Date.parse(cohort.expiresAtUtc)
    ? cohort
    : null;
};

const verifyCohortInventory = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
): Promise<"CONFLICT" | "MISSING" | "READY"> => {
  const cohort = await readExactCohort(env, frozen);
  if (cohort === null) return "MISSING";
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 2, prepare: true });
  try {
    const authority = makeQualificationCohortAuthority(createDb(client));
    const inventory = await Effect.runPromise(authority.inspectInventory(cohort));
    if (!Predicate.isTagged(inventory, "Ready")) {
      return Predicate.isTagged(inventory, "Conflict") ? "CONFLICT" : "MISSING";
    }
    let inventoryChecksum = qualificationChecksum({
      cohortChecksum: cohort.artifactChecksum,
      executionId: frozen.plan.executionId,
    });
    for (const plan of ["adventurer", "free"] as const) {
      const expectedCount = cohort.participantCounts[plan];
      let afterIndex = -1;
      let cursor: string | undefined;
      let verifiedCount = 0;
      while (verifiedCount < expectedCount) {
        const cursorFields = cursor === undefined ? {} : { cursor };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cohort inventory is page-verified in canonical order with bounded memory.
        const page = await env.ARTIFACTS.list({
          ...cursorFields,
          include: ["customMetadata"],
          limit: Math.min(1_000, expectedCount - verifiedCount),
          prefix: `${cohort.grantPrefix}/${plan}/`,
        });
        if (page.objects.length === 0) return "MISSING";
        // oxlint-disable-next-line eslint/no-await-in-loop -- PostgreSQL authority pages are joined to the corresponding immutable R2 page.
        const allocations = await Effect.runPromise(
          authority.listInventoryPage({
            afterIndex,
            cohortId: cohort.cohortId,
            limit: page.objects.length,
            plan,
          }),
        );
        if (allocations.length !== page.objects.length) return "MISSING";
        const pageFacts = page.objects.map((object, offset) => {
          const allocation = allocations[offset];
          if (allocation === undefined) return null;
          const expectedIndex = verifiedCount + offset;
          const metadata = object.customMetadata;
          const sha256 = object.checksums.toJSON().sha256;
          const exact =
            allocation.index === expectedIndex &&
            allocation.grantId === object.key &&
            object.key === qualificationParticipantGrantArtifactId(cohort, plan, expectedIndex) &&
            metadata?.["osfo-kind"] === "qualification-participant-grant-v1" &&
            metadata["osfo-cohort-id"] === cohort.cohortId &&
            metadata["osfo-execution-id"] === frozen.plan.executionId &&
            metadata["osfo-plan"] === plan &&
            metadata["osfo-index"] === String(expectedIndex) &&
            metadata["osfo-user-id"] === allocation.userId &&
            metadata["osfo-agent-id"] === allocation.agentId &&
            metadata["osfo-session-id"] === allocation.sessionId &&
            metadata["osfo-grant-checksum"] === allocation.grantChecksum &&
            metadata["osfo-provision-id"] === allocation.provisionId &&
            metadata["osfo-provision-checksum"] === allocation.provisionChecksum &&
            sha256 !== undefined &&
            metadata["osfo-body-sha256"] === sha256;
          return exact
            ? {
                bodySha256: sha256,
                grantChecksum: allocation.grantChecksum,
                index: expectedIndex,
                key: object.key,
                provisionChecksum: allocation.provisionChecksum,
              }
            : null;
        });
        if (pageFacts.some((fact) => fact === null)) return "CONFLICT";
        inventoryChecksum = qualificationChecksum({ inventoryChecksum, pageFacts, plan });
        verifiedCount += page.objects.length;
        afterIndex = verifiedCount - 1;
        if (page.truncated) {
          cursor = page.cursor;
          if (cursor === undefined) return "CONFLICT";
        } else {
          cursor = undefined;
          if (verifiedCount !== expectedCount) return "MISSING";
        }
      }
      if (cursor !== undefined || verifiedCount !== expectedCount) return "CONFLICT";
    }
    const artifactId = cohortInventoryReceiptArtifactId(frozen.plan.executionId);
    const content = {
      artifactId,
      cohortChecksum: cohort.artifactChecksum,
      executionId: frozen.plan.executionId,
      inventoryChecksum,
      manifestChecksum: frozen.manifest.manifestChecksum,
      participantCounts: cohort.participantCounts,
      planChecksum: frozen.plan.planChecksum,
      verifiedAtUtc: inventory.verifiedAt.toISOString(),
    };
    const receipt = { ...content, artifactChecksum: qualificationChecksum(content) };
    const encoded = canonicalQualificationJson(receipt);
    const retained = await env.ARTIFACTS.put(artifactId, encoded, {
      customMetadata: {
        "osfo-execution-id": frozen.plan.executionId,
        "osfo-inventory-checksum": inventoryChecksum,
        "osfo-kind": "qualification-cohort-inventory-v1",
      },
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (retained !== null) return "READY";
    const existing = await env.ARTIFACTS.get(artifactId);
    return existing !== null && (await existing.text()) === encoded ? "READY" : "CONFLICT";
  } finally {
    await client.end();
  }
};

const hasExactCohortInventoryReceipt = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
): Promise<boolean> => {
  const artifactId = cohortInventoryReceiptArtifactId(frozen.plan.executionId);
  const retained = await env.ARTIFACTS.get(artifactId);
  if (retained === null) return false;
  const decoded = decodeInventoryReceipt(await retained.text());
  if (Option.isNone(decoded)) return false;
  const { artifactChecksum, ...content } = decoded.value;
  const expectedAdventurer = frozen.manifest.corpus.registeredUsers / 10;
  return (
    artifactChecksum === qualificationChecksum(content) &&
    content.artifactId === artifactId &&
    content.executionId === frozen.plan.executionId &&
    content.cohortChecksum === frozen.cohortArtifactChecksum &&
    content.manifestChecksum === frozen.manifest.manifestChecksum &&
    content.planChecksum === frozen.plan.planChecksum &&
    content.participantCounts.adventurer === expectedAdventurer &&
    content.participantCounts.free === frozen.manifest.corpus.registeredUsers - expectedAdventurer
  );
};

const readFrozenExecution = async (
  invocation: QualificationProductAuthorityInvocation,
  env: QualificationProductAuthorityEnv,
): Promise<FrozenExecution | null> => {
  const expectedArtifactId = `qualification/executions/${encodeURIComponent(invocation.executionId)}/owner-request.json`;
  if (invocation.requestArtifactId !== expectedArtifactId) return null;
  const retained = await env.ARTIFACTS.get(expectedArtifactId);
  if (retained === null) return null;
  const frozen = decodeFrozenQualificationExecution(await retained.text(), invocation);
  return frozen === null ? null : { ...frozen, invocation };
};

const attemptOwnedSources = async (
  env: QualificationProductAuthorityEnv,
  executionId: string,
): Promise<ReadonlyArray<MissingSource>> => {
  const missing: Array<MissingSource> = [];
  const sql = postgres(env.DB.connectionString, { fetch_types: false, max: 1, prepare: true });
  try {
    const [tables] = await sql<
      ReadonlyArray<{
        readonly allowanceUsage: boolean;
        readonly allowanceZeroUsageEvidence: boolean;
        readonly qualificationRootAttempts: boolean;
        readonly scheduledEmails: boolean;
      }>
    >`
      select
        to_regclass('public.allowance_usage') is not null as "allowanceUsage",
        to_regclass('public.allowance_zero_usage_evidence') is not null as "allowanceZeroUsageEvidence",
        to_regclass('public.qualification_root_attempts') is not null as "qualificationRootAttempts",
        to_regclass('public.scheduled_emails') is not null as "scheduledEmails"
    `;
    if (tables?.qualificationRootAttempts !== true) {
      for (const source of qualificationAuthoritySourcesRequiring("attemptIndexTable")) {
        missing.push({
          detail: "The qualification_root_attempts correlation authority is unavailable",
          source,
        });
      }
    }
    if (!tables?.allowanceUsage || !tables.allowanceZeroUsageEvidence) {
      for (const source of qualificationAuthoritySourcesRequiring("allowanceTables")) {
        missing.push({
          detail: "The shared Allowance usage and zero-use authority tables are unavailable",
          source,
        });
      }
    }
    if (tables?.scheduledEmails !== true) {
      for (const source of qualificationAuthoritySourcesRequiring("scheduledEmailTable")) {
        missing.push({
          detail: "The Scheduled Email PostgreSQL authority table is unavailable",
          source,
        });
      }
    }
  } catch {
    for (const source of qualificationAuthoritySourcesRequiring("postgresBinding")) {
      missing.push({
        detail: "The PostgreSQL qualification authority could not be read",
        source,
      });
    }
  } finally {
    await sql.end();
  }

  if (env.OSFO_DIRECTORY === undefined) {
    for (const source of qualificationAuthoritySourcesRequiring("directoryBinding")) {
      missing.push({
        detail: "The Agent Directory qualification authority binding is unavailable",
        source,
      });
    }
  }

  try {
    await env.ARTIFACTS.list({
      limit: 1,
      prefix: `qualification/executions/${encodeURIComponent(executionId)}/`,
    });
  } catch {
    for (const source of qualificationAuthoritySourcesRequiring("artifactBucket")) {
      missing.push({
        detail: "The immutable qualification artifact transport could not be listed",
        source,
      });
    }
  }
  return missing;
};

const coverageMissingSources = (
  manifest: ProductionQualificationManifest,
): ReadonlyArray<MissingSource> =>
  qualificationAuthorityCoverageGaps(manifest).map(
    ({ activationCause, component, faultKind, faultScope, journey, source }) => ({
      detail:
        activationCause !== undefined
          ? `No production-owned ${source} adapter proves the ${activationCause} activation cause`
          : faultKind !== undefined
            ? `No production-owned ${source} adapter proves ${faultKind}${faultScope === undefined ? "" : `/${faultScope}`}`
            : journey === null
              ? `No production-owned ${source} adapter covers the frozen ${component} authority`
              : `No production-owned ${source} adapter covers ${journey}/${component}`,
      source,
    }),
  );

const canonicalMissingSources = (
  missing: ReadonlyArray<MissingSource>,
): ReadonlyArray<MissingSource> => {
  const seen = new Set<string>();
  return qualificationAuthoritySources
    .flatMap((source) => missing.filter((candidate) => candidate.source === source))
    .filter(({ detail, source }) => {
      const identity = `${source}\u0000${detail}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
};

const unsupportedExecutionResponse = (
  manifest: ProductionQualificationManifest,
): Response | null => {
  const missingSources = coverageMissingSources(manifest);
  return missingSources.length === 0
    ? null
    : Response.json(
        { missingSources: canonicalMissingSources(missingSources), status: "MISSING" },
        { status: 424 },
      );
};

const messageForJourney = (journey: QualificationContext["journey"]): string => {
  switch (journey) {
    case "accountBillingSafetyDataRights":
      return "Show my current plan usage and explain how I can permanently delete my account.";
    case "documentBuild":
      return "Build a concise document from my retained source files and report the durable outcome.";
    case "fileAnalysis":
      return "Analyze my newest retained text file and summarize the supported findings.";
    case "gmail":
      return "Find the newest relevant Gmail message and summarize it without sending anything.";
    case "ordinaryConversation":
      return "Summarize the latest request in this conversation in one concise sentence.";
    case "registration":
      return "Confirm that my registered Osfo workspace is ready and name the current session.";
    case "reminder":
      return "Create a reminder for tomorrow and report when its durable schedule is accepted.";
    case "researchReport":
      return "Create a short research report about Cloudflare Workers reliability patterns.";
    case "scheduledEmail":
      return "Schedule the exact protected Gmail message in this qualification request.";
  }
  return journey;
};

const retainAttemptAuthority = async (
  bucket: QualificationProductAuthorityArtifactBucket,
  artifact: QualificationConversationAttemptArtifact,
): Promise<{ readonly artifactChecksum: string; readonly artifactId: string } | null> => {
  const artifactId = qualificationAttemptArtifactId(artifact.context);
  const encoded = canonicalQualificationJson(artifact);
  const retained = await bucket.put(artifactId, encoded, {
    customMetadata: {
      "osfo-attempt-id": artifact.context.attemptId,
      "osfo-execution-id": artifact.context.executionId,
      "osfo-kind": "qualification-attempt-authority-v1",
      "osfo-plan-checksum": artifact.context.planChecksum,
      "osfo-root-id": artifact.context.rootId,
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return { artifactChecksum: artifact.artifactChecksum, artifactId };
  const existing = await bucket.get(artifactId);
  return existing !== null && (await existing.text()) === encoded
    ? { artifactChecksum: artifact.artifactChecksum, artifactId }
    : null;
};

const controlledColdActivationRun = (run: QualificationExecutionRun): boolean =>
  run.kind === "challenge" &&
  run.challenge === "coldActivation" &&
  run.arrivalCount === 1 &&
  run.fault?.kind === "coldActivation" &&
  run.fault.target === "osfoAgent" &&
  run.fault.trigger === "beforeOffer";

const controlledAgentRecoveryArtifactId = (controllerOperationId: string) =>
  `qualification/fault-controller/${encodeURIComponent(controllerOperationId)}.json`;

export const controlledAgentFaultPreparedBeforeOffer = (input: {
  readonly appliedAtUtc: string;
  readonly offeredAtEpochMs: number;
  readonly recoveredAtUtc: string;
}): boolean => {
  const appliedAtEpochMs = Date.parse(input.appliedAtUtc);
  const recoveredAtEpochMs = Date.parse(input.recoveredAtUtc);
  return (
    Number.isFinite(appliedAtEpochMs) &&
    Number.isFinite(recoveredAtEpochMs) &&
    appliedAtEpochMs <= recoveredAtEpochMs &&
    recoveredAtEpochMs <= input.offeredAtEpochMs
  );
};

const retainControlledAgentRecoveryAuthority = async (
  bucket: QualificationProductAuthorityArtifactBucket,
  receipt: QualificationControlledAgentRecoveryReceipt,
): Promise<boolean> => {
  const artifactId = controlledAgentRecoveryArtifactId(receipt.controllerOperationId);
  const encoded = canonicalQualificationJson(receipt);
  const retained = await bucket.put(artifactId, encoded, {
    customMetadata: {
      "osfo-artifact-checksum": receipt.artifactChecksum,
      "osfo-body-sha256": await sha256Hex(encoded),
      "osfo-controller-operation-id": receipt.controllerOperationId,
      "osfo-execution-id": receipt.executionId,
      "osfo-kind": "qualification-controlled-agent-recovery-v1",
      "osfo-plan-checksum": receipt.planChecksum,
      "osfo-root-id": receipt.rootId,
      "osfo-run-id": receipt.runId,
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained !== null) return true;
  const existing = await bucket.get(artifactId);
  return existing !== null && (await existing.text()) === encoded;
};

const executeArrival = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  arrivalIndex: number,
  mode: "execute" | "prepareControlledFault" = "execute",
): Promise<Response> => {
  if (!(await hasExactCohortInventoryReceipt(env, frozen))) {
    return Response.json(
      {
        missingSources: [
          {
            detail: "The complete frozen disposable cohort inventory has not been verified",
            source: "osfo_agent_activation_log",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const run = frozen.plan.runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) {
    return Response.json({ error: "qualificationRunNotFound" }, { status: 409 });
  }
  if (mode === "prepareControlledFault" && !controlledColdActivationRun(run)) {
    return Response.json({ status: "NOT_REQUIRED" });
  }
  const arrival = qualificationRunArrivalAt(frozen.manifest, run, arrivalIndex);
  if (arrival === undefined) {
    return Response.json({ error: "qualificationArrivalNotFound" }, { status: 409 });
  }
  const journey = "journey" in arrival ? arrival.journey : "ordinaryConversation";
  const requiredPlan = "plan" in arrival ? arrival.plan : "free";
  const expectedCohortArtifactId = qualificationCohortArtifactId(frozen.plan.executionId);
  const cohortObject =
    frozen.cohortArtifactId === expectedCohortArtifactId
      ? await env.ARTIFACTS.get(expectedCohortArtifactId)
      : null;
  const cohort =
    cohortObject === null ? null : decodeQualificationCohortManifest(await cohortObject.text());
  const expectedAdventurerCount = frozen.manifest.corpus.registeredUsers / 10;
  if (
    cohort === null ||
    cohort.artifactChecksum !== frozen.cohortArtifactChecksum ||
    cohort.executionId !== frozen.plan.executionId ||
    cohort.manifestChecksum !== frozen.manifest.manifestChecksum ||
    cohort.planChecksum !== frozen.plan.planChecksum ||
    cohort.sourceVersion !== frozen.manifest.sourceVersion ||
    cohort.participantCounts.adventurer !== expectedAdventurerCount ||
    cohort.participantCounts.free !==
      frozen.manifest.corpus.registeredUsers - expectedAdventurerCount ||
    Date.parse(cohort.notBeforeUtc) > Date.now() ||
    Date.parse(cohort.expiresAtUtc) <= Date.now()
  ) {
    return Response.json(
      {
        missingSources: [
          {
            detail: "The exact frozen disposable qualification cohort is unavailable",
            source: "osfo_agent_activation_log",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const participantIndex = arrivalIndex % cohort.participantCounts[requiredPlan];
  const grantObject = await env.ARTIFACTS.get(
    qualificationParticipantGrantArtifactId(cohort, requiredPlan, participantIndex),
  );
  const participant =
    grantObject === null ? null : decodeQualificationParticipantGrant(await grantObject.text());
  if (
    participant === null ||
    participant.cohortChecksum !== cohort.artifactChecksum ||
    participant.cohortId !== cohort.cohortId ||
    participant.executionId !== frozen.plan.executionId ||
    participant.index !== participantIndex ||
    participant.plan !== requiredPlan ||
    participant.expiresAtUtc !== cohort.expiresAtUtc ||
    participant.notBeforeUtc !== cohort.notBeforeUtc ||
    Date.parse(participant.notBeforeUtc) > Date.now() ||
    Date.parse(participant.expiresAtUtc) <= Date.now()
  ) {
    return Response.json(
      {
        missingSources: [
          {
            detail: `The disposable ${requiredPlan} participant grant ${participantIndex} is unavailable`,
            source: "osfo_agent_activation_log",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 5, prepare: true });
  try {
    const database = createDb(client);
    const cohortAuthority = makeQualificationCohortAuthority(database);
    const attemptIndex = makeQualificationAttemptIndex(database);
    const participantAuthority = await Effect.runPromise(
      cohortAuthority.inspectParticipant(participant),
    );
    if (participantAuthority._tag === "Missing") {
      return Response.json(
        {
          missingSources: [
            {
              detail: `No PostgreSQL disposable-account allocation exists for ${participant.userId}`,
              source: "osfo_agent_activation_log",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    if (participantAuthority._tag === "Conflict") {
      return Response.json({ error: "qualificationParticipantAuthorityConflict" }, { status: 409 });
    }
    const userId = UserId.make(participant.userId);
    const agentId = AgentId.make(participant.agentId);
    const now = new Date();
    const allowance = await Effect.runPromise(BillingDb.make(database).admit(userId, now));
    const retainAcceptedMessageUse = async (
      receipt: QualificationAdmissionReceipt,
    ): Promise<boolean> => {
      if (receipt.admissionDecision !== "accepted") return true;
      const retained = await Effect.runPromiseExit(
        BillingDb.make(database).recordUsageForUser(
          userId,
          allowance.allowancePeriodId,
          { sourceId: receipt.acceptanceReceiptId, sourceType: "acceptanceReceipt" },
          [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
        ),
      );
      return Exit.isSuccess(retained);
    };
    if (env.OSFO_DIRECTORY === undefined) {
      return Response.json(
        {
          missingSources: [
            {
              detail: "The Agent Directory qualification authority is unavailable",
              source: "osfo_agent_activation_log",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    const directory = await getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME);
    const agent = await directory.inspectAgent(agentId);
    if (
      agent === null ||
      agent.routeId !== participant.routeId ||
      agent.currentSessionId !== participant.sessionId
    ) {
      return Response.json(
        {
          missingSources: [
            {
              detail: `${agentId} is absent from the Agent Directory`,
              source: "osfo_agent_activation_log",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    const attemptIdentity = {
      executionId: frozen.plan.executionId,
      planChecksum: frozen.plan.planChecksum,
      rootId: arrival.rootId,
      runId: run.runId,
    };
    const context: QualificationContext = {
      attemptId: qualificationChecksum(attemptIdentity),
      executionId: frozen.plan.executionId,
      journey,
      offeredAtEpochMs: arrival.offeredAtEpochMs,
      planChecksum: frozen.plan.planChecksum,
      region: run.region,
      rootId: arrival.rootId,
      runId: run.runId,
    };
    const scheduledEmailFixture = participant.scheduledEmailFixture;
    if (journey === "scheduledEmail" && scheduledEmailFixture === undefined) {
      return Response.json(
        {
          missingSources: [
            {
              detail: "The disposable participant has no server-owned protected Gmail fixture",
              source: "gmail_provider_receipts",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    const authSession = await Effect.runPromise(
      cohortAuthority.readActiveAuthSession({
        at: new Date(Math.max(now.getTime(), context.offeredAtEpochMs)),
        userId,
      }),
    );
    if (authSession === null || authSession.userId !== userId) {
      return Response.json(
        {
          missingSources: [
            {
              detail: "The disposable participant has no unexpired Better Auth session",
              source: "osfo_agent_activation_log",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    if (journey === "scheduledEmail") {
      const connections = await directory.inspectIntegrationConnections(agentId, {
        authSessionId: authSession.sessionId,
        userId,
      });
      const connectionSummary = Schema.decodeUnknownOption(
        QualificationIntegrationConnectionSummary,
      )(connections);
      if (
        Option.isNone(connectionSummary) ||
        !hasConnectedQualificationGmail(connectionSummary.value)
      ) {
        return Response.json(
          {
            missingSources: [
              {
                detail: "The disposable participant has no connected production Gmail account",
                source: "gmail_provider_receipts",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
    }
    const submissionId = ThinkSubmissionId.make(`qualification:${context.attemptId}`);
    const message =
      journey === "scheduledEmail" && scheduledEmailFixture !== undefined
        ? qualificationScheduledEmailMessage(context, scheduledEmailFixture)
        : messageForJourney(journey);
    const authorization = project({
      allowance: { _tag: "Metered", ...allowance },
      authority: {
        _tag: "DurableTrigger",
        triggerId: context.attemptId,
        triggerType: "workflow",
        userId,
      },
      now,
      originatingAuthority: {
        _tag: "DurableTrigger",
        triggerId: context.attemptId,
        triggerType: "workflow",
      },
      plan: allowance.plan,
      planPolicyVersion: allowance.planPolicyVersion,
      userId,
    });
    const proofContent = {
      agentId,
      authSessionExpiresAtUtc: authSession.expiresAt.toISOString(),
      authSessionId: authSession.sessionId,
      context,
      messageChecksum: qualificationChecksum({ message }),
      participantGrantChecksum: participant.artifactChecksum,
      routeId: agent.routeId,
      submissionId,
      userId,
    };
    const proof = QualificationConversationAttemptArtifact.make({
      ...proofContent,
      artifactChecksum: qualificationChecksum(proofContent),
    });
    const retainedProof = await retainAttemptAuthority(env.ARTIFACTS, proof);
    if (retainedProof === null) {
      return Response.json({ error: "qualificationAttemptAuthorityConflict" }, { status: 409 });
    }
    const claimed = await Effect.runPromise(
      attemptIndex.claim({
        agentId,
        allocationId: participantAuthority.allocationId,
        allowancePeriodId: allowance.allowancePeriodId,
        attemptId: context.attemptId,
        authSessionExpiresAt: authSession.expiresAt,
        authSessionId: authSession.sessionId,
        executionId: context.executionId,
        journey: context.journey,
        offeredAt: new Date(context.offeredAtEpochMs),
        planChecksum: context.planChecksum,
        rootId: context.rootId,
        runId: context.runId,
        sessionId: participant.sessionId,
        submissionId,
        userId,
      }),
    );
    if (claimed.status === "CONFLICT") {
      return Response.json({ error: "qualificationAttemptIndexConflict" }, { status: 409 });
    }
    const completeScheduledEmailJourney = async (
      receipt: QualificationAdmissionReceipt,
    ): Promise<Response | null> => {
      if (
        journey !== "scheduledEmail" ||
        receipt.admissionDecision !== "accepted" ||
        scheduledEmailFixture === undefined
      ) {
        return null;
      }
      const retained = await Effect.runPromise(
        readQualificationScheduledEmailAuthority(database, context.executionId, [context.rootId]),
      );
      if (retained._tag === "Conflict") {
        return Response.json(
          { error: "qualificationScheduledEmailAuthorityConflict" },
          { status: 409 },
        );
      }
      if (retained._tag === "Ready") {
        const email = retained.records[0];
        return email !== undefined &&
          hasExactRetainedQualificationScheduledEmail(context, scheduledEmailFixture, email)
          ? null
          : Response.json(
              { error: "qualificationScheduledEmailAuthorityConflict" },
              { status: 409 },
            );
      }
      const approval = await Effect.runPromise(
        approveQualificationScheduledEmail({
          agentId,
          authSessionId: authSession.sessionId,
          context,
          expiresAtUtc: participant.expiresAtUtc,
          fixture: scheduledEmailFixture,
          port: directory,
          userId,
        }).pipe(
          Effect.match({
            onFailure: (failure) => ({ failure }) as const,
            onSuccess: (value) => ({ value }) as const,
          }),
        ),
      );
      if ("failure" in approval) {
        return approval.failure instanceof QualificationScheduledEmailApprovalConflict
          ? Response.json({ error: "qualificationScheduledEmailApprovalConflict" }, { status: 409 })
          : Response.json(
              {
                missingSources: [
                  {
                    detail: "The exact protected Scheduled Email Approval is not yet available",
                    source: "workflow_instance_receipts",
                  },
                ],
                status: "MISSING",
              },
              { status: 424 },
            );
      }
      const started = await Effect.runPromise(
        readQualificationScheduledEmailAuthority(database, context.executionId, [context.rootId]),
      );
      if (started._tag !== "Ready") {
        return started._tag === "Conflict"
          ? Response.json(
              { error: "qualificationScheduledEmailAuthorityConflict" },
              { status: 409 },
            )
          : Response.json(
              {
                missingSources: [
                  {
                    detail: "The approved Scheduled Email has not reached its PostgreSQL authority",
                    source: "workflow_instance_receipts",
                  },
                ],
                status: "MISSING",
              },
              { status: 424 },
            );
      }
      const email = started.records[0];
      return email !== undefined &&
        hasExactRetainedQualificationScheduledEmail(context, scheduledEmailFixture, email)
        ? null
        : Response.json({ error: "qualificationScheduledEmailAuthorityConflict" }, { status: 409 });
    };
    const completeControlledAgentFault = async (
      receipt: QualificationAdmissionReceipt,
    ): Promise<Response | null> => {
      if (!controlledColdActivationRun(run)) return null;
      const controllerOperationId = qualificationControlledAgentAbortOperationId(context);
      const authority = await directory.readQualificationControlledAgentRecovery(
        agentId,
        controllerOperationId,
      );
      if (authority._tag === "QualificationControlledAgentFaultConflict") {
        return Response.json(
          { error: "qualificationControlledAgentFaultConflict" },
          { status: 409 },
        );
      }
      if (
        authority._tag !== "QualificationControlledAgentRecoveryAuthority" ||
        authority.receipt === null
      ) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `${context.rootId} has no consumed controlled Agent recovery authority`,
                source: "qualification_fault_controller_receipts",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const recovery = Schema.decodeOption(QualificationControlledAgentRecoveryReceipt)(
        authority.receipt,
      );
      if (
        Option.isNone(recovery) ||
        recovery.value.executionId !== context.executionId ||
        recovery.value.planChecksum !== context.planChecksum ||
        recovery.value.rootId !== context.rootId ||
        recovery.value.runId !== context.runId ||
        recovery.value.controllerOperationId !== controllerOperationId ||
        receipt.attemptId !== context.attemptId
      ) {
        return Response.json(
          { error: "qualificationControlledAgentFaultConflict" },
          { status: 409 },
        );
      }
      const faultReceipt = qualificationControlledAgentFaultReceipt({
        manifestChecksum: frozen.manifest.manifestChecksum,
        receipt: recovery.value,
        scheduledTriggerAtUtc: new Date(run.startsAtEpochMs).toISOString(),
      });
      const runDescriptor = streamRuns(frozen.plan, frozen.manifest).find(
        (candidate) => candidate.runId === run.runId,
      );
      if (
        runDescriptor === undefined ||
        !(await retainControlledAgentRecoveryAuthority(env.ARTIFACTS, recovery.value)) ||
        !(await retainProductAuthorityShard(
          env,
          frozen,
          "qualification_fault_controller_receipts",
          runDescriptor.firstStreamChunkIndex,
          [faultReceipt],
        ))
      ) {
        return Response.json(
          { error: "qualificationControlledAgentFaultConflict" },
          { status: 409 },
        );
      }
      return null;
    };
    const retainedAdmissions = await directory.readQualificationAdmissionReceipts(
      agentId,
      frozen.plan.executionId,
    );
    const retainedAdmission = Array.isArray(retainedAdmissions)
      ? retainedAdmissions.find(
          (candidate): candidate is QualificationAdmissionReceipt =>
            Schema.is(QualificationAdmissionReceipt)(candidate) &&
            candidate.attemptId === context.attemptId &&
            candidate.rootId === context.rootId,
        )
      : undefined;
    if (retainedAdmission !== undefined) {
      const indexed = await Effect.runPromise(attemptIndex.recordDecision(retainedAdmission));
      const allowanceRetained = await retainAcceptedMessageUse(retainedAdmission);
      const controlledFaultContinuation =
        indexed === "CONFLICT" || !allowanceRetained
          ? null
          : await completeControlledAgentFault(retainedAdmission);
      const scheduledEmailContinuation =
        indexed === "CONFLICT" || !allowanceRetained || controlledFaultContinuation !== null
          ? null
          : await completeScheduledEmailJourney(retainedAdmission);
      if (
        mode === "prepareControlledFault" &&
        indexed !== "CONFLICT" &&
        allowanceRetained &&
        controlledFaultContinuation === null
      ) {
        return Response.json({
          controllerOperationId: qualificationControlledAgentAbortOperationId(context),
          status: "READY",
        });
      }
      return indexed === "CONFLICT"
        ? Response.json({ error: "qualificationAttemptIndexConflict" }, { status: 409 })
        : !allowanceRetained
          ? Response.json(
              {
                missingSources: [
                  {
                    detail: `${arrival.rootId} has no committed accepted-message Allowance fact`,
                    source: "allowance_and_billing_ledger",
                  },
                ],
                status: "MISSING",
              },
              { status: 424 },
            )
          : (controlledFaultContinuation ??
            scheduledEmailContinuation ??
            Response.json({ receipt: retainedAdmission, status: "COMPLETE" }));
    }
    if (controlledColdActivationRun(run)) {
      const command = QualificationControlledAgentAbort.make({
        context,
        controllerOperationId: qualificationControlledAgentAbortOperationId(context),
        manifestChecksum: frozen.manifest.manifestChecksum,
        proofArtifactChecksum: retainedProof.artifactChecksum,
        proofArtifactId: retainedProof.artifactId,
        sessionId: participant.sessionId,
      });
      if (mode === "prepareControlledFault" && Date.now() > context.offeredAtEpochMs) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `${context.rootId} controlled abort missed its before-offer barrier`,
                source: "qualification_fault_controller_receipts",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const preparation =
        mode === "prepareControlledFault"
          ? await directory.applyQualificationControlledAgentAbort(agentId, command)
          : await directory.inspectQualificationControlledAgentFaultPreparation(
              agentId,
              command.controllerOperationId,
            );
      if (preparation._tag === "QualificationControlledAgentFaultConflict") {
        return Response.json(
          { error: "qualificationControlledAgentFaultConflict" },
          { status: 409 },
        );
      }
      if (preparation._tag !== "QualificationControlledAgentFaultReady") {
        return Response.json(
          {
            missingSources: [
              {
                detail: `${context.rootId} controlled Agent abort is not durably recovered`,
                source: "qualification_fault_controller_receipts",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      if (
        !controlledAgentFaultPreparedBeforeOffer({
          appliedAtUtc: preparation.appliedAtUtc,
          offeredAtEpochMs: context.offeredAtEpochMs,
          recoveredAtUtc: preparation.recoveredAtUtc,
        })
      ) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `${context.rootId} controlled abort completed after its offered time`,
                source: "qualification_fault_controller_receipts",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      if (mode === "prepareControlledFault") {
        return Response.json({
          controllerOperationId: command.controllerOperationId,
          status: "READY",
        });
      }
    }
    await directory.submitQualificationConversation(agentId, {
      authorization,
      idempotencyKey: context.attemptId,
      message,
      proofArtifactChecksum: retainedProof.artifactChecksum,
      proofArtifactId: retainedProof.artifactId,
      qualificationContext: context,
      routeId: agent.routeId,
      submissionId,
    });
    const receipts = await directory.readQualificationAdmissionReceipts(
      agentId,
      frozen.plan.executionId,
    );
    if (!Array.isArray(receipts)) {
      return Response.json(
        {
          missingSources: [
            {
              detail: `${arrival.rootId} has no readable Agent admission authority`,
              source: "worker_admission_receipts",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    const receipt = receipts.find(
      (candidate): candidate is QualificationAdmissionReceipt =>
        Schema.is(QualificationAdmissionReceipt)(candidate) &&
        candidate.attemptId === context.attemptId &&
        candidate.rootId === context.rootId,
    );
    if (receipt !== undefined) {
      const indexed = await Effect.runPromise(attemptIndex.recordDecision(receipt));
      if (indexed === "CONFLICT") {
        return Response.json({ error: "qualificationAttemptIndexConflict" }, { status: 409 });
      }
      if (!(await retainAcceptedMessageUse(receipt))) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `${arrival.rootId} has no committed accepted-message Allowance fact`,
                source: "allowance_and_billing_ledger",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const controlledFaultContinuation = await completeControlledAgentFault(receipt);
      if (controlledFaultContinuation !== null) return controlledFaultContinuation;
      const scheduledEmailContinuation = await completeScheduledEmailJourney(receipt);
      if (scheduledEmailContinuation !== null) return scheduledEmailContinuation;
    }
    return receipt === undefined
      ? Response.json(
          {
            missingSources: [
              {
                detail: `${arrival.rootId} has no committed admission decision`,
                source: "worker_admission_receipts",
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        )
      : Response.json({ receipt, status: "COMPLETE" });
  } finally {
    await client.end();
  }
};

class QualificationArrivalChunkStopped extends Data.TaggedError(
  "QualificationArrivalChunkStopped",
)<{ readonly response: Response }> {}

const authorityShardDescriptor = async (
  frozen: FrozenExecution,
  encoded: string,
  shard: typeof AuthorityArrivalShard.Type,
) => {
  const { bodyChecksum, ...bodyContent } = shard;
  if (bodyChecksum !== qualificationChecksum(bodyContent)) return null;
  const bodySha256 = await sha256Hex(encoded);
  const content = {
    bodySha256,
    component: "arrivals" as const,
    executionId: frozen.plan.executionId,
    index: 0,
    planChecksum: frozen.plan.planChecksum,
    previousArtifactChecksum: shard.previousArtifactChecksum,
    recordCount: shard.records.length,
    sourceVersion: frozen.manifest.sourceVersion,
  };
  return {
    artifactChecksum: qualificationChecksum(content),
    bodySha256,
  };
};

const readPreviousArrivalStreamChecksum = async (
  _env: QualificationProductAuthorityEnv,
  _frozen: FrozenExecution,
  _streamChunkIndex: number,
): Promise<string | null> => {
  return "NONE";
};

const retainArrivalDerivedAuthority = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  streamChunkIndex: number,
  records: ReadonlyArray<typeof AuthorityArrivalRecord.Type>,
): Promise<boolean> => {
  const workerRecords = workerAuthorityRecordsFromArrivals(records);
  const thinkRecords = thinkAuthorityRecordsFromArrivals(records);
  const [workerRetained, thinkRetained] = await Promise.all([
    retainProductAuthorityShard(
      env,
      frozen,
      "worker_admission_receipts",
      streamChunkIndex,
      workerRecords,
    ),
    retainProductAuthorityShard(
      env,
      frozen,
      "think_submission_receipts",
      streamChunkIndex,
      thinkRecords,
    ),
  ]);
  return workerRetained && thinkRetained;
};

interface QualificationActivationCorrelationIdentity {
  readonly attemptId: string;
  readonly rootId: string;
  readonly sessionId: string;
  readonly submissionId: string;
}

type QualificationActivationAuthorityOutcome =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Ready";
      readonly records: ReadonlyArray<QualificationAuthorityRecord>;
    };

/** Join decoded Agent activation authority to one exact accepted arrival chunk. */
export const qualificationActivationAuthorityRecords = (input: {
  readonly acceptedAdmissions: ReadonlyArray<QualificationAdmissionReceipt>;
  readonly executionId: string;
  readonly identities: ReadonlyArray<QualificationActivationCorrelationIdentity>;
  readonly planChecksum: string;
  readonly receipts: unknown;
  readonly region: "americas" | "asiaPacific" | "europe";
  readonly runId: string;
}): QualificationActivationAuthorityOutcome => {
  const decodedReceipts = Schema.decodeUnknownOption(Schema.Array(QualificationActivationReceipt))(
    input.receipts,
  );
  if (Option.isNone(decodedReceipts)) return { _tag: "Conflict" };
  const correlated = input.acceptedAdmissions.map((admissionReceipt) => {
    const identity = input.identities.find(
      (candidate) => candidate.rootId === admissionReceipt.rootId,
    );
    const matches = decodedReceipts.value.filter(
      (candidate) => candidate.rootId === admissionReceipt.rootId,
    );
    return { admissionReceipt, identity, matches };
  });
  if (
    correlated.some(({ admissionReceipt, identity, matches }) => {
      const receipt = matches[0];
      if (receipt === undefined || matches.length !== 1 || identity === undefined) return true;
      const { artifactChecksum, ...content } = receipt;
      return (
        receipt.attemptId !== identity.attemptId ||
        receipt.attemptId !== admissionReceipt.attemptId ||
        receipt.executionId !== input.executionId ||
        receipt.planChecksum !== input.planChecksum ||
        receipt.runId !== input.runId ||
        receipt.requestId !== identity.submissionId ||
        receipt.requestId !== admissionReceipt.thinkSubmissionId ||
        receipt.sessionId !== identity.sessionId ||
        receipt.region !== input.region ||
        artifactChecksum !== qualificationChecksum(content)
      );
    })
  ) {
    return { _tag: "Conflict" };
  }
  if (
    correlated.some(({ matches }) => {
      const receipt = matches[0];
      return receipt?.cause === null || receipt?.classification === null;
    })
  ) {
    return { _tag: "Missing" };
  }
  return {
    _tag: "Ready",
    records: correlated.flatMap(({ matches }) => {
      const receipt = matches[0];
      if (receipt === undefined || receipt.cause === null || receipt.classification === null) {
        return [];
      }
      return [
        {
          activationId: receipt.activationId,
          cause: receipt.cause,
          classification: receipt.classification,
          effectReceipts: [],
          occurredAt: receipt.occurredAt,
          productFactId: receipt.productFactId,
          region: receipt.region,
          rootId: receipt.rootId,
          stageOccurrences: [],
          usageFacts: [],
        },
      ];
    }),
  };
};

type QualificationMemoryOutcome =
  | {
      readonly _tag: "NoMemoryObligation";
      readonly occurredAt: string;
      readonly productFactId: string;
      readonly terminalStatus: "aborted" | "error";
    }
  | {
      readonly completedAt: string | null;
      readonly outboxId: string;
      readonly providerDocumentId: string | null;
      readonly providerStatus: "done" | "failed" | "processing" | null;
      readonly status: "claimed" | "completed" | "failed" | "pending";
      readonly terminalAt: string | null;
    }
  | null;

/** Project settled Agent-owned Memory outcomes; pending work remains material absence. */
export const qualificationMemoryAuthorityRecords = (input: {
  readonly outcome: QualificationMemoryOutcome;
  readonly rootId: string;
  readonly userMessageId: string;
}): ReadonlyArray<QualificationAuthorityRecord> => {
  const outcome = input.outcome;
  if (outcome === null) return [];
  if ("_tag" in outcome) {
    return [
      {
        effectReceipts: [],
        memoryObligation: "notRequired",
        occurredAt: outcome.occurredAt,
        outcomeId: outcome.productFactId,
        productFactId: `memory-not-required:${outcome.productFactId}`,
        rootId: input.rootId,
        stageOccurrences: [],
        terminalStatus: outcome.terminalStatus,
        usageFacts: [],
        userMessageId: input.userMessageId,
      },
    ];
  }
  if (
    (outcome.status === "failed" || outcome.providerStatus === "failed") &&
    outcome.terminalAt !== null
  ) {
    return [
      {
        commitStatus: "failed",
        effectReceipts: [],
        memoryCommitId: outcome.outboxId,
        occurredAt: outcome.terminalAt,
        outcomeId: outcome.providerDocumentId ?? outcome.outboxId,
        productFactId: outcome.outboxId,
        rootId: input.rootId,
        stageOccurrences: [],
        usageFacts: [],
        userMessageId: input.userMessageId,
      },
    ];
  }
  return outcome.status === "completed" &&
    outcome.providerStatus === "done" &&
    outcome.completedAt !== null &&
    outcome.providerDocumentId !== null
    ? [
        {
          commitStatus: "committed",
          effectReceipts: [{ effectId: outcome.providerDocumentId, kind: "providerEffects" }],
          memoryCommitId: outcome.outboxId,
          occurredAt: outcome.completedAt,
          outcomeId: outcome.providerDocumentId,
          productFactId: outcome.outboxId,
          rootId: input.rootId,
          stageOccurrences: [],
          usageFacts: [],
          userMessageId: input.userMessageId,
        },
      ]
    : [];
};

interface QualificationScheduledEmailRecord {
  readonly acceptedAt: Date | null;
  readonly cloudflareInstanceId: string;
  readonly dueAt: Date;
  readonly providerLogId: string | null;
  readonly providerResourceId: string | null;
  readonly qualificationContext?: QualificationContext;
  readonly safeFailureCode: string | null;
  readonly sendAccountedAt: Date | null;
  readonly sendAccountingBasis: "conservative" | "observed" | null;
  readonly sendOutcome: "ambiguous" | "applied" | "notApplied" | null;
  readonly sendOutcomeAt: Date | null;
  readonly sendReconciliationClaimedAt: Date | null;
  readonly sendReconciliationLeaseExpiresAt: Date | null;
  readonly sendReconciliationRecoveryUsed: boolean;
  readonly sendStartedAt: Date | null;
  readonly state:
    | "accepted"
    | "admitted"
    | "canceled"
    | "failure"
    | "sending"
    | "send_pending_reconciliation"
    | "success"
    | "waiting";
  readonly terminalAt: Date | null;
  readonly workflowId: string;
}

export const qualificationScheduledEmailAuthorityRecords = (
  email: QualificationScheduledEmailRecord,
  workflowEvidence: ScheduledEmailWorkflowEvidence | null,
  nowEpochMs: number,
):
  | { readonly _tag: "Conflict"; readonly source: string }
  | { readonly _tag: "Missing"; readonly source: string }
  | { readonly _tag: "Pending"; readonly retryAtEpochMs: number; readonly source: string }
  | {
      readonly _tag: "Ready";
      readonly records: Readonly<
        Record<
          | "gmail_provider_receipts"
          | "provider_delivery_receipts"
          | "task_compute_receipts"
          | "workflow_instance_receipts",
          ReadonlyArray<QualificationAuthorityRecord>
        >
      >;
    } => {
  const context = email.qualificationContext;
  if (context === undefined) {
    return { _tag: "Missing", source: "workflow_instance_receipts" };
  }
  const collectionDeadlineEpochMs = (() => {
    if (email.sendStartedAt === null) return context.offeredAtEpochMs + 120_000;
    const evidenceDeadline =
      email.sendStartedAt.getTime() + ScheduledEmail.providerEvidenceHorizonMilliseconds;
    if (
      email.sendReconciliationClaimedAt === null ||
      email.sendReconciliationClaimedAt.getTime() > evidenceDeadline ||
      email.sendReconciliationLeaseExpiresAt === null
    ) {
      return evidenceDeadline;
    }
    const recoveryAllowance = email.sendReconciliationRecoveryUsed
      ? 0
      : ScheduledEmail.providerReconciliationRecoveryMilliseconds;
    return Math.max(
      evidenceDeadline,
      email.sendReconciliationLeaseExpiresAt.getTime() + recoveryAllowance,
    );
  })();
  const pending = (source: string) =>
    nowEpochMs < collectionDeadlineEpochMs
      ? {
          _tag: "Pending" as const,
          retryAtEpochMs: Math.min(nowEpochMs + 5_000, collectionDeadlineEpochMs),
          source,
        }
      : { _tag: "Missing" as const, source };
  const finalizedAmbiguity =
    email.sendOutcome === "ambiguous" &&
    email.terminalAt !== null &&
    email.sendAccountingBasis === "conservative" &&
    email.sendAccountedAt !== null &&
    email.safeFailureCode === "send-outcome-unknown";
  if (email.sendOutcome === "ambiguous" && !finalizedAmbiguity) {
    return pending("provider_delivery_receipts");
  }
  if (email.terminalAt === null) return pending("workflow_instance_receipts");
  if (workflowEvidence === null) return pending("task_compute_receipts");
  const { artifactChecksum, ...workflowEvidenceContent } = workflowEvidence;
  const completedAtEpochMs = canonicalUtcEpochMilliseconds(workflowEvidence.completedAtUtc);
  const evidenceTerminalAtEpochMs =
    workflowEvidence.terminalAtUtc === null
      ? null
      : canonicalUtcEpochMilliseconds(workflowEvidence.terminalAtUtc);
  const evidenceSendStartedAtEpochMs =
    workflowEvidence.sendStartedAtUtc === null
      ? null
      : canonicalUtcEpochMilliseconds(workflowEvidence.sendStartedAtUtc);
  const workflowEvidenceIsTerminal = ScheduledEmail.terminalStates.has(workflowEvidence.state);
  if (
    artifactChecksum !== qualificationChecksum(workflowEvidenceContent) ||
    workflowEvidence.artifactId !==
      scheduledEmailWorkflowEvidenceArtifactId(email.cloudflareInstanceId) ||
    workflowEvidence.instanceId !== email.cloudflareInstanceId ||
    workflowEvidence.workflowId !== email.workflowId ||
    workflowEvidence.dueAtUtc !== email.dueAt.toISOString() ||
    (workflowEvidence.sendStartedAtUtc === null
      ? email.sendStartedAt !== null
      : email.sendStartedAt === null ||
        workflowEvidence.sendStartedAtUtc !== email.sendStartedAt.toISOString()) ||
    completedAtEpochMs === null ||
    (workflowEvidence.sendStartedAtUtc !== null && evidenceSendStartedAtEpochMs === null) ||
    (workflowEvidence.terminalAtUtc !== null && evidenceTerminalAtEpochMs === null) ||
    (evidenceSendStartedAtEpochMs !== null && completedAtEpochMs < evidenceSendStartedAtEpochMs) ||
    (workflowEvidenceIsTerminal
      ? workflowEvidence.state !== email.state ||
        workflowEvidence.terminalAtUtc !== email.terminalAt.toISOString() ||
        evidenceTerminalAtEpochMs === null ||
        completedAtEpochMs < evidenceTerminalAtEpochMs
      : workflowEvidence.terminalAtUtc !== null)
  ) {
    return { _tag: "Conflict", source: "task_compute_receipts" };
  }
  const outcomeId = `scheduled-email-outcome:${email.workflowId}:${email.state}`;
  const base = {
    effectReceipts: [],
    occurredAt: email.terminalAt.toISOString(),
    outcomeId,
    rootId: context.rootId,
    stageOccurrences: [],
    usageFacts: [],
  };
  const workflow = {
    ...base,
    effectReceipts:
      email.acceptedAt === null
        ? []
        : [{ effectId: email.workflowId, kind: "workflowStarts" as const }],
    productFactId: email.workflowId,
    scheduledTaskId: email.cloudflareInstanceId,
    taskExecutionEvidenceId: workflowEvidence.artifactId,
    workflowId: email.workflowId,
    workflowStatus: email.state === "success" ? ("completed" as const) : ("failed" as const),
  };
  const task = {
    ...base,
    executionStatus: "completed" as const,
    occurredAt: workflowEvidence.completedAtUtc,
    productFactId: `scheduled-email-task:${email.cloudflareInstanceId}`,
    runtimeEvidenceId: workflowEvidence.artifactId,
    scheduledTaskId: email.cloudflareInstanceId,
    taskExecutionId: email.cloudflareInstanceId,
  };
  if (finalizedAmbiguity) {
    const failedProviderBase = {
      ...base,
      occurredAt: email.sendOutcomeAt?.toISOString() ?? email.terminalAt.toISOString(),
      productFactId: `scheduled-email-provider-outcome:${email.workflowId}`,
    };
    return {
      _tag: "Ready",
      records: {
        gmail_provider_receipts: [
          {
            ...failedProviderBase,
            deliveryId: email.workflowId,
            deliveryStatus: "failed",
          },
        ],
        provider_delivery_receipts: [
          {
            ...failedProviderBase,
            deliveryId: email.workflowId,
            providerStatus: "failed",
          },
        ],
        task_compute_receipts: [task],
        workflow_instance_receipts: [workflow],
      },
    };
  }
  if (email.sendOutcome === "applied") {
    if (
      email.providerLogId === null ||
      email.providerResourceId === null ||
      email.sendOutcomeAt === null
    ) {
      return { _tag: "Missing", source: "provider_delivery_receipts" };
    }
    const providerBase = { ...base, occurredAt: email.sendOutcomeAt.toISOString() };
    return {
      _tag: "Ready",
      records: {
        gmail_provider_receipts: [
          {
            ...providerBase,
            deliveryId: email.workflowId,
            deliveryStatus: "succeeded",
            effectReceipts: [
              { effectId: email.providerResourceId, kind: "providerEffects" as const },
            ],
            gmailMessageId: email.providerResourceId,
            productFactId: `gmail:${email.providerLogId}`,
          },
        ],
        provider_delivery_receipts: [
          {
            ...providerBase,
            deliveryId: email.workflowId,
            effectReceipts: [
              { effectId: email.providerResourceId, kind: "providerEffects" as const },
            ],
            productFactId: `provider:${email.providerLogId}`,
            providerStatus: "succeeded",
          },
        ],
        task_compute_receipts: [task],
        workflow_instance_receipts: [workflow],
      },
    };
  }
  if (email.sendOutcome === "notApplied") {
    if (email.sendOutcomeAt === null) {
      return { _tag: "Missing", source: "provider_delivery_receipts" };
    }
    const noEventBase = {
      ...base,
      occurredAt: email.sendOutcomeAt.toISOString(),
      productFactId: `scheduled-email-provider-outcome:${email.workflowId}`,
    };
    return {
      _tag: "Ready",
      records: {
        gmail_provider_receipts: [
          {
            ...noEventBase,
            deliveryId: email.workflowId,
            deliveryStatus: "notApplied",
          },
        ],
        provider_delivery_receipts: [
          {
            ...noEventBase,
            deliveryId: email.workflowId,
            providerStatus: "notApplied",
          },
        ],
        task_compute_receipts: [task],
        workflow_instance_receipts: [workflow],
      },
    };
  }
  const providerNoEffectProven =
    email.state === "canceled" &&
    (email.safeFailureCode === "authority-ended" ||
      (email.sendStartedAt === null &&
        (email.safeFailureCode === "account-deletion" ||
          email.safeFailureCode === "cancel-requested")));
  if (!providerNoEffectProven) {
    return { _tag: "Missing", source: "provider_delivery_receipts" };
  }
  return {
    _tag: "Ready",
    records: {
      gmail_provider_receipts: [
        {
          ...base,
          gmailObligation: "notRequired",
          productFactId: `gmail-not-required:${email.workflowId}`,
        },
      ],
      provider_delivery_receipts: [
        {
          ...base,
          productFactId: `provider-not-required:${email.workflowId}`,
          providerObligation: "notRequired",
        },
      ],
      task_compute_receipts: [task],
      workflow_instance_receipts: [workflow],
    },
  };
};

const canonicalUtcEpochMilliseconds = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
};

export const qualificationAuthorityConnectionLimit = 5;

export const mapQualificationAuthorityConnections = async <A, B>(
  inputs: ReadonlyArray<A>,
  operation: (input: A) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const output = new Array<B>();
  for (let offset = 0; offset < inputs.length; offset += qualificationAuthorityConnectionLimit) {
    const batch = inputs.slice(offset, offset + qualificationAuthorityConnectionLimit);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each batch enforces the Workers six-connection host limit with one slot reserved.
    const results = await Promise.all(batch.map((input) => operation(input)));
    output.push(...results);
  }
  return output;
};

const collectAgentSourceChunk = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  chunkIndex: number,
  source: QualificationAgentPostgresAuthoritySource,
): Promise<Response> => {
  const runDescriptor = streamRuns(frozen.plan, frozen.manifest).find(
    (candidate) => candidate.runId === runId,
  );
  if (runDescriptor === undefined || chunkIndex >= runDescriptor.chunkCount) {
    return Response.json({ error: "qualificationSourceChunkNotFound" }, { status: 409 });
  }
  const streamChunkIndex = runDescriptor.firstStreamChunkIndex + chunkIndex;
  const retainedArrival = await env.ARTIFACTS.get(
    authorityArrivalStreamArtifactId(frozen.plan.executionId, streamChunkIndex),
  );
  if (retainedArrival === null) {
    return Response.json(
      {
        missingSources: [{ detail: `Arrival chunk ${streamChunkIndex} is absent`, source }],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const encodedArrival = await retainedArrival.text();
  const arrivalShard = decodeAuthorityArrivalShard(encodedArrival);
  if (
    Option.isNone(arrivalShard) ||
    arrivalShard.value.executionId !== frozen.plan.executionId ||
    arrivalShard.value.planChecksum !== frozen.plan.planChecksum ||
    arrivalShard.value.runId !== runId ||
    arrivalShard.value.chunkIndex !== chunkIndex ||
    arrivalShard.value.streamChunkIndex !== streamChunkIndex ||
    (await authorityShardDescriptor(frozen, encodedArrival, arrivalShard.value)) === null
  ) {
    return Response.json({ error: "qualificationArrivalChunkConflict" }, { status: 409 });
  }
  const acceptedRecords = arrivalShard.value.records.filter(
    ({ admissionReceipt }) => admissionReceipt.admissionDecision === "accepted",
  );
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 2, prepare: true });
  try {
    const database = createDb(client);
    const index = makeQualificationAttemptIndex(database);
    const identities = await Effect.runPromise(
      index.readRoots({
        executionId: frozen.plan.executionId,
        rootIds: arrivalShard.value.records.map(({ rootId }) => rootId),
      }),
    );
    if (
      identities.length !== arrivalShard.value.records.length ||
      arrivalShard.value.records.some(({ admissionReceipt, attemptId, rootId }) => {
        const identity = identities.find((candidate) => candidate.rootId === rootId);
        return (
          identity === undefined ||
          identity.attemptId !== attemptId ||
          identity.admissionDecision !== admissionReceipt.admissionDecision ||
          identity.admissionFactId !== admissionReceipt.productFactId ||
          identity.state !== "DECIDED"
        );
      })
    ) {
      return Response.json({ error: "qualificationAttemptIndexConflict" }, { status: 409 });
    }
    if (
      source === "gmail_provider_receipts" ||
      source === "provider_delivery_receipts" ||
      source === "task_compute_receipts" ||
      source === "workflow_instance_receipts"
    ) {
      if (identities.some(({ journey }) => Option.isNone(decodeQualificationJourney(journey)))) {
        return Response.json({ error: "qualificationAttemptJourneyConflict" }, { status: 409 });
      }
      const component =
        source === "gmail_provider_receipts"
          ? "Gmail"
          : source === "provider_delivery_receipts"
            ? "Provider"
            : source === "task_compute_receipts"
              ? "TaskCompute"
              : "Workflow";
      const required = identities.filter(
        (identity) =>
          identity.admissionDecision === "accepted" &&
          Option.match(decodeQualificationJourney(identity.journey), {
            onNone: () => false,
            onSome: (journey) =>
              frozen.manifest.semanticRequirements[journey].requiredComponents.includes(component),
          }),
      );
      const unsupported = required.find(({ journey }) => journey !== "scheduledEmail");
      if (unsupported !== undefined) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `${source} has no installed ${unsupported.journey} producer adapter for ${unsupported.rootId}`,
                source,
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const authority = await Effect.runPromise(
        readQualificationScheduledEmailAuthority(
          database,
          frozen.plan.executionId,
          required.map(({ rootId }) => rootId),
        ),
      );
      if (authority._tag !== "Ready") {
        return authority._tag === "Conflict"
          ? Response.json(
              { error: "qualificationScheduledEmailAuthorityConflict" },
              { status: 409 },
            )
          : Response.json(
              {
                missingSources: [
                  {
                    detail: `Scheduled Email authority is incomplete for ${authority.rootId}`,
                    source,
                  },
                ],
                status: "MISSING",
              },
              { status: 424 },
            );
      }
      const retainedWorkflowEvidence = await mapQualificationAuthorityConnections(
        authority.records,
        async (email) => {
          const artifact = await env.ARTIFACTS.get(
            scheduledEmailWorkflowEvidenceArtifactId(email.cloudflareInstanceId),
          );
          if (artifact === null) return { email, evidence: null, invalid: false } as const;
          const decoded = Schema.decodeOption(
            Schema.fromJsonString(ScheduledEmailWorkflowEvidence),
          )(await artifact.text());
          return Option.isSome(decoded)
            ? { email, evidence: decoded.value, invalid: false as const }
            : { email, evidence: null, invalid: true as const };
        },
      );
      if (retainedWorkflowEvidence.some(({ invalid }) => invalid)) {
        return Response.json(
          { error: "qualificationScheduledEmailWorkflowEvidenceConflict" },
          { status: 409 },
        );
      }
      const nowEpochMs = Date.now();
      const mapped = retainedWorkflowEvidence.map(({ email, evidence }) =>
        qualificationScheduledEmailAuthorityRecords(email, evidence, nowEpochMs),
      );
      const conflict = mapped.find((entry) => entry._tag === "Conflict");
      if (conflict !== undefined) {
        return Response.json(
          { error: "qualificationScheduledEmailWorkflowEvidenceConflict" },
          { status: 409 },
        );
      }
      const pending = mapped.find((entry) => entry._tag === "Pending");
      if (pending !== undefined && pending._tag === "Pending") {
        return Response.json(
          {
            retryAtEpochMs: pending.retryAtEpochMs,
            source: pending.source,
            status: "PENDING",
          },
          { headers: { "retry-after": "5" }, status: 202 },
        );
      }
      const missing = mapped.find((entry) => entry._tag === "Missing");
      if (missing !== undefined) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `Scheduled Email ${missing.source} has not reached an authoritative terminal outcome`,
                source: missing.source,
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const records = mapped.flatMap((entry) =>
        entry._tag === "Ready" ? entry.records[source] : [],
      );
      return (await retainProductAuthorityShard(env, frozen, source, streamChunkIndex, records))
        ? Response.json({
            recordCount: records.length,
            source,
            status: "COMPLETE",
            streamChunkIndex,
          })
        : Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
    }
    if (env.OSFO_DIRECTORY === undefined) {
      return Response.json(
        {
          missingSources: [
            {
              detail: "The Agent Directory qualification authority is unavailable",
              source,
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    const directory = await getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME);
    if (source === "osfo_agent_activation_log") {
      const authority = await mapQualificationAuthorityConnections(
        [...new Set(identities.map(({ agentId, sessionId }) => `${agentId}\u0000${sessionId}`))],
        async (identity) => {
          const [agentId, sessionId] = identity.split("\u0000");
          if (agentId === undefined || sessionId === undefined) {
            return { _tag: "QualificationActivationAuthorityConflict" as const };
          }
          return directory.readQualificationActivationReceipts(
            agentId,
            frozen.plan.executionId,
            sessionId,
          );
        },
      );
      if (authority.some((result) => result._tag === "QualificationActivationAuthorityConflict")) {
        return Response.json(
          { error: "qualificationActivationAuthorityConflict" },
          { status: 409 },
        );
      }
      if (authority.some((result) => result._tag !== "QualificationActivationAuthority")) {
        return Response.json(
          {
            missingSources: [
              {
                detail: `Agent activation authority is unavailable for arrival chunk ${streamChunkIndex}`,
                source,
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const receipts = authority.flatMap((result) =>
        result._tag === "QualificationActivationAuthority" ? result.receipts : [],
      );
      const run = frozen.plan.runs.find((candidate) => candidate.runId === runId);
      if (run === undefined) {
        return Response.json(
          { error: "qualificationActivationAuthorityConflict" },
          { status: 409 },
        );
      }
      const activation = qualificationActivationAuthorityRecords({
        acceptedAdmissions: acceptedRecords.map(({ admissionReceipt }) => admissionReceipt),
        executionId: frozen.plan.executionId,
        identities,
        planChecksum: frozen.plan.planChecksum,
        receipts,
        region: run.region,
        runId,
      });
      if (activation._tag === "Conflict") {
        return Response.json(
          { error: "qualificationActivationAuthorityConflict" },
          { status: 409 },
        );
      }
      if (activation._tag === "Missing") {
        return Response.json(
          {
            missingSources: [
              {
                detail: `Agent activation cause is not authoritative for every accepted root in arrival chunk ${streamChunkIndex}`,
                source,
              },
            ],
            status: "MISSING",
          },
          { status: 424 },
        );
      }
      const records = activation.records;
      return (await retainProductAuthorityShard(env, frozen, source, streamChunkIndex, records))
        ? Response.json({
            recordCount: records.length,
            source,
            status: "COMPLETE",
            streamChunkIndex,
          })
        : Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
    }
    const roots = (
      await mapQualificationAuthorityConnections(
        [...new Set(identities.map(({ agentId, sessionId }) => `${agentId}\u0000${sessionId}`))],
        async (identity) => {
          const [agentId, sessionId] = identity.split("\u0000");
          if (agentId === undefined || sessionId === undefined) return [];
          const result = await directory.readQualificationTurnAuthority(
            agentId,
            frozen.plan.executionId,
            sessionId,
          );
          return result._tag === "QualificationTurnAuthority" ? result.roots : [];
        },
      )
    ).flat();
    const correlated = acceptedRecords.map(({ admissionReceipt }) => {
      const root = roots.find(
        (candidate) =>
          candidate.admission.rootId === admissionReceipt.rootId &&
          candidate.admission.artifactChecksum === admissionReceipt.artifactChecksum,
      );
      return { admissionReceipt, root };
    });
    if (correlated.some(({ root }) => root?.committedTurn === null || root === undefined)) {
      return Response.json(
        {
          missingSources: [
            {
              detail: `Agent terminal authority is incomplete for arrival chunk ${streamChunkIndex}`,
              source,
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    const billingRoots = correlated.map(({ admissionReceipt, root }) => {
      const identity = identities.find((candidate) => candidate.rootId === admissionReceipt.rootId);
      return identity === undefined || root === undefined
        ? null
        : {
            acceptanceReceiptId: admissionReceipt.acceptanceReceiptId,
            allowancePeriodId: AllowancePeriodId.make(identity.allowancePeriodId),
            modelCalls: root.modelAccess.map((model) => ({
              attemptId: model.attemptId,
              costReconciliationId: model.costReconciliationId,
              items: model.items,
              priceBookId: model.priceBookId,
            })),
            rootId: admissionReceipt.rootId,
            userId: identity.userId,
          };
    });
    if (billingRoots.some((root) => root === null)) {
      return Response.json({ error: "qualificationAttemptIndexConflict" }, { status: 409 });
    }
    const billing = await Effect.runPromise(
      BillingDb.readQualificationBillingAuthority(
        database,
        billingRoots.filter((root) => root !== null),
      ),
    );
    if (billing._tag !== "Ready") {
      return billing._tag === "Conflict"
        ? Response.json({ error: "qualificationBillingAuthorityConflict" }, { status: 409 })
        : Response.json(
            {
              missingSources: [
                {
                  detail: `Billing authority is incomplete for ${billing.rootId}`,
                  source: "allowance_and_billing_ledger",
                },
              ],
              status: "MISSING",
            },
            { status: 424 },
          );
    }
    if (source === "allowance_and_billing_ledger") {
      const records = [
        ...billing.localEvidence.map((evidence) => ({ _tag: "LocalEvidence" as const, evidence })),
        ...billing.records.map((record) => ({ _tag: "BillingFact" as const, record })),
      ];
      return (await retainProductAuthorityShard(env, frozen, source, streamChunkIndex, records))
        ? Response.json({
            recordCount: records.length,
            source,
            status: "COMPLETE",
            streamChunkIndex,
          })
        : Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
    }
    const records: ReadonlyArray<QualificationAuthorityRecord> =
      source === "osfo_committed_turns"
        ? correlated.flatMap(
            ({ admissionReceipt, root }): ReadonlyArray<QualificationAuthorityRecord> =>
              root?.committedTurn === null || root === undefined
                ? []
                : [
                    {
                      acceptanceReceiptId: admissionReceipt.acceptanceReceiptId,
                      authority: "osfo_committed_turns" as const,
                      evidenceId: `agent-sqlite:${root.committedTurn.assistantMessageId}`,
                      occurredAt: root.committedTurn.observedAt,
                      productFactId: root.committedTurn.assistantMessageId,
                      rootId: admissionReceipt.rootId,
                      store: "AgentSQLite" as const,
                      thinkRequestId: root.committedTurn.thinkRequestId,
                    },
                  ],
          )
        : source === "memory_commit_receipts"
          ? correlated.flatMap(
              ({ admissionReceipt, root }): ReadonlyArray<QualificationAuthorityRecord> => {
                return qualificationMemoryAuthorityRecords({
                  outcome: root?.memoryOutcome ?? null,
                  rootId: admissionReceipt.rootId,
                  userMessageId: admissionReceipt.userMessageId,
                });
              },
            )
          : correlated.flatMap(
              ({ admissionReceipt, root }): ReadonlyArray<QualificationAuthorityRecord> => {
                if (root?.modelNoObligation !== null && root?.modelNoObligation !== undefined) {
                  return [
                    {
                      effectReceipts: [],
                      modelObligation: "notRequired" as const,
                      occurredAt: root.modelNoObligation.occurredAt,
                      outcomeId: root.modelNoObligation.productFactId,
                      productFactId: `model-not-required:${root.modelNoObligation.productFactId}`,
                      rootId: admissionReceipt.rootId,
                      stageOccurrences: [],
                      terminalStatus: root.modelNoObligation.terminalStatus,
                      usageFacts: [],
                    },
                  ];
                }
                return (root?.modelAccess ?? []).flatMap((model) =>
                  model.dispatchedAt === null
                    ? []
                    : [
                        {
                          costReconciliationId: model.costReconciliationId,
                          effectReceipts: [],
                          gatewayRequestId: model.gatewayRequestId,
                          modelRequestId: model.modelRequestId,
                          occurredAt: model.dispatchedAt,
                          outcomeId: model.outcomeId,
                          priceBookId: model.priceBookId,
                          productFactId: model.attemptId,
                          requestStatus: "completed" as const,
                          rootId: admissionReceipt.rootId,
                          stageOccurrences: [],
                          usageFacts: [],
                        },
                      ],
                );
              },
            );
    if (source === "memory_commit_receipts" && records.length !== acceptedRecords.length) {
      return Response.json(
        {
          missingSources: [
            {
              detail: `Memory authority is not terminal for every accepted root in arrival chunk ${streamChunkIndex}`,
              source,
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    if (
      source === "model_access_receipts" &&
      correlated.some(
        ({ root }) =>
          root === undefined ||
          (root.modelAccess.length === 0 && root.modelNoObligation === null) ||
          root.modelAccess.some(({ dispatchedAt }) => dispatchedAt === null),
      )
    ) {
      return Response.json(
        {
          missingSources: [
            {
              detail: `Model access and cost authority is not terminal for every accepted root in arrival chunk ${streamChunkIndex}`,
              source,
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    return (await retainProductAuthorityShard(env, frozen, source, streamChunkIndex, records))
      ? Response.json({ recordCount: records.length, source, status: "COMPLETE", streamChunkIndex })
      : Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
  } finally {
    await client.end();
  }
};

const collectArrivalReadbackSourceChunk = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  chunkIndex: number,
  source: QualificationArrivalReadbackAuthoritySource,
): Promise<Response> => {
  const runDescriptor = streamRuns(frozen.plan, frozen.manifest).find(
    (candidate) => candidate.runId === runId,
  );
  if (runDescriptor === undefined || chunkIndex >= runDescriptor.chunkCount) {
    return Response.json({ error: "qualificationSourceChunkNotFound" }, { status: 409 });
  }
  const streamChunkIndex = runDescriptor.firstStreamChunkIndex + chunkIndex;
  const retained = await readRetainedProductAuthorityShard({
    chunkIndex,
    env,
    frozen,
    runId,
    source,
    streamChunkIndex,
  });
  if (retained._tag === "Missing") {
    return Response.json(
      {
        missingSources: [
          {
            detail: `The immutable ${source} shard is absent for arrival chunk ${streamChunkIndex}`,
            source,
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  if (retained._tag === "Ready" && source === "think_submission_receipts") {
    const worker = await readRetainedProductAuthorityShard({
      chunkIndex,
      env,
      frozen,
      runId,
      source: "worker_admission_receipts",
      streamChunkIndex,
    });
    if (worker._tag === "Missing") {
      return Response.json(
        {
          missingSources: [
            {
              detail: `The Worker admission dependency is absent for arrival chunk ${streamChunkIndex}`,
              source: "worker_admission_receipts",
            },
          ],
          status: "MISSING",
        },
        { status: 424 },
      );
    }
    if (worker._tag === "Conflict") {
      return Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
    }
    const acceptedRootIds = worker.records.flatMap((record) =>
      "admissionDecision" in record && record.admissionDecision === "accepted"
        ? [record.rootId]
        : [],
    );
    const thinkRootIds = retained.records.map(({ rootId }) => rootId);
    if (
      acceptedRootIds.length !== thinkRootIds.length ||
      acceptedRootIds.some((rootId, index) => thinkRootIds[index] !== rootId)
    ) {
      return Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
    }
  }
  return retained._tag === "Conflict"
    ? Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 })
    : Response.json({
        recordCount: retained.recordCount,
        source,
        status: "COMPLETE",
        streamChunkIndex,
      });
};

const collectDocumentR2ObjectSourceChunk = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  chunkIndex: number,
): Promise<Response> => {
  const run = frozen.plan.runs.find((candidate) => candidate.runId === runId);
  const runDescriptor = streamRuns(frozen.plan, frozen.manifest).find(
    (candidate) => candidate.runId === runId,
  );
  if (run === undefined || runDescriptor === undefined || chunkIndex >= runDescriptor.chunkCount) {
    return Response.json({ error: "qualificationSourceChunkNotFound" }, { status: 409 });
  }
  if (env.ARTIFACTS.head === undefined) {
    return missingDocumentR2Source("The actual-object R2 HEAD adapter is unavailable");
  }
  const streamChunkIndex = runDescriptor.firstStreamChunkIndex + chunkIndex;
  const retainedArrival = await env.ARTIFACTS.get(
    authorityArrivalStreamArtifactId(frozen.plan.executionId, streamChunkIndex),
  );
  if (retainedArrival === null) return missingDocumentR2Source("The arrival shard is absent");
  const encodedArrival = await retainedArrival.text();
  const arrivalShard = decodeAuthorityArrivalShard(encodedArrival);
  if (
    Option.isNone(arrivalShard) ||
    arrivalShard.value.executionId !== frozen.plan.executionId ||
    arrivalShard.value.planChecksum !== frozen.plan.planChecksum ||
    arrivalShard.value.runId !== runId ||
    arrivalShard.value.chunkIndex !== chunkIndex ||
    arrivalShard.value.streamChunkIndex !== streamChunkIndex ||
    (await authorityShardDescriptor(frozen, encodedArrival, arrivalShard.value)) === null
  ) {
    return Response.json({ error: "qualificationArrivalChunkConflict" }, { status: 409 });
  }
  const client = postgres(env.DB.connectionString, { fetch_types: false, max: 2, prepare: true });
  try {
    const database = createDb(client);
    const index = makeQualificationAttemptIndex(database);
    const identities = await Effect.runPromise(
      index.readRoots({
        executionId: frozen.plan.executionId,
        rootIds: arrivalShard.value.records.map(({ rootId }) => rootId),
      }),
    );
    if (
      !qualificationDocumentAttemptAuthorityExact({
        arrivalIndexOffset: chunkIndex * 256,
        executionId: frozen.plan.executionId,
        identities,
        manifest: frozen.manifest,
        planChecksum: frozen.plan.planChecksum,
        records: arrivalShard.value.records,
        run,
      })
    ) {
      return Response.json({ error: "qualificationAttemptIndexConflict" }, { status: 409 });
    }
    const required = identities.filter(
      ({ admissionDecision, journey }) =>
        admissionDecision === "accepted" && journey === "documentBuild",
    );
    const unsupported = identities.find(({ admissionDecision, journey }) => {
      if (admissionDecision !== "accepted") return false;
      const decoded = decodeQualificationJourney(journey);
      return (
        Option.isNone(decoded) ||
        (decoded.value !== "documentBuild" &&
          frozen.manifest.semanticRequirements[decoded.value].requiredComponents.includes("R2"))
      );
    });
    if (unsupported !== undefined) {
      return missingDocumentR2Source(
        `R2 has no installed ${unsupported.journey} producer for ${unsupported.rootId}`,
      );
    }
    const authority = await Effect.runPromise(
      readQualificationDocumentBuildAuthority(
        database,
        frozen.plan.executionId,
        required.map(({ rootId }) => rootId),
      ),
    );
    if (authority._tag !== "Ready") {
      return authority._tag === "Conflict"
        ? Response.json({ error: "qualificationDocumentBuildAuthorityConflict" }, { status: 409 })
        : missingDocumentR2Source(`Document Build authority is absent for ${authority.rootId}`);
    }
    if (
      !qualificationDocumentBuildAuthorityExact(
        authority.records,
        required,
        frozen.plan.planChecksum,
        runId,
      )
    ) {
      return Response.json(
        { error: "qualificationDocumentBuildAuthorityConflict" },
        { status: 409 },
      );
    }
    const inspected = await qualificationDocumentR2AuthorityRecords(
      env.ARTIFACTS,
      authority.records,
    );
    if (inspected._tag === "Pending") {
      return Response.json(
        {
          retryAtEpochMs: Date.now() + 5_000,
          source: "r2_object_metadata",
          status: "PENDING",
        },
        { headers: { "retry-after": "5" }, status: 202 },
      );
    }
    if (inspected._tag === "Conflict") {
      return Response.json(
        { error: "qualificationDocumentObjectAuthorityConflict" },
        { status: 409 },
      );
    }
    if (inspected._tag === "Missing") {
      return missingDocumentR2Source(`Document object receipt is absent for ${inspected.rootId}`);
    }
    return (await retainProductAuthorityShard(
      env,
      frozen,
      "r2_object_metadata",
      streamChunkIndex,
      inspected.records,
    ))
      ? Response.json({
          recordCount: inspected.records.length,
          source: "r2_object_metadata",
          status: "COMPLETE",
          streamChunkIndex,
        })
      : Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
  } finally {
    await client.end();
  }
};

/** Prove every retained arrival against the frozen run and exact attempt-index identity. */
export const qualificationDocumentAttemptAuthorityExact = (input: {
  readonly arrivalIndexOffset: number;
  readonly executionId: string;
  readonly identities: ReadonlyArray<QualificationDocumentAttemptIdentity>;
  readonly manifest: ProductionQualificationManifest;
  readonly planChecksum: string;
  readonly records: ReadonlyArray<typeof AuthorityArrivalRecord.Type>;
  readonly run: QualificationExecutionRun;
}): boolean =>
  input.identities.length === input.records.length &&
  input.records.every(
    ({ admissionReceipt, arrival, attemptId, authorityFactId, executionId, rootId }, offset) => {
      const expected = qualificationRunArrivalAt(
        input.manifest,
        input.run,
        input.arrivalIndexOffset + offset,
      );
      const identity = input.identities.find((candidate) => candidate.rootId === rootId);
      const journey =
        expected !== undefined && "journey" in expected ? expected.journey : "ordinaryConversation";
      return (
        expected !== undefined &&
        Predicate.isObject(arrival) &&
        qualificationChecksum(arrival) === qualificationChecksum(expected) &&
        identity !== undefined &&
        identity.admissionDecision === admissionReceipt.admissionDecision &&
        identity.admissionFactId === admissionReceipt.productFactId &&
        authorityFactId === admissionReceipt.productFactId &&
        identity.agentId === admissionReceipt.agentId &&
        identity.attemptId === attemptId &&
        identity.attemptId === admissionReceipt.attemptId &&
        identity.executionId === executionId &&
        identity.executionId === admissionReceipt.executionId &&
        identity.executionId === input.executionId &&
        identity.journey === journey &&
        identity.offeredAt.getTime() === expected.offeredAtEpochMs &&
        identity.planChecksum === input.planChecksum &&
        identity.planChecksum === admissionReceipt.planChecksum &&
        identity.rootId === expected.rootId &&
        identity.rootId === admissionReceipt.rootId &&
        identity.runId === input.run.runId &&
        identity.runId === admissionReceipt.runId &&
        identity.state === "DECIDED" &&
        identity.submissionId === admissionReceipt.thinkSubmissionId
      );
    },
  );

/** Prove each Document Build product row against its exact server-owned attempt allocation. */
export const qualificationDocumentBuildAuthorityExact = (
  builds: ReadonlyArray<
    Pick<
      DocumentBuild.Record,
      "agentId" | "allowancePeriodId" | "qualificationContext" | "sessionId" | "userId"
    >
  >,
  identities: ReadonlyArray<QualificationDocumentAttemptIdentity>,
  planChecksum: string,
  runId: string,
): boolean =>
  builds.length === identities.length &&
  builds.every((build) => {
    const context = build.qualificationContext;
    const identity = identities.find((candidate) => candidate.rootId === context?.rootId);
    return (
      context !== undefined &&
      identity !== undefined &&
      context.attemptId === identity.attemptId &&
      context.executionId === identity.executionId &&
      context.journey === "documentBuild" &&
      context.journey === identity.journey &&
      context.offeredAtEpochMs === identity.offeredAt.getTime() &&
      context.planChecksum === planChecksum &&
      context.planChecksum === identity.planChecksum &&
      context.rootId === identity.rootId &&
      context.runId === runId &&
      context.runId === identity.runId &&
      build.agentId === identity.agentId &&
      build.allowancePeriodId === identity.allowancePeriodId &&
      build.sessionId === identity.sessionId &&
      build.userId === identity.userId
    );
  });

const DocumentBuildTerminalStates = new Set(["success", "failure", "canceled"]);

/** Authenticate Document Build R2 authority from producer rows, immutable indexes, and actual HEADs. */
export const qualificationDocumentR2AuthorityRecords = async (
  bucket: QualificationProductAuthorityArtifactBucket,
  builds: ReadonlyArray<QualificationDocumentR2Build>,
): Promise<QualificationDocumentR2AuthorityOutcome> => {
  if (builds.some(({ state }) => !DocumentBuildTerminalStates.has(state))) {
    return { _tag: "Pending" };
  }
  if (bucket.head === undefined) return { _tag: "Missing", rootId: "r2-head-adapter" };
  const terminalWithoutObjects = builds.filter(({ state }) => state !== "success");
  const absentTerminalObjects = await mapQualificationAuthorityConnections(
    terminalWithoutObjects,
    async (build) => {
      const context = build.qualificationContext;
      if (context === undefined || build.artifactContentId !== null) return false;
      const canonicalContentId = ContentId.make(`document:workflow:${build.workflowId}`);
      const receipt = await bucket.head?.(
        qualificationReceiptKeyFor(context.executionId, context.runId, canonicalContentId),
      );
      const object = await bucket.head?.(contentKeyFor(canonicalContentId));
      return receipt === null && object === null;
    },
  );
  if (absentTerminalObjects.some((absent) => !absent)) return { _tag: "Conflict" };
  const successful = builds.filter(({ state }) => state === "success");
  const successfulContexts = successful.flatMap((build) =>
    build.qualificationContext === undefined ? [] : [build.qualificationContext],
  );
  if (
    successfulContexts.length !== successful.length ||
    new Set(successfulContexts.map(({ executionId, runId }) => `${executionId}\u0000${runId}`))
      .size > 1
  ) {
    return { _tag: "Conflict" };
  }
  const expectedReceipts = new Map(
    successful.map((build) => {
      const context = build.qualificationContext;
      const contentId = build.artifactContentId;
      if (
        context === undefined ||
        contentId === null ||
        contentId !== `document:workflow:${build.workflowId}`
      ) {
        return ["", context?.rootId ?? ""] as const;
      }
      return [
        qualificationReceiptKeyFor(context.executionId, context.runId, ContentId.make(contentId)),
        context.rootId,
      ] as const;
    }),
  );
  if (expectedReceipts.has("") || expectedReceipts.size !== successful.length) {
    return { _tag: "Conflict" };
  }
  const inspected = await mapQualificationAuthorityConnections(successful, async (build) => {
    const context = build.qualificationContext;
    const contentId = build.artifactContentId;
    if (context === undefined || contentId === null || build.artifactAccountedAt === null) {
      return { _tag: "Conflict" as const };
    }
    const artifactId = qualificationReceiptKeyFor(
      context.executionId,
      context.runId,
      ContentId.make(contentId),
    );
    const indexed = await bucket.get(artifactId);
    if (indexed === null) return { _tag: "Missing" as const, rootId: context.rootId };
    const encoded = await indexed.text();
    const decoded = decodeDocumentObjectReceipt(encoded);
    if (Option.isNone(decoded)) return { _tag: "Conflict" as const };
    const receipt = decoded.value;
    const { artifactChecksum, ...content } = receipt;
    const metadata = indexed.customMetadata;
    if (
      artifactChecksum !== qualificationChecksum(content) ||
      receipt.artifactId !== artifactId ||
      receipt.attemptId !== context.attemptId ||
      receipt.executionId !== context.executionId ||
      receipt.objectId !== contentId ||
      receipt.planChecksum !== context.planChecksum ||
      receipt.rootId !== context.rootId ||
      receipt.runId !== context.runId ||
      receipt.workflowId !== build.workflowId ||
      metadata?.["osfo-artifact-checksum"] !== artifactChecksum ||
      metadata["osfo-body-sha256"] !== (await sha256Hex(encoded)) ||
      metadata["osfo-execution-id"] !== context.executionId ||
      metadata["osfo-kind"] !== "qualification-document-object-receipt-v1" ||
      metadata["osfo-object-id"] !== contentId ||
      metadata["osfo-plan-checksum"] !== context.planChecksum ||
      metadata["osfo-root-id"] !== context.rootId ||
      metadata["osfo-run-id"] !== context.runId
    ) {
      return { _tag: "Conflict" as const };
    }
    const object = await bucket.head?.(receipt.objectKey);
    if (object === null || object === undefined) return { _tag: "Conflict" as const };
    const evidence = r2ObjectEvidence(object);
    const objectMetadata = object.customMetadata;
    const decodedStored = await Effect.runPromiseExit(
      DocumentArtifacts.decodeStoredArtifactMetadata(object, ContentId.make(contentId)),
    );
    if (
      evidence === null ||
      Exit.isFailure(decodedStored) ||
      object.size !== receipt.byteLength ||
      object.storageClass !== receipt.storageClass ||
      evidence.checksum !== receipt.contentSha256 ||
      evidence.etag !== receipt.etag ||
      evidence.objectId !== receipt.objectId ||
      evidence.objectKey !== receipt.objectKey ||
      evidence.rootId !== receipt.rootId ||
      evidence.uploadedAt !== receipt.uploadedAtUtc ||
      evidence.version !== receipt.objectVersion ||
      objectMetadata?.osfoAttemptId !== context.attemptId ||
      objectMetadata.osfoExecutionId !== context.executionId ||
      objectMetadata.osfoPlanChecksum !== context.planChecksum ||
      objectMetadata.osfoRunId !== context.runId ||
      objectMetadata["osfo-sha256"] !== receipt.contentSha256 ||
      (await sha256Hex(objectMetadata.osfo ?? "")) !== receipt.accountedMetadataSha256
    ) {
      return { _tag: "Conflict" as const };
    }
    const stored = decodedStored.value;
    const storedContext = stored.qualificationContext;
    if (
      stored.retention !== "accounted" ||
      stored.artifact.content.contentId !== contentId ||
      stored.artifact.content.byteLength !== receipt.byteLength ||
      stored.artifact.content.mediaType !== receipt.mediaType ||
      receipt.mediaType !==
        (build.request.format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
      stored.artifact.content.sha256 !== receipt.contentSha256 ||
      stored.owner._tag !== "Workflow" ||
      stored.owner.workflowId !== build.workflowId ||
      !sameQualificationContext(storedContext, context)
    ) {
      return { _tag: "Conflict" as const };
    }
    return { _tag: "Ready" as const, evidence };
  });
  const conflict = inspected.find(({ _tag }) => _tag === "Conflict");
  if (conflict !== undefined) return { _tag: "Conflict" };
  const missing = inspected.find(({ _tag }) => _tag === "Missing");
  if (missing !== undefined && missing._tag === "Missing") return missing;
  return {
    _tag: "Ready",
    records: inspected.flatMap((entry) => (entry._tag === "Ready" ? [entry.evidence] : [])),
  };
};

const missingDocumentR2Source = (detail: string) =>
  Response.json(
    { missingSources: [{ detail, source: "r2_object_metadata" }], status: "MISSING" },
    { status: 424 },
  );

const collectControlledAgentFaultSourceChunk = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  chunkIndex: number,
): Promise<Response> => {
  const run = frozen.plan.runs.find((candidate) => candidate.runId === runId);
  const descriptor = streamRuns(frozen.plan, frozen.manifest).find(
    (candidate) => candidate.runId === runId,
  );
  if (
    run === undefined ||
    descriptor === undefined ||
    chunkIndex !== 0 ||
    !controlledColdActivationRun(run)
  ) {
    return Response.json(
      {
        missingSources: [
          {
            detail: `${runId} has no installed controlled fault producer`,
            source: "qualification_fault_controller_receipts",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const streamChunkIndex = descriptor.firstStreamChunkIndex;
  const artifactId = productAuthorityShardArtifactId(
    frozen.plan.executionId,
    "qualification_fault_controller_receipts",
    streamChunkIndex,
  );
  const inventory = await env.ARTIFACTS.list({
    include: ["customMetadata"],
    limit: 2,
    prefix: artifactId,
  });
  if (inventory.objects.length === 0) {
    return Response.json(
      {
        missingSources: [
          {
            detail: `${runId} controlled fault receipt is absent`,
            source: "qualification_fault_controller_receipts",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  if (inventory.objects.length !== 1 || inventory.objects[0]?.key !== artifactId) {
    return Response.json({ error: "qualificationControlledAgentFaultConflict" }, { status: 409 });
  }
  const object = await env.ARTIFACTS.get(artifactId);
  if (object === null) {
    return Response.json(
      {
        missingSources: [
          {
            detail: `${runId} controlled fault receipt body is absent`,
            source: "qualification_fault_controller_receipts",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const encoded = await object.text();
  const decoded = Schema.decodeOption(Schema.fromJsonString(ControlledAgentFaultAuthorityShard))(
    encoded,
  );
  const arrival = qualificationRunArrivalAt(frozen.manifest, run, 0);
  if (Option.isNone(decoded) || arrival === undefined) {
    return Response.json({ error: "qualificationControlledAgentFaultConflict" }, { status: 409 });
  }
  const shard = decoded.value;
  const receipt = shard.records[0];
  const context: QualificationContext = {
    attemptId: qualificationChecksum({
      executionId: frozen.plan.executionId,
      planChecksum: frozen.plan.planChecksum,
      rootId: arrival.rootId,
      runId,
    }),
    executionId: frozen.plan.executionId,
    journey: "journey" in arrival ? arrival.journey : "ordinaryConversation",
    offeredAtEpochMs: arrival.offeredAtEpochMs,
    planChecksum: frozen.plan.planChecksum,
    region: run.region,
    rootId: arrival.rootId,
    runId,
  };
  const operationId = qualificationControlledAgentAbortOperationId(context);
  const recoveryArtifactId = controlledAgentRecoveryArtifactId(operationId);
  const recoveryObject = await env.ARTIFACTS.get(recoveryArtifactId);
  if (recoveryObject === null) {
    return Response.json(
      {
        missingSources: [
          {
            detail: `${runId} controlled Agent recovery authority is absent`,
            source: "qualification_fault_controller_receipts",
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    );
  }
  const recoveryEncoded = await recoveryObject.text();
  const recovery = Schema.decodeOption(
    Schema.fromJsonString(QualificationControlledAgentRecoveryReceipt),
  )(recoveryEncoded);
  const { checksum, ...content } = shard;
  const expectedBodySha256 = await sha256Hex(encoded);
  const metadataMatches = (metadata: Readonly<Record<string, string>> | undefined): boolean =>
    metadata?.["osfo-artifact-checksum"] === checksum &&
    metadata["osfo-body-sha256"] === expectedBodySha256 &&
    metadata["osfo-execution-id"] === frozen.plan.executionId &&
    metadata["osfo-index"] === "0" &&
    metadata["osfo-kind"] === "qualification-product-authority-export-v1" &&
    metadata["osfo-plan-checksum"] === frozen.plan.planChecksum &&
    metadata["osfo-previous-checksum"] === "NONE" &&
    metadata["osfo-record-count"] === "1" &&
    metadata["osfo-source"] === "qualification_fault_controller_receipts" &&
    metadata["osfo-source-version"] === frozen.manifest.sourceVersion &&
    metadata["osfo-stream-chunk-index"] === String(streamChunkIndex);
  const recoveryChecksumExact = Option.isSome(recovery)
    ? (() => {
        const { artifactChecksum, ...recoveryContent } = recovery.value;
        return artifactChecksum === qualificationChecksum(recoveryContent);
      })()
    : false;
  const receiptChecksumExact = (() => {
    if (receipt === undefined) return false;
    const { artifactChecksum, ...receiptContent } = receipt;
    return artifactChecksum === qualificationChecksum(receiptContent);
  })();
  const exact =
    receipt !== undefined &&
    shard.artifactId === artifactId &&
    shard.executionId === frozen.plan.executionId &&
    shard.planChecksum === frozen.plan.planChecksum &&
    shard.recordCount === 1 &&
    shard.records.length === 1 &&
    shard.sourceVersion === frozen.manifest.sourceVersion &&
    shard.streamChunkIndex === streamChunkIndex &&
    checksum === qualificationChecksum(content) &&
    receipt.artifactId === recoveryArtifactId &&
    receipt.controllerOperationId === operationId &&
    receipt.executionId === frozen.plan.executionId &&
    receipt.manifestChecksum === frozen.manifest.manifestChecksum &&
    receipt.planChecksum === frozen.plan.planChecksum &&
    receipt.runId === runId &&
    receipt.injectedAtUtc <= new Date(arrival.offeredAtEpochMs).toISOString() &&
    receipt.endedAtUtc <= new Date(arrival.offeredAtEpochMs).toISOString() &&
    Option.isSome(recovery) &&
    recoveryChecksumExact &&
    receiptChecksumExact &&
    receipt.applicationStatus === "applied" &&
    receipt.controllerSource === "osfo-directory-facet-abort-v1" &&
    receipt.durationSeconds === 0 &&
    receipt.kind === "coldActivation" &&
    receipt.scheduledTriggerAtUtc === new Date(run.startsAtEpochMs).toISOString() &&
    receipt.target === "osfoAgent" &&
    receipt.trigger === "beforeOffer" &&
    recovery.value.applicationAuthorityFactId === receipt.applicationAuthorityFactId &&
    recovery.value.appliedAtUtc === receipt.injectedAtUtc &&
    recovery.value.controllerOperationId === operationId &&
    recovery.value.executionId === frozen.plan.executionId &&
    recovery.value.manifestChecksum === frozen.manifest.manifestChecksum &&
    recovery.value.planChecksum === frozen.plan.planChecksum &&
    recovery.value.recoveredAtUtc === receipt.endedAtUtc &&
    recovery.value.restorationAuthorityFactId === receipt.restorationAuthorityFactId &&
    recovery.value.rootId === arrival.rootId &&
    recovery.value.runId === runId &&
    recoveryObject.customMetadata?.["osfo-artifact-checksum"] === recovery.value.artifactChecksum &&
    recoveryObject.customMetadata?.["osfo-body-sha256"] === (await sha256Hex(recoveryEncoded)) &&
    recoveryObject.customMetadata?.["osfo-controller-operation-id"] === operationId &&
    recoveryObject.customMetadata?.["osfo-execution-id"] === frozen.plan.executionId &&
    recoveryObject.customMetadata?.["osfo-kind"] === "qualification-controlled-agent-recovery-v1" &&
    recoveryObject.customMetadata?.["osfo-plan-checksum"] === frozen.plan.planChecksum &&
    recoveryObject.customMetadata?.["osfo-root-id"] === arrival.rootId &&
    recoveryObject.customMetadata?.["osfo-run-id"] === runId &&
    metadataMatches(object.customMetadata) &&
    metadataMatches(inventory.objects[0]?.customMetadata);
  return exact
    ? Response.json({
        recordCount: 1,
        source: "qualification_fault_controller_receipts",
        status: "COMPLETE",
        streamChunkIndex,
      })
    : Response.json({ error: "qualificationControlledAgentFaultConflict" }, { status: 409 });
};

const collectSourceChunk = (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  chunkIndex: number,
  source: QualificationAuthoritySource,
): Promise<Response> => {
  if (isQualificationArrivalReadbackAuthoritySource(source)) {
    return collectArrivalReadbackSourceChunk(env, frozen, runId, chunkIndex, source);
  }
  if (isQualificationAgentPostgresAuthoritySource(source)) {
    return collectAgentSourceChunk(env, frozen, runId, chunkIndex, source);
  }
  if (isQualificationControlledAgentFaultAuthoritySource(source)) {
    return collectControlledAgentFaultSourceChunk(env, frozen, runId, chunkIndex);
  }
  if (isQualificationDocumentR2ObjectAuthoritySource(source)) {
    return collectDocumentR2ObjectSourceChunk(env, frozen, runId, chunkIndex);
  }
  return Promise.resolve(
    Response.json(
      {
        missingSources: [
          {
            detail: `No production-owned ${source} qualification export adapter is installed`,
            source,
          },
        ],
        status: "MISSING",
      },
      { status: 424 },
    ),
  );
};

export const collectQualificationSourceBundle = async (input: {
  readonly collect: (source: QualificationAuthoritySource) => Promise<Response>;
  readonly streamChunkIndex: number;
}): Promise<Response> => {
  const recordCounts = new Array<{
    readonly recordCount: number;
    readonly source: QualificationAuthoritySource;
  }>();
  const pendingSources = new Array<QualificationAuthoritySource>();
  let retryAtEpochMs = 0;
  for (const source of qualificationAuthoritySources) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The ordered bundle stops at the first closed missing/conflict outcome.
    const response = await input.collect(source);
    if (response.status === 424 || response.status === 409) return response;
    // oxlint-disable-next-line eslint/no-await-in-loop -- One response body is consumed before advancing canonical source order.
    const encoded: unknown = await response.json();
    if (response.status === 202) {
      const pending = Schema.decodeUnknownOption(QualificationProductAuthoritySourceChunkPending)(
        encoded,
      );
      if (Option.isNone(pending) || pending.value.source !== source) {
        return Response.json(
          { error: "qualificationAuthoritySourceOutcomeConflict" },
          { status: 409 },
        );
      }
      pendingSources.push(source);
      retryAtEpochMs = Math.max(retryAtEpochMs, pending.value.retryAtEpochMs);
      continue;
    }
    const complete = Schema.decodeUnknownOption(QualificationProductAuthoritySourceChunkComplete)(
      encoded,
    );
    if (
      response.status !== 200 ||
      Option.isNone(complete) ||
      complete.value.source !== source ||
      complete.value.streamChunkIndex !== input.streamChunkIndex
    ) {
      return Response.json(
        { error: "qualificationAuthoritySourceOutcomeConflict" },
        { status: 409 },
      );
    }
    recordCounts.push({ recordCount: complete.value.recordCount, source });
  }
  return pendingSources.length > 0
    ? Response.json(
        QualificationProductAuthoritySourceBundlePending.make({
          pendingSources,
          retryAtEpochMs,
          status: "PENDING",
        }),
        { status: 202 },
      )
    : Response.json(
        QualificationProductAuthoritySourceBundleComplete.make({
          recordCounts,
          status: "COMPLETE",
          streamChunkIndex: input.streamChunkIndex,
        }),
      );
};

const executeArrivalChunk = async (
  env: QualificationProductAuthorityEnv,
  frozen: FrozenExecution,
  runId: string,
  chunkIndex: number,
): Promise<Response> => {
  const runDescriptor = streamRuns(frozen.plan, frozen.manifest).find(
    (candidate) => candidate.runId === runId,
  );
  const run = frozen.plan.runs.find((candidate) => candidate.runId === runId);
  if (run === undefined || runDescriptor === undefined || chunkIndex >= runDescriptor.chunkCount) {
    return Response.json({ error: "qualificationArrivalChunkNotFound" }, { status: 409 });
  }
  const firstArrivalIndex = chunkIndex * 256;
  const count = Math.min(256, run.arrivalCount - firstArrivalIndex);
  const streamChunkIndex = runDescriptor.firstStreamChunkIndex + chunkIndex;
  const artifactId = authorityArrivalStreamArtifactId(frozen.plan.executionId, streamChunkIndex);
  const expectedArrivals = Array.from({ length: count }, (_, offset) =>
    qualificationRunArrivalAt(frozen.manifest, run, firstArrivalIndex + offset),
  );
  if (expectedArrivals.some((arrival) => arrival === undefined)) {
    return Response.json({ error: "qualificationArrivalChunkConflict" }, { status: 409 });
  }
  const existing = await env.ARTIFACTS.get(artifactId);
  if (existing !== null) {
    const encoded = await existing.text();
    const decoded = decodeAuthorityArrivalShard(encoded);
    const expectedPreviousArtifactChecksum = await readPreviousArrivalStreamChecksum(
      env,
      frozen,
      streamChunkIndex,
    );
    const valid =
      Option.isSome(decoded) &&
      expectedPreviousArtifactChecksum !== null &&
      decoded.value.chunkIndex === chunkIndex &&
      decoded.value.executionId === frozen.plan.executionId &&
      decoded.value.planChecksum === frozen.plan.planChecksum &&
      decoded.value.previousArtifactChecksum === expectedPreviousArtifactChecksum &&
      decoded.value.records.length === count &&
      decoded.value.runId === runId &&
      decoded.value.streamChunkIndex === streamChunkIndex &&
      decoded.value.records.every((record, offset) => {
        const arrival = expectedArrivals[offset];
        return (
          arrival !== undefined &&
          Predicate.isObject(record.arrival) &&
          qualificationChecksum(record.arrival) === qualificationChecksum(arrival) &&
          record.attemptId ===
            qualificationChecksum({
              executionId: frozen.plan.executionId,
              planChecksum: frozen.plan.planChecksum,
              rootId: arrival.rootId,
              runId,
            }) &&
          record.authorityFactId.length > 0 &&
          record.admissionReceipt.attemptId === record.attemptId &&
          record.admissionReceipt.productFactId === record.authorityFactId &&
          record.admissionReceipt.rootId === record.rootId &&
          record.executionId === frozen.plan.executionId &&
          record.rootId === arrival.rootId &&
          Date.parse(record.submittedAtUtc) >= arrival.offeredAtEpochMs &&
          Date.parse(record.executedAtUtc) >= Date.parse(record.submittedAtUtc)
        );
      }) &&
      (await authorityShardDescriptor(frozen, encoded, decoded.value)) !== null;
    if (valid && Option.isSome(decoded)) {
      if (
        !(await retainArrivalDerivedAuthority(env, frozen, streamChunkIndex, decoded.value.records))
      ) {
        return Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
      }
    }
    return valid
      ? Response.json(
          QualificationProductAuthorityArrivalChunk.make({
            artifactChecksum:
              (await authorityShardDescriptor(frozen, encoded, decoded.value))?.artifactChecksum ??
              "",
            artifactId,
            chunkIndex,
            firstArrivalIndex,
            recordCount: count,
            runId,
            status: "COMPLETE",
            streamChunkIndex,
          }),
        )
      : Response.json({ error: "qualificationArrivalChunkConflict" }, { status: 409 });
  }
  const previousArtifactChecksum = await readPreviousArrivalStreamChecksum(
    env,
    frozen,
    streamChunkIndex,
  );
  if (previousArtifactChecksum === null) {
    return Response.json({ error: "qualificationPreviousArrivalChunkMissing" }, { status: 409 });
  }
  const records = await Effect.runPromise(
    Effect.forEach(
      expectedArrivals.map((arrival, offset) => ({ arrival, offset })),
      ({ arrival, offset }) =>
        Effect.gen(function* () {
          if (arrival === undefined) {
            return yield* new QualificationArrivalChunkStopped({
              response: Response.json(
                { error: "qualificationArrivalChunkConflict" },
                { status: 409 },
              ),
            });
          }
          const delayMs = arrival.offeredAtEpochMs - (yield* Clock.currentTimeMillis);
          if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs));
          const response = yield* Effect.promise(() =>
            executeArrival(env, frozen, runId, firstArrivalIndex + offset),
          );
          const body: unknown = yield* Effect.promise(() => response.json());
          const decoded = decodeExecuteArrivalComplete(body);
          if (!response.ok || Option.isNone(decoded)) {
            return yield* new QualificationArrivalChunkStopped({
              response: Response.json(body, { status: response.status }),
            });
          }
          const receipt = decoded.value.receipt;
          return {
            admissionReceipt: receipt,
            arrival,
            attemptId: receipt.attemptId,
            authorityFactId: receipt.productFactId,
            executedAtUtc: receipt.occurredAt,
            executionId: frozen.plan.executionId,
            rootId: arrival.rootId,
            submittedAtUtc: receipt.occurredAt,
          };
        }),
      { concurrency: 256 },
    ),
  ).catch((error) => {
    if (error instanceof QualificationArrivalChunkStopped) return error;
    throw error;
  });
  if (records instanceof QualificationArrivalChunkStopped) return records.response;
  const bodyContent = {
    chunkIndex,
    executionId: frozen.plan.executionId,
    planChecksum: frozen.plan.planChecksum,
    previousArtifactChecksum,
    records,
    runId,
    streamChunkIndex,
  };
  const shard = { ...bodyContent, bodyChecksum: qualificationChecksum(bodyContent) };
  const encoded = canonicalQualificationJson(shard);
  const descriptor = await authorityShardDescriptor(frozen, encoded, shard);
  if (descriptor === null) {
    return Response.json({ error: "qualificationArrivalChunkConflict" }, { status: 409 });
  }
  const retained = await env.ARTIFACTS.put(artifactId, encoded, {
    customMetadata: {
      "osfo-artifact-checksum": descriptor.artifactChecksum,
      "osfo-body-sha256": descriptor.bodySha256,
      "osfo-component": "arrivals",
      "osfo-execution-id": frozen.plan.executionId,
      "osfo-index": "0",
      "osfo-kind": "qualification-authority-stream-v1",
      "osfo-plan-checksum": frozen.plan.planChecksum,
      "osfo-previous-checksum": previousArtifactChecksum,
      "osfo-record-count": String(count),
      "osfo-source-version": frozen.manifest.sourceVersion,
      "osfo-stream-chunk-index": String(streamChunkIndex),
    },
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (retained === null) {
    const conflicted = await env.ARTIFACTS.get(artifactId);
    if (conflicted === null || (await conflicted.text()) !== encoded) {
      return Response.json({ error: "qualificationArrivalChunkConflict" }, { status: 409 });
    }
  }
  if (!(await retainArrivalDerivedAuthority(env, frozen, streamChunkIndex, records))) {
    return Response.json({ error: "qualificationAuthorityShardConflict" }, { status: 409 });
  }
  return Response.json(
    QualificationProductAuthorityArrivalChunk.make({
      artifactChecksum: descriptor.artifactChecksum,
      artifactId,
      chunkIndex,
      firstArrivalIndex,
      recordCount: count,
      runId,
      status: "COMPLETE",
      streamChunkIndex,
    }),
  );
};

/** Private source owner. Every readiness result follows an actual owning binding attempt. */
export const handleQualificationProductAuthority = async (
  request: Request,
  env: QualificationProductAuthorityEnv,
): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method !== "POST") {
    return new Response(null, { status: 404 });
  }
  const encoded = await request.text();
  if (url.pathname === "/v1/executions/source-chunks") {
    const decoded = decodeCollectSourceChunk(encoded);
    if (Option.isNone(decoded)) {
      return Response.json({ error: "qualificationProductAuthorityInvalid" }, { status: 400 });
    }
    const frozen = await readFrozenExecution(decoded.value, env);
    if (frozen === null) {
      return Response.json({ error: "qualificationProductAuthorityConflict" }, { status: 409 });
    }
    return collectSourceChunk(
      env,
      frozen,
      decoded.value.runId,
      decoded.value.chunkIndex,
      decoded.value.source,
    );
  }
  if (url.pathname === "/v1/executions/source-bundles") {
    const decoded = decodeExecuteArrivalChunk(encoded);
    if (Option.isNone(decoded)) {
      return Response.json({ error: "qualificationProductAuthorityInvalid" }, { status: 400 });
    }
    const frozen = await readFrozenExecution(decoded.value, env);
    if (frozen === null) {
      return Response.json({ error: "qualificationProductAuthorityConflict" }, { status: 409 });
    }
    const runDescriptor = streamRuns(frozen.plan, frozen.manifest).find(
      (candidate) => candidate.runId === decoded.value.runId,
    );
    if (runDescriptor === undefined) {
      return Response.json({ error: "qualificationArrivalChunkNotFound" }, { status: 409 });
    }
    const streamChunkIndex = runDescriptor.firstStreamChunkIndex + decoded.value.chunkIndex;
    return collectQualificationSourceBundle({
      collect: (source) =>
        collectSourceChunk(env, frozen, decoded.value.runId, decoded.value.chunkIndex, source),
      streamChunkIndex,
    });
  }
  if (url.pathname === "/v1/executions/arrival-chunks") {
    const decoded = decodeExecuteArrivalChunk(encoded);
    if (Option.isNone(decoded)) {
      return Response.json({ error: "qualificationProductAuthorityInvalid" }, { status: 400 });
    }
    const frozen = await readFrozenExecution(decoded.value, env);
    if (frozen === null) {
      return Response.json({ error: "qualificationProductAuthorityConflict" }, { status: 409 });
    }
    return (
      unsupportedExecutionResponse(frozen.manifest) ??
      executeArrivalChunk(env, frozen, decoded.value.runId, decoded.value.chunkIndex)
    );
  }
  if (url.pathname === "/v1/executions/controlled-agent-fault-preparations") {
    const decoded = decodeExecuteArrivalChunk(encoded);
    if (Option.isNone(decoded)) {
      return Response.json({ error: "qualificationProductAuthorityInvalid" }, { status: 400 });
    }
    const frozen = await readFrozenExecution(decoded.value, env);
    if (frozen === null) {
      return Response.json({ error: "qualificationProductAuthorityConflict" }, { status: 409 });
    }
    if (decoded.value.chunkIndex !== 0) {
      return Response.json({ error: "qualificationControlledAgentFaultConflict" }, { status: 409 });
    }
    return executeArrival(env, frozen, decoded.value.runId, 0, "prepareControlledFault");
  }
  if (url.pathname === "/v1/executions/arrivals") {
    const decoded = decodeExecuteArrival(encoded);
    if (Option.isNone(decoded)) {
      return Response.json({ error: "qualificationProductAuthorityInvalid" }, { status: 400 });
    }
    const frozen = await readFrozenExecution(decoded.value, env);
    if (frozen === null) {
      return Response.json({ error: "qualificationProductAuthorityConflict" }, { status: 409 });
    }
    return (
      unsupportedExecutionResponse(frozen.manifest) ??
      executeArrival(env, frozen, decoded.value.runId, decoded.value.arrivalIndex)
    );
  }
  if (url.pathname !== "/v1/executions/preflight") {
    return new Response(null, { status: 404 });
  }
  const decoded = decodeInvocation(encoded);
  const frozen = Option.isNone(decoded) ? null : await readFrozenExecution(decoded.value, env);
  if (frozen === null) {
    return Response.json({ error: "qualificationProductAuthorityConflict" }, { status: 409 });
  }
  const inventory = await verifyCohortInventory(env, frozen);
  if (inventory === "CONFLICT") {
    return Response.json({ error: "qualificationCohortInventoryConflict" }, { status: 409 });
  }
  const missingSources = [
    ...coverageMissingSources(frozen.manifest),
    ...(await attemptOwnedSources(env, frozen.invocation.executionId)),
  ];
  if (inventory === "MISSING") {
    missingSources.push({
      detail: "The complete frozen disposable qualification cohort inventory is unavailable",
      source: "osfo_agent_activation_log",
    });
  }
  const runs = streamRuns(frozen.plan, frozen.manifest);
  const canonicalMissing = canonicalMissingSources(missingSources);
  return canonicalMissing.length === 0
    ? Response.json({
        runs,
        sources: qualificationAuthoritySources,
        status: "READY",
        totalArrivalChunks: runs.reduce((total, run) => total + run.chunkCount, 0),
      })
    : Response.json({ missingSources: canonicalMissing, status: "MISSING" }, { status: 424 });
};
