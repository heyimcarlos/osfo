import { Array, Option, Order, Schema } from "effect";

import type { ReferenceJourney } from "./qualification-manifest";
import { qualificationChecksum } from "./qualification-checksum";
import {
  assessmentFromFindings,
  type QualificationAssessment,
  type QualificationFinding,
} from "./verdict";
import { ArtifactChecksum, QualificationId, QualificationUtcInstant } from "./evidence-primitives";

/** Local product stores that can authorize semantic facts. */
export type EvidenceStore = "AgentSQLite" | "PostgreSQL";

/** Required lifecycle stage recorded by one semantic root trace. */
export type SemanticStage =
  | "costReconciled"
  | "durableAcceptance"
  | "resourceUseReconciled"
  | "terminalOutcome"
  | "thinkSubmissionAccepted";

/** Production component whose root-correlated signal is required by a journey. */
export type SemanticComponent =
  | "AgentActivation"
  | "AgentSQLite"
  | "Gmail"
  | "Memory"
  | "ModelAccess"
  | "PostgreSQL"
  | "Provider"
  | "R2"
  | "TaskCompute"
  | "Think"
  | "WhatsApp"
  | "Worker"
  | "Workflow";

/** Root correlation identities required by a journey-specific semantic trace. */
export type SemanticCorrelation =
  | "acceptanceReceiptId"
  | "allowanceConsumptionId"
  | "costReconciliationId"
  | "deliveryId"
  | "outcomeId"
  | "priceBookId"
  | "r2ObjectId"
  | "scheduledTaskId"
  | "thinkRequestId"
  | "thinkSubmissionId"
  | "userMessageId"
  | "userUpdateId"
  | "workflowId";

/** Committed-turn fact correlated to the accepted root at the Agent SQLite boundary. */
export interface AgentSqliteProductEvidence {
  readonly acceptanceReceiptId: string;
  readonly authority: "osfo_committed_turns";
  readonly evidenceId: string;
  readonly occurredAt: string;
  readonly productFactId: string;
  readonly rootId: string;
  readonly store: "AgentSQLite";
  readonly thinkRequestId: string;
}

/** Allowance fact and semantic identities read from its committed PostgreSQL row. */
export interface PostgresProductEvidence {
  readonly acceptanceReceiptId: string;
  readonly allowanceConsumptionId: string;
  readonly authority: "allowance_usage";
  readonly evidenceId: string;
  readonly occurredAt: string;
  readonly productFactId: string;
  readonly store: "PostgreSQL";
}

/** Semantic evidence derived only from existing committed local product rows. */
export type LocalProductEvidence = AgentSqliteProductEvidence | PostgresProductEvidence;

/** Parser for evidence derived from committed local product rows. */
export const LocalProductEvidenceBoundary = Schema.Union([
  Schema.Struct({
    acceptanceReceiptId: QualificationId,
    authority: Schema.Literal("osfo_committed_turns"),
    evidenceId: QualificationId,
    occurredAt: QualificationUtcInstant,
    productFactId: QualificationId,
    rootId: QualificationId,
    store: Schema.Literal("AgentSQLite"),
    thinkRequestId: QualificationId,
  }),
  Schema.Struct({
    acceptanceReceiptId: QualificationId,
    allowanceConsumptionId: QualificationId,
    authority: Schema.Literal("allowance_usage"),
    evidenceId: QualificationId,
    occurredAt: QualificationUtcInstant,
    productFactId: QualificationId,
    store: Schema.Literal("PostgreSQL"),
  }),
]);

/** Root evidence derived from one committed R2 object's immutable metadata. */
export interface R2ObjectEvidence {
  readonly checksum: string;
  readonly etag: string;
  readonly objectId: string;
  readonly objectKey: string;
  readonly rootId: string;
  readonly uploadedAt: string;
  readonly version: string;
}

/** Parser for immutable R2 object metadata evidence. */
export const R2ObjectEvidenceBoundary = Schema.Struct({
  checksum: ArtifactChecksum,
  etag: QualificationId,
  objectId: QualificationId,
  objectKey: QualificationId,
  rootId: QualificationId,
  uploadedAt: QualificationUtcInstant,
  version: QualificationId,
});

/** Non-authoritative diagnostic signal exported after product commit. */
export interface TelemetrySignal {
  readonly observedAt: string;
  readonly rootId: string;
  readonly signal: string;
  readonly store: EvidenceStore | "R2";
}

/** One observed amplification count. The manifest owns the maximum. */
export interface RootAmplification {
  readonly count: number;
  readonly kind: string;
}

/** Timestamped lifecycle stage for one accepted root. */
export interface RootStageEvidence {
  readonly occurredAt: string;
  readonly stage: SemanticStage;
}

/** Exact committed product boundary used to reproduce a named SLI interval. */
export type ProductStageBoundary =
  | "deliveryAttemptStarted"
  | "durableAcceptanceCommitted"
  | "followUpAccepted"
  | "meaningfulUpdateCommitted"
  | "messageObserved"
  | "protectedSendStarted"
  | "scheduledEmailDue"
  | "scheduledEmailOutcomeCommitted"
  | "scheduledTaskDue"
  | "scheduledTaskHandlerStarted"
  | "scheduledTaskSubmissionAccepted"
  | "workflowMilestoneCommitted"
  | "workflowOutcomeCommitted"
  | "workflowStarted"
  | "workflowWakeDue";

export interface ProductStageOccurrence {
  readonly boundary: ProductStageBoundary;
  readonly occurredAt: string;
  readonly productFactId: string;
}

/** Root-correlated product signal from one required production component. */
export interface RootSemanticSignal {
  readonly component: SemanticComponent;
  readonly occurredAt: string;
  readonly signalId: string;
}

interface ProductAuthorityEvidence {
  readonly activation: RootSemanticTrace["activation"] | null;
  readonly authority: ProductAuthorityName;
  readonly component: SemanticComponent;
  readonly correlations: Readonly<Partial<Record<SemanticCorrelation, string>>>;
  readonly effectReceipts: ProductExportRecordBase["effectReceipts"];
  readonly occurredAt: string;
  readonly productFactId: string;
  readonly rootId: string;
  readonly terminalFact: boolean;
  readonly terminalObserved: boolean;
  readonly sourceArtifactChecksum: string;
  readonly sourceArtifactId: string;
  readonly stageOccurrences: ReadonlyArray<ProductStageOccurrence>;
}

