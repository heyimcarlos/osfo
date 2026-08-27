import {
  action,
  defaultContextOverflowClassifier,
  Session,
  Think,
  type ActionAuthorizationContext,
  type ActionAuthorizationDecision,
  type ChatErrorContext,
  type ChatResponseResult,
  type StreamCallback,
  type PrepareStepContext,
  type PendingApproval,
  type StepConfig,
  type StepContext,
  type SubmitMessagesResult,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import { SkillChangeRequest, SkillDeletionRequest } from "@osfo/api";
import type { MessengerContext } from "@cloudflare/think/messengers";
import { generateText, Output, tool, type ToolSet, type UIMessage } from "ai";
import { genericObservability } from "agents/observability";
import { createCompactFunction } from "agents/experimental/memory/utils";
import {
  Cause,
  Data,
  DateTime,
  Effect,
  Exit,
  Option,
  Predicate,
  Result,
  Schema,
  Semaphore,
} from "effect";

import type { ChannelLinkId } from "../../domain";
import type { AllowanceItem, AllowanceSource } from "../../domain/allowance";
import {
  AgentId,
  AllowancePeriodId,
  AssistantMessageId,
  ConversationRouteId,
  SessionId,
  ThinkSubmissionId,
  ThinkRequestId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { AuthSessionId } from "../../domain/auth-session";
import { ContentId } from "../../domain/client-content";
import type { AuthorizationOperation } from "../../domain/authorization-operation";
import {
  CapabilityId,
  closedCapabilityIds,
  currentCapabilityCatalog,
} from "../../domain/capability-catalog";
import {
  type GoodRootOutcomeEvaluationReference,
  PersonalSkillId,
  PersonalSkillVersion,
  PersonalSkillVersionId,
  type SkillLearningCandidate,
} from "../../domain/personal-skill";
import { DocumentArtifact } from "../../domain/document-artifact";
import { ArtifactGenerationComposition } from "../../composition/artifact-generation";
import { DocumentGenerationComposition } from "../../composition/document-generation";
import { ArtifactGeneration } from "../../services/artifact-generation";
import { IntegrationComposition } from "../../composition/integrations";
import { Db } from "../../db";
import { BillingDb } from "../../db/billing";
import { decodeOsfoStage, loadConfig } from "../../config";
import {
  hasRecognizedWebSearchPrice,
  makeDiscovery,
  makePageFetch,
} from "../../integrations/cloudflare/web";
import { ChannelLinkAuthorizationPostgres } from "../../integrations/postgres/channel-link-authorization";
import { SessionRecallAuthorizationPostgres } from "../../integrations/postgres/session-recall-authorization";
import { SupermemoryMemoryProvider } from "../../integrations/supermemory/memory-provider";
import {
  CancelManagedConversationInput,
  type ManagedCapabilityTurnState,
  ManagedTurnMetadata,
  type ManagedTurnAuthorityIdentity,
} from "../../domain/managed-conversation";
import {
  ModelCallUsageDispatchUnavailable,
  ModelCallAttemptId,
  ModelStepNumber,
  conservativeVendorCostForStep,
  modelCallAttemptId,
  type ModelCallEvidence,
  type PendingModelCallUsage,
} from "../../domain/model-call-attempt";
import {
  admitManagedConversation,
  type ManagedConversationDenied,
  type ManagedConversationAdmitted,
  type ManagedSessionReplacementAdmitted,
  SubmitManagedConversationInput,
} from "../../services/managed-conversation";
import {
  launchModelAccessPolicy,
  type ManagedRouteUnavailable,
} from "../../domain/model-access-policy";
import {
  currentLaunchPolicy,
  retainedCatalog,
  type PlanPolicyNotFound,
} from "../../domain/plan-policy";
import {
  CommittedTurnTerminal,
  persistThinkTerminalBeforeCapture,
  withCommittedTurnTerminal,
} from "./committed-turn-terminal";
import {
  ingestGoodRootEvaluation,
  recoverPersonalSkillLearning,
  selectPersonalSkillsForTurn,
} from "./personal-skill-runtime";
import { makePersonalSkillControl, PersonalSkillApprovalInvalid } from "./personal-skill-control";
import {
  FileAnalysisId,
  type FileAnalysisRecord,
  FileId,
  FileName,
  FileUploadId,
} from "../../domain/file";
import { makeCloudflareFileCompute } from "../../integrations/cloudflare/file-compute";
import {
  type FileObjectMetadataInvalid,
  type FileObjectStoreUnavailable,
  makeR2FileObjects,
} from "../../integrations/cloudflare/file-objects";
import { loadCurrentFileAuthorization } from "../../integrations/postgres/file-authorization";
import { DeletionCasePostgres } from "../../integrations/postgres/deletion-case";
import { AgentDirectory } from "../../services/agent-directory";
import { ChannelLinks } from "../../services/channel-links";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";
import { makeAgentDb } from "./db/client";

type ChannelProvider = "telegram" | "whatsapp";
import {
  FileAnalysisConflict,
  type FileNotFound,
  type FileStoreRecordInvalid,
  type FileStoreUnavailable,
  type FileUploadConflict,
  makeFileStore,
  type RetainedFileLimitExceeded,
} from "./db/file-store";
import { type FileStateTransitionConflict, makeFiles } from "../../services/files";
import {
  BoundCoreMemoryInput,
  type BoundCoreMemoryEncoded,
  boundCoreMemory,
  clearCoreMemory,
  configureCoreMemory,
  coreMemoryLabelFor,
  coreMemoryTools,
  type CoreMemoryBudgetExceeded,
  type CoreMemoryBound,
  type CoreMemoryCorrected,
  type CoreMemoryInspected,
  CoreMemoryUnavailable,
  CorrectCoreMemoryInput,
  type CorrectCoreMemoryEncoded,
  correctCoreMemory,
  inspectCoreMemory,
  InspectCoreMemoryInput,
  type InspectCoreMemoryEncoded,
  refreshCoreMemoryPrompt,
  replaceCoreMemoryBlocks,
} from "./core-memory";
import { Allowances } from "../../services/allowances";
import { makeActionApprovals } from "../../services/action-approvals";
import {
  approvalFor,
  type ApprovalPresentation,
  Authorization,
  restoreCoreMemoryAuthorization,
  type ApprovalRequired,
  AuthorizationContext,
  emptyLiveResourceFacts,
  type Denied,
} from "../../services/authorization";
import { DocumentGeneration } from "../../services/document-generation";
import { makeDurableModelCallUsage } from "../../services/model-call-usage";
import { MemoryProvider } from "../../services/memory-provider";
import { makeManagedActionAuthorization } from "../../services/managed-action-authorization";
import {
  makeSessionLifecycle,
  type SessionAuthorizationFactsFound,
  SessionLifecycleNotFound,
  SessionLifecycleUnavailable,
} from "../../services/session-lifecycle";
import {
  makeSessionRecall,
  SessionRecallAuthorizationUnavailable,
  SessionRecallStoreUnavailable,
} from "../../services/session-recall";
import { makeSessionRecallAuthorization } from "../../services/session-recall-authorization";
import { PromptAssembly } from "../../services/prompt-assembly";
import { PromptUtilization } from "../../services/prompt-utilization";
import { Capabilities } from "../../services/capabilities";
import { CapabilityTurn } from "./capability-turn";
import { CapabilityContext } from "./capability-context";
import type {
  CurrentSessionActivationUnavailable,
  CurrentSessionReplaced,
  CurrentSessionReplacementConflict,
} from "../../services/session-replacement";
import { messengerAuthorId } from "./channel-address";
import {
  type AgentInitializationConflict,
  AgentRequestInvalid,
  type AgentRequestOperation,
  AgentStateNotFound,
  type AgentStoreRecordInvalid,
  AgentStoreUnavailable,
  CommittedTurnConflict,
  ThinkSessionReadUnavailable,
  ThinkSessionRecordInvalid,
} from "./db/errors";
import { applyAgentMigrations } from "./db/migrate";
import { makeModelCallUsageStore } from "./db/model-call-usage";
import { makeSessionExecution } from "./session-execution";
import { personalAgentSystemPrompt } from "./persona";
import {
  AgentInitializationInput,
  type AgentInitializationEncoded,
  type AgentInitialized,
  type AgentFound,
  type CommittedTurnReceipt,
  type ConversationRouteFound,
  makeAgentStore,
} from "./db/store";
import {
  type ActionPresentation,
  type ActionPresentationFound,
  type ActionPresentationNotFound,
  type ActionPresentationUnavailable,
  ActionApprovalRequestInvalid,
  ApprovalActorAuthorizationUnavailable,
  type ApprovalActorUnauthorized,
  type ApprovalAlreadyResolved,
  type ApprovalDecisionAccepted,
  CancelActionApprovalRequest,
  DecideActionApprovalRequest,
  makeThinkActionApprovalAdapter,
  ReadActionPresentationRequest,
  ThinkApprovalUnavailable,
} from "./think-action-approvals";
import {
  artifactDeleteActionName,
  coreMemoryClearActionName,
  documentDeleteActionName,
  type ForgetKnowledgeInput,
  makeOsfoActions,
  RetainedDocumentInput,
  sanitizePendingApproval,
  type SessionDeleteInput,
} from "./action-registry";
import {
  approvedForgetKnowledgeCorrections,
  approvalPresentationFor,
  hasExactActionInput,
  hasExactForgetKnowledgeInput,
  hasExactIntegrationActionInput,
  hasExactPersonalSkillDeleteInput,
  hasExactSessionDeleteInput,
  makeActionPresentationPersistence,
  presentOsfoAction,
} from "./action-presentation";
import { CoreMemoryAuthorizationSnapshot } from "../../domain/core-memory-authorization";
import {
  makeAccountDeletionFencedSessionExecution,
  makeAccountDeletionFence,
  requireAccountDeletionQuiescence,
} from "./account-deletion-fence";
import { makeAgentSessionLifecycle } from "./session-lifecycle";
import { deleteLocalSession, type SessionReplacementGeneration } from "./session-deletion";
import {
  completeKnowledgeDeletionPreparation,
  correctForgottenKnowledge,
} from "./knowledge-deletion";
import { makeSessionRecallTools, makeThinkSessionRecallSearch } from "./session-recall";
import { effectToolSchema } from "./effect-tool-schema";
import { makeFileTools } from "./file-tools";
import { FileAnalysisReconciliation } from "./file-analysis-reconciliation";
import { ManagedCapabilityState } from "./managed-capability-turn-state";
import {
  makeGoodRootOutcomeEvaluatorAuthority,
  makePersonalSkillAuthority,
  type PersonalSkillAvailability,
} from "./personal-skill-authority";
import { makeGoodRootOutcomeEvaluator } from "./good-root-outcome-evaluator";
import {
  makePersonalSkillTools,
  SkillInspectInput,
  SkillManageInput,
} from "./personal-skill-tools";
import type { SkillDeleteInput } from "./personal-skill-tools";
import {
  bindSkillLearningModelDecision,
  projectSkillLearningDraft,
  SkillLearningModelDecision,
} from "./post-turn-skill-learning";
import {
  makeSkillLearningCoordinator,
  type SkillLearningModelInput,
} from "./skill-learning-coordinator";
import { deliverSkillLearningNotifications } from "./skill-learning-notification";
import {
  projectCommittedConversationSnapshot,
  projectTerminalMarkedCommittedTurns,
} from "./memory-provider-projection";
import {
  type ClaimedMemoryProviderWork,
  makeMemoryProviderOutboxStore,
  MemoryProviderOutboxId,
} from "./db/memory-provider-outbox";
import {
  ProviderDeletionDeferred,
  ProviderSaveDeferred,
  memoryProviderClaimLeaseMilliseconds,
  quiesceProcessingConversations,
  reconcileMemoryProviderOutbox,
  type ReconciliationOptions,
} from "./memory-provider-reconciliation";
import { makeMemoryProviderReconciliationQueue } from "./memory-provider-reconciliation-queue";
import { makeProviderConversationSaveGate } from "./provider-conversation-save-gate";
import {
  type ApprovedCoreMemoryReplacement,
  type DeletionAuthorization,
  DeletionActionUnavailable,
} from "./deletion-actions";
import {
  integrationActionNames,
  IntegrationTools,
  IntegrationToolUnavailable,
  type IntegrationOperationIdentity,
  type IntegrationToolInput,
} from "./integration-tools";
import {
  resolveManifest,
  type ResolvedIntegrationManifestOperation,
} from "../../domain/integration-manifest";
import type { Integrations } from "../../services/integrations";
import { Web, WebUnavailable, type AuthorizationRequest } from "../../services/web";
import { makeWebState } from "./db/web-state";
import { makeWebTools } from "./web-tools";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Cloudflare Agent RPC and lifecycle hooks require Promise boundaries, and Effect results use _tag. */
/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Agent hooks and Durable Object callbacks supply the wall-clock boundary for retained metadata. */

const pendingSessionId = "__osfo_uninitialized__";
const gatewayId = "default";
const modelCallUsageRetryDelaySeconds = 60;
const memoryProviderRetryDelaySeconds = 30;
const accountDeletionProviderPollMilliseconds = 250;
const accountDeletionProviderQuiescenceTimeoutMilliseconds = 10_000;
const gatewayCostMaximumLookups = 3;
const requestTimeoutForIntegrationMillis = 30_000;

class MemoryProviderWorkUnavailable extends Data.TaggedError("MemoryProviderWorkUnavailable")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class SkillLearningModelUnavailable extends Data.TaggedError("SkillLearningModelUnavailable")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const authorization = Authorization.make(retainedCatalog);
const capabilityActionNames = [
  "analyzeFile",
  "deleteArtifact",
  "deleteDocument",
  "generateDiagram",
  "generateDocument",
  "generateImage",
  "generatePresentation",
  "revisePresentation",
  "osfoClearCoreMemory",
  "osfoDeleteSession",
  "osfoForgetKnowledge",
  "osfoDeletePersonalSkill",
  ...integrationActionNames,
] as const satisfies ReadonlyArray<Capabilities.RegisteredToolName>;
const initialPersonalSkillAvailability = {
  capabilityIds: [CapabilityId.make("conversation")],
  requirements: [
    "document-renderer",
    "file-storage",
    "native-memory",
    "personal-agent",
    "session-history",
    "skill-store",
  ],
} as const;
const settingsPersonalSkillAvailability: PersonalSkillAvailability = {
  capabilityIds: closedCapabilityIds,
  requirements: initialPersonalSkillAvailability.requirements,
};
const integrationSettingsMappings = [
  {
    description: "Search and read email on demand, then send only after exact approval.",
    label: "Gmail",
    provider: "gmail" as const,
  },
  {
    description: "Read availability and manage exact events after approval.",
    label: "Google Calendar",
    provider: "googlecalendar" as const,
  },
  {
    description: "Read owned files and deliver approved Osfo documents privately.",
    label: "Google Drive",
    provider: "googledrive" as const,
  },
];
const PersonalSkillControlActor = Schema.Struct({
  decisionReference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  userId: UserId,
});
type PersonalSkillControlActor = typeof PersonalSkillControlActor.Type;
const PersonalSkillControlChange = Schema.Struct({
  actor: PersonalSkillControlActor,
  change: SkillChangeRequest,
});
const PersonalSkillControlDelete = Schema.Struct({
  actor: PersonalSkillControlActor,
  reference: Schema.String,
  request: SkillDeletionRequest,
});
const PersonalSkillControlRead = Schema.Struct({
  actor: PersonalSkillControlActor,
  reference: Schema.String,
});
const IntegrationSettingsActor = Schema.Struct({
  authSessionId: AuthSessionId,
  userId: UserId,
});
const IntegrationSettingsToolkit = Schema.Literals(["gmail", "googlecalendar", "googledrive"]);
const integrationSettingsSelection = {
  actor: IntegrationSettingsActor,
  toolkit: IntegrationSettingsToolkit,
} as const;
const IntegrationSettingsConnect = Schema.Struct({
  ...integrationSettingsSelection,
  callbackUrl: Schema.String.check(
    Schema.makeFilter((value) => URL.canParse(value) || "must be a URL"),
  ),
});
const IntegrationSettingsMutation = Schema.Struct(integrationSettingsSelection);
const SkillLearningPrompt = Schema.Struct({
  corrections: Schema.Array(Schema.String),
  decisions: Schema.Array(Schema.String),
  priorSkill: Schema.NullOr(PersonalSkillVersion),
  taskDescription: Schema.String,
});
const encodeSkillLearningPrompt = Schema.encodeSync(Schema.fromJsonString(SkillLearningPrompt));
type AgentFilePersistenceError =
  | FileAnalysisConflict
  | FileNotFound
  | FileStateTransitionConflict
  | FileStoreRecordInvalid
  | FileStoreUnavailable
  | FileUploadConflict
  | RetainedFileLimitExceeded;

const GatewayProviderMetadata = Schema.Struct({
  cloudflare: Schema.optional(
    Schema.Struct({
      aiGatewayLogId: Schema.optional(Schema.String),
    }),
  ),
});
const GatewayCostSettlement = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  attemptId: ModelCallAttemptId,
  conservativeVendorUsdMicros: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  gatewayLogId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  lookupAttempt: Schema.Int.check(Schema.isGreaterThan(0)),
});
type GatewayCostSettlement = typeof GatewayCostSettlement.Type;

const GenerateDocumentInput = Schema.Struct({
  format: DocumentArtifact.DocumentFormat,
  source: DocumentGeneration.DocumentSource,
});
const GeneratePresentationInput = Schema.Struct({ source: ArtifactGeneration.PresentationSource });
const RevisePresentationInput = Schema.Struct({
  source: ArtifactGeneration.PresentationSource,
  sourceContentId: ContentId,
});
const GenerateImageInput = Schema.Struct({ source: ArtifactGeneration.ImageSource });
const GenerateDiagramInput = Schema.Struct({ source: ArtifactGeneration.DiagramSource });
// Think 0.15.1 documents and forwards both fields, but its StepConfig Omit loses
// them when AI SDK 7's PrepareStepResult union includes undefined.
type CapabilityStepConfig = StepConfig & {
  readonly activeTools: Array<string>;
  readonly instructions: string;
};
/** RPC representation of one managed conversation submission. */
export type SubmitManagedConversationRequest = typeof SubmitManagedConversationInput.Encoded;

/** RPC representation of one managed conversation cancellation. */
export type CancelManagedConversationRequest = typeof CancelManagedConversationInput.Encoded;

const FileActionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Trusted server-routed request to ingest one User-owned file. */
export const UploadFileRequest = Schema.Struct({
  actionId: FileActionId,
  authorization: AuthorizationContext,
  bytes: Schema.instanceOf(Uint8Array),
  declaredMediaType: Schema.String,
  fileId: FileId,
  fileName: FileName,
  uploadId: FileUploadId,
});
export type UploadFileRequest = typeof UploadFileRequest.Type;

/** Trusted server-routed request to read one User-owned file. */
export const ReadFileRequest = Schema.Struct({
  actionId: FileActionId,
  authorization: AuthorizationContext,
  fileId: FileId,
});
export type ReadFileRequest = typeof ReadFileRequest.Type;

