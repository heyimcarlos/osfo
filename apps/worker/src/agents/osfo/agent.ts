import {
  defaultContextOverflowClassifier,
  Session,
  Think,
  type ChatErrorContext,
  type ChatResponseResult,
  type PrepareStepContext,
  type PendingApproval,
  type SessionMessage,
  type StepContext,
  type SubmitMessagesResult,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import { DateTime, Effect, Option, Predicate, Result, Schema } from "effect";

import type { AssistantMessageId as AssistantMessageIdType, SessionId, UserId } from "../../domain";
import {
  AgentId,
  AssistantMessageId,
  ConversationRouteId as ConversationRouteIdSchema,
  SessionId as SessionIdSchema,
  ThinkRequestId,
  ThinkSubmissionId,
} from "../../domain";
import { database as workerDatabase } from "../../db";
import * as Billing from "../../db/billing";
import { decodeOsfoStage } from "../../env";
import {
  CancelManagedConversationInput,
  ManagedTurnMetadata,
} from "../../domain/managed-conversation";
import {
  ModelCallUsageDispatchUnavailable,
  ModelStepNumber,
  conservativeVendorCostForStep,
  modelCallAttemptId,
  type PendingModelCallUsage,
} from "../../domain/model-call-attempt";
import {
  admitManagedConversation,
  type ManagedConversationDenied,
  SubmitManagedConversationInput,
} from "../../services/managed-conversation";
import {
  launchModelAccessPolicy,
  type ManagedRouteUnavailable,
} from "../../domain/model-access-policy";
import { retainedCatalog } from "../../domain/plan-policy";
import * as AgentDirectory from "../../services/agent-directory";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";
import { makeAgentDb } from "./db/client";
import * as Allowances from "../../services/allowances";
import { makeDurableModelCallUsage } from "../../services/model-call-usage";
import {
  type AgentInitializationConflict,
  AgentRequestInvalid,
  type AgentRequestOperation,
  AgentStateNotFound,
  type AgentStoreRecordInvalid,
  type AgentStoreUnavailable,
  CommittedTurnConflict,
  type CurrentSessionReplacementConflict,
  ThinkSessionReadUnavailable,
  ThinkSessionRecordInvalid,
} from "./db/errors";
import { applyAgentMigrations } from "./db/migrate";
import { makeModelCallUsageStore } from "./db/model-call-usage";
import {
  AgentInitializationInput,
  type AgentInitializationEncoded,
  type AgentInitialized,
  type AgentFound,
  type CommittedTurnReceipt,
  type ConversationRouteFound,
  type CurrentSessionReplaced,
  makeAgentStore,
  ReplaceCurrentSessionInput,
  type ReplaceCurrentSessionEncoded,
} from "./db/store";
import {
  type ActionPresentationFound,
  type ActionPresentationNotFound,
  type ActionPresentationUnavailable,
  type ActionApprovalRequestInvalid,
  ApprovalActorAuthorizationUnavailable,
  type ApprovalActorUnauthorized,
  type ApprovalAlreadyResolved,
  type ApprovalDecisionAccepted,
  type CancelActionApprovalRequest,
  type DecideActionApprovalRequest,
  makeThinkActionApprovals,
  type ReadActionPresentationRequest,
  type ThinkApprovalUnavailable,
} from "./think-action-approvals";
import {
  makeTestProtectedAction,
  presentTestProtectedAction,
  sanitizeTestProtectedActionInput,
  testProtectedActionName,
  type TestProtectedActionState,
} from "./test-protected-action";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Agent RPC and lifecycle hooks require Promise boundaries. */

const pendingSessionId = "__osfo_uninitialized__";
const gatewayId = "default";
const defaultTestProtectedActionState: TestProtectedActionState = {
  authority: "active",
  providerOutcome: "applied",
};

const GatewayProviderMetadata = Schema.Struct({
  cloudflare: Schema.optional(
    Schema.Struct({
      aiGatewayLogId: Schema.optional(Schema.String),
    }),
  ),
});

/** RPC representation of one managed conversation submission. */
export type SubmitManagedConversationRequest = typeof SubmitManagedConversationInput.Encoded;

/** RPC representation of one managed conversation cancellation. */
export type CancelManagedConversationRequest = typeof CancelManagedConversationInput.Encoded;

/** Classified failure from a Think Submission method. */
export class ThinkSubmissionUnavailable extends Schema.TaggedError<ThinkSubmissionUnavailable>()(
  "ThinkSubmissionUnavailable",
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
  override maxSteps = launchModelAccessPolicy.plans.free.maxSteps;

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
  #activeModelStepNumber = ModelStepNumber.make(1);
  readonly #completedModelSteps = new Set<number>();
  readonly #actionApprovals = makeThinkActionApprovals({
    authorizer: { ownsAgent: (userId) => this.#userOwnsAgent(userId) },
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    present: presentTestProtectedAction,
    think: {
      approve: (executionId) => this.approveExecution(executionId),
      pending: (executionId) => this.pendingApprovals(executionId),
      reject: (executionId, reason) => this.rejectExecution(executionId, reason),
    },
  });
  readonly #modelCallUsagePersistence = makeModelCallUsageStore(this.#db);
  readonly #modelCallUsage = makeDurableModelCallUsage({
    dispatch: { record: (usage) => this.#dispatchModelCallUsage(usage) },
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    persistence: this.#modelCallUsagePersistence,
  });
  readonly #store = makeAgentStore(this.#db);
  readonly #migrationsReady = this.ctx.blockConcurrencyWhile(() =>
    Effect.runPromise(applyAgentMigrations(this.ctx.storage)),
  );
  readonly #runtime = Option.map(decodeOsfoStage(this.env.OSFO_STAGE), (stage) =>
    makeOsfoAgentRuntime(this.ctx.id.name ?? this.ctx.id.toString(), stage, { db: this.env.DB }),
  );

  /** Resolve a safe model before trusted per-turn metadata selects the exact managed route. */
  override getModel() {
    return launchModelAccessPolicy.plans.free.route;
  }

  /** Register a typed protected Action only in the Worker test stage. */
  override getActions() {
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    if (Option.isNone(stage) || stage.value !== "test") return {};
    return {
      [testProtectedActionName]: makeTestProtectedAction({
        readState: () =>
          this.getConfig<TestProtectedActionState>() ?? defaultTestProtectedActionState,
      }),
    };
  }

  /** Keep inherited pending-Approval RPC output client-safe for every registered Action. */
  override async pendingApprovals(executionId?: string): Promise<Array<PendingApproval>> {
    const pending = await super.pendingApprovals(executionId);
    return pending.map((approval) =>
      approval.source === "action" && approval.descriptor.action === testProtectedActionName
        ? Object.assign({}, approval, {
            descriptor: Object.assign({}, approval.descriptor, {
              input: sanitizeTestProtectedActionInput(approval.descriptor.input),
            }),
          })
        : Object.assign({}, approval, {
            descriptor: Object.assign({}, approval.descriptor, { input: {} }),
          }),
    );
  }

  /** Apply only the route and limits pinned to the current durable Think Submission. */
  override beforeTurn(_context: TurnContext): Promise<TurnConfig> {
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
          };
        }),
      ),
    );
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
    const attemptId = modelCallAttemptId(
      ThinkSubmissionId.make(metadata.value.submissionId),
      stepNumber,
    );
    const evidence =
      step === undefined
        ? conservativeStepEvidence(metadata.value, stepNumber)
        : await this.#readStepEvidence(metadata.value, stepNumber, step);
    await Effect.runPromise(
      this.#modelCallUsage.record(metadata.value.allowancePeriodId, attemptId, evidence).pipe(
        Effect.catch(() =>
          Effect.logError("Managed model usage recording remains pending").pipe(
            Effect.annotateLogs({
              attemptId,
              failureTag: "ModelCallUsageRecordingFailure",
            }),
          ),
        ),
      ),
    );
  }

  /** Select the current primary Think Session after migration exclusion completes. */
  override async configureSession(session: Session): Promise<Session> {
    await this.#migrationsReady;
    const current = await Effect.runPromise(this.#readOptionalPrimarySessionId());
    return session
      .forSession(Option.getOrElse(current, () => pendingSessionId))
      .onCompaction(compactManagedSession)
      .compactAfter(launchModelAccessPolicy.plans.free.context.targetInputTokens);
  }

  /** Reconcile committed Think messages when a new Agent activation starts. */
  override async onStart(): Promise<void> {
    await this.#migrationsReady;
    await Effect.runPromise(this.#modelCallUsage.reconcile);
    await Effect.runPromise(this.#reconcileCommittedTurns());
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
    | ManagedConversationDenied
    | ManagedRouteUnavailable
    | SubmitMessagesResult
    | ThinkSubmissionUnavailable
  > {
    await this.#migrationsReady;
    const decoded = Schema.decodeResult(SubmitManagedConversationInput)(input);
    if (Result.isFailure(decoded)) return invalidRequest("submitManagedConversation");
    const admission = await runRpc(admitManagedConversation(decoded.success));
    if (!Predicate.isTagged(admission, "ManagedConversationAdmitted")) return admission;
    return runRpc(
      callThinkSubmission("runTurn", () =>
        this.runTurn({
          idempotencyKey: admission.idempotencyKey,
          input: admission.message,
          metadata: admission.metadata,
          mode: "submit",
          submissionId: admission.submissionId,
        }),
      ),
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
    return runRpc(this.#actionApprovals.read(input));
  }

  /** Record the first authenticated exact Approval decision and dispatch it to Think. */
  async decideActionApproval(
    input: DecideActionApprovalRequest,
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
    return runRpc(this.#actionApprovals.decide(input));
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
    return runRpc(this.#actionApprovals.cancel(input));
  }

  /** Look up the stable initialization fact and current primary Session. */
  async inspect(): Promise<
    AgentFound | AgentStateNotFound | AgentStoreRecordInvalid | AgentStoreUnavailable
  > {
    await this.#migrationsReady;
    return runRpc(this.#store.inspect());
  }

  /** Replace one route's current Session while retaining canonical history. */
  async replaceCurrentSession(
    input: ReplaceCurrentSessionEncoded,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CurrentSessionReplaced
    | CurrentSessionReplacementConflict
  > {
    await this.#migrationsReady;
    const outcome = await runRpc(
      Schema.decodeEffect(ReplaceCurrentSessionInput)(input).pipe(
        Effect.mapError(() => invalidRequest("replaceCurrentSession")),
        Effect.flatMap((parsed) => this.#store.replaceCurrentSession(parsed)),
      ),
    );
    if ("currentSessionId" in outcome) await this.#activateCurrentSession();
    return outcome;
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
      Schema.decodeEffect(ConversationRouteIdSchema)(routeId).pipe(
        Effect.mapError(() => invalidRequest("readRoute")),
        Effect.flatMap((parsed) => this.#store.readRoute(parsed)),
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
        const parsed = yield* Schema.decodeEffect(SessionIdSchema)(sessionId).pipe(
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
        return { _tag: "SessionHistoryFound", messages, sessionId: parsed } as const;
      }),
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
    this.session = await this.configureSession(Session.create(this));
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
              const database = yield* workerDatabase;
              const allowances = Allowances.make({
                billing: Billing.make(database),
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

  async #readStepEvidence(
    metadata: ManagedTurnMetadata,
    stepNumber: ModelStepNumber,
    step: StepContext,
  ) {
    const logId = readAiGatewayLogId(step.response.headers, step.providerMetadata);
    if (Option.isNone(logId)) return conservativeStepEvidence(metadata, stepNumber);
    const cost = await Effect.runPromise(
      Effect.tryPromise({
        try: () => this.env.AI.gateway(gatewayId).getLog(logId.value),
        catch: () => null,
      }),
    );
    if (cost === null || cost.cost === undefined || !Number.isFinite(cost.cost) || cost.cost < 0) {
      return conservativeStepEvidence(metadata, stepNumber);
    }
    return {
      _tag: "Observed" as const,
      supermemoryIngestionTokens: 0n,
      supermemoryRetrievals: 0n,
      vendorUsdMicros: BigInt(Math.ceil(cost.cost * 1_000_000)),
    };
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

  #findThinkMessageOwner(
    assistantMessageId: AssistantMessageIdType,
    thinkRequestId: ThinkRequestId,
  ) {
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

const invalidRequest = (operation: AgentRequestOperation): AgentRequestInvalid =>
  new AgentRequestInvalid({ message: "The Agent RPC input is invalid", operation });

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

const CompactableMessage = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    parts: Schema.Array(
      Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
    role: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const TextPart = Schema.Struct({ text: Schema.String, type: Schema.Literal("text") });

const compactManagedSession = async (messages: ReadonlyArray<SessionMessage>) => {
  const protectedTail = 4;
  if (messages.length <= protectedTail + 1) return null;
  const compacted = messages.slice(0, -protectedTail);
  const parsed = Schema.decodeUnknownOption(Schema.Array(CompactableMessage))(compacted);
  if (Option.isNone(parsed)) return null;
  const lines = parsed.value.flatMap((message) =>
    message.parts.flatMap((part) => {
      const text = Schema.decodeUnknownOption(TextPart)(part);
      return Option.isSome(text) ? [`${message.role}: ${text.value.text}`] : [];
    }),
  );
  const first = parsed.value[0];
  const last = parsed.value.at(-1);
  if (first === undefined || last === undefined) return null;
  return {
    fromMessageId: first.id,
    summary: `[Earlier conversation]\n${lines.join("\n").slice(-8_000)}`,
    toMessageId: last.id,
  };
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
  assistantMessageId: AssistantMessageIdType,
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