const componentAuthorities = {
  AgentActivation: "osfo_agent_activation_log",
  AgentSQLite: "osfo_committed_turns",
  Gmail: "gmail_provider_receipts",
  Memory: "memory_commit_receipts",
  ModelAccess: "model_access_receipts",
  PostgreSQL: "allowance_and_billing_ledger",
  Provider: "provider_delivery_receipts",
  R2: "r2_object_metadata",
  TaskCompute: "task_compute_receipts",
  Think: "think_submission_receipts",
  WhatsApp: "whatsapp_delivery_receipts",
  Worker: "worker_admission_receipts",
  Workflow: "workflow_instance_receipts",
} as const satisfies Readonly<Record<SemanticComponent, string>>;

type ProductAuthorityName = (typeof componentAuthorities)[SemanticComponent];

const componentForAuthority = (authority: ProductAuthorityName): SemanticComponent => {
  switch (authority) {
    case "allowance_and_billing_ledger":
      return "PostgreSQL";
    case "gmail_provider_receipts":
      return "Gmail";
    case "memory_commit_receipts":
      return "Memory";
    case "model_access_receipts":
      return "ModelAccess";
    case "osfo_committed_turns":
      return "AgentSQLite";
    case "osfo_agent_activation_log":
      return "AgentActivation";
    case "provider_delivery_receipts":
      return "Provider";
    case "r2_object_metadata":
      return "R2";
    case "task_compute_receipts":
      return "TaskCompute";
    case "think_submission_receipts":
      return "Think";
    case "whatsapp_delivery_receipts":
      return "WhatsApp";
    case "worker_admission_receipts":
      return "Worker";
    case "workflow_instance_receipts":
      return "Workflow";
  }
  authority satisfies never;
  return authority;
};

interface ProductExportRecordBase {
  readonly effectReceipts: ReadonlyArray<{
    readonly effectId: string;
    readonly kind: "providerEffects" | "thinkSubmissions" | "workflowStarts";
  }>;
  readonly occurredAt: string;
  readonly productFactId: string;
  readonly rootId: string;
  readonly stageOccurrences: ReadonlyArray<ProductStageOccurrence>;
  readonly usageFacts: ReadonlyArray<{
    readonly category: string;
    readonly provider: string;
    readonly quantity: bigint;
    readonly unit: string;
    readonly usageId: string;
  }>;
}

type ProductAuthorityExportRecord =
  | (ProductExportRecordBase & {
      readonly activationId: string;
      readonly cause: RootSemanticTrace["activation"]["cause"];
      readonly classification: RootSemanticTrace["activation"]["classification"];
      readonly region: RootSemanticTrace["activation"]["region"];
    })
  | (ProductExportRecordBase & {
      readonly acceptanceReceiptId: string;
      readonly admissionDecision: "accepted" | "typedRejected";
      readonly userMessageId: string;
      readonly userUpdateId: string;
    })
  | (ProductExportRecordBase & {
      readonly acceptanceReceiptId: string;
      readonly submissionStatus: "accepted" | "failed";
      readonly thinkSubmissionId: string;
    })
  | (ProductExportRecordBase & {
      readonly deliveryId: string;
      readonly outcomeId: string;
      readonly providerMessageId: string;
      readonly deliveryStatus: "failed" | "succeeded";
      readonly userMessageId: string;
      readonly userUpdateId: string;
    })
  | (ProductExportRecordBase & {
      readonly deliveryId: string;
      readonly outcomeId: string;
      readonly providerStatus: "failed" | "sent" | "succeeded";
    })
  | (ProductExportRecordBase & {
      readonly deliveryId: string;
      readonly gmailMessageId: string;
      readonly outcomeId: string;
      readonly deliveryStatus: "failed" | "succeeded";
    })
  | (ProductExportRecordBase & {
      readonly outcomeId: string;
      readonly scheduledTaskId: string;
      readonly workflowId: string;
      readonly workflowStatus: "completed" | "failed" | "running";
    })
  | (ProductExportRecordBase & {
      readonly costReconciliationId: string;
      readonly modelRequestId: string;
      readonly outcomeId: string;
      readonly priceBookId: string;
      readonly requestStatus: "completed" | "failed";
    })
  | (ProductExportRecordBase & {
      readonly memoryCommitId: string;
      readonly outcomeId: string;
      readonly commitStatus: "committed" | "failed";
      readonly userMessageId: string;
    })
  | (ProductExportRecordBase & {
      readonly outcomeId: string;
      readonly scheduledTaskId: string;
      readonly taskExecutionId: string;
      readonly executionStatus: "completed" | "failed";
    });

/** Immutable authority-specific export retained from one owning production component. */
export interface ProductAuthorityExport {
  readonly artifactId: string;
  readonly authority: ProductAuthorityName;
  readonly checksum: string;
  readonly exportedAtUtc: string;
  readonly records: ReadonlyArray<ProductAuthorityExportRecord>;
  readonly sourceVersion: string;
}

const ProductExportRecordBaseBoundary = {
  effectReceipts: Schema.Array(
    Schema.Struct({
      effectId: QualificationId,
      kind: Schema.Literals(["providerEffects", "thinkSubmissions", "workflowStarts"]),
    }),
  ),
  occurredAt: QualificationUtcInstant,
  productFactId: QualificationId,
  rootId: QualificationId,
  stageOccurrences: Schema.Array(
    Schema.Struct({
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
      occurredAt: QualificationUtcInstant,
      productFactId: QualificationId,
    }),
  ),
  usageFacts: Schema.Array(
    Schema.Struct({
      category: QualificationId,
      provider: QualificationId,
      quantity: Schema.BigInt,
      unit: QualificationId,
      usageId: QualificationId,
    }),
  ),
};

const productAuthorityExportBoundary = <A>(
  authority: ProductAuthorityName,
  record: Schema.Codec<A, unknown>,
) =>
  Schema.Struct({
    artifactId: QualificationId,
    authority: Schema.Literal(authority),
    checksum: ArtifactChecksum,
    exportedAtUtc: QualificationUtcInstant,
    records: Schema.Array(record),
    sourceVersion: QualificationId,
  });

