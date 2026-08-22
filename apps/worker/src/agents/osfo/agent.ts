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
  type StepContext,
  type SubmitMessagesResult,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import type { MessengerContext } from "@cloudflare/think/messengers";
import { tool, type ToolSet, type UIMessage } from "ai";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { Cause, DateTime, Effect, Exit, Option, Predicate, Result, Schema } from "effect";

import type { ChannelLinkId, UserId } from "../../domain";
import type { AllowanceItem, AllowanceSource } from "../../domain/allowance";
import {
  AgentId,
  AllowancePeriodId,
  AssistantMessageId,
  ConversationRouteId,
  SessionId,
  ThinkSubmissionId,
  ThinkRequestId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import { DocumentGenerationComposition } from "../../composition/document-generation";
import { Db } from "../../db";
import { BillingDb } from "../../db/billing";
import { decodeOsfoStage, loadConfig } from "../../config";
import { ChannelLinkAuthorizationPostgres } from "../../integrations/postgres/channel-link-authorization";
import { SessionRecallAuthorizationPostgres } from "../../integrations/postgres/session-recall-authorization";
import {
  CancelManagedConversationInput,
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
import { currentPolicy, retainedCatalog, type PlanPolicyNotFound } from "../../domain/plan-policy";
import { FileAnalysisId, FileId, FileName, FileUploadId } from "../../domain/file";
import { makeCloudflareFileCompute } from "../../integrations/cloudflare/file-compute";
import {
  type FileObjectMetadataInvalid,
  type FileObjectStoreUnavailable,
  makeR2FileObjects,
} from "../../integrations/cloudflare/file-objects";
import { loadCurrentFileAuthorization } from "../../integrations/postgres/file-authorization";
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
  type FileAnalysisConflict,
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
} from "./core-memory";
import { Allowances } from "../../services/allowances";
import { makeActionApprovals } from "../../services/action-approvals";
import {
  Authorization,
  restoreCoreMemoryAuthorization,
  type ApprovalRequired,
  AuthorizationContext,
  type Denied,
} from "../../services/authorization";
import { DocumentGeneration } from "../../services/document-generation";
import { makeDurableModelCallUsage } from "../../services/model-call-usage";
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
  type AgentStoreUnavailable,
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
  ActionPresentation,
  type ActionPresentationFound,
  ActionPresentationId,
  type ActionPresentationNotFound,
  ActionPresentationUnavailable,
  ActionApprovalRequestInvalid,
  ApprovalActorAuthorizationUnavailable,
  type ApprovalActor,
  ApprovalActorUnauthorized,
  type ApprovalAlreadyResolved,
  type ApprovalDecisionAccepted,
  CancelActionApprovalRequest,
  DecideActionApprovalRequest,
  makeThinkActionApprovalAdapter,
  ReadActionPresentationRequest,
  type ThinkApprovalUnavailable,
} from "./think-action-approvals";
import {
  coreMemoryClearActionName,
  makeOsfoActions,
  presentOsfoAction,
  sanitizePendingApproval,
} from "./action-registry";
import { CoreMemoryAuthorizationSnapshot } from "../../domain/core-memory-authorization";
import { makeAgentSessionLifecycle } from "./session-lifecycle";
import { makeSessionRecallTools, makeThinkSessionRecallSearch } from "./session-recall";
import { effectToolSchema } from "./effect-tool-schema";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Cloudflare Agent RPC and lifecycle hooks require Promise boundaries, and Effect results use _tag. */

const pendingSessionId = "__osfo_uninitialized__";
const gatewayId = "default";
const modelCallUsageRetryDelaySeconds = 60;
const gatewayCostMaximumLookups = 3;
const authorization = Authorization.make(retainedCatalog);

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
const RetainedDocumentInput = Schema.Struct({ contentId: ContentId });
const documentDeleteActionName = "deleteDocument";

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
const SessionHistoryMessagePart = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

