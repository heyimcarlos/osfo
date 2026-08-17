import {
  defaultContextOverflowClassifier,
  Session,
  Think,
  type ActionAuthorizationContext,
  type ActionAuthorizationDecision,
  type ChatErrorContext,
  type ChatResponseResult,
  type PrepareStepContext,
  type PendingApproval,
  type StepContext,
  type SubmitMessagesResult,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { DateTime, Effect, Option, Predicate, Result, Schema } from "effect";
import { HelpArea, OnboardingLocale } from "@osfo/api";

import type { AssistantMessageId as AssistantMessageIdType, SessionId, UserId } from "../../domain";
import {
  AgentId,
  AllowancePeriodId,
  AssistantMessageId,
  ChannelBindingId,
  ConversationRouteId as ConversationRouteIdSchema,
  SessionId as SessionIdSchema,
  ThinkRequestId,
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
  SubmitManagedConversationInput,
} from "../../services/managed-conversation";
import {
  launchModelAccessPolicy,
  type ManagedRouteUnavailable,
} from "../../domain/model-access-policy";
import { currentPolicy, retainedCatalog, type PlanPolicyNotFound } from "../../domain/plan-policy";
import * as AgentDirectory from "../../services/agent-directory";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";
import { makeAgentDb } from "./db/client";
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
import * as Allowances from "../../services/allowances";
import { makeActionApprovals } from "../../services/action-approvals";
import {
  make as makeAuthorization,
  restoreCoreMemoryAuthorization,
  type ApprovalRequired,
  type AuthorizationContext,
  type Denied,
} from "../../services/authorization";
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
  ThinkSessionWriteUnavailable,
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
import {
  currentTestAuthorization,
  testProtectedActionUserId,
  type TestProtectedActionState,
} from "./test-protected-action";
import { CoreMemoryAuthorizationSnapshot } from "../../domain/core-memory-authorization";
import type { ActionId } from "../../domain/action-execution";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Agent RPC and lifecycle hooks require Promise boundaries. */

const pendingSessionId = "__osfo_uninitialized__";
const gatewayId = "default";
const modelCallUsageRetryDelaySeconds = 60;
const gatewayCostMaximumLookups = 3;
const defaultTestProtectedActionState: TestProtectedActionState = {
  authority: "active",
  providerOutcome: "applied",
};
const authorization = makeAuthorization(retainedCatalog);

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

const PersonalWelcomeInput = Schema.Struct({
  channelBindingId: ChannelBindingId,
  helpAreas: Schema.Array(HelpArea),
  locale: OnboardingLocale,
  preferredName: Schema.NullOr(Schema.String),
});
type PersonalWelcomeEncoded = typeof PersonalWelcomeInput.Encoded;

/** Durable result for the deterministic first personal response. */
export interface PersonalWelcomeCommitted {
  readonly _tag: "PersonalWelcomeCommitted";
  readonly messageId: AssistantMessageIdType;
  readonly sessionId: SessionId;
  readonly text: string;
}

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
    present: presentOsfoAction,
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

  /** Register Core Memory clearing and the test-stage protected Action. */
  override getActions() {
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    const executeClear = (input: Parameters<typeof clearCoreMemory>[1], actionId: ActionId) =>
      this.#clearCoreMemory(input, actionId);
    return Option.isSome(stage) && stage.value === "test"
      ? makeOsfoActions({
          clearCoreMemory: executeClear,
          testProtectedActionState: () =>
            this.getConfig<TestProtectedActionState>() ?? defaultTestProtectedActionState,
        })
      : makeOsfoActions({ clearCoreMemory: executeClear });
  }

  /** Keep inherited pending-Approval RPC output client-safe for every registered Action. */
  override async pendingApprovals(executionId?: string): Promise<Array<PendingApproval>> {
    const pending = await super.pendingApprovals(executionId);
    return pending.map(sanitizePendingApproval);
  }

  /** Apply only the route and limits pinned to the current durable Think Submission. */
  override async beforeTurn(_context: TurnContext): Promise<TurnConfig> {
    const system = await this.session.refreshSystemPrompt();
    const tools = coreMemoryTools(this.session);
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
    const configured = session
      .forSession(Option.getOrElse(current, () => pendingSessionId))
      .withContext("Operating Contract", {
        provider: { get: async () => this.getSystemPrompt() },
      });
    const coreMemory = await configureCoreMemory(configured, this);
    return coreMemory
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
        approval: { actionId, operation: "memory.clear", userId: current.user.userId },
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
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    return Option.isSome(stage) && stage.value === "test"
      ? Effect.succeed(
          currentTestAuthorization(
            this.getConfig<TestProtectedActionState>() ?? defaultTestProtectedActionState,
          ),
        )
      : Effect.fail(
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
    | ManagedConversationDenied
    | ManagedRouteUnavailable
    | PlanPolicyNotFound
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

  /** Commit the first localized personal response without running a model turn. */
  async commitWelcome(
    input: PersonalWelcomeEncoded,
  ): Promise<
    | AgentRequestInvalid
    | AgentStateNotFound
    | AgentStoreRecordInvalid
    | AgentStoreUnavailable
    | CommittedTurnConflict
    | PersonalWelcomeCommitted
    | ThinkSessionWriteUnavailable
  > {
    await this.#migrationsReady;
    const activateCurrentSession = () => this.#activateCurrentSession();
    const addWelcome = (message: {
      readonly id: string;
      readonly parts: Array<{ readonly text: string; readonly type: "text" }>;
      readonly role: "assistant";
    }) => this.addMessages([message]);
    const store = this.#store;
    return runRpc(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeEffect(PersonalWelcomeInput)(input).pipe(
          Effect.mapError(() => invalidRequest("commitWelcome")),
        );
        const agent = yield* store.inspect();
        const messageId = AssistantMessageId.make(`welcome-${parsed.channelBindingId}`);
        const text = personalWelcome(parsed);
        yield* Effect.tryPromise({
          try: async () => {
            await activateCurrentSession();
            await addWelcome({
              id: messageId,
              parts: [{ text, type: "text" }],
              role: "assistant",
            });
          },
          catch: (cause) =>
            new ThinkSessionWriteUnavailable({
              cause,
              message: "The personal welcome could not be persisted",
              sessionId: agent.currentSessionId,
            }),
        });
        yield* store.recordCommittedTurn({
          assistantMessageId: messageId,
          sessionId: agent.currentSessionId,
          source: "reconciliation",
          thinkRequestId: null,
        });
        return {
          _tag: "PersonalWelcomeCommitted",
          messageId,
          sessionId: agent.currentSessionId,
          text,
        } as const;
      }),
    );
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
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    if (Option.isSome(stage) && stage.value === "test") {
      return Effect.succeed(userId === testProtectedActionUserId);
    }
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

const personalWelcome = (profile: typeof PersonalWelcomeInput.Type): string => {
  const preferredName = profile.preferredName?.trim();
  const name = preferredName === undefined || preferredName.length === 0 ? "" : ` ${preferredName}`;
  const areas = profile.helpAreas.map((area) => helpAreaLabels[profile.locale][area]);
  if (profile.locale === "es") {
    const selected = areas.length === 0 ? "" : ` Elegiste ${formatList(areas, "y")}.`;
    return `Hola${name}, estoy listo.${selected} ¿En qué trabajamos primero?`;
  }
  const selected = areas.length === 0 ? "" : ` You selected ${formatList(areas, "and")}.`;
  return `Hi${name}, I'm ready.${selected} What should we work on first?`;
};

const helpAreaLabels = {
  en: {
    "files-documents": "files and documents",
    "money-planning": "money and planning",
    research: "research",
    "scheduling-reminders": "scheduling and reminders",
    "something-else": "something else",
    "writing-email": "writing and email",
  },
  es: {
    "files-documents": "archivos y documentos",
    "money-planning": "dinero y planificación",
    research: "investigación",
    "scheduling-reminders": "agenda y recordatorios",
    "something-else": "algo más",
    "writing-email": "redacción y correo",
  },
} as const;

const formatList = (values: ReadonlyArray<string>, conjunction: string): string => {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} ${conjunction} ${values.at(-1)}`;
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
    (Predicate.isTagged(authority, "ChannelBinding") ||
      Predicate.isTagged(authority, "RevokedChannelBinding")) &&
    authority.channelBindingId === actor.channelBindingId
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