/** Parser for one retained authority-specific product export. */
export const ProductAuthorityExportBoundary = Schema.Union([
  productAuthorityExportBoundary(
    "osfo_agent_activation_log",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      activationId: QualificationId,
      cause: Schema.Literals(["deployment", "faultRecovery", "firstUse", "idleEviction", "warm"]),
      classification: Schema.Literals(["cold", "warm"]),
      region: Schema.Literals(["americas", "asiaPacific", "europe"]),
    }),
  ),
  productAuthorityExportBoundary(
    "worker_admission_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      acceptanceReceiptId: QualificationId,
      admissionDecision: Schema.Literals(["accepted", "typedRejected"]),
      userMessageId: QualificationId,
      userUpdateId: QualificationId,
    }),
  ),
  productAuthorityExportBoundary(
    "think_submission_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      acceptanceReceiptId: QualificationId,
      submissionStatus: Schema.Literals(["accepted", "failed"]),
      thinkSubmissionId: QualificationId,
    }),
  ),
  productAuthorityExportBoundary(
    "whatsapp_delivery_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      deliveryId: QualificationId,
      outcomeId: QualificationId,
      providerMessageId: QualificationId,
      deliveryStatus: Schema.Literals(["failed", "succeeded"]),
      userMessageId: QualificationId,
      userUpdateId: QualificationId,
    }),
  ),
  productAuthorityExportBoundary(
    "provider_delivery_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      deliveryId: QualificationId,
      outcomeId: QualificationId,
      providerStatus: Schema.Literals(["failed", "sent", "succeeded"]),
    }),
  ),
  productAuthorityExportBoundary(
    "gmail_provider_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      deliveryId: QualificationId,
      gmailMessageId: QualificationId,
      outcomeId: QualificationId,
      deliveryStatus: Schema.Literals(["failed", "succeeded"]),
    }),
  ),
  productAuthorityExportBoundary(
    "workflow_instance_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      outcomeId: QualificationId,
      scheduledTaskId: QualificationId,
      workflowId: QualificationId,
      workflowStatus: Schema.Literals(["completed", "failed", "running"]),
    }),
  ),
  productAuthorityExportBoundary(
    "model_access_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      costReconciliationId: QualificationId,
      modelRequestId: QualificationId,
      outcomeId: QualificationId,
      priceBookId: QualificationId,
      requestStatus: Schema.Literals(["completed", "failed"]),
    }),
  ),
  productAuthorityExportBoundary(
    "memory_commit_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      memoryCommitId: QualificationId,
      outcomeId: QualificationId,
      commitStatus: Schema.Literals(["committed", "failed"]),
      userMessageId: QualificationId,
    }),
  ),
  productAuthorityExportBoundary(
    "task_compute_receipts",
    Schema.Struct({
      ...ProductExportRecordBaseBoundary,
      outcomeId: QualificationId,
      scheduledTaskId: QualificationId,
      taskExecutionId: QualificationId,
      executionStatus: Schema.Literals(["completed", "failed"]),
    }),
  ),
]);

/** One explicit retry attempt retained on a semantic trace. */
export interface RootRetryEvidence {
  readonly attempt: number;
  readonly kind: string;
  readonly occurredAt: string;
}

/** One resource-use quantity attributed to an accepted root. */
export interface RootResourceUse {
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
}

export type RootOperationKind =
  | "cost"
  | "delivery"
  | "file"
  | "memory"
  | "modelStep"
  | "providerCall"
  | "retry"
  | "search"
  | "tool"
  | "workflowStep";

/** Raw root operation samples and their reproducible distribution. */
export interface RootOperationEvidence {
  readonly kind: RootOperationKind;
  readonly maximum: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly sampleCount: number;
  readonly samples: ReadonlyArray<number>;
  readonly sourceProductFactIds: ReadonlyArray<string>;
}

/** One unsampled semantic trace correlated across Osfo work identities. */
export interface RootSemanticTrace {
  readonly activation: {
    readonly activationId: string;
    readonly cause: "deployment" | "faultRecovery" | "firstUse" | "idleEviction" | "warm";
    readonly classification: "cold" | "warm";
    readonly region: "americas" | "asiaPacific" | "europe";
  };
  readonly ambiguity: "blockedBlindRetry" | "none" | "reconciled";
  readonly amplification: ReadonlyArray<RootAmplification>;
  readonly correlations: {
    readonly acceptanceReceiptId: string;
    readonly allowanceConsumptionId: string;
    readonly costReconciliationId: string;
    readonly deliveryId: string;
    readonly outcomeId: string;
    readonly priceBookId: string;
    readonly r2ObjectId: string | null;
    readonly scheduledTaskId: string | null;
    readonly thinkRequestId: string;
    readonly thinkSubmissionId: string;
    readonly userMessageId: string;
    readonly userUpdateId: string;
    readonly workflowId: string | null;
  };
  readonly costReconciliationId: string;
  readonly journey: ReferenceJourney;
  readonly plan: "adventurer" | "free";
  readonly operations: ReadonlyArray<RootOperationEvidence>;
  readonly resourceUse: ReadonlyArray<RootResourceUse>;
  readonly retries: ReadonlyArray<RootRetryEvidence>;
  readonly rootId: string;
  readonly signals: ReadonlyArray<RootSemanticSignal>;
  readonly stages: ReadonlyArray<RootStageEvidence>;
  readonly stageOccurrences: ReadonlyArray<ProductStageOccurrence>;
  readonly terminalState: "failed" | "succeeded" | "typedRejected";
  readonly traceId: string;
}

/** Manifest-owned semantic requirements for one journey. */
export interface SemanticJourneyRequirement {
  readonly amplificationLimits: Readonly<Record<string, number>>;
  readonly requiredComponents: ReadonlyArray<SemanticComponent>;
  readonly requiredCorrelations: ReadonlyArray<SemanticCorrelation>;
  readonly requiredStages: ReadonlyArray<SemanticStage>;
  readonly requiredStores: ReadonlyArray<EvidenceStore>;
}