/** Osfo-owned boundary shape for one message returned from Think Session history. */
export const SessionHistoryMessage = Schema.StructWithRest(
  Schema.Struct({
    createdAt: Schema.optional(Schema.Union([Schema.Date, Schema.String])),
    id: Schema.String,
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
  override maxSteps = Number(currentPolicy.plans.free.operationLimits.modelStepsPerRequest);

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

  readonly #db = makeAgentDb(this.ctx.storage);
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
  #activeModelStepNumber = ModelStepNumber.make(1);
  readonly #completedModelSteps = new Set<number>();
  readonly #currentApprovalAuthorization = new Map<ActionId, AuthorizationContext>();
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
    present: presentProtectedAction,
  });
  readonly #modelCallUsagePersistence = makeModelCallUsageStore(this.#db);
  readonly #modelCallUsage = makeDurableModelCallUsage({
    dispatch: { record: (usage) => this.#dispatchModelCallUsage(usage) },
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    persistence: this.#modelCallUsagePersistence,
  });
  readonly #store = makeAgentStore(this.#db);
  readonly #sessionExecution = makeSessionExecution({
    hasPendingOrRunning: callThinkSubmission("listSubmissions", () =>
      this.listSubmissions({ limit: 1, status: ["pending", "running"] }),
    ).pipe(Effect.map((submissions) => submissions.length > 0)),
  });
  readonly #migrationsReady = this.ctx.blockConcurrencyWhile(() =>
    Effect.runPromise(applyAgentMigrations(this.ctx.storage)),
  );
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeOsfoAgentRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage, {
      db: this.env.DB,
    }),
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
      Effect.promise(() => this.#migrationsReady).pipe(
        Effect.andThen(this.#sessionRecall.recall(request)),
      ),
  });
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
    const result = await Effect.runPromiseExit(
      message.text.trim() === "/new"
        ? this.#sessionExecution.runWhenIdle(operation)
        : this.#sessionExecution.run(operation),
    );
    if (Exit.isFailure(result)) {
      const failureTag = Option.match(Cause.findErrorOption(result.cause), {
        onNone: () => "DefectOrInterruption",
        onSome: (value) => value._tag,
      });
      await Effect.runPromise(
        Effect.logError("Messenger authorization failed").pipe(Effect.annotateLogs({ failureTag })),
      );
      await this.#completeMessengerPolicyReply(
        callback,
        context,
        "I could not authorize that message right now. Please try again.",
      );
      return;
    }
    if (Predicate.isTagged(result.value.admission, "ManagedConversationDenied")) {
      await this.#completeMessengerPolicyReply(
        callback,
        context,
        "Your current Osfo allowance does not permit this request.",
      );
      return;
    }
    if (Predicate.isTagged(result.value.admission, "ManagedSessionReplacementAdmitted")) {
      const recorded = await this.#recordMessengerAcceptedMessage(
        result.value.currentAuthorization,
        provider,
        message.providerMessageId,
      );
      if (!recorded) {
        await this.#completeMessengerPolicyReply(
          callback,
          context,
          "I could not reserve this message in your allowance. Please try again.",
        );
        return;
      }
      await this.#completeMessengerPolicyReply(callback, context, "Started a new Osfo session.");
      return;
    }

    const recorded = await this.#recordMessengerAcceptedMessage(
      result.value.currentAuthorization,
      provider,
      message.providerMessageId,
    );
    if (!recorded) {
      await this.#completeMessengerPolicyReply(
        callback,
        context,
        "I could not reserve this message in your allowance. Please try again.",
      );
      return;
    }
    await super.chatWithMessengerContext(userMessage, callback, context, {
      metadata: result.value.admission.metadata,
    });
  }

  /** Register document and test actions in their owning stages. */
  override getActions() {
    const documentActions = {
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
        description: "Generate one bounded PDF or DOCX with at most 20 pages and 5 MB.",
        execute: (input, context) => this.#generateDocument(input, context.toolCallId),
        idempotencyKey: ({ ctx }) => `document-generate:${ctx.toolCallId}`,
        inputSchema: effectToolSchema(GenerateDocumentInput),
        permissions: ["documents:generate"],
        timeoutMs: 90_000,
      }),
    };
    const executeClear = (input: Parameters<typeof clearCoreMemory>[1], actionId: ActionId) =>
      this.#clearCoreMemory(input, actionId);
    const osfoActions = makeOsfoActions({ clearCoreMemory: executeClear });
    return {
      ...documentActions,
      ...osfoActions,
    };
  }

  /** Register Session Recall and document export tools. */
  override getTools(): ToolSet {
    return {
      ...this.#sessionRecallTools,
      exportDocument: tool({
        description: "Export one retained generated PDF or DOCX owned by the current User.",
        execute: (input, context) => this.#exportDocument(input, context.toolCallId),
        inputSchema: effectToolSchema(RetainedDocumentInput),
      }),
    };
  }

  /** Keep inherited pending-Approval RPC output client-safe for every registered Action. */
  override async pendingApprovals(executionId?: string): Promise<Array<PendingApproval>> {
    const pending = await super.pendingApprovals(executionId);
    return pending.map((approval) =>
      approval.source === "action" && approval.descriptor.action === documentDeleteActionName
        ? Object.assign({}, approval, {
            descriptor: Object.assign({}, approval.descriptor, {
              input: sanitizeDocumentDeleteInput(approval.descriptor.input),
            }),
          })
        : sanitizePendingApproval(approval),
    );
  }

  /** Apply only the route and limits pinned to the current durable Think Submission. */
  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    const system = await this.session.refreshSystemPrompt();
    const tools = { ...context.tools, ...coreMemoryTools(this.session) };
    return Effect.runPromise(
      Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
        Effect.map((metadata) => {
          this.#completedModelSteps.clear();
          this.contextOverflow = {
            maxRetries: 1,
            proactive: {
              headroom: metadata.targetInputTokens / metadata.maxInputTokens,
              maxCompactions: 1,
              maxInputTokens: metadata.maxInputTokens,
            },
            reactive: true,
          };
          return {
            maxOutputTokens: metadata.maxOutputTokens,
            maxRetries: metadata.maxRetries,
            maxSteps: metadata.maxSteps,
            model: metadata.route,
            sendReasoning: false,
            system,
            tools,
          };
        }),
      ),
    );
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

  /** Reuse Think's zero-based step index as the stable model-call attempt position. */
  override beforeStep(context: PrepareStepContext): void {
    this.#activeModelStepNumber = ModelStepNumber.make(context.stepNumber + 1);
  }

  /** Record observed AI Gateway cost or one bounded share after each completed step. */
  override async onStepEnd(context: StepContext): Promise<void> {
    const stepNumber = ModelStepNumber.make(context.stepNumber + 1);
    await this.#recordCurrentModelUsage(stepNumber, context);
    this.#completedModelSteps.add(stepNumber);
  }

  /** Preserve conservative cost evidence when a provider turn ends ambiguously. */
  // oxlint-disable-next-line osfo/no-unknown-parameters, osfo/no-unknown-returns -- Think owns the error hook's unknown protocol contract.
  override onChatError(error: unknown, context?: ChatErrorContext): unknown {
    if (context?.stage === "turn" || context?.stage === "stream" || context?.stage === "recovery") {
      if (!this.#completedModelSteps.has(this.#activeModelStepNumber)) {
        this.ctx.waitUntil(this.#recordCurrentModelUsage(this.#activeModelStepNumber));
      }
    }
    return super.onChatError(error, context);
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
    await this.#activateCurrentSession();
    const session = this.session;
    const applyBound = (parsed: BoundCoreMemoryInput) => boundCoreMemory(session, this, parsed);
    const outcome = await runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(BoundCoreMemoryInput)(input).pipe(
          Effect.mapError(() => invalidRequest("boundCoreMemory")),
        );
        const admission = authorization.admit(parsed.authorization, {
          actionId: parsed.actionId,
          kind: "memory.correct",
        });
        if (!Predicate.isTagged(admission, "Admitted")) return admission;
        return yield* applyBound(parsed);
      }),
    );
    if (Predicate.isTagged(outcome, "CoreMemoryBound")) await this.#activateCurrentSession();
    return outcome;
  }

  /** Inspect Agent-wide User Context and Agent Notes before or after any turn. */
  async inspectCoreMemory(
    input: InspectCoreMemoryEncoded,
  ): Promise<
    AgentRequestInvalid | ApprovalRequired | CoreMemoryInspected | CoreMemoryUnavailable | Denied
  > {
    await this.#migrationsReady;
    await this.#activateCurrentSession();
    const session = this.session;
    return runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(InspectCoreMemoryInput)(input).pipe(
          Effect.mapError(() => invalidRequest("inspectCoreMemory")),
        );
        const admission = authorization.admit(parsed.authorization, {
          actionId: parsed.actionId,
          kind: "memory.inspect",
        });
        if (!Predicate.isTagged(admission, "Admitted")) return admission;
        return yield* inspectCoreMemory(session);
      }),
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
    await this.#activateCurrentSession();
    const session = this.session;
    return runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(CorrectCoreMemoryInput)(input).pipe(
          Effect.mapError(() => invalidRequest("correctCoreMemory")),
        );
        const admission = authorization.admit(parsed.authorization, {
          actionId: parsed.actionId,
          kind: "memory.correct",
        });
        if (!Predicate.isTagged(admission, "Admitted")) return admission;
        return yield* correctCoreMemory(session, parsed);
      }),
    );
  }

  async #clearCoreMemory(input: Parameters<typeof clearCoreMemory>[1], actionId: ActionId) {
    await this.#migrationsReady;
    const current = this.#currentApprovalAuthorization.get(actionId);
    if (current === undefined) {
      return new CoreMemoryUnavailable({
        cause: actionId,
        message: "Current Core Memory authority is unavailable",
        operation: "clear",
      });
    }
    const recheck = authorization.recheck(
      {
        ...current,
        approval: {
          actionId,
          operation: "memory.clear",
          userId: current.user.userId,
        },
      },
      { actionId, kind: "memory.clear" },
    );
    if (Predicate.isTagged(recheck, "Denied")) return recheck;
    await this.#activateCurrentSession();
    return runRpc(clearCoreMemory(this.session, input));
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
    const store = this.#store;
    const outcome = await runRpc(
      Effect.gen(function* () {
        const namedAgentId = yield* Schema.decodeEffect(AgentId)(agentName).pipe(
          Effect.mapError(() => invalidRequest("initialize")),
        );
        const parsed = yield* Schema.decodeEffect(AgentInitializationInput)(input).pipe(
          Effect.mapError(() => invalidRequest("initialize")),
        );
        return yield* store.initialize(namedAgentId, parsed);
      }),
    );
    if ("currentSessionId" in outcome) await this.#activateCurrentSession();
    return outcome;
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
    return runRpc(
      decoded.success.message.trim() === "/new"
        ? this.#sessionExecution.runWhenIdle(operation)
        : this.#sessionExecution.run(operation),
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
    );
  }

  /** Delete one authenticated User-owned file after exact destructive Approval. */
  async deleteFile(input: DeleteFileRequest) {
    await this.#migrationsReady;
    return runRpc(
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
                found.presentation.operation === "memory.clear"
              ) {
                if (!authorizationMatchesActor(parsed.authorization, parsed.actor)) {
                  return Effect.fail(
                    new ApprovalActorUnauthorized({
                      message: "The current Authorization context does not match the actor",
                      presentationId: parsed.presentationId,
                      userId: parsed.actor.userId,
                    }),
                  );
                }
                this.#currentApprovalAuthorization.set(actionId, parsed.authorization);
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
                    Effect.sync(() => this.#currentApprovalAuthorization.delete(actionId)),
                  ),
                );
            }),
          ),
        ),
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

  /** Look up the stable initialization fact and current primary Session. */
  async inspect(): Promise<
    AgentFound | AgentStateNotFound | AgentStoreRecordInvalid | AgentStoreUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(this.#store.inspect());
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
    );
  }

  async #exportDocument(input: typeof RetainedDocumentInput.Type, toolCallId: string) {
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

  async #deleteDocument(input: typeof RetainedDocumentInput.Type, toolCallId: string) {
    await this.#migrationsReady;
    const actionId = ActionId.make(toolCallId);
    const currentAuthorization = () =>
      this.#currentDocumentAuthorization(0n, {
        actionId,
        operation: "file.delete",
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

  #currentDocumentAuthorization(
    requestVendorUsdMicros: bigint,
    approval?: {
      readonly actionId: ActionId;
      readonly operation: "file.delete";
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
              : {
                  actionId: approval.actionId,
                  operation: approval.operation,
                  userId: currentContext.user.userId,
                },
          requestVendorUsdMicros,
        }),
      ),
    );
  }

  /** Record one correlation reference after Think commits a completed response. */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (result.status !== "completed") return;
    await this.#migrationsReady;
    const assistantMessageId = AssistantMessageId.make(result.message.id);
    const thinkRequestId = ThinkRequestId.make(result.requestId);
    await Effect.runPromise(
      this.#findThinkMessageOwner(assistantMessageId, thinkRequestId).pipe(
        Effect.flatMap((sessionId) =>
          this.#store.recordCommittedTurn({
            assistantMessageId,
            sessionId,
            source: "hook",
            thinkRequestId,
          }),
        ),
      ),
    );
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
                  messages.filter(({ role }) => role === "assistant"),
                  (message) =>
                    this.#store.recordCommittedTurn({
                      assistantMessageId: AssistantMessageId.make(message.id),
                      sessionId,
                      source: "reconciliation",
                      thinkRequestId: null,
                    }),
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