/** Trusted server-routed request to analyze one normalized User-owned file. */
export const AnalyzeFileRequest = Schema.Struct({
  actionId: FileActionId,
  analysisId: FileAnalysisId,
  authorization: AuthorizationContext,
  fileId: FileId,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
export type AnalyzeFileRequest = typeof AnalyzeFileRequest.Type;

/** Trusted server-routed request to delete one User-owned file. */
export const DeleteFileRequest = ReadFileRequest;
export type DeleteFileRequest = typeof DeleteFileRequest.Type;

/** Classified failure from a Think Submission method. */
export class ThinkSubmissionUnavailable extends Schema.TaggedError<ThinkSubmissionUnavailable>()(
  "ThinkSubmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected failure when production file dependencies cannot be reached from an Agent. */
export class FileCapabilityUnavailable extends Schema.TaggedError<FileCapabilityUnavailable>()(
  "FileCapabilityUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}
class CapabilityTurnStateCommitUnavailable extends Schema.TaggedError<CapabilityTurnStateCommitUnavailable>()(
  "CapabilityTurnStateCommitUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}
const SessionHistoryMessagePart = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

/** Osfo-owned boundary shape for one message returned from Think Session history. */
export const SessionHistoryMessage = Schema.StructWithRest(
  Schema.Struct({
    createdAt: Schema.optional(Schema.Union([Schema.Date, Schema.String])),
    id: Schema.String,
    metadata: Schema.optional(Schema.Unknown),
    parts: Schema.Array(SessionHistoryMessagePart),
    role: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Osfo-owned boundary shape for one message returned from Think Session history. */
export type SessionHistoryMessage = typeof SessionHistoryMessage.Type;

/** Think Session history read for one Agent-owned Session. */
export interface SessionHistoryFound {
  readonly _tag: "SessionHistoryFound";
  readonly messages: ReadonlyArray<SessionHistoryMessage>;
  readonly sessionId: SessionId;
}

/** Expected read result when a Session does not belong to the Agent. */
export interface SessionHistoryNotFound {
  readonly _tag: "SessionHistoryNotFound";
  readonly message: string;
}

/** Observable result of reading Think Session history. */
export type SessionHistoryRead = SessionHistoryFound | SessionHistoryNotFound;

/** User-scoped Think Durable Object with stable Osfo Agent and Session identity. */
export class OsfoAgent extends Think<Env> {
  /** Construct the optional provider boundary at this Agent-owned storage partition. */
  protected makeIntegrations(): Option.Option<Integrations.Interface> {
    return IntegrationComposition.make(loadConfig(this.env), this.ctx.storage, this.env.ARTIFACTS);
  }

  /** Keep shell execution unavailable until a concrete Osfo tool contract enables it. */
  override workspaceBash = false;

  /** Do not expose connected MCP catalogs until Osfo registers a typed tool boundary. */
  override includeMcpTools = false;

  /** Do not attach prompts or responses to telemetry spans. */
  override storeMessages = false;

  /** Do not attach tool inputs or outputs to telemetry spans. */
  override storeTools = false;

  /** Do not stream hidden model reasoning to a channel. */
  override sendReasoning = false;

  /** Free policy is the safe class fallback. Every admitted turn overrides it from metadata. */
  override maxSteps = Number(currentLaunchPolicy.plans.free.operationLimits.modelStepsPerRequest);

  /** Never replay an uncertain external effect from an abandoned pending ledger row. */
  override actionLedgerPendingRetryLeaseMs = false as const;

  /** Match Think's abandoned Approval lifetime to the Osfo Approval Request lifetime. */
  override actionPendingApprovalTtlMs = 15 * 60 * 1_000;

  /** Do not repeat a billable provider call after an interrupted managed turn. */
  override chatRecovery = false;

  /** Bound wake-time memory while retaining enough history for the larger managed route. */
  override hydrationByteBudget = 512_000;

  /** Let Think classify and recover provider context-window failures. */
  override classifyChatError = defaultContextOverflowClassifier;

  #promptUtilizationObserver: PromptUtilization.Observer | undefined;
  #promptUtilizationSubmissionId: ThinkSubmissionId | undefined;

  /** Preserve Agents SDK diagnostics and export only numeric compaction evidence to Osfo logs. */
  override observability = PromptUtilization.makeThinkObservability({
    delegate: genericObservability,
    onCompacted: (event) => {
      const observer = this.#promptUtilizationObserver;
      if (observer === undefined) return;
      const evidence = PromptUtilization.compactionEvidence(
        observer,
        event,
        this.contextOverflow?.maxRetries ?? 0,
      );
      this.ctx.waitUntil(
        Effect.runPromise(
          Effect.forEach(evidence, PromptUtilization.emit, { concurrency: 1, discard: true }),
        ),
      );
    },
  });

  readonly #db = makeAgentDb(this.ctx.storage);
  readonly #accountDeletionFence = makeAccountDeletionFence();
  readonly #fileStore = makeFileStore(this.#db);
  readonly #files = makeFiles<
    FileCapabilityUnavailable,
    FileCapabilityUnavailable,
    FileObjectMetadataInvalid | FileObjectStoreUnavailable,
    AgentFilePersistenceError
  >({
    allowances: {
      record: (periodId, source, items) => this.#recordFileAllowance(periodId, source, items),
    },
    authorization: Authorization.make(retainedCatalog),
    catalog: retainedCatalog,
    compute: makeCloudflareFileCompute(this.env.DOCUMENT_SANDBOX),
    currentAuthorizationContext: (context) => this.#currentFileAuthorizationContext(context),
    now: DateTime.now.pipe(
      Effect.map((time) => Db.DbTimestamp.make(DateTime.toDateUtc(time).toISOString())),
    ),
    objects: makeR2FileObjects(this.env.FILES),
    store: this.#fileStore,
  });
  readonly #fileToolAuthorizationContext = Effect.fn("OsfoAgent.fileToolAuthorizationContext")(() =>
    Effect.tryPromise({
      try: () => this.#migrationsReady,
      catch: (cause) =>
        new FileCapabilityUnavailable({
          cause,
          message: "File Tool storage migrations are unavailable",
          operation: "readToolAuthorization",
        }),
    }).pipe(
      Effect.andThen(this.#readCoreMemoryAuthorization()),
      Effect.mapError(
        (cause) =>
          new FileCapabilityUnavailable({
            cause,
            message: "The active turn has no retained file authority",
            operation: "readToolAuthorization",
          }),
      ),
      Effect.flatMap((base) => {
        const runtime = Option.getOrUndefined(this.#runtime);
        if (runtime === undefined) {
          return Effect.fail(
            new FileCapabilityUnavailable({
              cause: invalidOsfoEnvironment,
              message: "File Tool authorization has no valid Worker runtime",
              operation: "readToolAuthorization",
            }),
          );
        }
        return Effect.tryPromise({
          try: () =>
            runtime.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
                  const database = yield* Db.database;
                  const allowance = yield* BillingDb.make(database).admit(base.user.userId, now);
                  return AuthorizationContext.make({
                    ...base,
                    allowance: { _tag: "Metered", ...allowance },
                    now,
                  });
                }),
              ),
            ),
          catch: (cause) =>
            new FileCapabilityUnavailable({
              cause,
              message: "Current file Tool allowance facts are unavailable",
              operation: "readToolAuthorization",
            }),
        });
      }),
    ),
  );
  readonly #reconcileFileAnalysis = FileAnalysisReconciliation.make({
    analyze: (input) => this.#files.analyze(input),
    authorize: () => this.#fileToolAuthorizationContext(),
    find: (analysisId) => this.#fileStore.findAnalysis(analysisId),
    notFound: (analysisId) =>
      new FileAnalysisConflict({
        analysisId,
        message: "The retained file analysis does not exist",
      }),
  });
  readonly #fileTools = makeFileTools({
    reconcileAnalysis: (input) =>
      this.#reconcileFileAnalysis(input).pipe(
        Effect.tap((analysis) => this.#recordFileAnalysisState(analysis)),
      ),
    read: (input) =>
      this.#fileToolAuthorizationContext().pipe(
        Effect.flatMap((context) => this.#files.read({ ...input, context })),
      ),
    startAnalysis: (input) =>
      this.#fileToolAuthorizationContext().pipe(
        Effect.flatMap((context) => this.#files.analyze({ ...input, context })),
        Effect.tap((analysis) => this.#recordFileAnalysisState(analysis)),
      ),
  });
  #capabilityTurnState: ManagedCapabilityTurnState = {
    eligiblePersonalSkills: [],
    initialized: false,
    loadedSkillReceipts: [],
    pendingFileAnalyses: [],
    skillLearningDraft: null,
  };
  #activeCapabilityMetadata: ManagedTurnMetadata | undefined;
  #activeRequestText = "";
  readonly #webState = makeWebState(this.#db);
  readonly #web = Web.make({
    authorize: (request) => this.#authorizeWeb(request),
    discover: makeDiscovery(this.env.WEBSEARCH),
    fetchPage: makePageFetch(),
    // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- Durable opaque result identities cross the Effect-free AI Tool boundary.
    makeId: () => crypto.randomUUID(),
    now: Effect.sync(() => new Date()),
    state: this.#webState,
  });
  readonly #webTools = makeWebTools({
    readActiveTurn: () => this.#activeCapabilityMetadata,
    readRequestText: () => this.#activeRequestText,
    web: this.#web,
  });
  readonly #capabilityStateSemaphore = Semaphore.makeUnsafe(1);
  #activeModelStepNumber = ModelStepNumber.make(1);
  readonly #completedModelSteps = new Set<number>();
  readonly #currentApprovedActions = new Map<
    ActionId,
    {
      readonly actionPresentation: ActionPresentation;
      readonly operation:
        | "artifact.delete"
        | "file.delete"
        | "integration.effect"
        | "memory.clear"
        | "memory.forgetKnowledge"
        | "session.delete"
        | "skill.manage";
      readonly presentation: ApprovalPresentation;
    }
  >();
  readonly #actionApprovals = makeActionApprovals({
    authorizer: { ownsAgent: (userId) => this.#userOwnsAgent(userId) },
    lifecycle: makeThinkActionApprovalAdapter({
      think: {
        approve: (executionId) => this.approveExecution(executionId),
        pending: (executionId) => this.pendingApprovals(executionId),
        reject: (executionId, reason) => this.rejectExecution(executionId, reason),
      },
    }),
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    present: (pending) => presentOsfoAction(pending, inspectCoreMemory(this.session)),
    presentations: makeActionPresentationPersistence(this.ctx.storage),
  });
  readonly #modelCallUsagePersistence = makeModelCallUsageStore(this.#db);
  readonly #memoryProviderOutbox = makeMemoryProviderOutboxStore(this.#db);
  readonly #memoryProviderReconciliationQueue = makeMemoryProviderReconciliationQueue();
  readonly #modelCallUsage = makeDurableModelCallUsage({
    dispatch: { record: (usage) => this.#dispatchModelCallUsage(usage) },
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    persistence: this.#modelCallUsagePersistence,
  });
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) => {
    const config = loadConfig(this.env);
    return makeOsfoAgentRuntime(
      this.ctx.id.name ?? this.ctx.id.toString(),
      stage,
      { db: this.env.DB },
      config.supermemory,
    );
  });
  readonly #capabilities = Option.match(this.#runtime, {
    onNone: () => Capabilities.make(),
    onSome: (runtime) => runtime.runSync(Capabilities.Service),
  });
  readonly #integrations = this.makeIntegrations();
  readonly #integrationToolRegistry = Option.map(this.#integrations, () =>
    IntegrationTools.make({
      executeEffect: (identity, input, actionId) =>
        this.#executeIntegrationEffect(identity, input, actionId),
      executeRead: (identity, input, actionId) =>
        this.#executeIntegrationRead(identity, input, actionId),
    }),
  );
  readonly #integrationReadTools = Option.match(this.#integrationToolRegistry, {
    onNone: () => ({}),
    onSome: ({ tools }) => tools,
  });
  #activeCapabilityTurn: CapabilityTurn.Interface | undefined;
  readonly #promptAssembly = PromptAssembly.makeRetainedPromptAssembly();
  readonly #store = makeAgentStore(this.#db);
  readonly #personalSkillAuthority = makePersonalSkillAuthority(this.ctx.storage);
  readonly #goodRootOutcomeEvaluator = makeGoodRootOutcomeEvaluator({
    authority: makeGoodRootOutcomeEvaluatorAuthority(this.ctx.storage),
    facts: {
      readCommittedTurns: this.#store.readCommittedTurns,
      readMessages: () => this.messages,
    },
  });
  readonly #personalSkillTools = makePersonalSkillTools({
    authority: this.#personalSkillAuthority,
    availability: () => this.#personalSkillAvailability,
    current: () => {
      const metadata = this.#activeCapabilityMetadata;
      return metadata === undefined
        ? null
        : {
            decisionReferenceId: metadata.submissionId,
            userId: metadata.authorityIdentity.userId,
          };
    },
    nowEpochMillis: Date.now,
  });
  #personalSkillAvailability: PersonalSkillAvailability = initialPersonalSkillAvailability;
  readonly #sessionExecution = makeSessionExecution({
    hasPendingOrRunning: callThinkSubmission("listSubmissions", () =>
      this.listSubmissions({ limit: 1, status: ["pending", "running"] }),
    ).pipe(Effect.map((submissions) => submissions.length > 0)),
  });
  readonly #accountDeletionFencedSessionExecution = makeAccountDeletionFencedSessionExecution(
    this.#sessionExecution,
    this.#accountDeletionFence,
  );
  readonly #providerConversationSaveGate = makeProviderConversationSaveGate();
  readonly #migrationsReady = this.ctx.blockConcurrencyWhile(() =>
    Effect.runPromise(applyAgentMigrations(this.ctx.storage)),
  );
  readonly #sessionRecallSearch = makeThinkSessionRecallSearch((sessionId, query, limit) =>
    Session.create(this).forSession(sessionId).search(query, { limit }),
  );
  readonly #sessionLifecycle = makeSessionLifecycle({
    inspect: this.#store.inspect().pipe(
      Effect.mapError((failure) => sessionLifecycleStoreFailure("inspect", failure)),
      Effect.map(({ agentId }) => ({ agentId })),
    ),
    readRoute: (requestedRouteId) =>
      this.#store.readRoute(requestedRouteId).pipe(
        Effect.mapError((failure) => sessionLifecycleStoreFailure("readRoute", failure)),
        Effect.map(({ currentSessionId, routeId }) => ({
          currentSessionId,
          routeId,
        })),
      ),
  });
  readonly #sessionRecall = makeSessionRecall({
    search: this.#sessionRecallSearch,
    store: {
      readRecallPage: (recallRouteId, cursor, limit) =>
        this.#store.readRouteSessionPage(recallRouteId, cursor, limit).pipe(
          Effect.mapError((failure) =>
            Predicate.isTagged(failure, "SessionRecallCursorInvalid")
              ? failure
              : sessionRecallStoreFailure(failure),
          ),
          Effect.map((page) => ({
            candidates: page.candidates,
            currentSessionId: page.currentSessionId,
            hasMore: page.hasMore,
            routeId: page.routeId,
          })),
        ),
    },
  });
  readonly #sessionRecallAuthorization = makeSessionRecallAuthorization({
    inspectAuthorization: (identity) => this.#inspectSessionRecallAuthorization(identity),
    readCurrentSession: (routeId) =>
      this.#sessionLifecycle.readAuthorizationFacts(routeId).pipe(
        Effect.map(({ currentSessionId }) => currentSessionId),
        Effect.mapError(
          (cause) =>
            new SessionRecallAuthorizationUnavailable({
              cause,
              message: "Current Session Recall route facts are unavailable",
            }),
        ),
      ),
  });
  readonly #managedActionAuthorization = makeManagedActionAuthorization({
    inspectAuthorization: (identity) => this.#inspectSessionRecallAuthorization(identity),
  });
  readonly #agentSessionLifecycle = makeAgentSessionLifecycle({
    activateCurrentSession: () => this.#activateCurrentSession(),
    store: this.#store,
  });
  readonly #sessionRecallTools = makeSessionRecallTools({
    authorize: (metadata) => this.#sessionRecallAuthorization.authorize(metadata),
    readActiveTurn: () =>
      Option.getOrUndefined(
        Schema.decodeUnknownOption(ManagedTurnMetadata)(this.activeTurnMetadata),
      ),
    recall: (request) =>
      Effect.tryPromise({
        try: () => this.#migrationsReady,
        catch: (cause) =>
          new SessionRecallStoreUnavailable({
            cause,
            message: "Session Recall storage migrations are unavailable",
          }),
      }).pipe(Effect.andThen(this.#sessionRecall.recall(request))),
  });
  readonly #nativeTools = {
    ...this.#fileTools.tools,
    ...this.#sessionRecallTools,
    ...this.#webTools,
    exportDocument: tool({
      description: "Export one retained generated PDF or DOCX owned by the current User.",
      execute: (input, context) => this.#exportDocument(input, context.toolCallId),
      inputSchema: effectToolSchema(RetainedDocumentInput),
    }),
    exportArtifact: tool({
      description: "Export one retained presentation, image, or diagram owned by the current User.",
      execute: (input, context) => this.#exportArtifact(input, context.toolCallId),
      inputSchema: effectToolSchema(RetainedDocumentInput),
    }),
    loadSkill: tool({
      description:
        "Load one exact Skill Version from the current turn's validated Skill index. This never grants authority or registers Tools.",
      execute: (input) => this.#loadSkill(input),
      inputSchema: effectToolSchema(CapabilityContext.LoadSkillToolInput),
    }),
    skillInspect: tool({
      description: "List active personal Skills or inspect one immutable Skill lineage.",
      execute: (input) =>
        Effect.runPromise(
          this.#personalSkillTools.inspect(input).pipe(
            Effect.match({
              onFailure: () => ({
                _tag: "SkillUnavailable" as const,
                message: "The personal Skill could not be inspected for this User.",
              }),
              onSuccess: (result) => result,
            }),
          ),
        ),
      inputSchema: effectToolSchema(SkillInspectInput),
    }),
    skillManage: tool({
      description:
        "Create, revise, archive, restore, roll back, or request approved deletion of a personal Skill after an explicit User request.",
      execute: (input) =>
        Effect.runPromise(
          this.#personalSkillTools.manage(input).pipe(
            Effect.match({
              onFailure: () => ({
                _tag: "SkillUnavailable" as const,
                message: "The personal Skill lifecycle change could not be committed.",
              }),
              onSuccess: (result) => result,
            }),
          ),
        ),
      inputSchema: effectToolSchema(SkillManageInput),
    }),
  } satisfies ToolSet;
  /** Resolve a safe model before trusted per-turn metadata selects the exact managed route. */
  override getModel() {
    return launchModelAccessPolicy.plans.free.route;
  }

  /** Speak with the shared Osfo persona from the registered personal partition. */
  override getSystemPrompt() {
    return personalAgentSystemPrompt();
  }

  /** Apply Osfo policy before a Think messenger turn starts on this user-owned facet. */
  override async chatWithMessengerContext(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
  ): Promise<void> {
    await this.#migrationsReady;
    const authorId = messengerAuthorId(context);
    const message = context.message;
    const provider = context.provider;
    if (
      (provider !== "telegram" && provider !== "whatsapp") ||
      authorId === undefined ||
      message === undefined
    ) {
      await this.#completeMessengerPolicyReply(
        callback,
        context,
        "I could not authorize that message. Please reconnect this channel from Osfo.",
      );
      return;
    }

    const linkResolution = await this.#resolveMessengerLink(context.messengerId, authorId);
    if (linkResolution._tag === "Unavailable") {
      await this.#completeMessengerPolicyReply(
        callback,
        context,
        "I could not authorize that message right now. Please try again.",
      );
      return;
    }
    const link = linkResolution.link;
    if (link === null) {
      await Effect.runPromise(
        Effect.logWarning(
          "Messenger Channel Link could not authorize the current Agent facet",
        ).pipe(
          Effect.annotateLogs({
            linkResolution: "missing",
            runtimeAvailable: Option.isSome(this.#runtime),
          }),
        ),
      );
      await this.#completeMessengerPolicyReply(
        callback,
        context,
        "This connection is no longer authorized. Please reconnect it from Osfo.",
      );
      return;
    }

    const submissionId = await messengerSubmissionId(
      provider,
      context.thread.id,
      message.providerMessageId,
    );
    const store = this.#store;
    const inspectAuthorization = () => this.#inspectCurrentChannelLinkAuthorization(link);
    const replaceCurrent = (admission: ManagedSessionReplacementAdmitted) =>
      this.#agentSessionLifecycle.replaceCurrent(admission);
    const operation = Effect.gen(function* () {
      const [agent, currentAuthorization] = yield* Effect.all([
        store.inspect(),
        inspectAuthorization(),
      ]);
      const admission = yield* admitManagedConversation(
        {
          authorization: currentAuthorization,
          idempotencyKey: `${provider}:${context.thread.id}:${message.providerMessageId}`,
          message: message.text,
          routeId: agent.routeId,
          submissionId,
        },
        { currentSessionId: agent.currentSessionId, routeId: agent.routeId },
      );
      if (Predicate.isTagged(admission, "ManagedSessionReplacementAdmitted")) {
        yield* replaceCurrent(admission);
      }
      return { admission, currentAuthorization };
    });
    const continuation = (result: Effect.Success<typeof operation>, signal: AbortSignal) =>
      Effect.tryPromise({
        try: async () => {
          if (Predicate.isTagged(result.admission, "ManagedConversationDenied")) {
            await this.#completeMessengerPolicyReply(
              callback,
              context,
              "Your current Osfo allowance does not permit this request.",
            );
            return;
          }
          const admission: ManagedConversationAdmitted | ManagedSessionReplacementAdmitted =
            result.admission;
          if (Predicate.isTagged(admission, "ManagedSessionReplacementAdmitted")) {
            const recorded = await this.#recordMessengerAcceptedMessage(
              result.currentAuthorization,
              provider,
              message.providerMessageId,
            );
            if (signal.aborted) return;
            if (!recorded) {
              await this.#completeMessengerPolicyReply(
                callback,
                context,
                "I could not reserve this message in your allowance. Please try again.",
              );
              return;
            }
            await this.#completeMessengerPolicyReply(
              callback,
              context,
              "Started a new Osfo session.",
            );
            return;
          }

          const recorded =
            admission.metadata.executionMode === "exhaustedConversation" ||
            (await this.#recordMessengerAcceptedMessage(
              result.currentAuthorization,
              provider,
              message.providerMessageId,
            ));
          if (signal.aborted) return;
          if (!recorded) {
            await this.#completeMessengerPolicyReply(
              callback,
              context,
              "I could not reserve this message in your allowance. Please try again.",
            );
            return;
          }
          await super.chatWithMessengerContext(userMessage, callback, context, {
            metadata: admission.metadata,
            signal,
          });
        },
        catch: (cause) =>
          new ThinkSubmissionUnavailable({
            cause,
            message: "The admitted messenger turn could not continue",
            operation: "chatWithMessengerContext",
          }),
      });
    const onClosed = () =>
      new ThinkSubmissionUnavailable({
        cause: submissionId,
        message: "Account deletion fenced this messenger turn",
        operation: "chatWithMessengerContext",
      });
    const execution = this.#accountDeletionFencedSessionExecution;
    const continued = await Effect.runPromiseExit(
      message.text.trim() === "/new"
        ? execution.runTrackedWhenIdle(() => operation, continuation, onClosed)
        : execution.runTracked(() => operation, continuation, onClosed),
    );
    if (Exit.isSuccess(continued)) return;
    const failureTag = Option.match(Cause.findErrorOption(continued.cause), {
      onNone: () => "DefectOrInterruption",
      onSome: (value) => value._tag,
    });
    await Effect.runPromise(
      Effect.logError("Messenger continuation failed").pipe(Effect.annotateLogs({ failureTag })),
    );
    await Effect.runPromiseExit(
      this.#accountDeletionFence.runTracked(
        () =>
          Effect.tryPromise({
            try: () =>
              this.#completeMessengerPolicyReply(
                callback,
                context,
                "I could not authorize that message right now. Please try again.",
              ),
            catch: (cause) =>
              new ThinkSubmissionUnavailable({
                cause,
                message: "The messenger policy reply could not be sent",
                operation: "chatWithMessengerContext",
              }),
          }),
        onClosed,
      ),
    );
  }

  /** Register document and test actions in their owning stages. */
  override getActions() {
    const documentActions = {
      [artifactDeleteActionName]: action({
        approval: true,
        approvalRisk: "high",
        approvalSummary: "Delete the retained generated artifact",
        description:
          "Delete one retained presentation, image, or diagram owned by the current User.",
        execute: (input, context) => this.#deleteArtifact(input, context.toolCallId),
        idempotencyKey: ({ ctx }) => `artifact-delete:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(RetainedDocumentInput),
        kind: "durable-pause",
        permissions: ["files:delete"],
      }),
      [documentDeleteActionName]: action({
        approval: true,
        approvalRisk: "high",
        approvalSummary: "Delete the retained generated document",
        description: "Delete one retained generated PDF or DOCX owned by the current User.",
        execute: (input, context) => this.#deleteDocument(input, context.toolCallId),
        idempotencyKey: ({ ctx }) => `document-delete:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(RetainedDocumentInput),
        kind: "durable-pause",
        permissions: ["files:delete"],
      }),
      generateDocument: action({
        description:
          "Generate one bounded PDF or DOCX with at most 20 pages and 5 MB. A page may reference one previously verified owned image or diagram by visualContentId.",
        execute: (input, context) => this.#generateDocument(input, context.toolCallId),
        idempotencyKey: ({ ctx }) => `document-generate:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(GenerateDocumentInput),
        permissions: ["documents:generate"],
        timeoutMs: 90_000,
      }),
      generatePresentation: action({
        description: "Generate one validated PPTX with at most 20 slides and 20 MB.",
        execute: (input, context) =>
          this.#generateArtifact(
            { _tag: "Presentation", source: input.source },
            context.toolCallId,
          ),
        idempotencyKey: ({ ctx }) => `presentation-generate:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(GeneratePresentationInput),
        permissions: ["artifacts:generate"],
        timeoutMs: 90_000,
      }),
      revisePresentation: action({
        description: "Revise one owned PPTX into a new immutable validated presentation.",
        execute: (input, context) => this.#revisePresentation(input, context.toolCallId),
        idempotencyKey: ({ ctx }) => `presentation-revise:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(RevisePresentationInput),
        permissions: ["artifacts:generate"],
        timeoutMs: 90_000,
      }),
      generateImage: action({
        description: "Generate one validated PNG with bounded dimensions and size.",
        execute: (input, context) =>
          this.#generateArtifact({ _tag: "Image", source: input.source }, context.toolCallId),
        idempotencyKey: ({ ctx }) => `image-generate:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(GenerateImageInput),
        permissions: ["artifacts:generate"],
        timeoutMs: 90_000,
      }),
      generateDiagram: action({
        description: "Generate one validated deterministic PNG diagram.",
        execute: (input, context) =>
          this.#generateArtifact({ _tag: "Diagram", source: input.source }, context.toolCallId),
        idempotencyKey: ({ ctx }) => `diagram-generate:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(GenerateDiagramInput),
        permissions: ["artifacts:generate"],
        timeoutMs: 90_000,
      }),
    };
    const executeClear = (input: Parameters<typeof clearCoreMemory>[1], actionId: ActionId) =>
      this.#clearCoreMemory(input, actionId);
    const osfoActions = makeOsfoActions({
      clearCoreMemory: executeClear,
      deletePersonalSkill: (input, actionId) => this.#deletePersonalSkill(input, actionId),
      deleteSession: (input, actionId) => this.#deleteSession(input, actionId),
      forgetKnowledge: (input, actionId) => this.#forgetKnowledge(input, actionId),
    });
    const integrationActions = Option.match(this.#integrationToolRegistry, {
      onNone: () => ({}),
      onSome: ({ actions }) => actions,
    });
    return {
      ...documentActions,
      ...this.#fileTools.actions,
      ...integrationActions,
      ...osfoActions,
    };
  }

  /** Register trusted native Tools; beforeTurn publishes only the selected schemas. */
  override getTools(): ToolSet {
    return this.#nativeTools;
  }

  /** Keep inherited pending-Approval RPC output client-safe for every registered Action. */
  override async pendingApprovals(executionId?: string): Promise<Array<PendingApproval>> {
    const pending = await super.pendingApprovals(executionId);
    return pending.map(sanitizePendingApproval);
  }

  /** Apply only the route and limits pinned to the current durable Think Submission. */
  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    const system = await this.session.refreshSystemPrompt();
    const metadata = await Effect.runPromise(
      Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata),
    );
    this.#activeCapabilityMetadata = metadata;
    const firstInitialization = !metadata.capabilityTurnState.initialized;
    const capabilityTurnState = ManagedCapabilityState.initialize(this.messages, metadata);
    const availableIntegrationToolkits = await this.#availableIntegrationToolkits(
      metadata.authorityIdentity.userId,
    );
    const trustedToolAssembly = CapabilityContext.trustedToolAssembly({
      actionNames: capabilityActionNames,
      allTools: context.tools,
      integrationTools: this.#integrationReadTools,
      nativeTools: { ...this.#nativeTools, ...coreMemoryTools(this.session) },
      reservedNames: Capabilities.registeredToolNames,
    });
    const tools = trustedToolAssembly.tools;
    const capabilityAvailability = {
      availableIntegrationToolkits,
      availableRequirements: [
        ...(Option.isSome(this.#integrations) ? (["composio"] as const) : []),
        "document-renderer",
        "file-storage",
        "native-memory",
        "personal-agent",
        "session-history",
        "skill-store",
        ...(hasRecognizedWebSearchPrice ? (["web-provider"] as const) : []),
      ],
      availableToolNames: Object.keys(tools),
    } as const;
    const promptPolicy = PromptAssembly.policyForManagedExecution(metadata.executionMode);
    const prompt = await this.#assemblePrompt(context, metadata, system, promptPolicy.recallMode);
    const capabilityContext = CapabilityContext.projectTurn(context.messages, {
      pendingFileAnalysis: capabilityTurnState.pendingFileAnalyses.length > 0,
    });
    this.#activeRequestText = capabilityContext.taskDescription;
    const personalSkills = await Effect.runPromise(
      selectPersonalSkillsForTurn({
        authority: this.#personalSkillAuthority,
        eligible: capabilityTurnState.eligiblePersonalSkills,
        firstInitialization,
        userId: metadata.authorityIdentity.userId,
      }),
    );
    const baseIndex = await Effect.runPromise(
      this.#capabilities.eligibleIndex({
        ...capabilityAvailability,
        catalogVersion: metadata.capabilityCatalogVersion,
        declaredRequirements: [],
        origin: capabilityTurnOrigin(metadata.authorityIdentity),
        personalSkills,
        plan: metadata.plan,
        taskDescription: capabilityContext.taskDescription,
        taskKinds: capabilityContext.taskKinds,
        trustedCapabilityIds: capabilityContext.trustedCapabilityIds,
        userId: metadata.authorityIdentity.userId,
      }),
    );
    const learningDraft = Option.getOrNull(
      projectSkillLearningDraft({
        availableCapabilityIds: baseIndex.candidates.flatMap(({ capabilityIds }) => capabilityIds),
        availableRequirements: capabilityAvailability.availableRequirements,
        origin: capabilityTurnOrigin(metadata.authorityIdentity),
        ownerUserId: metadata.authorityIdentity.userId,
        priorSkillId: null,
        priorSkillVersion: null,
        submissionId: metadata.submissionId,
        taskDescription: capabilityContext.taskDescription,
      }),
    );
    const retainedCapabilityTurnState = firstInitialization
      ? {
          ...capabilityTurnState,
          eligiblePersonalSkills: baseIndex.candidates.flatMap((candidate) =>
            candidate.source === "personal"
              ? [
                  {
                    skillId: PersonalSkillId.make(candidate.skillId),
                    skillVersion: PersonalSkillVersionId.make(candidate.skillVersion),
                  },
                ]
              : [],
          ),
          skillLearningDraft:
            learningDraft === null
              ? null
              : {
                  availableCapabilityIds: learningDraft.availableCapabilityIds,
                  availableRequirements: learningDraft.availableRequirements,
                  taskDescription: learningDraft.taskDescription,
                },
        }
      : capabilityTurnState;
    await this.#replaceCapabilityTurnState(retainedCapabilityTurnState);
    const restored = this.#capabilities.restoreLoadedSkillReceipts({
      ...capabilityAvailability,
      catalogVersion: metadata.capabilityCatalogVersion,
      index: baseIndex,
      receipts: retainedCapabilityTurnState.loadedSkillReceipts,
      submissionId: metadata.submissionId,
    });
    const index = restored.index;
    this.#personalSkillAvailability = {
      capabilityIds: [...new Set(index.candidates.flatMap(({ capabilityIds }) => capabilityIds))],
      requirements: capabilityAvailability.availableRequirements,
    };
    const activeCapabilityTurn = CapabilityTurn.make({
      availableToolNames: capabilityAvailability.availableToolNames,
      baseInstructions: prompt.instructions,
      capabilities: this.#capabilities,
      index,
      loadedSkills: restored.loadedSkills,
      personalSkills,
      toolSchemas: CapabilityContext.toolSchemaAccounting(trustedToolAssembly),
      userId: metadata.authorityIdentity.userId,
    });
    this.#activeCapabilityTurn = activeCapabilityTurn;
    const capabilityStep = activeCapabilityTurn.step();
    this.#recordCapabilityAccounting(capabilityStep.bundle, index);
    if (prompt.usage !== null) {
      this.ctx.waitUntil(this.#recordProviderRecallCompanyCost(metadata, prompt.usage));
    }
    this.#completedModelSteps.clear();
    const promptUtilizationObserver =
      this.#promptUtilizationSubmissionId === metadata.submissionId &&
      this.#promptUtilizationObserver !== undefined
        ? this.#promptUtilizationObserver
        : PromptUtilization.makeObserver({ contextWindowTokens: metadata.maxInputTokens });
    this.#promptUtilizationObserver = promptUtilizationObserver;
    this.#promptUtilizationSubmissionId = metadata.submissionId;
    this.contextOverflow = PromptUtilization.compactionPolicy({
      contextWindowTokens: metadata.maxInputTokens,
      proactiveCompactionLimit: 1,
      reactiveRetryLimit: 1,
      targetInputTokens: metadata.targetInputTokens,
    });
    const estimatedInputTokens = PromptUtilization.estimateInputTokens({
      instructions: capabilityStep.instructions,
      messages: prompt.messages,
    });
    this.ctx.waitUntil(
      Effect.runPromise(
        PromptUtilization.emit(
          promptUtilizationObserver.promptAssembled({
            categoryTokens: PromptUtilization.categoryTokensForTurn({
              conversationMessages: context.messages,
              providerContext: prompt.providerContext,
              systemInstructions: capabilityStep.instructions,
            }),
            estimatedInputTokens,
          }),
        ),
      ),
    );
    return {
      maxOutputTokens: metadata.maxOutputTokens,
      maxRetries: metadata.maxRetries,
      maxSteps: metadata.maxSteps,
      model: metadata.route,
      messages: prompt.messages,
      sendReasoning: false,
      activeTools: [...capabilityStep.activeToolNames],
      instructions: capabilityStep.instructions,
      tools,
    };
  }

  /** Admit each Action through Osfo policy after Think validates its exact input. */
  override async authorizeAction(
    context: ActionAuthorizationContext,
  ): Promise<ActionAuthorizationDecision> {
    if (context.action !== coreMemoryClearActionName) return super.authorizeAction(context);
    const current = await runRpc(this.#readCoreMemoryAuthorization());
    if (Predicate.isTagged(current, "CoreMemoryUnavailable")) {
      return { allowed: false, reason: current.message };
    }
    const admission = authorization.admit(current, {
      actionId: context.toolCallId,
      kind: "memory.clear",
    });
    return Predicate.isTagged(admission, "Denied")
      ? { allowed: false, reason: admission.reason }
      : { allowed: true, grantedPermissions: ["memory:clear"] };
  }

  /** Pin the canonical Session for the full durable Think Submission lifecycle. */
  override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
    const owner = Schema.decodeResult(ThinkSubmissionId)(submission.submissionId);
    if (Result.isFailure(owner)) {
      try {
        if (submission.status === "running") {
          await this.cancelSubmission(
            submission.submissionId,
            "Invalid managed submission identity",
          );
        }
      } finally {
        await Effect.runPromise(this.#sessionExecution.submissionChanged);
      }
      return;
    }
    try {
      if (submission.status !== "running") return;

      const metadata = Schema.decodeUnknownResult(ManagedTurnMetadata)(submission.metadata);
      if (Result.isFailure(metadata) || metadata.success.submissionId !== owner.success) {
        await this.cancelSubmission(submission.submissionId, "Invalid managed turn authority");
        return;
      }
      const activated = await Effect.runPromiseExit(
        Effect.promise(() => this.#activateSession(metadata.success.sessionId)),
      );
      if (Exit.isFailure(activated)) {
        await this.cancelSubmission(submission.submissionId, "Managed Session activation failed");
      }
    } finally {
      await Effect.runPromise(this.#sessionExecution.submissionChanged);
    }
  }

  /** Publish newly loaded Skill bodies and schemas on the next model step. */
  override beforeStep(context: PrepareStepContext): CapabilityStepConfig | void {
    this.#activeModelStepNumber = ModelStepNumber.make(context.stepNumber + 1);
    const activeTurn = this.#activeCapabilityTurn;
    if (activeTurn === undefined) return;
    const step = activeTurn.step();
    if (context.stepNumber > 0) {
      this.#recordCapabilityAccounting(step.bundle, step.index);
    }
    const observer = this.#promptUtilizationObserver;
    if (observer !== undefined) {
      this.ctx.waitUntil(
        Effect.runPromise(
          PromptUtilization.emit(
            observer.stepStarted({
              estimatedInputTokens: PromptUtilization.estimateInputTokens({
                instructions: step.instructions,
                messages: context.messages,
              }),
              stepNumber: context.stepNumber + 1,
            }),
          ),
        ),
      );
    }
    return {
      activeTools: [...step.activeToolNames],
      instructions: step.instructions,
    };
  }

  #authorizeWeb(request: AuthorizationRequest) {
    if (!hasRecognizedWebSearchPrice) {
      return Effect.fail(
        new WebUnavailable({
          message: "Public-web provider pricing is not yet recognized for Plan Usage.",
          reason: "authorizationDenied",
        }),
      );
    }
    const active = this.#activeCapabilityMetadata;
    if (
      active === undefined ||
      active.submissionId !== request.turnId ||
      active.authorityIdentity.userId !== request.userId
    ) {
      return Effect.fail(
        new WebUnavailable({
          message: "The public-web operation does not belong to the active User turn.",
          reason: "authorizationDenied",
        }),
      );
    }
    return this.#fileToolAuthorizationContext().pipe(
      Effect.flatMap((context) => {
        const operation =
          request.searches > 0
            ? {
                actionId: request.operationId,
                deadlineMilliseconds: 15_000n,
                kind: "web.search" as const,
                pages: BigInt(request.pages),
                redirects: 3n,
                responseBytes: request.responseBytes,
                results: 10n,
                retries: 1n,
                searches: BigInt(request.searches),
              }
            : {
                actionId: request.operationId,
                deadlineMilliseconds: 15_000n,
                kind: "web.read" as const,
                pages: BigInt(request.pages),
                redirects: 3n,
                responseBytes: request.responseBytes,
                retries: 1n,
              };
        const admitted = authorization.admit({ ...context, requestVendorUsdMicros: 0n }, operation);
        return Predicate.isTagged(admitted, "Admitted")
          ? Effect.void
          : Effect.fail(
              new WebUnavailable({
                message: "Plan Usage or public-web operation bounds denied this request.",
                reason: "authorizationDenied",
              }),
            );
      }),
    );
  }

  /** Record observed AI Gateway cost or one bounded share after each completed step. */
  override async onStepEnd(context: StepContext): Promise<void> {
    const stepNumber = ModelStepNumber.make(context.stepNumber + 1);
    await this.#recordCurrentModelUsage(stepNumber, context);
    const observer = this.#promptUtilizationObserver;
    if (observer !== undefined) {
      const inputTokens = context.usage.inputTokens ?? context.usage.totalTokens ?? 0;
      await Effect.runPromise(
        PromptUtilization.emit(
          observer.stepCompleted({
            inputTokens,
            outputTokens: context.usage.outputTokens ?? 0,
            stepNumber,
            toolCallCount: context.toolCalls.length,
            toolResultCount: context.toolResults.length,
          }),
        ),
      );
    }
    this.#completedModelSteps.add(stepNumber);
  }

  /** Preserve conservative cost evidence when a provider turn ends ambiguously. */
  // oxlint-disable-next-line osfo/no-unknown-parameters, osfo/no-unknown-returns -- Think owns the error hook's unknown protocol contract.
  override onChatError(error: unknown, context?: ChatErrorContext): unknown {
    if (context?.classification === "context_overflow") {
      const observer = this.#promptUtilizationObserver;
      if (observer !== undefined) {
        this.ctx.waitUntil(
          Effect.runPromise(
            PromptUtilization.emit(
              observer.overflowTerminal({ retryLimit: this.contextOverflow?.maxRetries ?? 0 }),
            ),
          ),
        );
      }
    }
    if (context?.stage === "turn" || context?.stage === "stream" || context?.stage === "recovery") {
      if (!this.#completedModelSteps.has(this.#activeModelStepNumber)) {
        this.ctx.waitUntil(this.#recordCurrentModelUsage(this.#activeModelStepNumber));
      }
    }
    return super.onChatError(error, context);
  }

  async #loadSkill(input: typeof CapabilityContext.LoadSkillToolInput.Type) {
    const activeTurn = this.#activeCapabilityTurn;
    const metadata = this.#activeCapabilityMetadata;
    if (activeTurn === undefined || metadata === undefined) {
      return {
        _tag: "SkillUnavailable",
        message: "The active turn has no validated Skill index or metadata",
      } as const;
    }
    return Effect.runPromise(
      activeTurn.loadSkill(input).pipe(
        Effect.flatMap((loaded) =>
          Effect.tryPromise({
            try: async () => {
              const state = await this.#updateCapabilityTurnState((current) =>
                ManagedCapabilityState.recordLoadedSkill(current, {
                  ...loaded,
                  catalogVersion: metadata.capabilityCatalogVersion,
                  submissionId: metadata.submissionId,
                }),
              );
              const receiptCommitted = state.loadedSkillReceipts.some(
                ({ skillId, skillVersion }) =>
                  skillId === loaded.skillId && skillVersion === loaded.skillVersion,
              );
              if (!receiptCommitted || !activeTurn.commitLoadedSkill(loaded)) {
                throw new Error("The active turn reached its loaded Skill limit");
              }
              if (loaded.source === "personal") {
                this.ctx.waitUntil(
                  Effect.runPromise(
                    this.#personalSkillAuthority
                      .recordUse({
                        nowEpochMillis: Date.now(),
                        skillId: PersonalSkillId.make(loaded.skillId),
                        skillVersion: PersonalSkillVersionId.make(loaded.skillVersion),
                        userId: metadata.authorityIdentity.userId,
                      })
                      .pipe(
                        Effect.catch((failure) =>
                          Effect.logWarning("Personal Skill use metadata was not recorded").pipe(
                            Effect.annotateLogs({ failure: failure._tag }),
                          ),
                        ),
                      ),
                  ),
                );
              }
              return loaded;
            },
            catch: () =>
              new Capabilities.SkillNotEligible({
                message: "The Skill receipt could not be committed for this turn",
                skillId: loaded.skillId,
                skillVersion: loaded.skillVersion,
              }),
          }),
        ),
        Effect.match({
          onFailure: () => ({
            _tag: "SkillUnavailable" as const,
            message: "The requested Skill is not eligible for this turn",
          }),
          onSuccess: (loaded) => loaded,
        }),
      ),
    );
  }

  #recordFileAnalysisState(
    analysis: ApprovalRequired | Denied | FileAnalysisRecord,
  ): Effect.Effect<void, CapabilityTurnStateCommitUnavailable> {
    if (
      Predicate.isTagged(analysis, "ApprovalRequired") ||
      Predicate.isTagged(analysis, "Denied")
    ) {
      return Effect.void;
    }
    const metadata = this.#activeCapabilityMetadata;
    if (metadata === undefined) {
      return Effect.fail(
        new CapabilityTurnStateCommitUnavailable({
          cause: new Error("The active Capability turn has no retained metadata"),
          message: "The file analysis receipt has no active Capability submission",
        }),
      );
    }
    return this.#commitCapabilityTurnState(metadata, (state) =>
      ManagedCapabilityState.recordFileAnalysis(
        state,
        { analysisId: analysis.analysisId },
        analysis.state === "pending" || analysis.state === "ambiguous",
      ),
    ).pipe(Effect.asVoid);
  }

  async #updateCapabilityTurnState(
    update: (state: ManagedCapabilityTurnState) => ManagedCapabilityTurnState,
  ): Promise<ManagedCapabilityTurnState> {
    const metadata = this.#activeCapabilityMetadata;
    if (metadata === undefined) {
      throw new Error("The active Capability turn has no retained metadata");
    }
    return Effect.runPromise(this.#commitCapabilityTurnState(metadata, update));
  }

  async #replaceCapabilityTurnState(
    state: ManagedCapabilityTurnState,
  ): Promise<ManagedCapabilityTurnState> {
    const metadata = this.#activeCapabilityMetadata;
    if (metadata === undefined) {
      throw new Error("The active Capability turn has no retained metadata");
    }
    return Effect.runPromise(this.#commitCapabilityTurnState(metadata, () => state));
  }

  readonly #commitCapabilityTurnState = Effect.fn("OsfoAgent.commitCapabilityTurnState")(
    (
      metadata: ManagedTurnMetadata,
      update: (state: ManagedCapabilityTurnState) => ManagedCapabilityTurnState,
    ) =>
      this.#capabilityStateSemaphore.withPermit(
        Effect.sync(() => update(this.#capabilityTurnState)).pipe(
          Effect.flatMap((state) => {
            if (state === this.#capabilityTurnState) return Effect.succeed(state);
            const nextMetadata = { ...metadata, capabilityTurnState: state };
            const message = ManagedCapabilityState.stampActiveUserMessage(
              this.messages,
              nextMetadata,
            );
            if (message === null) {
              return Effect.fail(
                new CapabilityTurnStateCommitUnavailable({
                  cause: new Error("The active Submission message was not found"),
                  message: "The active Capability submission is absent from durable history",
                }),
              );
            }
            return Effect.tryPromise({
              try: () => this.updateMessageInHistory(message),
              catch: (cause) =>
                new CapabilityTurnStateCommitUnavailable({
                  cause,
                  message: "The Capability receipt could not be persisted",
                }),
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  this.#capabilityTurnState = state;
                  this.#activeCapabilityMetadata = nextMetadata;
                }),
              ),
              Effect.andThen(
                Effect.tryPromise({
                  try: () => this.syncMessagesFromStorage(),
                  catch: (cause) =>
                    new CapabilityTurnStateCommitUnavailable({
                      cause,
                      message: "The persisted Capability receipt could not be synchronized",
                    }),
                }),
              ),
              Effect.as(state),
            );
          }),
        ),
      ),
  );

  #recordCapabilityAccounting(
    bundle: Capabilities.ToolBundle,
    index: Capabilities.EligibleIndex,
  ): void {
    this.ctx.waitUntil(
      Effect.runPromise(
        Effect.logInfo("Capability turn assembled").pipe(
          Effect.annotateLogs({
            alwaysVisibleCoreBytes: bundle.accounting.prompt.alwaysVisibleCoreBytes,
            capabilityCatalogVersion: index.catalogVersion,
            integrationToolSchemasBytes: bundle.accounting.schemas.integrationToolSchemasBytes,
            loadedSkillBodyBytes: bundle.accounting.prompt.loadedSkillBodyBytes,
            nativeToolSchemasBytes: bundle.accounting.schemas.nativeToolSchemasBytes,
            selectedSkillIndexBytes: bundle.accounting.prompt.selectedSkillIndexBytes,
          }),
        ),
      ),
    );
  }

  async #assemblePrompt(
    context: TurnContext,
    metadata: ManagedTurnMetadata,
    agentInstructions: string,
    recallMode: MemoryProvider.RecallMode,
  ): Promise<PromptAssembly.ModelTurnResult> {
    const config = loadConfig(this.env);
    const memoryProviderOutbox = this.#memoryProviderOutbox;
    const promptAssembly = this.#promptAssembly;
    return Effect.runPromise(
      Effect.gen(function* () {
        const recentTurns = yield* memoryProviderOutbox
          .readRecentTurnBridge(metadata.authorityIdentity.userId)
          .pipe(
            Effect.catch((failure) =>
              Effect.logWarning("MemoryProvider recent-turn bridge is unavailable").pipe(
                Effect.annotateLogs({ failureTag: failure._tag }),
                Effect.as([]),
              ),
            ),
          );
        return yield* promptAssembly.forModelTurn({
          agentInstructions,
          continuation: context.continuation,
          messages: context.messages,
          mode: recallMode,
          recentTurns,
          submissionId: metadata.submissionId,
          userId: metadata.authorityIdentity.userId,
        });
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Think's beforeTurn hook is the application entry point for this request Layer.
        Effect.provide(SupermemoryMemoryProvider.layerFromConfig(config.supermemory)),
      ),
    );
  }

  async #recordProviderRecallCompanyCost(
    metadata: ManagedTurnMetadata,
    usage: PromptAssembly.ProviderRecallAvailable["usage"],
  ): Promise<void> {
    const summary = MemoryProvider.summarizeUsageEvidence(usage);
    await Effect.runPromise(
      Effect.logInfo("MemoryProvider recall completed").pipe(
        Effect.annotateLogs({
          allowancePeriodId: metadata.allowancePeriodId,
          companyCostContinuity: true,
          ratedCostUsdMicros: String(summary.ratedCostUsdMicros),
          resourcePriceVersions: summary.resourcePriceVersions.join(","),
          submissionId: metadata.submissionId,
        }),
      ),
    );
  }

  async #recordCurrentModelUsage(stepNumber: ModelStepNumber, step?: StepContext): Promise<void> {
    const metadata = Schema.decodeUnknownOption(ManagedTurnMetadata)(this.activeTurnMetadata);
    if (Option.isNone(metadata)) {
      await Effect.runPromise(
        Effect.logError("Managed model usage could not be attributed").pipe(
          Effect.annotateLogs({ failureTag: "ManagedTurnMetadataUnavailable" }),
        ),
      );
      return;
    }
    if (metadata.value.executionMode === "exhaustedConversation") return;
    const attemptId = modelCallAttemptId(metadata.value.submissionId, stepNumber);
    if (step !== undefined) {
      const evidence = await this.#readStepEvidence(metadata.value, stepNumber, step);
      if (Predicate.isTagged(evidence, "GatewayCostPending")) {
        await this.#scheduleGatewayCostSettlement(evidence.settlement);
        return;
      }
      await this.#recordModelCallUsage(
        metadata.value.allowancePeriodId,
        attemptId,
        evidence.evidence,
      );
      return;
    }
    await this.#recordModelCallUsage(
      metadata.value.allowancePeriodId,
      attemptId,
      conservativeStepEvidence(metadata.value, stepNumber),
    );
  }

  async #recordModelCallUsage(
    allowancePeriodId: AllowancePeriodId,
    attemptId: ModelCallAttemptId,
    evidence: ModelCallEvidence,
  ): Promise<void> {
    await Effect.runPromise(
      this.#modelCallUsage.record(allowancePeriodId, attemptId, evidence).pipe(
        Effect.catchTag("ModelCallUsageDispatchUnavailable", () =>
          Effect.promise(() => this.#scheduleModelCallUsageReconciliation()).pipe(
            Effect.andThen(
              Effect.logError("Managed model usage recording remains pending").pipe(
                Effect.annotateLogs({
                  attemptId,
                  failureTag: "ModelCallUsageRecordingFailure",
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /** Select the current primary Think Session after migration exclusion completes. */
  override async configureSession(session: Session): Promise<Session> {
    await this.#migrationsReady;
    const current = await Effect.runPromise(this.#readOptionalPrimarySessionId());
    return await this.#configureSession(
      session,
      Option.getOrElse(current, () => pendingSessionId),
    );
  }

  async #configureSession(session: Session, sessionId: string): Promise<Session> {
    const configured = session.forSession(sessionId).withContext("Operating Contract", {
      provider: { get: async () => this.getSystemPrompt() },
    });
    const coreMemory = await configureCoreMemory(configured, this);
    return coreMemory
      .forSession(sessionId)
      .onCompaction(
        createCompactFunction({
          summarize: summarizeManagedSession,
        }),
      )
      .compactAfter(launchModelAccessPolicy.plans.free.context.targetInputTokens);
  }

  /** Change one Core Memory block's independent User-selected budget. */
  async boundCoreMemory(
    input: BoundCoreMemoryEncoded,
  ): Promise<
    | AgentRequestInvalid
    | ApprovalRequired
    | CoreMemoryBound
    | CoreMemoryBudgetExceeded
    | CoreMemoryUnavailable
    | Denied
  > {
    await this.#migrationsReady;
    const activateCurrentSession = () => this.#activateCurrentSession();
    const applyBound = (parsed: BoundCoreMemoryInput) =>
      boundCoreMemory(this.session, this, parsed);
    return runRpc(
      this.#accountDeletionFencedSessionExecution.run(
        Effect.promise(activateCurrentSession).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const parsed = yield* Schema.decodeEffect(BoundCoreMemoryInput)(input).pipe(
                Effect.mapError(() => invalidRequest("boundCoreMemory")),
              );
              const admission = authorization.admit(parsed.authorization, {
                actionId: parsed.actionId,
                kind: "memory.correct",
              });
              if (!Predicate.isTagged(admission, "Admitted")) return admission;
              const outcome = yield* applyBound(parsed);
              yield* Effect.promise(activateCurrentSession);
              return outcome;
            }),
          ),
        ),
        () =>
          new CoreMemoryUnavailable({
            cause: "account deletion fence",
            message: "Core Memory budgets are unavailable while account deletion is pending",
            operation: "bound",
          }),
      ),
    );
  }

  /** Inspect Agent-wide User Context and Agent Notes before or after any turn. */
  async inspectCoreMemory(
    input: InspectCoreMemoryEncoded,
  ): Promise<
    AgentRequestInvalid | ApprovalRequired | CoreMemoryInspected | CoreMemoryUnavailable | Denied
  > {
    await this.#migrationsReady;
    const activateCurrentSession = () => this.#activateCurrentSession();
    const inspectCurrent = () => inspectCoreMemory(this.session);
    return runRpc(
      this.#accountDeletionFencedSessionExecution.run(
        Effect.promise(activateCurrentSession).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const parsed = yield* Schema.decodeEffect(InspectCoreMemoryInput)(input).pipe(
                Effect.mapError(() => invalidRequest("inspectCoreMemory")),
              );
              const admission = authorization.admit(parsed.authorization, {
                actionId: parsed.actionId,
                kind: "memory.inspect",
              });
              if (!Predicate.isTagged(admission, "Admitted")) return admission;
              return yield* inspectCurrent();
            }),
          ),
        ),
        () =>
          new CoreMemoryUnavailable({
            cause: "account deletion fence",
            message: "Core Memory inspection is unavailable while account deletion is pending",
            operation: "inspect",
          }),
      ),
    );
  }

  /** Immediately replace one Core Memory block from a direct User correction. */
  async correctCoreMemory(
    input: CorrectCoreMemoryEncoded,
  ): Promise<
    | AgentRequestInvalid
    | ApprovalRequired
    | CoreMemoryBudgetExceeded
    | CoreMemoryCorrected
    | CoreMemoryUnavailable
    | Denied
  > {
    await this.#migrationsReady;
    const activateCurrentSession = () => this.#activateCurrentSession();
    const applyCorrection = (parsed: CorrectCoreMemoryInput) =>
      correctCoreMemory(this.session, parsed);
    return runRpc(
      this.#accountDeletionFencedSessionExecution.run(
        Effect.promise(activateCurrentSession).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const parsed = yield* Schema.decodeEffect(CorrectCoreMemoryInput)(input).pipe(
                Effect.mapError(() => invalidRequest("correctCoreMemory")),
              );
              const admission = authorization.admit(parsed.authorization, {
                actionId: parsed.actionId,
                kind: "memory.correct",
              });
              if (!Predicate.isTagged(admission, "Admitted")) return admission;
              return yield* applyCorrection(parsed);
            }),
          ),
        ),
        () =>
          new CoreMemoryUnavailable({
            cause: "account deletion fence",
            message: "Core Memory correction is unavailable while account deletion is pending",
            operation: "correct",
          }),
      ),
    );
  }

  async #clearCoreMemory(input: Parameters<typeof clearCoreMemory>[1], actionId: ActionId) {
    await this.#migrationsReady;
    const current = this.#currentApprovedActions.get(actionId);
    if (
      current === undefined ||
      current.operation !== "memory.clear" ||
      !hasExactActionInput(
        current.actionPresentation,
        "memory.clear",
        coreMemoryLabelFor(input.block),
      )
    ) {
      return new CoreMemoryUnavailable({
        cause: actionId,
        message: "Current Core Memory authority is unavailable",
        operation: "clear",
      });
    }
    const recheck = await runRpc(
      Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
        Effect.mapError(
          (cause) =>
            new CoreMemoryUnavailable({
              cause,
              message: "Current Core Memory authority is unavailable",
              operation: "clear",
            }),
        ),
        Effect.flatMap((metadata) =>
          this.#managedActionAuthorization
            .recheck(
              metadata.authorityIdentity,
              { actionId, kind: "memory.clear" },
              current.presentation,
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CoreMemoryUnavailable({
                    cause,
                    message: "Current Core Memory authority could not be loaded",
                    operation: "clear",
                  }),
              ),
            ),
        ),
      ),
    );
    if (Predicate.isTagged(recheck, "CoreMemoryUnavailable")) return recheck;
    if (Predicate.isTagged(recheck, "Denied")) return recheck;
    await this.#activateCurrentSession();
    return runRpc(clearCoreMemory(this.session, input));
  }

  async #deletePersonalSkill(input: SkillDeleteInput, actionId: ActionId) {
    await this.#migrationsReady;
    const current = this.#currentApprovedActions.get(actionId);
    if (
      current?.operation !== "skill.manage" ||
      !hasExactPersonalSkillDeleteInput(current.actionPresentation, input)
    ) {
      return {
        _tag: "SkillUnavailable",
        message: "Current personal Skill deletion Approval does not match the requested lineage.",
      } as const;
    }
    const metadata = Schema.decodeUnknownOption(ManagedTurnMetadata)(this.activeTurnMetadata);
    if (Option.isNone(metadata)) {
      return {
        _tag: "SkillUnavailable",
        message: "Current personal Skill authority is unavailable.",
      } as const;
    }
    const recheck = await runRpc(
      this.#managedActionAuthorization.recheck(
        metadata.value.authorityIdentity,
        { actionId, change: "delete", kind: "skill.manage" },
        current.presentation,
      ),
    );
    if (Predicate.isTagged(recheck, "Denied")) return recheck;
    return runRpc(
      this.#accountDeletionFence
        .run(
          this.#personalSkillAuthority.delete({
            ...input,
            userId: metadata.value.authorityIdentity.userId,
          }),
          () => ({
            _tag: "SkillUnavailable" as const,
            message: "Account deletion fenced personal Skill management.",
          }),
        )
        .pipe(
          Effect.orElseSucceed(() => ({
            _tag: "SkillUnavailable" as const,
            message: "The approved personal Skill deletion could not be committed.",
          })),
        ),
    );
  }

  async #forgetKnowledge(input: ForgetKnowledgeInput, actionId: ActionId) {
    await this.#migrationsReady;
    const current = this.#currentApprovedActions.get(actionId);
    if (current === undefined) return deletionApprovalUnavailable(actionId, "forgetKnowledge");
    const recheck = await this.#recheckDeletionAction(
      actionId,
      "memory.forgetKnowledge",
      hasExactForgetKnowledgeInput(current.actionPresentation, input),
      "forgetKnowledge",
    );
    if (
      Predicate.isTagged(recheck, "DeletionActionUnavailable") ||
      Predicate.isTagged(recheck, "Denied")
    )
      return recheck;
    const approvedCoreMemory = approvedForgetKnowledgeCorrections(
      current.actionPresentation,
      input,
    );
    if (Option.isNone(approvedCoreMemory)) {
      return deletionApprovalUnavailable(actionId, "forgetKnowledge");
    }
    const owner = await this.#resolveOwnerUserId("forgetKnowledge");
    if (Predicate.isTagged(owner, "DeletionActionUnavailable")) return owner;
    const deletionAuthorization: DeletionAuthorization = {
      actionId,
      authorityIdentity: recheck.authorityIdentity,
      operation: "memory.forgetKnowledge",
      presentation: current.presentation,
    };
    return this.#serializeMemoryProviderWork(() =>
      this.#retainAndCorrectForgottenKnowledge(
        input,
        approvedCoreMemory.value,
        actionId,
        owner,
        deletionAuthorization,
      ),
    );
  }

  async #retainAndCorrectForgottenKnowledge(
    input: ForgetKnowledgeInput,
    approvedCoreMemory: readonly [
      ApprovedCoreMemoryReplacement,
      ...ReadonlyArray<ApprovedCoreMemoryReplacement>,
    ],
    actionId: ActionId,
    owner: UserId,
    deletionAuthorization: DeletionAuthorization,
  ) {
    const preparationStartedAt = await Effect.runPromise(DateTime.now);
    const enqueuedAt = Db.DbTimestamp.make(DateTime.toDateUtc(preparationStartedAt).toISOString());
    const claimExpiresAt = Db.DbTimestamp.make(
      DateTime.toDateUtc(
        DateTime.add(preparationStartedAt, {
          milliseconds: memoryProviderClaimLeaseMilliseconds,
        }),
      ).toISOString(),
    );
    const retained = await runRpc(
      this.#memoryProviderOutbox
        .retainDeletionPreparation({
          claimExpiresAt,
          claimToken: `initial-correction:${actionId}`,
          enqueuedAt,
          outboxId: MemoryProviderOutboxId.make(`forget-knowledge:${actionId}`),
          payload: {
            _tag: "ForgetKnowledge",
            authorization: deletionAuthorization,
            coreMemory: approvedCoreMemory,
            memoryIds: input.memoryIds,
            userId: owner,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeletionActionUnavailable({
                cause,
                message: "Knowledge forgetting could not be retained for local preparation",
                operation: "forgetKnowledge",
              }),
          ),
        ),
    );
    if (Predicate.isTagged(retained, "DeletionActionUnavailable")) return retained;
    if (Option.isNone(retained)) {
      this.ctx.waitUntil(this.#reconcileMemoryProviderOutboxOrSchedule());
      return { _tag: "KnowledgeForgetCorrectionPending", memoryIds: input.memoryIds } as const;
    }
    const authorizeReplacement = Effect.tryPromise({
      try: () => {
        const latest = this.#currentApprovedActions.get(actionId);
        return this.#recheckDeletionAction(
          actionId,
          "memory.forgetKnowledge",
          latest?.presentation === deletionAuthorization.presentation &&
            latest !== undefined &&
            hasExactForgetKnowledgeInput(latest.actionPresentation, input),
          "forgetKnowledge",
        );
      },
      catch: (cause) =>
        new DeletionActionUnavailable({
          cause,
          message: "Knowledge forgetting authority could not be loaded",
          operation: "forgetKnowledge",
        }),
    }).pipe(
      Effect.flatMap((result) =>
        Predicate.isTagged(result, "DeletionActionUnavailable") ||
        Predicate.isTagged(result, "Denied")
          ? Effect.fail(result)
          : Effect.void,
      ),
    );
    const priorCorrectionState =
      retained.value.deletionProgress?._tag === "ForgetKnowledge"
        ? retained.value.deletionProgress.coreMemoryState
        : undefined;
    const activateForKnowledgeCorrection = Effect.tryPromise({
      try: () => this.#activateCurrentSession(),
      catch: (cause) =>
        new DeletionActionUnavailable({
          cause,
          message: "Current Session could not be activated for Knowledge forgetting",
          operation: "forgetKnowledge",
        }),
    });
    const noCorrections: ReadonlyArray<CoreMemoryCorrected> = [];
    const correct =
      priorCorrectionState === "refreshed"
        ? Effect.succeed(noCorrections)
        : activateForKnowledgeCorrection.pipe(
            Effect.andThen(
              priorCorrectionState === "committed"
                ? refreshCoreMemoryPrompt(this.session).pipe(Effect.as(noCorrections))
                : correctForgottenKnowledge(
                    approvedCoreMemory,
                    authorizeReplacement,
                    (replacements, authorize) =>
                      replaceCoreMemoryBlocks(
                        this.session,
                        this.ctx.storage,
                        replacements,
                        authorize,
                        this.#memoryProviderOutbox.markForgetKnowledgeCorrectionCommitted(
                          retained.value,
                        ),
                      ),
                  ),
            ),
          );
    const prepared = await runRpc(
      completeKnowledgeDeletionPreparation({
        correct,
        release: this.#memoryProviderOutbox.releaseDeletionPreparation(retained.value, enqueuedAt),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DeletionActionUnavailable({
              cause,
              message: "Matching Core Memory could not be corrected",
              operation: "forgetKnowledge",
            }),
        ),
      ),
    );
    if (Predicate.isTagged(prepared, "DeletionActionUnavailable")) return prepared;
    this.ctx.waitUntil(this.#reconcileMemoryProviderOutboxOrSchedule());
    if (prepared._tag === "CorrectionPending") {
      return { _tag: "KnowledgeForgetCorrectionPending", memoryIds: input.memoryIds } as const;
    }
    return {
      _tag: "KnowledgeForgetPending",
      corrected: prepared.corrected,
      memoryIds: input.memoryIds,
    } as const;
  }

  async #deleteSession(input: SessionDeleteInput, actionId: ActionId) {
    await this.#migrationsReady;
    const current = this.#currentApprovedActions.get(actionId);
    if (current === undefined) return deletionApprovalUnavailable(actionId, "deleteSession");
    const recheck = await this.#recheckDeletionAction(
      actionId,
      "session.delete",
      hasExactSessionDeleteInput(current.actionPresentation, input),
      "deleteSession",
    );
    if (
      Predicate.isTagged(recheck, "DeletionActionUnavailable") ||
      Predicate.isTagged(recheck, "Denied")
    )
      return recheck;
    const owner = await this.#resolveOwnerUserId("deleteSession");
    if (Predicate.isTagged(owner, "DeletionActionUnavailable")) return owner;
    const initiallyOwned = await runRpc(
      this.#store.ownsSession(input.sessionId).pipe(
        Effect.mapError(
          (cause) =>
            new DeletionActionUnavailable({
              cause,
              message: "Session ownership could not be checked",
              operation: "deleteSession",
            }),
        ),
      ),
    );
    if (Predicate.isTagged(initiallyOwned, "DeletionActionUnavailable")) return initiallyOwned;
    if (!initiallyOwned) {
      return new DeletionActionUnavailable({
        cause: input.sessionId,
        message: "The selected Session does not belong to this Agent",
        operation: "deleteSession",
      });
    }
    const deletionAuthorization: DeletionAuthorization = {
      actionId,
      authorityIdentity: recheck.authorityIdentity,
      operation: "session.delete",
      presentation: current.presentation,
    };
    const deleted = await this.#deleteSessionLocally(
      input,
      deletionAuthorization,
      owner,
      recheck.routeId,
    );
    this.ctx.waitUntil(this.#reconcileMemoryProviderOutboxOrSchedule());
    if (
      Predicate.isTagged(deleted, "DeletionActionUnavailable") ||
      Predicate.isTagged(deleted, "Denied") ||
      Predicate.isTagged(deleted, "CurrentSessionReplacementConflict")
    )
      return Predicate.isTagged(deleted, "CurrentSessionReplacementConflict")
        ? new DeletionActionUnavailable({
            cause: deleted,
            message: "A different deletion Action owns the replacement Session",
            operation: "deleteSession",
          })
        : deleted;
    return { _tag: "SessionDeletionPending", sessionId: input.sessionId } as const;
  }

  async #deleteSessionLocally(
    input: SessionDeleteInput,
    deletionAuthorization: DeletionAuthorization,
    owner: UserId,
    activeRouteId: ConversationRouteId | undefined,
  ) {
    return runRpc(
      this.#providerConversationSaveGate.runSessionDeletion(
        deleteLocalSession(
          {
            replacementSessionId: SessionId.make(
              `session-delete-${deletionAuthorization.actionId}`,
            ),
            sessionId: input.sessionId,
          },
          {
            activeRouteId,
            activateSession: (sessionId) =>
              Effect.tryPromise({
                try: () => this.#activateSession(sessionId),
                catch: sessionDeletionFailure("The selected Session could not be activated"),
              }),
            authorizeDeletion: () =>
              this.#managedActionAuthorization
                .recheck(
                  deletionAuthorization.authorityIdentity,
                  { actionId: deletionAuthorization.actionId, kind: "session.delete" },
                  deletionAuthorization.presentation,
                )
                .pipe(
                  Effect.mapError(
                    sessionDeletionFailure("Session deletion authority could not be loaded"),
                  ),
                  Effect.flatMap((result) =>
                    Predicate.isTagged(result, "Denied") ? Effect.fail(result) : Effect.void,
                  ),
                ),
            clearMessages: (sessionId) =>
              Effect.tryPromise({
                try: () => Session.create(this).forSession(sessionId).clearMessages(),
                catch: sessionDeletionFailure("Think Session history could not be deleted"),
              }),
            inspectSession: (sessionId) =>
              this.#store
                .readSessionDeletionFacts(sessionId)
                .pipe(
                  Effect.mapError(
                    sessionDeletionFailure("Target Session ownership is unavailable"),
                  ),
                ),
            prepareSession: (sessionId) =>
              Effect.tryPromise({
                try: () => this.#configureSession(Session.create(this), sessionId),
                catch: sessionDeletionFailure(
                  "The exact Session write selection could not be prepared",
                ),
              }),
            readReplacementGeneration: (historicalSessionId, replacementSessionId) =>
              this.#store
                .readSessionReplacementGeneration(historicalSessionId, replacementSessionId)
                .pipe(
                  Effect.mapError(
                    sessionDeletionFailure(
                      "The exact replacement Session generation could not be loaded",
                    ),
                  ),
                ),
            replacedAt: currentDbTimestamp,
            retainIntent: (sessionId, replacementGeneration) =>
              Effect.tryPromise({
                try: () =>
                  this.#retainSessionDeletionIntent(
                    sessionId,
                    deletionAuthorization,
                    owner,
                    replacementGeneration,
                  ),
                catch: (cause) =>
                  new DeletionActionUnavailable({
                    cause,
                    message: "Session deletion intent could not be retained",
                    operation: "deleteSession",
                  }),
              }).pipe(
                Effect.flatMap((result) =>
                  Predicate.isTagged(result, "DeletionActionUnavailable")
                    ? Effect.fail(result)
                    : Effect.void,
                ),
              ),
            replaceCurrentSession: (replacement) =>
              this.#store
                .replaceCurrentSession(replacement)
                .pipe(
                  Effect.mapError(
                    sessionDeletionFailure(
                      "A replacement Session could not be created before deletion",
                    ),
                  ),
                ),
            rollbackCurrentSessionReplacement: (replacement) =>
              this.#store.rollbackCurrentSessionReplacement(replacement).pipe(
                Effect.mapError(
                  sessionDeletionFailure(
                    "The replacement Session could not be rolled back after authority changed",
                  ),
                ),
                Effect.flatMap((rolledBack) =>
                  rolledBack
                    ? Effect.void
                    : Effect.fail(
                        sessionDeletionFailure(
                          "The replacement Session no longer matched the rollback request",
                        )(replacement),
                      ),
                ),
              ),
            selectSessionForWrites: (prepared) =>
              Effect.sync(() => {
                this.session = prepared;
              }),
            settle: (sessionId, replacementGeneration) =>
              Effect.tryPromise({
                try: () =>
                  this.#settleDeletedSession(
                    sessionId,
                    deletionAuthorization,
                    owner,
                    replacementGeneration,
                  ),
                catch: (cause) =>
                  new DeletionActionUnavailable({
                    cause,
                    message: "Session deletion settlement remains pending",
                    operation: "deleteSession",
                  }),
              }).pipe(
                Effect.flatMap((result) =>
                  Predicate.isTagged(result, "DeletionActionUnavailable")
                    ? Effect.fail(result)
                    : Effect.succeed(result),
                ),
              ),
          },
        ),
      ),
    );
  }

  async #retainSessionDeletionIntent(
    sessionId: SessionId,
    deletionAuthorization: DeletionAuthorization,
    owner: UserId,
    replacementGeneration?: SessionReplacementGeneration,
  ) {
    const preparationStartedAt = await Effect.runPromise(DateTime.now);
    const enqueuedAt = Db.DbTimestamp.make(DateTime.toDateUtc(preparationStartedAt).toISOString());
    const claimExpiresAt = Db.DbTimestamp.make(
      DateTime.toDateUtc(
        DateTime.add(preparationStartedAt, {
          milliseconds: memoryProviderClaimLeaseMilliseconds,
        }),
      ).toISOString(),
    );
    const payload =
      replacementGeneration === undefined
        ? {
            _tag: "DeleteSessionConversation" as const,
            authorization: deletionAuthorization,
            sessionId,
            userId: owner,
          }
        : {
            _tag: "DeleteSessionConversation" as const,
            authorization: deletionAuthorization,
            replacementGeneration,
            sessionId,
            userId: owner,
          };
    const retained = await runRpc(
      this.#memoryProviderOutbox
        .retainDeletionPreparation({
          claimExpiresAt,
          claimToken: `initial-session-deletion:${deletionAuthorization.actionId}`,
          enqueuedAt,
          outboxId: MemoryProviderOutboxId.make(`delete-session:${deletionAuthorization.actionId}`),
          payload,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeletionActionUnavailable({
                cause,
                message: "Session deletion intent could not be retained for local preparation",
                operation: "deleteSession",
              }),
          ),
        ),
    );
    if (Predicate.isTagged(retained, "DeletionActionUnavailable")) return retained;
    return undefined;
  }

  async #settleDeletedSession(
    sessionId: SessionId,
    deletionAuthorization: DeletionAuthorization,
    owner: UserId,
    replacementGeneration?: SessionReplacementGeneration,
  ) {
    const deletedAt = await Effect.runPromise(currentDbTimestamp);
    const deletionInput =
      replacementGeneration === undefined
        ? {
            authorization: deletionAuthorization,
            deletedAt,
            outboxId: MemoryProviderOutboxId.make(
              `delete-session:${deletionAuthorization.actionId}`,
            ),
            sessionId,
            userId: owner,
          }
        : {
            authorization: deletionAuthorization,
            deletedAt,
            outboxId: MemoryProviderOutboxId.make(
              `delete-session:${deletionAuthorization.actionId}`,
            ),
            replacementGeneration,
            sessionId,
            userId: owner,
          };
    return runRpc(
      this.#store.deleteHistoricalSession(deletionInput).pipe(
        Effect.mapError(
          (cause) =>
            new DeletionActionUnavailable({
              cause,
              message: "Session deletion could not be retained for provider retry",
              operation: "deleteSession",
            }),
        ),
      ),
    );
  }

  async #recheckDeletionAction(
    actionId: ActionId,
    operation: "memory.forgetKnowledge" | "session.delete",
    exactInput: boolean,
    failureOperation: "forgetKnowledge" | "deleteSession",
  ) {
    const current = this.#currentApprovedActions.get(actionId);
    if (current?.operation !== operation || !exactInput) {
      return new DeletionActionUnavailable({
        cause: actionId,
        message: "Current deletion Approval does not match the requested target",
        operation: failureOperation,
      });
    }
    return runRpc(
      Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
        Effect.mapError(
          (cause) =>
            new DeletionActionUnavailable({
              cause,
              message: "Current deletion authority is unavailable",
              operation: failureOperation,
            }),
        ),
        Effect.flatMap((metadata) =>
          this.#managedActionAuthorization
            .recheck(
              metadata.authorityIdentity,
              { actionId, kind: operation },
              current.presentation,
            )
            .pipe(
              Effect.map((result) =>
                result._tag === "Permitted"
                  ? {
                      _tag: "DeletionPermitted" as const,
                      authorityIdentity: metadata.authorityIdentity,
                      routeId: metadata.routeId,
                    }
                  : result,
              ),
              Effect.mapError(
                (cause) =>
                  new DeletionActionUnavailable({
                    cause,
                    message: "Current deletion authority could not be loaded",
                    operation: failureOperation,
                  }),
              ),
            ),
        ),
      ),
    );
  }

  async #resolveOwnerUserId(operation: "forgetKnowledge" | "deleteSession") {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return new DeletionActionUnavailable({
        cause: invalidOsfoEnvironment,
        message: "The Agent owner is unavailable",
        operation,
      });
    }
    try {
      return await runtime.runPromise(
        Effect.scoped(
          AgentDirectory.make.pipe(
            Effect.flatMap((directory) => directory.resolveAgent(AgentId.make(this.name))),
            Effect.map(({ userId }) => userId),
          ),
        ),
      );
    } catch (cause) {
      return new DeletionActionUnavailable({
        cause,
        message: "The Agent owner could not be resolved",
        operation,
      });
    }
  }

  #readCoreMemoryAuthorization() {
    const metadata = Schema.decodeUnknownOption(ManagedTurnMetadata)(this.activeTurnMetadata);
    if (Option.isSome(metadata)) {
      return Schema.decodeEffect(CoreMemoryAuthorizationSnapshot)(
        metadata.value.coreMemoryAuthorization,
      ).pipe(
        Effect.map(restoreCoreMemoryAuthorization),
        Effect.mapError(
          (cause) =>
            new CoreMemoryUnavailable({
              cause,
              message: "Core Memory authority could not be restored",
              operation: "clear",
            }),
        ),
      );
    }
    return Effect.fail(
      new CoreMemoryUnavailable({
        cause: this.activeTurnMetadata,
        message: "Core Memory authority is unavailable outside an admitted turn",
        operation: "clear",
      }),
    );
  }

  /** Reconcile committed Think messages when a new Agent activation starts. */
  override async onStart(): Promise<void> {
    await this.#migrationsReady;
    await this.#reconcileModelCallUsageOrSchedule();
    await Effect.runPromise(this.#reconcileCommittedTurns());
    this.ctx.waitUntil(this.#recoverSkillLearning());
    this.ctx.waitUntil(this.#reconcileMemoryProviderOutboxOrSchedule());
  }

  async #recordGoodRootOutcome(input: GoodRootOutcomeEvaluationReference) {
    const committed = await Effect.runPromise(this.#store.readCommittedTurns);
    const outcome = await Effect.runPromise(
      ingestGoodRootEvaluation({
        authority: this.#personalSkillAuthority,
        committedTurns: committed,
        messages: this.messages,
        nowEpochMillis: Date.now(),
        reference: input,
      }),
    );
    if (outcome._tag !== "SkillLearningQueued") return outcome;
    this.ctx.waitUntil(this.#runSkillLearning(outcome.candidate));
    return { _tag: outcome._tag, candidateId: outcome.candidateId } as const;
  }

  async #evaluateGoodRootOutcome(assistantMessageId: AssistantMessageId): Promise<void> {
    const evaluation = await Effect.runPromise(
      this.#goodRootOutcomeEvaluator.evaluate({
        assistantMessageId,
        evaluatedAtEpochMillis: Date.now(),
      }),
    );
    if (Option.isNone(evaluation)) return;
    await this.#recordGoodRootOutcome(evaluation.value);
  }

  async #recoverSkillLearning(): Promise<void> {
    const recoverable = await Effect.runPromise(
      recoverPersonalSkillLearning(this.#personalSkillAuthority, Date.now()),
    );
    await Promise.all(recoverable.map((candidate) => this.#runSkillLearning(candidate)));
    await this.#deliverPendingSkillLearningNotifications();
  }

  async #runSkillLearning(candidate: SkillLearningCandidate): Promise<void> {
    const authority = this.#personalSkillAuthority;
    const deliverNotifications = () => this.#deliverPendingSkillLearningNotificationsUnfenced();
    const propose = (input: SkillLearningModelInput) => this.#proposeSkillLearning(input);
    await Effect.runPromise(
      this.#accountDeletionFence
        .run(
          Effect.gen(function* () {
            const load = yield* authority.learningLoad(candidate.ownerUserId, Date.now());
            const outcome = yield* makeSkillLearningCoordinator({
              authority,
              propose,
              recordCompanyCost: (cost) => authority.recordLearningCost(cost),
            }).run({
              availability: {
                capabilityIds: candidate.availableCapabilityIds,
                requirements: candidate.availableRequirements,
              },
              candidate,
              load,
              nowEpochMillis: Date.now(),
            });
            yield* Effect.logInfo("Post-turn personal Skill Learning completed").pipe(
              Effect.annotateLogs({
                outcome: outcome._tag,
                reason: "reason" in outcome ? outcome.reason : undefined,
              }),
            );
            yield* Effect.tryPromise({
              try: deliverNotifications,
              catch: (cause) => ({ _tag: "SkillLearningDeliveryUnavailable" as const, cause }),
            });
          }),
          () => ({ _tag: "AccountDeletionFenced" as const }),
        )
        .pipe(
          Effect.catch((failure) =>
            Effect.logWarning("Post-turn personal Skill Learning was isolated").pipe(
              Effect.annotateLogs({ failure: failure._tag }),
            ),
          ),
        ),
    );
  }

  #proposeSkillLearning(input: SkillLearningModelInput) {
    const authority = this.#personalSkillAuthority;
    const readGatewayVendorCost = (logId: string) => this.#readGatewayVendorCost(logId);
    const resolveModel = () => this.resolveModel(launchModelAccessPolicy.plans.free.route);
    return Effect.gen(function* () {
      const prompt = encodeSkillLearningPrompt({
        corrections: input.candidate.corrections,
        decisions: input.candidate.decisions,
        priorSkill: input.priorVersion,
        taskDescription: input.candidate.taskDescription,
      });
      const generated = yield* Effect.exit(
        Effect.tryPromise({
          try: () =>
            generateText({
              maxOutputTokens: currentCapabilityCatalog.skillLearning.modelOutputTokens,
              maxRetries: 0,
              model: resolveModel(),
              output: Output.object({ schema: effectToolSchema(SkillLearningModelDecision) }),
              prompt,
              system:
                "Decide whether the trusted direct User correction creates a reusable personal Skill. Return only bounded natural-language guidance. Never add authority, code, credentials, provider payloads, or facts absent from the supplied correction and prior Skill.",
              timeout: 20_000,
            }),
          catch: (cause) =>
            new SkillLearningModelUnavailable({
              cause,
              message: "The isolated Skill Learning model call failed",
            }),
        }),
      );
      const conservativeVendorUsdMicros = Number(
        currentLaunchPolicy.plans.free.operationLimits.vendorUsdMicrosPerRequest,
      );
      if (Exit.isFailure(generated)) {
        yield* authority.recordLearningCost({
          attemptId: input.attemptId,
          basis: "conservative",
          candidateId: input.candidate.candidateId,
          modelInputTokens: currentCapabilityCatalog.skillLearning.modelInputTokens,
          modelOutputTokens: currentCapabilityCatalog.skillLearning.modelOutputTokens,
          outcome: "failure",
          recordedAtEpochMillis: Date.now(),
          userId: input.candidate.ownerUserId,
          vendorUsdMicros: conservativeVendorUsdMicros,
        });
        return yield* new SkillLearningModelUnavailable({
          cause: generated.cause,
          message: "The isolated Skill Learning model call failed",
        });
      }
      const logId = readAiGatewayLogId(
        generated.value.finalStep.response.headers,
        generated.value.finalStep.providerMetadata,
      );
      const observed = Option.isNone(logId)
        ? Option.none<bigint>()
        : yield* Effect.promise(() => readGatewayVendorCost(logId.value));
      const measured =
        generated.value.usage.inputTokens !== undefined &&
        generated.value.usage.outputTokens !== undefined &&
        Option.isSome(observed);
      return {
        proposal: bindSkillLearningModelDecision(input, generated.value.output),
        usage: {
          costBasis: measured ? ("observed" as const) : ("conservative" as const),
          modelInputTokens:
            generated.value.usage.inputTokens ??
            currentCapabilityCatalog.skillLearning.modelInputTokens,
          modelOutputTokens:
            generated.value.usage.outputTokens ??
            currentCapabilityCatalog.skillLearning.modelOutputTokens,
          vendorUsdMicros: Option.match(observed, {
            onNone: () => conservativeVendorUsdMicros,
            onSome: Number,
          }),
        },
      };
    });
  }

  async #deliverPendingSkillLearningNotifications(): Promise<void> {
    await Effect.runPromise(
      this.#accountDeletionFence
        .run(
          Effect.tryPromise({
            try: () => this.#deliverPendingSkillLearningNotificationsUnfenced(),
            catch: (cause) => ({ _tag: "SkillLearningDeliveryUnavailable" as const, cause }),
          }),
          () => ({ _tag: "AccountDeletionFenced" as const }),
        )
        .pipe(
          Effect.catch((failure) =>
            Effect.logWarning("Personal Skill Learning notification delivery was isolated").pipe(
              Effect.annotateLogs({ failure: failure._tag }),
            ),
          ),
        ),
    );
  }

  async #deliverPendingSkillLearningNotificationsUnfenced(): Promise<void> {
    await Effect.runPromise(
      deliverSkillLearningNotifications({
        markDelivered: (input) =>
          this.#personalSkillAuthority.markLearningNotificationDelivered(input),
        messages: () => this.messages,
        nowEpochMillis: Date.now,
        pending: this.#personalSkillAuthority.pendingLearningNotifications,
        updateMessage: (message) => Effect.promise(() => this.updateMessageInHistory(message)),
      }),
    );
  }

  /** Retry durable Knowledge Base operations after an activation or scheduled wake. */
  async reconcileMemoryProviderOutbox(): Promise<void> {
    await this.#migrationsReady;
    await this.#reconcileMemoryProviderOutboxOrSchedule();
  }

  /** Fence ordinary Agent/R2 work, then drain provider activity for account deletion. */
  async quiesceAccountDeletion(encodedUserId: string): Promise<void> {
    await this.#migrationsReady;
    const userId = await Effect.runPromise(Schema.decodeEffect(UserId)(encodedUserId));
    const quiescence = await runRpc(
      this.#accountDeletionFencedSessionExecution.closeAfter(
        Effect.tryPromise({
          try: () => this.#cancelActiveSubmissionsForAccountDeletion(),
          catch: (cause) =>
            new ThinkSubmissionUnavailable({
              cause,
              message: "Ordinary Agent executions could not be cancelled for account deletion",
              operation: "quiesceAccountDeletion",
            }),
        }),
      ),
    );
    requireAccountDeletionQuiescence(quiescence);
    await this.#reconcileMemoryProviderOutboxOrSchedule();
    const canSave = await Effect.runPromise(this.#canSaveProviderConversation(userId));
    if (canSave) throw new Error("Account deletion has not fenced provider conversation saves");
    await Effect.runPromise(
      quiesceProcessingConversations(
        this.#memoryProviderOutbox,
        () =>
          Effect.promise(() =>
            this.#reconcileMemoryProviderOutboxOrSchedule(accountDeletionProviderPollMilliseconds),
          ),
        accountDeletionProviderPollMilliseconds,
      ).pipe(Effect.timeout(accountDeletionProviderQuiescenceTimeoutMilliseconds)),
    );
    await Effect.runPromise(this.#personalSkillAuthority.deleteUserData(userId));
  }

  async #cancelActiveSubmissionsForAccountDeletion() {
    const active = await this.listSubmissions({ limit: 100, status: ["pending", "running"] });
    if (active.length === 0) return;
    await Promise.all(
      active.map(({ submissionId }) =>
        this.cancelSubmission(submissionId, "Account deletion fenced ordinary Agent execution"),
      ),
    );
    await this.#cancelActiveSubmissionsForAccountDeletion();
  }

  #authorizeProviderDeletion(deletionAuthorization: DeletionAuthorization) {
    return this.#managedActionAuthorization
      .recheck(
        deletionAuthorization.authorityIdentity,
        { actionId: deletionAuthorization.actionId, kind: deletionAuthorization.operation },
        deletionAuthorization.presentation,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDeletionDeferred({
              cause,
              message: "Current deletion authority could not be loaded",
            }),
        ),
      );
  }

  #canSaveProviderConversation(userId: UserId) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return Effect.fail(
        new ProviderSaveDeferred({
          cause: invalidOsfoEnvironment,
          message: "Current account-deletion state is unavailable",
        }),
      );
    }
    return Effect.tryPromise({
      try: () =>
        runtime.runPromise(
          Effect.scoped(
            DeletionCasePostgres.make.pipe(
              Effect.flatMap((deletionCases) => deletionCases.inspect(userId)),
              Effect.map((access) => access._tag === "DeletionAccessAvailable"),
            ),
          ),
        ),
      catch: (cause) =>
        new ProviderSaveDeferred({
          cause,
          message: "Current account-deletion state could not be loaded",
        }),
    });
  }

  #prepareProviderDeletion(claim: ClaimedMemoryProviderWork) {
    const payload = claim.payload;
    if (payload._tag === "ForgetKnowledge") {
      const correctionCommitted =
        claim.deletionProgress?._tag === "ForgetKnowledge" &&
        claim.deletionProgress.coreMemoryState === "committed";
      return Effect.tryPromise({
        try: () => this.#activateCurrentSession(),
        catch: (cause) =>
          new ProviderDeletionDeferred({
            cause,
            message: "Current Session could not be activated for Core Memory correction",
          }),
      }).pipe(
        Effect.andThen(
          correctionCommitted
            ? refreshCoreMemoryPrompt(this.session)
            : correctForgottenKnowledge(
                payload.coreMemory,
                this.#authorizeProviderDeletion(payload.authorization).pipe(
                  Effect.flatMap((result) =>
                    Predicate.isTagged(result, "Denied")
                      ? Effect.fail(
                          new ProviderDeletionDeferred({
                            cause: result,
                            message: "Core Memory correction authority changed",
                          }),
                        )
                      : Effect.void,
                  ),
                ),
                (replacements, authorize) =>
                  replaceCoreMemoryBlocks(
                    this.session,
                    this.ctx.storage,
                    replacements,
                    authorize,
                    this.#memoryProviderOutbox.markForgetKnowledgeCorrectionCommitted(claim),
                  ),
              ).pipe(Effect.asVoid),
        ),
        Effect.mapError(
          (cause) =>
            new ProviderDeletionDeferred({
              cause,
              message: "Core Memory correction remains pending",
            }),
        ),
      );
    }
    if (payload._tag === "DeleteSessionConversation") {
      const deletionAuthorization = payload.authorization;
      return Effect.tryPromise({
        try: () =>
          this.#deleteSessionLocally(
            { sessionId: payload.sessionId },
            deletionAuthorization,
            payload.userId,
            undefined,
          ),
        catch: (cause) =>
          new ProviderDeletionDeferred({
            cause,
            message: "Local Session deletion remains pending",
          }),
      }).pipe(
        Effect.flatMap((result) =>
          Predicate.isTagged(result, "DeletionActionUnavailable") ||
          Predicate.isTagged(result, "Denied") ||
          Predicate.isTagged(result, "CurrentSessionReplacementConflict")
            ? Effect.fail(
                new ProviderDeletionDeferred({
                  cause: result,
                  message: "Local Session deletion remains pending",
                }),
              )
            : Effect.void,
        ),
      );
    }
    return Effect.void;
  }

  /** Retry durable model usage that has not reached PostgreSQL Allowances. */
  async reconcileModelCallUsage(): Promise<void> {
    await this.#migrationsReady;
    await this.#reconcileModelCallUsageOrSchedule();
  }

  /** Settle one delayed AI Gateway cost lookup without creating another execution lifecycle. */
  async settleGatewayModelUsage(input: GatewayCostSettlement): Promise<void> {
    await this.#migrationsReady;
    const settlement = await Effect.runPromise(Schema.decodeEffect(GatewayCostSettlement)(input));
    const vendorUsdMicros = await this.#readGatewayVendorCost(settlement.gatewayLogId);
    if (Option.isSome(vendorUsdMicros)) {
      await this.#recordModelCallUsage(settlement.allowancePeriodId, settlement.attemptId, {
        _tag: "Observed",
        vendorUsdMicros: vendorUsdMicros.value,
      });
      return;
    }
    if (settlement.lookupAttempt >= gatewayCostMaximumLookups) {
      await this.#recordModelCallUsage(settlement.allowancePeriodId, settlement.attemptId, {
        _tag: "Ambiguous",
        conservativeVendorUsdMicros: BigInt(settlement.conservativeVendorUsdMicros),
      });
      return;
    }
    await this.#scheduleGatewayCostSettlement({
      ...settlement,
      lookupAttempt: settlement.lookupAttempt + 1,
    });
  }

  /** Idempotently establish the initialization fact, primary route, and current Session. */
  async initialize(
    input: AgentInitializationEncoded,
  ): Promise<
    | AgentInitializationConflict
    | AgentInitialized
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
  > {
    await this.#migrationsReady;
    const agentName = this.name;
    const activateCurrentSession = () => this.#activateCurrentSession();
    const store = this.#store;
    return runRpc(
      this.#accountDeletionFencedSessionExecution.run(
        Effect.gen(function* () {
          const namedAgentId = yield* Schema.decodeEffect(AgentId)(agentName).pipe(
            Effect.mapError(() => invalidRequest("initialize")),
          );
          const parsed = yield* Schema.decodeEffect(AgentInitializationInput)(input).pipe(
            Effect.mapError(() => invalidRequest("initialize")),
          );
          const outcome = yield* store.initialize(namedAgentId, parsed);
          if ("currentSessionId" in outcome) {
            yield* Effect.promise(activateCurrentSession);
          }
          return outcome;
        }),
        () =>
          new AgentStoreUnavailable({
            cause: "account deletion fence",
            message: "Agent initialization is unavailable while account deletion is pending",
            operation: "initialize",
          }),
      ),
    );
  }

  /** Authorize and durably enqueue one server-routed managed conversation turn. */
  async submitManagedConversation(
    input: SubmitManagedConversationRequest,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CurrentSessionActivationUnavailable
    | CurrentSessionReplaced
    | CurrentSessionReplacementConflict
    | ManagedConversationDenied
    | ManagedRouteUnavailable
    | PlanPolicyNotFound
    | SessionLifecycleNotFound
    | SessionLifecycleUnavailable
    | SubmitMessagesResult
    | ThinkSubmissionUnavailable
  > {
    await this.#migrationsReady;
    const decoded = Schema.decodeResult(SubmitManagedConversationInput)(input);
    if (Result.isFailure(decoded)) return invalidRequest("submitManagedConversation");
    const lifecycle = this.#agentSessionLifecycle;
    const sessionLifecycle = this.#sessionLifecycle;
    const submitTurn = (admission: ManagedConversationAdmitted) =>
      this.runTurn({
        idempotencyKey: admission.idempotencyKey,
        input: {
          id: admission.submissionId,
          metadata: { turnMetadata: admission.metadata },
          parts: [{ text: admission.message, type: "text" }],
          role: "user",
        },
        metadata: admission.metadata,
        mode: "submit",
        submissionId: admission.submissionId,
      });
    const operation = Effect.gen(function* () {
      const session = yield* sessionLifecycle.readAuthorizationFacts(decoded.success.routeId);
      const admission = yield* admitManagedConversation(decoded.success, session);
      if (Predicate.isTagged(admission, "ManagedSessionReplacementAdmitted")) {
        return yield* lifecycle.replaceCurrent(admission);
      }
      if (!Predicate.isTagged(admission, "ManagedConversationAdmitted")) return admission;
      return yield* callThinkSubmission("runTurn", () => submitTurn(admission));
    });
    const fenced = this.#accountDeletionFencedSessionExecution;
    const onClosed = () =>
      new ThinkSubmissionUnavailable({
        cause: decoded.success.submissionId,
        message: "Account deletion fenced this managed conversation",
        operation: "submitManagedConversation",
      });
    return runRpc(
      decoded.success.message.trim() === "/new"
        ? fenced.runWhenIdle(operation, onClosed)
        : fenced.run(operation, onClosed),
    );
  }

  /** Cancel one Think-owned managed conversation without creating another lifecycle. */
  async cancelManagedConversation(
    input: CancelManagedConversationRequest,
  ): Promise<AgentRequestInvalid | ThinkSubmissionInspection | ThinkSubmissionUnavailable | null> {
    await this.#migrationsReady;
    const decoded = Schema.decodeResult(CancelManagedConversationInput)(input);
    if (Result.isFailure(decoded)) return invalidRequest("cancelManagedConversation");
    return runRpc(
      callThinkSubmission("cancelSubmission", () =>
        this.cancelSubmission(decoded.success.submissionId, decoded.success.reason),
      ).pipe(
        Effect.andThen(
          callThinkSubmission("inspectSubmission", () =>
            this.inspectSubmission(decoded.success.submissionId),
          ),
        ),
      ),
    );
  }

  /** Ingest and normalize one authenticated User-owned file through owned production adapters. */
  async uploadFile(input: UploadFileRequest) {
    await this.#migrationsReady;
    return runRpc(
      this.#accountDeletionFence.run(
        Schema.decodeEffect(UploadFileRequest)(input).pipe(
          Effect.mapError(() => invalidRequest("uploadFile")),
          Effect.flatMap((parsed) =>
            this.#files.upload({
              actionId: parsed.actionId,
              bytes: parsed.bytes,
              context: parsed.authorization,
              declaredMediaType: parsed.declaredMediaType,
              fileId: parsed.fileId,
              fileName: parsed.fileName,
              uploadId: parsed.uploadId,
            }),
          ),
        ),
        () =>
          new FileCapabilityUnavailable({
            cause: "account deletion fence",
            message: "File upload is unavailable while account deletion is pending",
            operation: "uploadFile",
          }),
      ),
    );
  }

  /** Read one authenticated User-owned file through its Agent and R2 ownership boundary. */
  async readFile(input: ReadFileRequest) {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(ReadFileRequest)(input).pipe(
        Effect.mapError(() => invalidRequest("readFile")),
        Effect.flatMap((parsed) =>
          this.#files.read({
            actionId: parsed.actionId,
            context: parsed.authorization,
            fileId: parsed.fileId,
          }),
        ),
      ),
    );
  }

  /** Analyze one authenticated User-owned normalized file in disposable compute. */
  async analyzeFile(input: AnalyzeFileRequest) {
    await this.#migrationsReady;
    return runRpc(
      this.#accountDeletionFence.run(
        Schema.decodeEffect(AnalyzeFileRequest)(input).pipe(
          Effect.mapError(() => invalidRequest("analyzeFile")),
          Effect.flatMap((parsed) =>
            this.#files.analyze({
              actionId: parsed.actionId,
              analysisId: parsed.analysisId,
              context: parsed.authorization,
              fileId: parsed.fileId,
              prompt: parsed.prompt,
            }),
          ),
        ),
        () =>
          new FileCapabilityUnavailable({
            cause: "account deletion fence",
            message: "File analysis is unavailable while account deletion is pending",
            operation: "analyzeFile",
          }),
      ),
    );
  }

  /** Delete one authenticated User-owned file after exact destructive Approval. */
  async deleteFile(input: DeleteFileRequest) {
    await this.#migrationsReady;
    return runRpc(
      this.#accountDeletionFence.run(
        Schema.decodeEffect(DeleteFileRequest)(input).pipe(
          Effect.mapError(() => invalidRequest("deleteFile")),
          Effect.flatMap((parsed) =>
            this.#files.remove({
              actionId: parsed.actionId,
              context: parsed.authorization,
              fileId: parsed.fileId,
            }),
          ),
        ),
        () =>
          new FileCapabilityUnavailable({
            cause: "account deletion fence",
            message: "File deletion is unavailable while account deletion is pending",
            operation: "deleteFile",
          }),
      ),
    );
  }

  /** Read one immutable presentation and current Approval state for an authenticated User. */
  async readActionPresentation(
    input: ReadActionPresentationRequest,
  ): Promise<
    | ActionPresentationFound
    | ActionPresentationNotFound
    | ActionPresentationUnavailable
    | ActionApprovalRequestInvalid
    | ApprovalActorAuthorizationUnavailable
    | ApprovalActorUnauthorized
    | ThinkApprovalUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(ReadActionPresentationRequest)(input).pipe(
        Effect.mapError(
          () =>
            new ActionApprovalRequestInvalid({
              message: "The Action Presentation request is invalid",
              operation: "readActionPresentation",
            }),
        ),
        Effect.flatMap((parsed) => this.#actionApprovals.read(parsed.actor, parsed.presentationId)),
      ),
    );
  }

  /** Record the first authenticated exact Approval decision and dispatch it to Think. */
  async decideActionApproval(
    input: DecideActionApprovalRequest,
  ): Promise<
    | ActionPresentationNotFound
    | ActionPresentationUnavailable
    | ActionApprovalRequestInvalid
    | ApprovalActorAuthorizationUnavailable
    | ApprovalActorUnauthorized
    | ApprovalAlreadyResolved
    | ApprovalDecisionAccepted
    | ThinkApprovalUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(
      this.#accountDeletionFence.run(
        Schema.decodeEffect(DecideActionApprovalRequest)(input).pipe(
          Effect.mapError(
            () =>
              new ActionApprovalRequestInvalid({
                message: "The Action Approval decision is invalid",
                operation: "decideActionApproval",
              }),
          ),
          Effect.flatMap((parsed) =>
            this.#actionApprovals.read(parsed.actor, parsed.presentationId).pipe(
              Effect.flatMap((found) => {
                const actionId = found.presentation.actionId;
                if (
                  parsed.decision === "approve" &&
                  (found.presentation.operation === "artifact.delete" ||
                    found.presentation.operation === "memory.clear" ||
                    found.presentation.operation === "file.delete" ||
                    found.presentation.operation === "memory.forgetKnowledge" ||
                    found.presentation.operation === "session.delete" ||
                    found.presentation.operation === "skill.manage" ||
                    found.presentation.operation === "integration.effect")
                ) {
                  this.#currentApprovedActions.set(actionId, {
                    actionPresentation: found.presentation,
                    operation: found.presentation.operation,
                    presentation: approvalPresentationFor(found.presentation),
                  });
                }
                return this.#actionApprovals
                  .dispatch(
                    parsed.actor,
                    parsed.presentationId,
                    parsed.decision === "approve" ? "approved" : "rejected",
                    parsed.reason,
                  )
                  .pipe(
                    Effect.ensuring(
                      Effect.sync(() => this.#currentApprovedActions.delete(actionId)),
                    ),
                  );
              }),
            ),
          ),
        ),
        () =>
          new ThinkApprovalUnavailable({
            cause: "account deletion fence",
            message: "Action Approval is unavailable while account deletion is pending",
            operation: "decideActionApproval",
          }),
      ),
    );
  }

  /** Cancel one pending Approval and its owning Think execution. */
  async cancelActionApproval(
    input: CancelActionApprovalRequest,
  ): Promise<
    | ActionPresentationNotFound
    | ActionApprovalRequestInvalid
    | ApprovalActorAuthorizationUnavailable
    | ApprovalActorUnauthorized
    | ApprovalAlreadyResolved
    | ApprovalDecisionAccepted
    | ThinkApprovalUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(CancelActionApprovalRequest)(input).pipe(
        Effect.mapError(
          () =>
            new ActionApprovalRequestInvalid({
              message: "The Action Approval cancellation is invalid",
              operation: "cancelActionApproval",
            }),
        ),
        Effect.flatMap((parsed) =>
          this.#actionApprovals.dispatch(
            parsed.actor,
            parsed.presentationId,
            "canceled",
            parsed.reason,
          ),
        ),
      ),
    );
  }

  /** List the authenticated User's active and archived personal Skills. */
  async inspectPersonalSkills(input: PersonalSkillControlActor) {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(PersonalSkillControlActor)(input).pipe(
        Effect.flatMap((actor) => this.#personalSkillControl(actor).inspect(actor.userId)),
      ),
    );
  }

  /** Show safe current connection state without exposing provider account identities. */
  async inspectIntegrationConnections(input: typeof IntegrationSettingsActor.Type) {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(IntegrationSettingsActor)(input).pipe(
        Effect.flatMap((actor) => this.#integrationConnectionSummary(actor.userId)),
      ),
    );
  }

  /** Acquire one provider-hosted link after current connection-management authorization. */
  async connectIntegrationFromSettings(input: typeof IntegrationSettingsConnect.Type) {
    await this.#migrationsReady;
    const accountDeletionFence = this.#accountDeletionFence;
    const integrationsOption = this.#integrations;
    const authorizeConnection = (
      actor: typeof IntegrationSettingsActor.Type,
      toolkit: typeof IntegrationSettingsToolkit.Type,
    ) => this.#authorizeIntegrationConnection(actor, toolkit, "connect");
    return runRpc(
      Schema.decodeEffect(IntegrationSettingsConnect)(input).pipe(
        Effect.flatMap((request) =>
          Effect.gen(function* () {
            yield* authorizeConnection(request.actor, request.toolkit);
            const integrations = Option.getOrUndefined(integrationsOption);
            if (integrations === undefined) return yield* settingsIntegrationUnavailable();
            const link = yield* accountDeletionFence.run(
              integrations.connectLink({
                callbackUrl: new URL(request.callbackUrl),
                toolkit: request.toolkit,
                userId: request.actor.userId,
              }),
              settingsIntegrationUnavailable,
            );
            return { url: link.redirectUrl.href };
          }),
        ),
      ),
    );
  }

  /** Revoke the one current toolkit account after a fresh authority check. */
  async disconnectIntegrationFromSettings(input: typeof IntegrationSettingsMutation.Type) {
    await this.#migrationsReady;
    const accountDeletionFence = this.#accountDeletionFence;
    const integrationsOption = this.#integrations;
    const authorizeConnection = (
      actor: typeof IntegrationSettingsActor.Type,
      toolkit: typeof IntegrationSettingsToolkit.Type,
    ) => this.#authorizeIntegrationConnection(actor, toolkit, "revoke");
    return runRpc(
      Schema.decodeEffect(IntegrationSettingsMutation)(input).pipe(
        Effect.flatMap((request) =>
          Effect.gen(function* () {
            yield* authorizeConnection(request.actor, request.toolkit);
            const integrations = Option.getOrUndefined(integrationsOption);
            if (integrations === undefined) return yield* settingsIntegrationUnavailable();
            yield* accountDeletionFence.run(
              integrations.disconnect({
                toolkit: request.toolkit,
                userId: request.actor.userId,
              }),
              settingsIntegrationUnavailable,
            );
            return { status: "missing" as const, toolkit: request.toolkit };
          }),
        ),
      ),
    );
  }

  /** Commit one authenticated non-destructive personal Skill lifecycle change. */
  async changePersonalSkill(input: typeof PersonalSkillControlChange.Type) {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(PersonalSkillControlChange)(input).pipe(
        Effect.flatMap(({ actor, change }) =>
          this.#accountDeletionFence.run(
            this.#personalSkillControl(actor).change(actor.userId, change),
            () =>
              new PersonalSkillApprovalInvalid({
                message: "Account deletion fenced personal Skill management.",
              }),
          ),
        ),
      ),
    );
  }

  /** Present the exact current personal Skill lineage before destructive Approval. */
  async presentPersonalSkillDeletion(input: typeof PersonalSkillControlRead.Type) {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(PersonalSkillControlRead)(input).pipe(
        Effect.flatMap(({ actor, reference }) =>
          this.#personalSkillControl(actor).presentDeletion(actor.userId, reference),
        ),
      ),
    );
  }

  /** Consume one exact destructive Approval and delete its personal Skill lineage. */
  async deletePersonalSkillFromSettings(input: typeof PersonalSkillControlDelete.Type) {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(PersonalSkillControlDelete)(input).pipe(
        Effect.flatMap(({ actor, reference, request }) =>
          this.#accountDeletionFence.run(
            this.#personalSkillControl(actor).delete(actor.userId, reference, request),
            () =>
              new PersonalSkillApprovalInvalid({
                message: "Account deletion fenced personal Skill deletion.",
              }),
          ),
        ),
      ),
    );
  }

  /** Look up the stable initialization fact and current primary Session. */
  async inspect(): Promise<
    AgentFound | AgentStateNotFound | AgentStoreRecordInvalid | AgentStoreUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(this.#store.inspect());
  }

  #personalSkillControl(actor: PersonalSkillControlActor) {
    return makePersonalSkillControl({
      authority: this.#personalSkillAuthority,
      availability: () => settingsPersonalSkillAvailability,
      decisionReference: () => actor.decisionReference,
      nowEpochMillis: Date.now,
    });
  }

  #integrationConnectionSummary(userId: UserId) {
    const mappings = integrationSettingsMappings;
    const integrations = Option.getOrUndefined(this.#integrations);
    if (integrations === undefined) {
      return Effect.succeed({
        connections: mappings.map(({ description, label, provider }) => ({
          description,
          label,
          status: "unavailable" as const,
          toolkit: provider,
        })),
      });
    }
    return Effect.forEach(
      mappings,
      ({ description, label, provider }) =>
        integrations.connectionEvidence({ toolkit: provider, userId }).pipe(
          Effect.match({
            onFailure: () => ({
              description,
              label,
              status: "unavailable" as const,
              toolkit: provider,
            }),
            onSuccess: (evidence) => ({
              description,
              label,
              status:
                evidence._tag === "IntegrationConnectionConnected"
                  ? ("connected" as const)
                  : evidence._tag === "IntegrationConnectionStale" ||
                      evidence._tag === "IntegrationConnectionAmbiguous"
                    ? ("stale" as const)
                    : ("missing" as const),
              toolkit: provider,
            }),
          }),
        ),
      { concurrency: 1 },
    ).pipe(Effect.map((connections) => ({ connections })));
  }

  #authorizeIntegrationConnection(
    actor: typeof IntegrationSettingsActor.Type,
    toolkit: typeof IntegrationSettingsToolkit.Type,
    change: "connect" | "revoke",
  ) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) return Effect.fail(settingsIntegrationUnavailable());
    const identity = {
      _tag: "AuthSession" as const,
      authSessionId: actor.authSessionId,
      userId: actor.userId,
    };
    const operation = {
      actionId: `settings:${actor.authSessionId}:${toolkit}:${change}`,
      change,
      kind: "integration.connection.manage" as const,
      toolkit,
    };
    return this.#inspectSessionRecallAuthorization(identity).pipe(
      Effect.flatMap((facts) =>
        Effect.tryPromise({
          try: () =>
            runtime.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const database = yield* Db.database;
                  return yield* BillingDb.make(database).admit(facts.user.userId, facts.now);
                }),
              ),
            ),
          catch: settingsIntegrationUnavailable,
        }).pipe(
          Effect.flatMap((allowance) => {
            const result = authorization.admit(
              AuthorizationContext.make({
                allowance: { _tag: "Metered", ...allowance },
                approval: null,
                gmailConnection: null,
                integrationConnections: [],
                liveFacts: emptyLiveResourceFacts,
                originatingAuthority: { _tag: "AuthSession", authSessionId: actor.authSessionId },
                requestVendorUsdMicros: 0n,
                ...facts,
              }),
              operation,
            );
            return Predicate.isTagged(result, "Admitted")
              ? Effect.void
              : Effect.fail(settingsIntegrationUnavailable());
          }),
        ),
      ),
      Effect.mapError(settingsIntegrationUnavailable),
    );
  }

  /** Read the current and historical Session identities for one route. */
  async readRoute(
    routeId: string,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | ConversationRouteFound
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(ConversationRouteId)(routeId).pipe(
        Effect.mapError(() => invalidRequest("readRoute")),
        Effect.flatMap((parsed) => this.#store.readRoute(parsed)),
      ),
    );
  }

  /** Read Agent ownership and current Session facts for Authorization. */
  async readSessionAuthorizationFacts(
    routeId: string,
  ): Promise<
    | AgentRequestInvalid
    | SessionAuthorizationFactsFound
    | SessionLifecycleNotFound
    | SessionLifecycleUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(ConversationRouteId)(routeId).pipe(
        Effect.mapError(() => invalidRequest("readSessionAuthorizationFacts")),
        Effect.flatMap((parsed) => this.#sessionLifecycle.readAuthorizationFacts(parsed)),
      ),
    );
  }

  /** Read Think Session history for one Agent-owned Session. */
  async readSession(
    sessionId: string,
  ): Promise<
    | AgentRequestInvalid
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | SessionHistoryRead
    | ThinkSessionReadUnavailable
    | ThinkSessionRecordInvalid
  > {
    await this.#migrationsReady;
    const session = Session.create(this);
    const store = this.#store;
    return runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(SessionId)(sessionId).pipe(
          Effect.mapError(() => invalidRequest("readSession")),
        );
        const owned = yield* store.ownsSession(parsed);
        if (!owned) {
          return {
            _tag: "SessionHistoryNotFound",
            message: "The Think Session does not belong to this Agent",
          } as const;
        }
        const messages = yield* readThinkHistory(session, parsed);
        return {
          _tag: "SessionHistoryFound",
          messages,
          sessionId: parsed,
        } as const;
      }),
    );
  }

  async #availableIntegrationToolkits(
    userId: UserId,
  ): Promise<Capabilities.AvailabilityFacts["availableIntegrationToolkits"]> {
    const integrations = Option.getOrUndefined(this.#integrations);
    if (integrations === undefined) return [];
    const toolkitMappings = [
      { catalog: "gmail" as const, provider: "gmail" },
      { catalog: "google-calendar" as const, provider: "googlecalendar" },
      { catalog: "google-drive" as const, provider: "googledrive" },
    ];
    return Effect.runPromise(
      Effect.forEach(
        toolkitMappings,
        ({ catalog, provider }) =>
          integrations.connectionEvidence({ toolkit: provider, userId }).pipe(
            Effect.match({
              onFailure: () => [] as const,
              onSuccess: (evidence) =>
                evidence._tag === "IntegrationConnectionConnected" ? ([catalog] as const) : [],
            }),
          ),
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flat())),
    );
  }

  async #executeIntegrationRead(
    identity: IntegrationOperationIdentity,
    input: IntegrationToolInput,
    actionId: ActionId,
  ) {
    return Effect.runPromise(this.#executeIntegration(identity, input, actionId, undefined));
  }

  async #executeIntegrationEffect(
    identity: IntegrationOperationIdentity,
    input: IntegrationToolInput,
    actionId: ActionId,
  ) {
    const approvalRequired = true;
    const approved = approvalRequired ? this.#currentApprovedActions.get(actionId) : undefined;
    if (
      approvalRequired &&
      (approved?.operation !== "integration.effect" ||
        !hasExactIntegrationActionInput(approved.actionPresentation, identity.operation, input))
    ) {
      throw new IntegrationToolUnavailable({
        cause: actionId,
        message: "The current integration Approval does not match the protected effect",
        operation: identity.operation,
      });
    }
    return Effect.runPromise(
      this.#executeIntegration(identity, input, actionId, approved?.presentation),
    );
  }

  #executeIntegration(
    identity: IntegrationOperationIdentity,
    input: IntegrationToolInput,
    actionId: ActionId,
    presentation: ApprovalPresentation | undefined,
  ) {
    const integrations = Option.getOrUndefined(this.#integrations);
    if (integrations === undefined) {
      return Effect.fail(
        new IntegrationToolUnavailable({
          cause: "missing Composio configuration",
          message: "Integrations are unavailable in this environment",
          operation: identity.operation,
        }),
      );
    }
    return Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
      Effect.mapError(
        (cause) =>
          new IntegrationToolUnavailable({
            cause,
            message: "The active ToolCall has no trusted integration authority",
            operation: identity.operation,
          }),
      ),
      Effect.flatMap((metadata) =>
        integrations.execute({
          actionId,
          authorize: this.authorizeIntegration(metadata, identity, actionId, presentation),
          identity,
          input,
          userId: metadata.authorityIdentity.userId,
        }),
      ),
    );
  }

  protected authorizeIntegration(
    metadata: ManagedTurnMetadata,
    identity: IntegrationOperationIdentity,
    actionId: ActionId,
    presentation: ApprovalPresentation | undefined,
  ) {
    const resolved = resolveManifest(identity);
    if (Result.isFailure(resolved)) {
      return Effect.fail(
        new IntegrationToolUnavailable({
          cause: resolved.failure,
          message: "The integration operation is not in the retained manifest",
          operation: identity.operation,
        }),
      );
    }
    const operation = integrationAuthorizationOperation(resolved.success, actionId);
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return Effect.fail(
        new IntegrationToolUnavailable({
          cause: invalidOsfoEnvironment,
          message: "Current integration authorization has no valid Worker runtime",
          operation: identity.operation,
        }),
      );
    }
    return this.#inspectSessionRecallAuthorization(metadata.authorityIdentity).pipe(
      Effect.flatMap((facts) =>
        Effect.tryPromise({
          try: () =>
            runtime.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const database = yield* Db.database;
                  return yield* BillingDb.make(database).admit(facts.user.userId, facts.now);
                }),
              ),
            ),
          catch: (cause) =>
            new IntegrationToolUnavailable({
              cause,
              message: "Current integration allowance facts are unavailable",
              operation: identity.operation,
            }),
        }).pipe(
          Effect.flatMap((allowance) => {
            const { userId: _userId, ...originatingAuthority } = metadata.authorityIdentity;
            const result = authorization.admit(
              AuthorizationContext.make({
                allowance: { _tag: "Metered", ...allowance },
                approval:
                  presentation === undefined
                    ? null
                    : approvalFor(facts.user.userId, operation, presentation),
                ...facts,
                gmailConnection: null,
                integrationConnections: [
                  { _tag: "Connected", toolkit: identity.toolkit, userId: facts.user.userId },
                ],
                liveFacts: emptyLiveResourceFacts,
                originatingAuthority,
                requestVendorUsdMicros: 0n,
              }),
              operation,
            );
            return Predicate.isTagged(result, "Admitted")
              ? Effect.void
              : Effect.fail(
                  new IntegrationToolUnavailable({
                    cause: result,
                    message: "Current Osfo policy denied the integration operation",
                    operation: identity.operation,
                  }),
                );
          }),
        ),
      ),
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "IntegrationToolUnavailable")
          ? cause
          : new IntegrationToolUnavailable({
              cause,
              message: "Current integration authority facts are unavailable",
              operation: identity.operation,
            }),
      ),
    );
  }

  async #generateArtifact(intent: ArtifactGeneration.ArtifactIntent, toolCallId: string) {
    await this.#migrationsReady;
    const actionId = ActionId.make(toolCallId);
    const currentAuthorization = () =>
      this.#currentArtifactAuthorization(
        ArtifactGenerationComposition.conservativeArtifactVendorUsdMicros,
      );
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    return runtime.runPromise(
      this.#accountDeletionFence.run(
        Effect.scoped(
          Effect.gen(function* () {
            const currentContext = yield* currentAuthorization();
            const database = yield* Db.database;
            return yield* ArtifactGenerationComposition.make(
              env,
              database,
              currentAuthorization,
            ).generate({
              actionId,
              authorization: currentContext,
              intent,
              owner: { _tag: "ToolCall", toolCallId },
            });
          }),
        ),
        () =>
          new ArtifactGeneration.ArtifactAuthorizationUnavailable({
            cause: "account deletion fence",
            message: "Artifact generation is unavailable while account deletion is pending",
          }),
      ),
    );
  }

  async #revisePresentation(input: typeof RevisePresentationInput.Type, toolCallId: string) {
    await this.#migrationsReady;
    const actionId = ActionId.make(toolCallId);
    const currentAuthorization = () =>
      this.#currentArtifactAuthorization(
        ArtifactGenerationComposition.conservativeArtifactVendorUsdMicros,
      );
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    return runtime.runPromise(
      this.#accountDeletionFence.run(
        Effect.scoped(
          Effect.gen(function* () {
            const currentContext = yield* currentAuthorization();
            const database = yield* Db.database;
            return yield* ArtifactGenerationComposition.make(
              env,
              database,
              currentAuthorization,
            ).revise({
              actionId,
              authorization: currentContext,
              intent: { _tag: "Presentation", source: input.source },
              owner: { _tag: "ToolCall", toolCallId },
              sourceContentId: input.sourceContentId,
            });
          }),
        ),
        () =>
          new ArtifactGeneration.ArtifactAuthorizationUnavailable({
            cause: "account deletion fence",
            message: "Presentation revision is unavailable while account deletion is pending",
          }),
      ),
    );
  }

  async #exportArtifact(input: RetainedDocumentInput, toolCallId: string) {
    await this.#migrationsReady;
    const currentAuthorization = () => this.#currentArtifactAuthorization(0n);
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    const artifact = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const currentContext = yield* currentAuthorization();
          const database = yield* Db.database;
          return yield* ArtifactGenerationComposition.make(
            env,
            database,
            currentAuthorization,
          ).reference({
            actionId: ActionId.make(toolCallId),
            authorization: currentContext,
            contentId: input.contentId,
          });
        }),
      ),
    );
    return { artifact, delivery: "authenticated-retained-content" } as const;
  }

  async #deleteArtifact(input: RetainedDocumentInput, toolCallId: string) {
    await this.#migrationsReady;
    const actionId = ActionId.make(toolCallId);
    const approved = this.#currentApprovedActions.get(actionId);
    if (
      approved === undefined ||
      approved.operation !== "artifact.delete" ||
      !hasExactActionInput(approved.actionPresentation, "artifact.delete", input.contentId)
    ) {
      throw new ArtifactGeneration.ArtifactAuthorizationUnavailable({
        cause: actionId,
        message: "The approved artifact presentation is unavailable",
      });
    }
    const currentAuthorization = () =>
      this.#currentArtifactAuthorization(0n, {
        actionId,
        operation: "artifact.delete",
        presentation: approved.presentation,
      });
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const currentContext = yield* currentAuthorization();
          const database = yield* Db.database;
          return yield* ArtifactGenerationComposition.make(
            env,
            database,
            currentAuthorization,
          ).delete({ actionId, authorization: currentContext, contentId: input.contentId });
        }),
      ),
    );
    return { contentId: input.contentId, deleted: true } as const;
  }

  async #generateDocument(input: typeof GenerateDocumentInput.Type, toolCallId: string) {
    await this.#migrationsReady;
    const actionId = ActionId.make(toolCallId);
    const currentAuthorization = () =>
      this.#currentDocumentAuthorization(
        DocumentGenerationComposition.conservativeDocumentSandboxUsdMicros,
      );
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    return runtime.runPromise(
      this.#accountDeletionFence.run(
        Effect.scoped(
          Effect.gen(function* () {
            const currentContext = yield* currentAuthorization();
            const database = yield* Db.database;
            return yield* DocumentGenerationComposition.make(
              env,
              database,
              currentAuthorization,
            ).generate({
              actionId,
              authorization: currentContext,
              format: input.format,
              owner: { _tag: "ToolCall", toolCallId },
              source: input.source,
            });
          }),
        ),
        () =>
          new DocumentGeneration.DocumentAuthorizationUnavailable({
            cause: "account deletion fence",
            message: "Document generation is unavailable while account deletion is pending",
          }),
      ),
    );
  }

  async #exportDocument(input: RetainedDocumentInput, toolCallId: string) {
    await this.#migrationsReady;
    const currentAuthorization = () => this.#currentDocumentAuthorization(0n);
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    const artifact = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const currentContext = yield* currentAuthorization();
          const database = yield* Db.database;
          return yield* DocumentGenerationComposition.make(
            env,
            database,
            currentAuthorization,
          ).reference({
            actionId: ActionId.make(toolCallId),
            authorization: currentContext,
            contentId: input.contentId,
          });
        }),
      ),
    );
    // The model receives only the immutable reference. An authenticated HTTP boundary
    // delivers the bytes after it checks the current User and session again.
    return { artifact, delivery: "authenticated-retained-content" } as const;
  }

  async #deleteDocument(input: RetainedDocumentInput, toolCallId: string) {
    await this.#migrationsReady;
    const actionId = ActionId.make(toolCallId);
    const approved = this.#currentApprovedActions.get(actionId);
    if (
      approved === undefined ||
      approved.operation !== "file.delete" ||
      !hasExactActionInput(approved.actionPresentation, "file.delete", input.contentId)
    ) {
      throw new DocumentGeneration.DocumentAuthorizationUnavailable({
        cause: actionId,
        message: "The approved document presentation is unavailable",
      });
    }
    const currentAuthorization = () =>
      this.#currentDocumentAuthorization(0n, {
        actionId,
        operation: "file.delete",
        presentation: approved.presentation,
      });
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) throw invalidOsfoEnvironment;
    const env = this.env;
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const currentContext = yield* currentAuthorization();
          const database = yield* Db.database;
          return yield* DocumentGenerationComposition.make(
            env,
            database,
            currentAuthorization,
          ).delete({
            actionId,
            authorization: currentContext,
            contentId: input.contentId,
          });
        }),
      ),
    );
    return { contentId: input.contentId, deleted: true } as const;
  }

  #currentArtifactAuthorization(
    requestVendorUsdMicros: bigint,
    approval?: {
      readonly actionId: ActionId;
      readonly operation: "artifact.delete";
      readonly presentation: ApprovalPresentation;
    },
  ) {
    // oxlint-disable-next-line effecttsgo/prefer-typed-schema-decoder -- Agent metadata is optional and supplied by the external Think boundary.
    return Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactGeneration.ArtifactAuthorizationUnavailable({
            cause,
            message: "The active ToolCall has no trusted provider authority identity",
          }),
      ),
      Effect.flatMap((metadata) => {
        const authority = metadata.authorityIdentity;
        if (authority._tag === "ChannelLink") {
          return this.#inspectCurrentChannelLinkAuthorization(authority).pipe(
            Effect.mapError(
              (cause) =>
                new ArtifactGeneration.ArtifactAuthorizationUnavailable({
                  cause,
                  message: "Current artifact authorization facts could not be loaded",
                }),
            ),
          );
        }
        return Effect.fail(
          new ArtifactGeneration.ArtifactAuthorizationUnavailable({
            cause: { authority: authority._tag },
            message: "The active ToolCall has no channel authority",
          }),
        );
      }),
      Effect.map((currentContext) =>
        AuthorizationContext.make({
          ...currentContext,
          approval:
            approval === undefined
              ? null
              : approvalFor(
                  currentContext.user.userId,
                  { actionId: approval.actionId, kind: approval.operation },
                  approval.presentation,
                ),
          requestVendorUsdMicros,
        }),
      ),
    );
  }

  #currentDocumentAuthorization(
    requestVendorUsdMicros: bigint,
    approval?: {
      readonly actionId: ActionId;
      readonly operation: "file.delete";
      readonly presentation: ApprovalPresentation;
    },
  ) {
    // oxlint-disable-next-line effecttsgo/prefer-typed-schema-decoder -- Agent metadata is optional and supplied by the external Think boundary.
    return Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
      Effect.mapError(
        (cause) =>
          new DocumentGeneration.DocumentAuthorizationUnavailable({
            cause,
            message: "The active ToolCall has no trusted provider authority identity",
          }),
      ),
      Effect.flatMap((metadata) => {
        const authority = metadata.authorityIdentity;
        if (authority._tag === "ChannelLink") {
          return this.#inspectCurrentChannelLinkAuthorization(authority).pipe(
            Effect.mapError(
              (cause) =>
                new DocumentGeneration.DocumentAuthorizationUnavailable({
                  cause,
                  message: "Current document authorization facts could not be loaded",
                }),
            ),
          );
        }
        return Effect.fail(
          new DocumentGeneration.DocumentAuthorizationUnavailable({
            cause: { authority: authority._tag },
            message: "The active ToolCall has no channel authority",
          }),
        );
      }),
      Effect.map((currentContext) =>
        AuthorizationContext.make({
          ...currentContext,
          approval:
            approval === undefined
              ? null
              : approvalFor(
                  currentContext.user.userId,
                  { actionId: approval.actionId, kind: approval.operation },
                  approval.presentation,
                ),
          requestVendorUsdMicros,
        }),
      ),
    );
  }

  /** Record terminal evidence after Think commits an assistant response. */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    await this.#migrationsReady;
    const assistantMessageId = AssistantMessageId.make(result.message.id);
    const thinkRequestId = ThinkRequestId.make(result.requestId);
    const activeTurn = Schema.decodeUnknownOption(ManagedTurnMetadata)(this.activeTurnMetadata);
    const terminal = Option.isNone(activeTurn)
      ? CommittedTurnTerminal.make({ requestId: thinkRequestId, status: result.status })
      : CommittedTurnTerminal.make({
          attribution: {
            allowancePeriodId: activeTurn.value.allowancePeriodId,
            executionMode: activeTurn.value.executionMode ?? "normalPlanUsage",
            sessionId: activeTurn.value.sessionId,
            userId: activeTurn.value.authorityIdentity.userId,
          },
          requestId: thinkRequestId,
          status: result.status,
          submissionId: activeTurn.value.submissionId,
        });
    await Effect.runPromise(
      persistThinkTerminalBeforeCapture(
        () =>
          this.updateMessageInHistory({
            ...result.message,
            metadata: withCommittedTurnTerminal(result.message.metadata, terminal),
          }),
        this.#findThinkMessageOwner(assistantMessageId, thinkRequestId).pipe(
          Effect.tap((sessionId) =>
            readThinkHistory(Session.create(this), sessionId).pipe(
              Effect.flatMap((history) =>
                this.#store.recordCommittedTurn(
                  {
                    assistantMessageId,
                    sessionId,
                    source: "hook",
                    thinkRequestId,
                  },
                  result.status === "completed" &&
                    !(
                      Option.isSome(activeTurn) &&
                      activeTurn.value.executionMode === "exhaustedConversation"
                    )
                    ? Option.getOrUndefined(
                        projectCommittedConversationSnapshot(
                          history,
                          assistantMessageId,
                          sessionId,
                        ),
                      )
                    : undefined,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    if (result.status === "completed") {
      this.ctx.waitUntil(
        Effect.runPromise(
          Effect.tryPromise({
            try: () => this.#evaluateGoodRootOutcome(assistantMessageId),
            catch: (cause) => ({ _tag: "GoodRootEvaluationUnavailable" as const, cause }),
          }).pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Good Root evaluation was isolated from the committed turn").pipe(
                Effect.annotateLogs({ failure: failure._tag }),
              ),
            ),
          ),
        ),
      );
      this.ctx.waitUntil(this.#reconcileMemoryProviderOutboxOrSchedule());
    }
  }

  /** Read idempotent committed-turn references owned by this Agent. */
  async readCommittedTurns(): Promise<
    | AgentStoreUnavailable
    | AgentStoreRecordInvalid
    | CommittedTurnConflict
    | ReadonlyArray<CommittedTurnReceipt>
    | ThinkSessionReadUnavailable
    | ThinkSessionRecordInvalid
  > {
    await this.#migrationsReady;
    return runRpc(
      this.#reconcileCommittedTurns().pipe(Effect.andThen(this.#store.readCommittedTurns)),
    );
  }

  /** Return the technical runtime identity for local smoke verification. */
  probeRuntime(): Promise<RuntimeProbeResult> {
    return Option.match(this.#runtime, {
      onNone: () => Promise.resolve(invalidOsfoEnvironment),
      onSome: (runtime) => runtime.runPromise(probeExecutionUnit),
    });
  }

  async #activateCurrentSession(): Promise<void> {
    await this.#migrationsReady;
    const current = await Effect.runPromise(this.#readOptionalPrimarySessionId());
    this.session = await this.#configureSession(
      Session.create(this),
      Option.getOrElse(current, () => pendingSessionId),
    );
    await this.#finishSessionActivation();
  }

  async #activateSession(sessionId: SessionId): Promise<void> {
    await this.#migrationsReady;
    this.session = await this.#configureSession(Session.create(this), sessionId);
    await this.#finishSessionActivation();
  }

  async #finishSessionActivation(): Promise<void> {
    this.session.internal_onMessagesChanged(async () => {
      await this.syncMessagesFromStorage();
    });
    await this.syncMessagesFromStorage();
  }

  #readOptionalPrimarySessionId() {
    return this.#store.readPrimarySessionId().pipe(
      Effect.map(Option.some),
      Effect.catchTag("AgentStateNotFound", () => Effect.succeed(Option.none<SessionId>())),
    );
  }

  #dispatchModelCallUsage(
    usage: PendingModelCallUsage,
  ): Effect.Effect<void, ModelCallUsageDispatchUnavailable> {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) return Effect.fail(modelCallUsageDispatchUnavailable(usage));
    return Effect.tryPromise({
      try: () =>
        runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const database = yield* Db.database;
              const allowances = Allowances.make({
                billing: BillingDb.make(database),
                catalog: retainedCatalog,
                now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
              });
              yield* allowances.record(
                usage.allowancePeriodId,
                { sourceId: usage.attemptId, sourceType: "ModelCallAttempt" },
                usage.items,
              );
            }),
          ),
        ),
      catch: () => modelCallUsageDispatchUnavailable(usage),
    });
  }

  #recordFileAllowance(
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return new FileCapabilityUnavailable({
        cause: invalidOsfoEnvironment,
        message: "File allowance recording has no valid Worker runtime",
        operation: "recordAllowance",
      });
    }
    return Effect.tryPromise({
      try: () =>
        runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const database = yield* Db.database;
              const allowances = Allowances.make({
                billing: BillingDb.make(database),
                catalog: retainedCatalog,
                now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
              });
              return yield* allowances.record(allowancePeriodId, source, items);
            }),
          ),
        ),
      catch: (cause) =>
        new FileCapabilityUnavailable({
          cause,
          message: "File allowance recording is unavailable",
          operation: "recordAllowance",
        }),
    });
  }

  #currentFileAuthorizationContext(
    context: AuthorizationContext,
  ): Effect.Effect<AuthorizationContext, FileCapabilityUnavailable> {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return Effect.fail(
        new FileCapabilityUnavailable({
          cause: invalidOsfoEnvironment,
          message: "Current file authorization has no valid Worker runtime",
          operation: "readCurrentAuthorization",
        }),
      );
    }
    const agentId = AgentId.make(this.name);
    const config = loadConfig(this.env);
    return Effect.tryPromise({
      try: () =>
        runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
              const database = yield* Db.database;
              const channelLinks = yield* ChannelLinks.Service;
              return yield* loadCurrentFileAuthorization(
                database,
                channelLinks,
                agentId,
                context,
                now,
              );
            }).pipe(
              // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The captured runtime supplies Db and Crypto while this layer supplies request configuration.
              Effect.provide(ChannelLinks.layerFromConfig(config)),
            ),
          ),
        ),
      catch: (cause) =>
        new FileCapabilityUnavailable({
          cause,
          message: "Current file authorization facts are unavailable",
          operation: "readCurrentAuthorization",
        }),
    });
  }

  async #readStepEvidence(
    metadata: ManagedTurnMetadata,
    stepNumber: ModelStepNumber,
    step: StepContext,
  ) {
    const logId = readAiGatewayLogId(step.response.headers, step.providerMetadata);
    if (Option.isNone(logId)) {
      return {
        _tag: "StepEvidenceReady" as const,
        evidence: conservativeStepEvidence(metadata, stepNumber),
      };
    }
    const cost = await this.#readGatewayVendorCost(logId.value);
    if (Option.isNone(cost)) {
      return {
        _tag: "GatewayCostPending" as const,
        settlement: GatewayCostSettlement.make({
          allowancePeriodId: metadata.allowancePeriodId,
          attemptId: modelCallAttemptId(metadata.submissionId, stepNumber),
          conservativeVendorUsdMicros: Number(
            conservativeStepEvidence(metadata, stepNumber).conservativeVendorUsdMicros,
          ),
          gatewayLogId: logId.value,
          lookupAttempt: 1,
        }),
      };
    }
    return {
      _tag: "StepEvidenceReady" as const,
      evidence: {
        _tag: "Observed" as const,
        vendorUsdMicros: cost.value,
      },
    };
  }

  async #readGatewayVendorCost(logId: string): Promise<Option.Option<bigint>> {
    const read = await Effect.runPromise(
      Effect.option(
        Effect.tryPromise({
          try: () => this.env.AI.gateway(gatewayId).getLog(logId),
          catch: () => undefined,
        }),
      ),
    );
    if (Option.isNone(read)) return Option.none();
    const log = read.value;
    return log.cost === undefined || !Number.isFinite(log.cost) || log.cost < 0
      ? Option.none()
      : Option.some(BigInt(Math.ceil(log.cost * 1_000_000)));
  }

  async #scheduleGatewayCostSettlement(settlement: GatewayCostSettlement): Promise<void> {
    const delaySeconds = 10 * 3 ** (settlement.lookupAttempt - 1);
    await this.schedule(delaySeconds, "settleGatewayModelUsage", settlement, {
      idempotent: true,
      retry: { baseDelayMs: 500, maxAttempts: 3, maxDelayMs: 5_000 },
    });
  }

  async #scheduleModelCallUsageReconciliation(): Promise<void> {
    await this.schedule(modelCallUsageRetryDelaySeconds, "reconcileModelCallUsage", undefined, {
      idempotent: true,
      retry: { baseDelayMs: 500, maxAttempts: 3, maxDelayMs: 5_000 },
    });
  }

  async #scheduleMemoryProviderReconciliation(): Promise<void> {
    await this.schedule(
      memoryProviderRetryDelaySeconds,
      "reconcileMemoryProviderOutbox",
      undefined,
      {
        idempotent: true,
        retry: { baseDelayMs: 500, maxAttempts: 3, maxDelayMs: 5_000 },
      },
    );
  }

  async #reconcileMemoryProviderOutboxOrSchedule(
    conversationStatusRetryMilliseconds?: number,
  ): Promise<void> {
    await this.#serializeMemoryProviderWork(() =>
      this.#runMemoryProviderReconciliationOrSchedule(conversationStatusRetryMilliseconds),
    );
  }

  #serializeMemoryProviderWork<A>(work: () => Promise<A>): Promise<A> {
    return Effect.runPromise(
      this.#memoryProviderReconciliationQueue.run(
        Effect.tryPromise({
          try: work,
          catch: (cause) =>
            new MemoryProviderWorkUnavailable({
              cause,
              message: "Serialized Memory Provider work rejected at the Think Promise boundary",
            }),
        }),
      ),
    );
  }

  async #runMemoryProviderReconciliationOrSchedule(
    conversationStatusRetryMilliseconds?: number,
  ): Promise<void> {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime !== undefined) {
      try {
        const baseOptions: ReconciliationOptions = {
          authorizeDeletion: (deletion) => this.#authorizeProviderDeletion(deletion),
          canSaveConversation: (userId) => this.#canSaveProviderConversation(userId),
          prepareDeletion: (claim) => this.#prepareProviderDeletion(claim),
          runSaveConversation: this.#providerConversationSaveGate.runSave,
        };
        const options =
          conversationStatusRetryMilliseconds === undefined
            ? baseOptions
            : { ...baseOptions, conversationStatusRetryMilliseconds };
        await runtime.runPromise(
          Effect.scoped(reconcileMemoryProviderOutbox(this.#memoryProviderOutbox, options)),
        );
      } catch (cause) {
        await Effect.runPromise(
          Effect.logError("MemoryProvider outbox reconciliation failed").pipe(
            Effect.annotateLogs({ cause, failureTag: "MemoryProviderOutboxReconciliationFailure" }),
          ),
        );
      }
    }
    if (await Effect.runPromise(this.#memoryProviderOutbox.hasRetryableWork)) {
      await this.#scheduleMemoryProviderReconciliation();
    }
  }

  async #reconcileModelCallUsageOrSchedule(): Promise<void> {
    await Effect.runPromise(
      this.#modelCallUsage.reconcile.pipe(
        Effect.catch(() =>
          Effect.promise(() => this.#scheduleModelCallUsageReconciliation()).pipe(
            Effect.andThen(
              Effect.logError("Model-call usage reconciliation remains pending").pipe(
                Effect.annotateLogs({
                  failureTag: "ModelCallUsageReconciliationFailure",
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  #userOwnsAgent(userId: UserId) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return Effect.fail(approvalActorAuthorizationUnavailable(userId, invalidOsfoEnvironment));
    }
    return Effect.tryPromise({
      try: () =>
        runtime.runPromise(
          Effect.scoped(
            AgentDirectory.make.pipe(
              Effect.flatMap((directory) =>
                directory.resolveAgent(AgentId.make(this.name)).pipe(
                  Effect.map((route) => route.userId === userId),
                  Effect.catchTag("AgentOwnerNotFound", () => Effect.succeed(false)),
                ),
              ),
            ),
          ),
        ),
      catch: (cause) => approvalActorAuthorizationUnavailable(userId, cause),
    });
  }

  async #resolveMessengerLink(messengerId: string, authorId: string) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return { _tag: "Unavailable" } as const;
    }
    const result = await Effect.runPromiseExit(
      Effect.promise(() => {
        const config = loadConfig(this.env);
        return runtime.runPromise(
          Effect.scoped(
            ChannelLinks.Service.pipe(
              Effect.flatMap((channelLinks) =>
                channelLinks.resolve(
                  ChannelLinks.ChannelAddress.make({
                    authorId: ChannelLinks.ChannelAuthorId.make(authorId),
                    channelId: ChannelLinks.ChannelId.make(messengerId),
                  }),
                ),
              ),
              // The messenger Agent method is the request entry point that owns this scoped authority layer.
              // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The captured runtime supplies Db and Crypto while this layer supplies request configuration.
              Effect.provide(ChannelLinks.layerFromConfig(config)),
            ),
          ),
        );
      }),
    );
    if (Exit.isSuccess(result)) {
      return { _tag: "Resolved", link: result.value } as const;
    }
    return { _tag: "Unavailable" } as const;
  }

  #inspectCurrentChannelLinkAuthorization(link: {
    readonly address: typeof ChannelLinks.ChannelAddress.Type;
    readonly channelLinkId: ChannelLinkId;
    readonly userId: UserId;
  }) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return Effect.fail(
        new ChannelLinkAuthorizationPostgres.ChannelLinkAuthorizationUnavailable({
          cause: invalidOsfoEnvironment,
          message: "Current Channel Link authorization could not be checked",
        }),
      );
    }
    const config = loadConfig(this.env);
    return Effect.tryPromise({
      try: () =>
        runtime.runPromise(
          Effect.scoped(
            ChannelLinkAuthorizationPostgres.make.pipe(
              Effect.flatMap((currentAuthorization) =>
                currentAuthorization.admit({ agentId: AgentId.make(this.name), ...link }),
              ),
              // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This messenger request entry point supplies Channel Links policy to the captured runtime.
              Effect.provide(ChannelLinks.layerFromConfig(config)),
            ),
          ),
        ),
      catch: (cause) =>
        Predicate.isTagged(cause, "ChannelLinkAuthorizationUnavailable")
          ? cause
          : new ChannelLinkAuthorizationPostgres.ChannelLinkAuthorizationUnavailable({
              cause,
              message: "Current Channel Link authorization could not be checked",
            }),
    });
  }

  async #recordMessengerAcceptedMessage(
    currentAuthorization: AuthorizationContext,
    provider: ChannelProvider,
    providerMessageId: string,
  ): Promise<boolean> {
    if (currentAuthorization.allowance._tag !== "Metered") return false;
    const allowancePeriodId = currentAuthorization.allowance.allowancePeriodId;
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) return false;
    const result = await runtime.runPromiseExit(
      Effect.scoped(
        Db.database.pipe(
          Effect.flatMap((database) =>
            Allowances.make({
              billing: BillingDb.make(database),
              catalog: retainedCatalog,
              now: Effect.succeed(currentAuthorization.now),
            }).record(
              allowancePeriodId,
              {
                sourceId: `${provider}:${providerMessageId}`,
                sourceType: "acceptanceReceipt",
              },
              [
                {
                  allowanceKind: "acceptedMessages",
                  basis: "known_at_start",
                  quantity: 1n,
                },
              ],
            ),
          ),
          Effect.asVoid,
        ),
      ),
    );
    if (Exit.isSuccess(result)) return true;
    const failureTag = Option.match(Cause.findErrorOption(result.cause), {
      onNone: () => "DefectOrInterruption",
      onSome: (failure) => failure._tag,
    });
    await Effect.runPromise(
      Effect.logError("Messenger allowance reservation failed").pipe(
        Effect.annotateLogs({ failureTag }),
      ),
    );
    return false;
  }

  async #completeMessengerPolicyReply(
    callback: StreamCallback,
    context: MessengerContext,
    text: string,
  ): Promise<void> {
    const requestId = `policy:${context.message?.providerMessageId ?? context.thread.id}`;
    await callback.onStart({ requestId });
    await callback.onEvent(JSON.stringify({ delta: text, id: requestId, type: "text-delta" }));
    await callback.onDone();
  }

  #inspectSessionRecallAuthorization(identity: ManagedTurnAuthorityIdentity) {
    const runtime = Option.getOrUndefined(this.#runtime);
    if (runtime === undefined) {
      return Effect.fail(
        new SessionRecallAuthorizationUnavailable({
          cause: invalidOsfoEnvironment,
          message: "Current Session Recall authorization facts are unavailable",
        }),
      );
    }
    const config = loadConfig(this.env);
    return Effect.tryPromise({
      try: (signal) =>
        runtime.runPromise(
          Effect.scoped(
            SessionRecallAuthorizationPostgres.inspect(AgentId.make(this.name), identity).pipe(
              // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Recall request entry point supplies Channel Links policy to the captured runtime.
              Effect.provide(ChannelLinks.layerFromConfig(config)),
            ),
          ),
          { signal },
        ),
      catch: (cause) =>
        new SessionRecallAuthorizationUnavailable({
          cause,
          message: "Current Session Recall authorization facts are unavailable",
        }),
    });
  }

  #findThinkMessageOwner(assistantMessageId: AssistantMessageId, thinkRequestId: ThinkRequestId) {
    const makeSession = () => Session.create(this);
    const store = this.#store;
    return Effect.gen(function* () {
      const sessionIds = yield* store.readSessionIds;
      const matches = yield* Effect.forEach(
        sessionIds,
        (sessionId) =>
          readThinkMessage(makeSession(), sessionId, assistantMessageId).pipe(
            Effect.map((message) => (message === null ? null : sessionId)),
          ),
        { concurrency: 1 },
      );
      const owners = matches.filter((sessionId): sessionId is SessionId => sessionId !== null);
      const owner = owners[0];
      if (owner === undefined) {
        return yield* new AgentStateNotFound({
          message: "The committed assistant message does not belong to an Agent Session",
          subject: "session",
        });
      }
      if (owners.length > 1) {
        const conflictingOwner = owners.at(1) ?? owner;
        return yield* new CommittedTurnConflict({
          assistantMessageId,
          existingAssistantMessageId: assistantMessageId,
          existingSessionId: owner,
          existingThinkRequestId: thinkRequestId,
          message: "The assistant message appears in more than one Think Session",
          sessionId: conflictingOwner,
          thinkRequestId,
        });
      }
      return owner;
    });
  }

  #reconcileCommittedTurns(): Effect.Effect<
    void,
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CommittedTurnConflict
    | ThinkSessionReadUnavailable
    | ThinkSessionRecordInvalid
  > {
    return this.#store.readSessionIds.pipe(
      Effect.flatMap((sessionIds) =>
        Effect.forEach(
          sessionIds,
          (sessionId) =>
            readThinkHistory(Session.create(this), sessionId).pipe(
              Effect.flatMap((messages) =>
                Effect.forEach(
                  projectTerminalMarkedCommittedTurns(messages, sessionId),
                  ({ assistantMessageId, projection, terminal }) =>
                    this.#store.recordCommittedTurn(
                      {
                        assistantMessageId,
                        sessionId,
                        source: "reconciliation",
                        thinkRequestId: terminal.requestId,
                      },
                      projection,
                    ),
                  { concurrency: 1, discard: true },
                ),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    );
  }
}

const integrationAuthorizationOperation = (
  manifest: ResolvedIntegrationManifestOperation,
  actionId: ActionId,
): AuthorizationOperation => {
  if (manifest.operationKind === "effect") {
    return {
      actionId,
      kind: "integration.effect",
      manifestVersion: manifest.manifestVersion,
      providerOperation: manifest.operation,
      toolkit: manifest.toolkit,
    };
  }
  const exhausted = manifest.exhaustedMode;
  const windowDays =
    exhausted?._tag === "CalendarEvents" || exhausted?._tag === "Availability"
      ? BigInt(exhausted.windowDays)
      : undefined;
  const operation: AuthorizationOperation = {
    actionId,
    attachments: 0n,
    deadlineMilliseconds: BigInt(requestTimeoutForIntegrationMillis),
    kind: "integration.read",
    manifestVersion: manifest.manifestVersion,
    pagination: 0n,
    providerExecutions: BigInt(manifest.hardBounds.providerExecutions),
    providerOperation: manifest.operation,
    records: BigInt(manifest.hardBounds.maximumRecords),
    responseBytes: manifest.hardBounds.maximumResponseBytes,
    toolkit: manifest.toolkit,
  };
  if (windowDays === undefined) return operation;
  return { ...operation, windowDays };
};

type SessionLifecycleStoreSourceFailure =
  | AgentStateNotFound
  | AgentStoreRecordInvalid
  | AgentStoreUnavailable;

const sessionLifecycleStoreFailure = (
  operation: "inspect" | "readRoute",
  failure: SessionLifecycleStoreSourceFailure,
): SessionLifecycleNotFound | SessionLifecycleUnavailable =>
  Predicate.isTagged(failure, "AgentStateNotFound")
    ? new SessionLifecycleNotFound({
        message: failure.message,
        subject: failure.subject === "agent" ? "agent" : "route",
      })
    : new SessionLifecycleUnavailable({
        cause: failure,
        message: "Agent-owned Session lifecycle storage is unavailable",
        operation,
      });

const sessionRecallStoreFailure = (
  failure: SessionLifecycleStoreSourceFailure,
): SessionLifecycleNotFound | SessionRecallStoreUnavailable =>
  Predicate.isTagged(failure, "AgentStateNotFound")
    ? new SessionLifecycleNotFound({
        message: failure.message,
        subject: failure.subject === "agent" ? "agent" : "route",
      })
    : new SessionRecallStoreUnavailable({
        cause: failure,
        message: "Agent-owned Session Recall storage is unavailable",
      });

const invalidRequest = (operation: AgentRequestOperation): AgentRequestInvalid =>
  new AgentRequestInvalid({
    message: "The Agent RPC input is invalid",
    operation,
  });

/** Derive one stable, schema-valid Think submission identity from provider message identity. */
export const messengerSubmissionId = async (
  provider: "telegram" | "whatsapp",
  threadId: string,
  providerMessageId: string,
): Promise<ThinkSubmissionId> => {
  const bytes = new TextEncoder().encode(`${provider}\u0000${threadId}\u0000${providerMessageId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return ThinkSubmissionId.make(`messenger-${hex}`);
};

const modelCallUsageDispatchUnavailable = (usage: PendingModelCallUsage) =>
  new ModelCallUsageDispatchUnavailable({
    attemptId: usage.attemptId,
    message: "Durable model-call evidence has not reached Allowances",
  });

const callThinkSubmission = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ThinkSubmissionUnavailable({
        cause,
        message: "Think Submission storage is unavailable",
        operation,
      }),
  });

const approvalActorAuthorizationUnavailable = (userId: UserId, cause: unknown) =>
  new ApprovalActorAuthorizationUnavailable({
    cause,
    message: "The Agent owner could not be checked",
    userId,
  });

const sessionDeletionFailure = (message: string) => (cause: unknown) =>
  new DeletionActionUnavailable({ cause, message, operation: "deleteSession" });

const conservativeStepEvidence = (metadata: ManagedTurnMetadata, stepNumber: ModelStepNumber) => {
  const maximum = BigInt(metadata.conservativeVendorUsdMicros);
  return {
    _tag: "Ambiguous" as const,
    conservativeVendorUsdMicros: conservativeVendorCostForStep(
      maximum,
      metadata.maxSteps,
      stepNumber,
    ),
  };
};

const HeaderRecord = Schema.Record(Schema.String, Schema.String);

const readAiGatewayLogId = (
  headers: StepContext["response"]["headers"],
  providerMetadata: StepContext["providerMetadata"],
): Option.Option<string> => {
  const decodedHeaders = Schema.decodeUnknownOption(HeaderRecord)(headers);
  if (Option.isSome(decodedHeaders)) {
    const entry = Object.entries(decodedHeaders.value).find(
      ([name]) => name.toLowerCase() === "cf-aig-log-id",
    );
    if (entry !== undefined && entry[1].length > 0) return Option.some(entry[1]);
  }
  return Option.flatMap(
    Schema.decodeUnknownOption(GatewayProviderMetadata)(providerMetadata),
    (metadata) => Option.fromNullishOr(metadata.cloudflare?.aiGatewayLogId),
  );
};

const summarizeManagedSession = (prompt: string): Promise<string> => {
  const initialMarker = "CONVERSATION TO SUMMARIZE:\n";
  const updateMarker = "PREVIOUS SUMMARY:\n";
  const startMarker = prompt.includes(initialMarker) ? initialMarker : updateMarker;
  const start = prompt.indexOf(startMarker);
  const bodyStart = start < 0 ? 0 : start + startMarker.length;
  const initialEnd = prompt.indexOf("\n\nUse this structure:", bodyStart);
  const updateEnd = prompt.indexOf("\n\nUpdate the summary.", bodyStart);
  const bodyEnd = initialEnd >= 0 ? initialEnd : updateEnd >= 0 ? updateEnd : prompt.length;
  return Promise.resolve(
    `[Earlier conversation]\n${prompt.slice(bodyStart, bodyEnd).slice(-8_000)}`,
  );
};

const capabilityTurnOrigin = (identity: ManagedTurnAuthorityIdentity): Capabilities.TurnOrigin => {
  if (identity._tag === "AuthSession") return "authSession";
  if (identity._tag === "ChannelLink") return "channelLink";
  return identity.triggerType;
};

const readThinkHistory = (session: Session, sessionId: SessionId) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ThinkSessionReadUnavailable({
        cause,
        message: "Think Session history is unavailable",
        sessionId,
      }),
    try: () => session.forSession(sessionId).getHistory(),
  }).pipe(
    Effect.flatMap((messages) =>
      Schema.decodeUnknownEffect(Schema.Array(SessionHistoryMessage))(messages).pipe(
        Effect.mapError(
          () =>
            new ThinkSessionRecordInvalid({
              message: "Think Session history contains an invalid message",
              sessionId,
            }),
        ),
      ),
    ),
  );