/** Complete unsampled semantic evidence corpus for accepted qualification roots. */
export interface SemanticEvidenceInput {
  readonly acceptedRootIds: ReadonlyArray<string>;
  readonly localEvidence: ReadonlyArray<LocalProductEvidence>;
  readonly productAuthorityExports: ReadonlyArray<ProductAuthorityExport>;
  readonly r2Evidence: ReadonlyArray<R2ObjectEvidence>;
  readonly telemetry: ReadonlyArray<TelemetrySignal>;
  readonly traces: ReadonlyArray<RootSemanticTrace>;
}

/** Frozen deploy version and exact run window for each accepted semantic root. */
export interface SemanticEvidenceContext {
  readonly sourceVersion: string;
  readonly rootWindows: Readonly<
    Record<string, { readonly endedAtUtc: string; readonly startedAtUtc: string }>
  >;
}

const finding = (
  code: string,
  detail: string,
  subject: string,
  verdict: QualificationFinding["verdict"],
): QualificationFinding => ({ code, detail, subject, verdict });

const validTimestamp = (value: string): boolean =>
  value.length > 0 && Number.isFinite(Date.parse(value));

const requiredOperationKinds: ReadonlyArray<RootOperationKind> = [
  "modelStep",
  "tool",
  "search",
  "memory",
  "file",
  "workflowStep",
  "retry",
  "delivery",
  "providerCall",
  "cost",
];

const operationPercentile = (sorted: ReadonlyArray<number>, ratio: number): number =>
  sorted.at(Math.max(0, Math.ceil(sorted.length * ratio) - 1)) ?? 0;

const evidenceFromAuthorityExport = (
  artifact: ProductAuthorityExport,
): ReadonlyArray<ProductAuthorityEvidence> => {
  const base = (
    record: ProductExportRecordBase,
    correlations: ProductAuthorityEvidence["correlations"],
    terminalFact = true,
    activation: RootSemanticTrace["activation"] | null = null,
    terminalObserved = true,
  ): ProductAuthorityEvidence => ({
    activation,
    authority: artifact.authority,
    component: componentForAuthority(artifact.authority),
    correlations,
    effectReceipts: record.effectReceipts,
    occurredAt: record.occurredAt,
    productFactId: record.productFactId,
    rootId: record.rootId,
    terminalFact,
    terminalObserved,
    sourceArtifactChecksum: artifact.checksum,
    sourceArtifactId: artifact.artifactId,
    stageOccurrences: record.stageOccurrences,
  });
  switch (artifact.authority) {
    case "osfo_agent_activation_log":
      return artifact.records
        .filter((record) => "activationId" in record)
        .map((record) =>
          base(record, {}, true, {
            activationId: record.activationId,
            cause: record.cause,
            classification: record.classification,
            region: record.region,
          }),
        );
    case "worker_admission_receipts":
      return artifact.records
        .filter((record) => "admissionDecision" in record)
        .map((record) =>
          base(
            record,
            {
              acceptanceReceiptId: record.acceptanceReceiptId,
              userMessageId: record.userMessageId,
              userUpdateId: record.userUpdateId,
            },
            record.admissionDecision === "accepted",
          ),
        );
    case "think_submission_receipts":
      return artifact.records
        .filter((record) => "thinkSubmissionId" in record)
        .map((record) =>
          base(
            record,
            {
              acceptanceReceiptId: record.acceptanceReceiptId,
              thinkSubmissionId: record.thinkSubmissionId,
            },
            record.submissionStatus === "accepted",
          ),
        );
    case "whatsapp_delivery_receipts":
      return artifact.records
        .filter((record) => "providerMessageId" in record)
        .map((record) =>
          base(
            record,
            {
              deliveryId: record.deliveryId,
              outcomeId: record.outcomeId,
              userMessageId: record.userMessageId,
              userUpdateId: record.userUpdateId,
            },
            record.deliveryStatus === "succeeded",
          ),
        );
    case "provider_delivery_receipts":
      return artifact.records
        .filter((record) => "providerStatus" in record)
        .map((record) =>
          base(
            record,
            { deliveryId: record.deliveryId, outcomeId: record.outcomeId },
            record.providerStatus === "succeeded",
          ),
        );
    case "gmail_provider_receipts":
      return artifact.records
        .filter((record) => "gmailMessageId" in record)
        .map((record) =>
          base(
            record,
            { deliveryId: record.deliveryId, outcomeId: record.outcomeId },
            record.deliveryStatus === "succeeded",
          ),
        );
    case "workflow_instance_receipts":
      return artifact.records
        .filter((record) => "workflowStatus" in record)
        .map((record) =>
          base(
            record,
            {
              outcomeId: record.outcomeId,
              scheduledTaskId: record.scheduledTaskId,
              workflowId: record.workflowId,
            },
            record.workflowStatus === "completed",
            null,
            record.workflowStatus !== "running",
          ),
        );
    case "model_access_receipts":
      return artifact.records
        .filter((record) => "modelRequestId" in record)
        .map((record) =>
          base(
            record,
            {
              costReconciliationId: record.costReconciliationId,
              outcomeId: record.outcomeId,
              priceBookId: record.priceBookId,
            },
            record.requestStatus === "completed",
          ),
        );
    case "memory_commit_receipts":
      return artifact.records
        .filter((record) => "memoryCommitId" in record)
        .map((record) =>
          base(
            record,
            { outcomeId: record.outcomeId, userMessageId: record.userMessageId },
            record.commitStatus === "committed",
          ),
        );
    case "task_compute_receipts":
      return artifact.records
        .filter((record) => "taskExecutionId" in record)
        .map((record) =>
          base(
            record,
            { outcomeId: record.outcomeId, scheduledTaskId: record.scheduledTaskId },
            record.executionStatus === "completed",
          ),
        );
  }
  return [];
};

const correlationAuthorities = {
  costReconciliationId: ["ModelAccess"],
  deliveryId: ["Provider", "WhatsApp", "Gmail"],
  outcomeId: ["Provider", "Workflow", "TaskCompute"],
  priceBookId: ["ModelAccess"],
  scheduledTaskId: ["TaskCompute"],
  thinkRequestId: ["AgentSQLite"],
  thinkSubmissionId: ["Think"],
  userMessageId: ["AgentSQLite", "WhatsApp"],
  userUpdateId: ["WhatsApp", "Worker"],
  workflowId: ["Workflow"],
} satisfies Readonly<
  Record<
    Exclude<SemanticCorrelation, "acceptanceReceiptId" | "allowanceConsumptionId" | "r2ObjectId">,
    ReadonlyArray<SemanticComponent>
  >