const authorizationMatchesActor = (
  context: AuthorizationContext,
  actor: ApprovalActor,
): boolean => {
  const authority = context.authority;
  if (authority === null || authority.userId !== actor.userId) return false;
  if (Predicate.isTagged(actor, "AuthSession")) {
    return (
      (Predicate.isTagged(authority, "AuthSession") ||
        Predicate.isTagged(authority, "RevokedAuthSession")) &&
      authority.authSessionId === actor.authSessionId
    );
  }
  return (
    (Predicate.isTagged(authority, "ChannelLink") ||
      Predicate.isTagged(authority, "RevokedChannelLink")) &&
    authority.channelLinkId === actor.channelLinkId
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

const presentProtectedAction = (pending: Parameters<typeof presentOsfoAction>[0]) =>
  pending.descriptor.action === documentDeleteActionName
    ? Schema.decodeUnknownEffect(RetainedDocumentInput)(pending.descriptor.input).pipe(
        Effect.mapError(
          () =>
            new ActionPresentationUnavailable({
              action: pending.descriptor.action,
              message: "The document deletion input cannot be projected safely",
            }),
        ),
        Effect.map((input) =>
          ActionPresentation.make({
            actionDefinitionVersion: "osfo-delete-generated-document-v1",
            actionId: ActionId.make(pending.descriptor.toolCallId),
            consequences: ["Permanently delete the retained generated document."],
            description: "Delete the exact retained document shown here.",
            fields: [{ label: "Content", name: "contentId", value: input.contentId }],
            operation: "file.delete",
            presentationId: ActionPresentationId.make(pending.executionId),
            title: "Delete generated document",
          }),
        ),
      )
    : presentOsfoAction(pending);

/* oxlint-disable osfo/no-unknown-parameters -- This is the parser at Think's descriptor boundary. */
const sanitizeDocumentDeleteInput = (input: unknown) =>
  Option.getOrElse(Schema.decodeUnknownOption(RetainedDocumentInput)(input), () => ({}));
/* oxlint-enable osfo/no-unknown-parameters */