const readThinkMessage = (
  session: Session,
  sessionId: SessionId,
  assistantMessageId: AssistantMessageId,
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ThinkSessionReadUnavailable({
        cause,
        message: "Think Session message lookup is unavailable",
        sessionId,
      }),
    try: () => session.forSession(sessionId).getMessage(assistantMessageId),
  }).pipe(
    Effect.flatMap((message) =>
      Schema.decodeUnknownEffect(Schema.NullOr(SessionHistoryMessage))(message).pipe(
        Effect.mapError(
          () =>
            new ThinkSessionRecordInvalid({
              message: "Think Session message lookup returned an invalid message",
              sessionId,
            }),
        ),
      ),
    ),
  );

const runRpc = <A, E>(effect: Effect.Effect<A, E>): Promise<A | E> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: (value) => value,
      }),
    ),
  );

const currentDbTimestamp = DateTime.now.pipe(
  Effect.map((time) => Db.DbTimestamp.make(DateTime.toDateUtc(time).toISOString())),
);

const settingsIntegrationUnavailable = () =>
  new IntegrationToolUnavailable({
    cause: "settings integration boundary",
    message: "Integration connections are temporarily unavailable",
    operation: "integration.connection.manage",
  });

const deletionApprovalUnavailable = (
  actionId: ActionId,
  operation: "forgetKnowledge" | "deleteSession",
) =>
  new DeletionActionUnavailable({
    cause: actionId,
    message: "Current deletion Approval does not match the requested target",
    operation,
  });