>;

/** Assess authoritative root evidence against frozen journey requirements. */
export const assessSemanticEvidence = (
  input: SemanticEvidenceInput,
  requirementsByJourney: Readonly<Record<string, SemanticJourneyRequirement>>,
  context?: SemanticEvidenceContext,
): QualificationAssessment => {
  const findings: Array<QualificationFinding> = [];
  const parsedLocalEvidence = input.localEvidence.flatMap((record) =>
    Option.toArray(Schema.decodeOption(LocalProductEvidenceBoundary)(record)),
  );
  if (parsedLocalEvidence.length !== input.localEvidence.length) {
    findings.push(
      finding(
        "localEvidenceBoundaryInvalid",
        "Local product evidence failed its refined boundary parser",
        "semanticEvidence",
        "FAIL",
      ),
    );
  }
  const parsedR2Evidence = input.r2Evidence.flatMap((record) =>
    Option.toArray(Schema.decodeOption(R2ObjectEvidenceBoundary)(record)),
  );
  if (parsedR2Evidence.length !== input.r2Evidence.length) {
    findings.push(
      finding(
        "r2EvidenceBoundaryInvalid",
        "R2 evidence failed its refined boundary parser",
        "semanticEvidence",
        "FAIL",
      ),
    );
  }
  const parsedAuthorityExports = input.productAuthorityExports.flatMap((artifact) =>
    Option.toArray(Schema.decodeOption(ProductAuthorityExportBoundary)(artifact)),
  );
  if (parsedAuthorityExports.length !== input.productAuthorityExports.length) {
    findings.push(
      finding(
        "productEvidenceBoundaryInvalid",
        "A retained component authority export failed its refined boundary parser",
        "semanticEvidence",
        "FAIL",
      ),
    );
  }
  const parsedProductEvidence: Array<ProductAuthorityEvidence> =
    parsedAuthorityExports.flatMap<ProductAuthorityEvidence>((artifact) => {
      if (
        artifact.checksum !==
        qualificationChecksum({
          artifactId: artifact.artifactId,
          authority: artifact.authority,
          exportedAtUtc: artifact.exportedAtUtc,
          records: artifact.records,
          sourceVersion: artifact.sourceVersion,
        })
      ) {
        findings.push(
          finding(
            "productAuthorityExportChecksumMismatch",
            `${artifact.artifactId} does not match its committed export content`,
            artifact.artifactId,
            "FAIL",
          ),
        );
        return [];
      }
      const exportTime = Date.parse(artifact.exportedAtUtc);
      if (
        context !== undefined &&
        (artifact.sourceVersion !== context.sourceVersion ||
          artifact.records.some((record) => {
            const window = context.rootWindows[record.rootId];
            const occurredAt = Date.parse(record.occurredAt);
            return (
              window === undefined ||
              occurredAt < Date.parse(window.startedAtUtc) ||
              occurredAt > Date.parse(window.endedAtUtc) ||
              occurredAt > exportTime
            );
          }))
      ) {
        findings.push(
          finding(
            "productAuthorityExportWindowConflict",
            `${artifact.artifactId} is stale or outside the frozen run version and UTC window`,
            artifact.artifactId,
            "FAIL",
          ),
        );
        return [];
      }
      return evidenceFromAuthorityExport(artifact);
    });
  const agentRootByReceipt = new Map(
    parsedLocalEvidence.flatMap((record) =>
      record.store === "AgentSQLite" ? [[record.acceptanceReceiptId, record.rootId] as const] : [],
    ),
  );
  parsedProductEvidence.push(
    ...parsedLocalEvidence.flatMap((record): ReadonlyArray<ProductAuthorityEvidence> => {
      if (record.store === "AgentSQLite") {
        return [
          {
            authority: "osfo_committed_turns",
            activation: null,
            component: "AgentSQLite",
            correlations: {
              acceptanceReceiptId: record.acceptanceReceiptId,
              thinkRequestId: record.thinkRequestId,
              userMessageId: record.rootId,
            },
            effectReceipts: [],
            occurredAt: record.occurredAt,
            productFactId: record.productFactId,
            rootId: record.rootId,
            terminalFact: true,
            terminalObserved: true,
            sourceArtifactChecksum: record.evidenceId,
            sourceArtifactId: record.evidenceId,
            stageOccurrences: [],
          },
        ];
      }
      const rootId = agentRootByReceipt.get(record.acceptanceReceiptId);
      if (rootId === undefined) return [];
      return [
        {
          authority: "allowance_and_billing_ledger",
          activation: null,
          component: "PostgreSQL",
          correlations: {
            acceptanceReceiptId: record.acceptanceReceiptId,
            allowanceConsumptionId: record.allowanceConsumptionId,
          },
          effectReceipts: [],
          occurredAt: record.occurredAt,
          productFactId: record.productFactId,
          rootId,
          terminalFact: true,
          terminalObserved: true,
          sourceArtifactChecksum: record.evidenceId,
          sourceArtifactId: record.evidenceId,
          stageOccurrences: [],
        },
      ];
    }),
    ...parsedR2Evidence.map((record): ProductAuthorityEvidence => ({
      authority: "r2_object_metadata",
      activation: null,
      component: "R2",
      correlations: { r2ObjectId: record.objectId },
      effectReceipts: [],
      occurredAt: record.uploadedAt,
      productFactId: record.objectId,
      rootId: record.rootId,
      terminalFact: true,
      terminalObserved: true,
      sourceArtifactChecksum: record.checksum,
      sourceArtifactId: record.objectKey,
      stageOccurrences: [],
    })),
  );
  const acceptedRoots = new Set(input.acceptedRootIds);
  const tracesByRoot = new Map<string, Array<RootSemanticTrace>>();
  for (const trace of input.traces) {
    const traces = tracesByRoot.get(trace.rootId) ?? [];
    traces.push(trace);
    tracesByRoot.set(trace.rootId, traces);
  }
  const agentEvidenceByRoot = new Map<string, Array<AgentSqliteProductEvidence>>();
  const postgresEvidenceByReceipt = new Map<string, Array<PostgresProductEvidence>>();
  for (const record of parsedLocalEvidence) {
    if (record.store === "AgentSQLite") {
      const records = agentEvidenceByRoot.get(record.rootId) ?? [];
      records.push(record);
      agentEvidenceByRoot.set(record.rootId, records);
    } else {
      const records = postgresEvidenceByReceipt.get(record.acceptanceReceiptId) ?? [];
      records.push(record);
      postgresEvidenceByReceipt.set(record.acceptanceReceiptId, records);
    }
  }
  const productEvidenceByRoot = new Map<string, Array<ProductAuthorityEvidence>>();
  for (const record of parsedProductEvidence) {
    const records = productEvidenceByRoot.get(record.rootId) ?? [];
    records.push(record);
    productEvidenceByRoot.set(record.rootId, records);
  }
  const r2EvidenceByRoot = new Map<string, Array<R2ObjectEvidence>>();
  for (const record of parsedR2Evidence) {
    const records = r2EvidenceByRoot.get(record.rootId) ?? [];
    records.push(record);
    r2EvidenceByRoot.set(record.rootId, records);
  }
  for (const record of parsedR2Evidence) {
    if (!acceptedRoots.has(record.rootId)) {
      findings.push(
        finding(
          "r2EvidenceOutsideCorpus",
          `${record.rootId} is not an accepted qualification root`,
          record.rootId,
          "FAIL",
        ),
      );
    }
  }
  const correlationOwners = new Map<string, string>();
  const acceptedReceiptIds = new Set(
    input.traces.map((trace) => trace.correlations.acceptanceReceiptId),
  );
  if (input.acceptedRootIds.some((rootId) => rootId.length === 0)) {
    findings.push(
      finding(
        "invalidAcceptedRoot",
        "Accepted root identities must be non-empty",
        "semanticEvidence",
        "FAIL",
      ),
    );
  }
  if (acceptedRoots.size !== input.acceptedRootIds.length) {
    findings.push(
      finding(
        "duplicateAcceptedRoot",
        "The accepted-root identity set contains duplicates",
        "semanticEvidence",
        "FAIL",
      ),
    );
  }
  for (const trace of input.traces) {
    if (!acceptedRoots.has(trace.rootId)) {
      findings.push(
        finding(
          "unacceptedRootTrace",
          `${trace.rootId} was not in the accepted-root set`,
          trace.rootId,
          "FAIL",
        ),
      );
    }
  }
  for (const record of parsedLocalEvidence) {
    const traceBound =
      record.store === "AgentSQLite"
        ? acceptedRoots.has(record.rootId)
        : acceptedReceiptIds.has(record.acceptanceReceiptId);
    if (!traceBound) {
      findings.push(
        finding(
          "localEvidenceOutsideCorpus",
          `${record.evidenceId} is not bound to an accepted root`,
          record.evidenceId,
          "FAIL",
        ),
      );
    }
  }
  for (const record of parsedProductEvidence) {
    if (!acceptedRoots.has(record.rootId)) {
      findings.push(
        finding(
          "productEvidenceOutsideCorpus",
          `${record.productFactId} is not bound to an accepted root`,
          record.productFactId,
          "FAIL",
        ),
      );
    }
  }
  for (const rootId of input.acceptedRootIds) {
    const traces = tracesByRoot.get(rootId) ?? [];
    if (traces.length === 0) {
      findings.push(
        finding("rootTraceMissing", `${rootId} has no semantic trace`, rootId, "MISSING"),
      );
      continue;
    }
    if (traces.length > 1) {
      findings.push(
        finding(
          "duplicateRootTrace",
          `${rootId} has ${traces.length} semantic traces`,
          rootId,
          "FAIL",
        ),
      );
      continue;
    }
    const trace = traces[0];
    if (trace === undefined) continue;
    const requirements = requirementsByJourney[trace.journey];
    if (requirements === undefined) {
      findings.push(
        finding(
          "semanticJourneyUnknown",
          `${trace.journey} has no frozen semantic requirements`,
          rootId,
          "MISSING",
        ),
      );
      continue;
    }
    for (const correlation of requirements.requiredCorrelations) {
      if (correlation === "priceBookId") continue;
      const value = trace.correlations[correlation];
      if (value === null || value.length === 0) continue;
      const identity = `${correlation}:${value}`;
      const owner = correlationOwners.get(identity);
      if (owner !== undefined && owner !== rootId) {
        findings.push(
          finding(
            "crossRootCorrelationConflict",
            `${correlation} ${value} is reused by ${owner} and ${rootId}`,
            value,
            "FAIL",
          ),
        );
      } else {
        correlationOwners.set(identity, rootId);
      }
    }
    for (const store of requirements.requiredStores) {
      const records =
        store === "AgentSQLite"
          ? (agentEvidenceByRoot.get(rootId) ?? [])
          : (postgresEvidenceByReceipt.get(trace.correlations.acceptanceReceiptId) ?? []);
      if (records.length === 0) {
        findings.push(
          finding(
            "localEvidenceMissing",
            `${rootId} has no authoritative ${store} evidence`,
            rootId,
            "MISSING",
          ),
        );
      } else if (records.length > 1) {
        findings.push(
          finding(
            "duplicateLocalAuthorityEvidence",
            `${rootId} has ${records.length} authoritative ${store} records`,
            rootId,
            "FAIL",
          ),
        );
      }
      for (const record of records) {
        if (
          record.evidenceId.length === 0 ||
          record.productFactId.length === 0 ||
          !validTimestamp(record.occurredAt)
        ) {
          findings.push(
            finding(
              "invalidLocalEvidence",
              `${rootId} has malformed ${store} transaction evidence`,
              rootId,
              "FAIL",
            ),
          );
        }
        if (
          (record.store === "AgentSQLite" &&
            (record.authority !== "osfo_committed_turns" ||
              record.thinkRequestId !== trace.correlations.thinkRequestId)) ||
          (record.store === "PostgreSQL" &&
            (record.authority !== "allowance_usage" ||
              record.productFactId !== record.allowanceConsumptionId ||
              record.allowanceConsumptionId !== trace.correlations.allowanceConsumptionId))
        ) {
          findings.push(
            finding(
              "localProductEvidenceConflict",
              `${rootId} semantic identities do not match the committed ${store} product row`,
              rootId,
              "FAIL",
            ),
          );
        }
      }
    }
    for (const stage of requirements.requiredStages) {
      const stages = trace.stages.filter((entry) => entry.stage === stage);
      if (stages.length === 0) {
        findings.push(
          finding(
            "stageEvidenceMissing",
            `${rootId} has no ${stage} stage evidence`,
            rootId,
            "MISSING",
          ),
        );
      } else if (stages.length > 1) {
        findings.push(
          finding(
            "duplicateStageEvidence",
            `${rootId} has duplicate ${stage} stage evidence`,
            rootId,
            "FAIL",
          ),
        );
      } else if (!validTimestamp(stages[0]?.occurredAt ?? "")) {
        findings.push(
          finding(
            "invalidStageTimestamp",
            `${rootId} has an invalid ${stage} timestamp`,
            rootId,
            "FAIL",
          ),
        );
      }
    }
    const rootProductEvidence = productEvidenceByRoot.get(rootId) ?? [];
    const productFactIds = new Set(rootProductEvidence.map((record) => record.productFactId));
    for (const kind of requiredOperationKinds) {
      const operations = trace.operations.filter((operation) => operation.kind === kind);
      const operation = operations[0];
      if (operation === undefined) {
        findings.push(
          finding(
            "rootOperationDistributionMissing",
            `${rootId} has no raw ${kind} distribution`,
            `${rootId}:${kind}`,
            "MISSING",
          ),
        );
        continue;
      }
      const sorted = Array.sortWith(operation.samples, (sample) => sample, Order.Number);
      if (
        operations.length !== 1 ||
        sorted.length === 0 ||
        sorted.some((sample) => !Number.isFinite(sample) || sample < 0) ||
        operation.sampleCount !== sorted.length ||
        operation.maximum !== sorted.at(-1) ||
        operation.p50 !== operationPercentile(sorted, 0.5) ||
        operation.p95 !== operationPercentile(sorted, 0.95) ||
        operation.p99 !== operationPercentile(sorted, 0.99) ||
        operation.sourceProductFactIds.length === 0
      ) {
        findings.push(
          finding(
            "rootOperationDistributionInvalid",
            `${rootId} ${kind} distribution is not derived from authority-bound raw samples`,
            `${rootId}:${kind}`,
            "FAIL",
          ),
        );
      }
      if (operation.sourceProductFactIds.some((factId) => !productFactIds.has(factId))) {
        findings.push(
          finding(
            "rootOperationAuthorityMissing",
            `${rootId} ${kind} samples have no retained product authority fact`,
            `${rootId}:${kind}`,
            "MISSING",
          ),
        );
      }
    }
    const committedStageOccurrences = rootProductEvidence.flatMap(
      (record) => record.stageOccurrences,
    );
    const traceStageKeys = trace.stageOccurrences.map((occurrence) => occurrence.boundary);
    if (new Set(traceStageKeys).size !== traceStageKeys.length) {
      findings.push(
        finding(
          "duplicateProductStageOccurrence",
          `${rootId} has duplicate named product stage boundaries`,
          rootId,
          "FAIL",
        ),
      );
    }
    for (const occurrence of trace.stageOccurrences) {
      const matches = committedStageOccurrences.filter(
        (committed) =>
          committed.boundary === occurrence.boundary &&
          committed.productFactId === occurrence.productFactId &&
          committed.occurredAt === occurrence.occurredAt,
      );
      if (matches.length === 0) {
        findings.push(
          finding(
            "productStageAuthorityMissing",
            `${rootId} ${occurrence.boundary} has no exact committed authority fact`,
            `${rootId}:${occurrence.boundary}`,
            "MISSING",
          ),
        );
      } else if (matches.length > 1) {
        findings.push(
          finding(
            "duplicateProductStageAuthority",
            `${rootId} ${occurrence.boundary} has duplicate committed authority facts`,
            `${rootId}:${occurrence.boundary}`,
            "FAIL",
          ),
        );
      }
    }
    for (const component of new Set(requirements.requiredComponents)) {
      const signals = trace.signals.filter((signal) => signal.component === component);
      if (signals.length === 0) {
        findings.push(
          finding(
            "componentEvidenceMissing",
            `${rootId} has no ${component} semantic signal`,
            `${rootId}:${component}`,
            "MISSING",
          ),
        );
      } else if (signals.length > 1) {
        findings.push(
          finding(
            "duplicateComponentEvidence",
            `${rootId} has duplicate ${component} semantic signals`,
            `${rootId}:${component}`,
            "FAIL",
          ),
        );
      } else if (
        signals.some((signal) => signal.signalId.length === 0 || !validTimestamp(signal.occurredAt))
      ) {
        findings.push(
          finding(
            "invalidComponentEvidence",
            `${rootId} has malformed ${component} semantic evidence`,
            `${rootId}:${component}`,
            "FAIL",
          ),
        );
      }
      const authorityRecords = rootProductEvidence.filter(
        (record) =>
          record.component === component &&
          record.authority === componentAuthorities[component] &&
          signals.some(
            (signal) =>
              signal.signalId === record.productFactId && signal.occurredAt === record.occurredAt,
          ),
      );
      if (authorityRecords.length === 0) {
        findings.push(
          finding(
            "componentProductAuthorityMissing",
            `${rootId} has no committed ${component} product fact`,
            `${rootId}:${component}`,
            "MISSING",
          ),
        );
      } else if (
        authorityRecords.length > 1 ||
        authorityRecords.some(
          (record) =>
            record.productFactId.length === 0 ||
            !validTimestamp(record.occurredAt) ||
            !record.terminalObserved ||
            (component === "AgentActivation" &&
              (record.activation?.activationId !== trace.activation.activationId ||
                record.activation?.cause !== trace.activation.cause ||
                record.activation?.classification !== trace.activation.classification ||
                record.activation?.region !== trace.activation.region)),
        )
      ) {
        findings.push(
          finding(
            "componentProductAuthorityInvalid",
            `${rootId} has duplicate or malformed ${component} product authority`,
            `${rootId}:${component}`,
            "FAIL",
          ),
        );
      }
    }
    for (const correlation of requirements.requiredCorrelations) {
      const value = trace.correlations[correlation];
      if (value === null || value.length === 0) {
        findings.push(
          finding(
            "rootCorrelationMissing",
            `${rootId} has no ${correlation} correlation identity`,
            rootId,
            "MISSING",
          ),
        );
      } else if (
        correlation !== "acceptanceReceiptId" &&
        correlation !== "allowanceConsumptionId" &&
        correlation !== "r2ObjectId" &&
        !rootProductEvidence.some(
          (record) =>
            new Set<SemanticComponent>(correlationAuthorities[correlation]).has(record.component) &&
            record.correlations[correlation] === value,
        )
      ) {
        findings.push(
          finding(
            "correlationProductAuthorityMissing",
            `${rootId} ${correlation} is not bound to a committed product fact`,
            rootId,
            "MISSING",
          ),
        );
      }
    }
    if (requirements.requiredComponents.includes("R2")) {
      const r2Records = (r2EvidenceByRoot.get(rootId) ?? []).filter(
        (record) => record.rootId === rootId && record.objectId === trace.correlations.r2ObjectId,
      );
      if (r2Records.length === 0) {
        findings.push(
          finding(
            "r2ObjectEvidenceMissing",
            `${rootId} has no checksum-backed committed R2 object evidence`,
            rootId,
            "MISSING",
          ),
        );
      } else if (
        r2Records.length > 1 ||
        r2Records.some(
          (record) =>
            record.checksum.length === 0 ||
            record.etag.length === 0 ||
            record.objectKey.length === 0 ||
            record.version.length === 0 ||
            !validTimestamp(record.uploadedAt),
        )
      ) {
        findings.push(
          finding(
            "r2ObjectEvidenceInvalid",
            `${rootId} has duplicate or malformed R2 object evidence`,
            rootId,
            "FAIL",
          ),
        );
      }
    }
    for (const [kind, maximum] of Object.entries(requirements.amplificationLimits)) {
      const records = trace.amplification.filter((entry) => entry.kind === kind);
      const authorityReceipts = rootProductEvidence.flatMap((record) =>
        record.effectReceipts.filter((receipt) => receipt.kind === kind),
      );
      const authorityCount = new Set(authorityReceipts.map(({ effectId }) => effectId)).size;
      const authorityInvalid =
        authorityReceipts.length === 0 || authorityCount !== authorityReceipts.length;
      if (records.length === 0) {
        findings.push(
          finding(
            "amplificationEvidenceMissing",
            `${rootId} has no ${kind} amplification count`,
            rootId,
            "MISSING",
          ),
        );
      } else if (records.length > 1) {
        findings.push(
          finding(
            "duplicateAmplificationEvidence",
            `${rootId} has duplicate ${kind} amplification counts`,
            rootId,
            "FAIL",
          ),
        );
      } else if (authorityInvalid) {
        findings.push(
          finding(
            authorityReceipts.length === 0
              ? "amplificationAuthorityMissing"
              : "amplificationAuthorityDuplicate",
            `${rootId} has no unique retained ${kind} effect receipts`,
            rootId,
            authorityReceipts.length === 0 ? "MISSING" : "FAIL",
          ),
        );
      } else {
        const count = records[0]?.count;
        if (
          count === undefined ||
          !Number.isInteger(count) ||
          count < 0 ||
          !Number.isInteger(maximum) ||
          maximum < 0
        ) {
          findings.push(
            finding(
              "invalidAmplificationEvidence",
              `${rootId} has invalid ${kind} amplification evidence`,
              rootId,
              "FAIL",
            ),
          );
        } else if (count !== authorityCount) {
          findings.push(
            finding(
              "amplificationAuthorityConflict",
              `${rootId} declared ${count} ${kind}, authority receipts contain ${authorityCount}`,
              rootId,
              "FAIL",
            ),
          );
        } else if (authorityCount > maximum) {
          findings.push(
            finding(
              "amplificationExceeded",
              `${rootId} produced ${authorityCount} ${kind}, maximum ${maximum}`,
              rootId,
              "FAIL",
            ),
          );
        }
      }
    }
    for (const amplification of trace.amplification) {
      if (!(amplification.kind in requirements.amplificationLimits)) {
        findings.push(
          finding(
            "unfrozenAmplificationKind",
            `${rootId} recorded ${amplification.kind} without a frozen manifest maximum`,
            rootId,
            "FAIL",
          ),
        );
      }
    }
    if (trace.correlations.userMessageId !== trace.rootId) {
      findings.push(
        finding(
          "rootCorrelationConflict",
          `${rootId} is correlated to UserMessage ${trace.correlations.userMessageId}`,
          rootId,
          "FAIL",
        ),
      );
    }
    if (trace.correlations.costReconciliationId !== trace.costReconciliationId) {
      findings.push(
        finding(
          "costCorrelationConflict",
          `${rootId} has conflicting trace and correlation cost identities`,
          rootId,
          "FAIL",
        ),
      );
    }
    if (
      trace.traceId.length === 0 ||
      trace.activation.activationId.length === 0 ||
      trace.correlations.acceptanceReceiptId.length === 0 ||
      trace.correlations.thinkRequestId.length === 0 ||
      trace.correlations.thinkSubmissionId.length === 0 ||
      trace.costReconciliationId.length === 0 ||
      trace.resourceUse.length === 0
    ) {
      findings.push(
        finding(
          "materialTraceEvidenceMissing",
          `${rootId} omits a material trace identity, resource, or cost fact`,
          rootId,
          "MISSING",
        ),
      );
    }
    if ((trace.activation.classification === "warm") !== (trace.activation.cause === "warm")) {
      findings.push(
        finding(
          "activationClassificationConflict",
          `${rootId} has an inconsistent activation classification and cause`,
          rootId,
          "FAIL",
        ),
      );
    }
    if (
      trace.resourceUse.some(
        (use) =>
          use.name.length === 0 ||
          use.unit.length === 0 ||
          !Number.isFinite(use.quantity) ||
          use.quantity < 0,
      ) ||
      trace.retries.some(
        (retry) =>
          retry.kind.length === 0 ||
          !Number.isInteger(retry.attempt) ||
          retry.attempt < 1 ||
          !validTimestamp(retry.occurredAt),
      )
    ) {
      findings.push(
        finding(
          "invalidTraceEvidence",
          `${rootId} has malformed retry or resource evidence`,
          rootId,
          "FAIL",
        ),
      );
    }
  }
  return assessmentFromFindings(findings);
};
