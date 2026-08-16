import {
  Session,
  Think,
  type ChatErrorContext,
  type ChatResponseResult,
  type PrepareStepContext,
  type StepContext,
  type SubmitMessagesResult,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import { DateTime, Effect, Exit, Option, Predicate, Result, Schema } from "effect";

import type { AssistantMessageId as AssistantMessageIdType, SessionId } from "../../domain";
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
import {
  type ActionApprovalRecordInvalid,
  type ActionApprovalStoreUnavailable,
  type ApprovalCancellationRecorded,
  type ActionMaterialityConflict,
  type ActionPresentationFound,
  ActionPresentationId,
  type ActionPresentationNotFound,
  type ActionPresentationPrepared,
  type ApprovalActorUnauthorized,
  type ApprovalAlreadyResolved,
  ApprovalDispatchAmbiguous,
  ApprovalDispatchUnavailable,
  ApprovalRequestId,
  type ApprovalDecisionRecorded,
  type ApprovalExpired,
  CancelActionApprovalInput,
  type CancelActionApprovalEncoded,
  DecideActionApprovalInput,
  type DecideActionApprovalEncoded,
  PrepareActionPresentationInput,
  type PrepareActionPresentationEncoded,
  ReadActionPresentationInput,
  type ReadActionPresentationEncoded,
} from "../../domain/action-approval";
import { decodeOsfoStage } from "../../env";
import {
  boundManagedContext,
  CancelManagedConversationInput,
  type CancelManagedConversationEncoded,
  ManagedTurnMetadata,
} from "../../domain/managed-conversation";
import {
  ModelCallUsageDispatchUnavailable,
  ModelStepNumber,
  modelCallAttemptId,
  type PendingModelCallUsage,
} from "../../domain/model-call-attempt";
import {
  admitManagedConversation,
  type ManagedConversationDenied,
  SubmitManagedConversationInput,
  type SubmitManagedConversationEncoded,
} from "../../services/managed-conversation";
import {
  launchModelAccessPolicy,
  type ManagedRouteUnavailable,
} from "../../domain/model-access-policy";
import { retainedCatalog } from "../../domain/plan-policy";
import {
  invalidOsfoEnvironment,
  makeOsfoAgentRuntime,
  probeExecutionUnit,
  type RuntimeProbeResult,
} from "../../layers";
import { makeAgentDb } from "./db/client";
import { digestActionPresentation, makeActionApprovalStore } from "./db/action-approvals";
import { makeActionApprovalService } from "../../services/action-approvals";
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

/* oxlint-disable effecttsgo/async-function -- Cloudflare Agent RPC and lifecycle hooks require Promise boundaries. */

const pendingSessionId = "__osfo_uninitialized__";

const ThinkApprovalDispatchError = Schema.Struct({
  error: Schema.String,
  executionId: Schema.String,
  status: Schema.Literal("error"),
});

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

  readonly #db = makeAgentDb(this.ctx.storage);
  #activeModelStepNumber = ModelStepNumber.make(1);
  readonly #approvalPersistence = makeActionApprovalStore(this.#db);
  readonly #actionApprovals = makeActionApprovalService({
    dispatch: {
      dispatch: (terminal) =>
        Effect.promise(() =>
          this.#dispatchApproval(terminal.presentationId, terminal.executionId, terminal.decision),
        ).pipe(
          Effect.flatMap((failure) => (failure === null ? Effect.void : Effect.fail(failure))),
        ),
    },
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    persistence: this.#approvalPersistence,
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

  /** Apply only the route and limits pinned to the current durable Think Submission. */
  override beforeTurn(_context: TurnContext): Promise<TurnConfig> {
    return Effect.runPromise(
      Schema.decodeUnknownEffect(ManagedTurnMetadata)(this.activeTurnMetadata).pipe(
        Effect.map((metadata) => ({
          activeTools: [],
          maxOutputTokens: metadata.maxOutputTokens,
          maxRetries: metadata.maxRetries,
          maxSteps: metadata.maxSteps,
          messages: boundManagedContext(
            _context.messages,
            _context.system,
            metadata.maxContextBytes,
          ),
          model: metadata.route,
          sendReasoning: false,
        })),
      ),
    );
  }

  /** Reuse Think's zero-based step index as the stable model-call attempt position. */
  override beforeStep(context: PrepareStepContext): void {
    this.#activeModelStepNumber = ModelStepNumber.make(context.stepNumber + 1);
  }

  /** Record conservative model cost after each provider-completed Think step. */
  override async onStepEnd(_context: StepContext): Promise<void> {
    await this.#recordCurrentModelUsage();
  }

  /** Preserve conservative cost evidence when a provider turn ends ambiguously. */
  // oxlint-disable-next-line osfo/no-unknown-parameters, osfo/no-unknown-returns -- Think owns the error hook's unknown protocol contract.
  override onChatError(error: unknown, context?: ChatErrorContext): unknown {
    if (context?.stage === "turn" || context?.stage === "stream" || context?.stage === "recovery") {
      this.ctx.waitUntil(this.#recordCurrentModelUsage());
    }
    return super.onChatError(error, context);
  }

  async #recordCurrentModelUsage(): Promise<void> {
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
      this.#activeModelStepNumber,
    );
    await Effect.runPromise(
      this.#modelCallUsage
        .record(metadata.value.allowancePeriodId, attemptId, {
          _tag: "Ambiguous",
          conservativeVendorUsdMicros: BigInt(metadata.value.conservativeVendorUsdMicros),
        })
        .pipe(
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
    return session.forSession(Option.getOrElse(current, () => pendingSessionId));
  }

  /** Reconcile committed Think messages when a new Agent activation starts. */
  override async onStart(): Promise<void> {
    await this.#migrationsReady;
    await Effect.runPromise(this.#actionApprovals.reconcile);
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

  /** Commit or recover one immutable client-safe Action Presentation and Approval Request. */
  async prepareActionPresentation(
    input: PrepareActionPresentationEncoded,
  ): Promise<
    | ActionApprovalRecordInvalid
    | ActionApprovalStoreUnavailable
    | ActionMaterialityConflict
    | ActionPresentationPrepared
    | AgentRequestInvalid
  > {
    await this.#migrationsReady;
    return runRpc(
      Effect.gen(
        function* (this: OsfoAgent) {
          const parsed = yield* Schema.decodeEffect(PrepareActionPresentationInput)(input).pipe(
            Effect.mapError(() => invalidRequest("prepareActionPresentation")),
          );
          const actionDigest = yield* digestActionPresentation(parsed);
          const presentationId = ActionPresentationId.make(
            // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- Presentation IDs require cryptographic opacity.
            `action-presentation-${crypto.randomUUID()}`,
          );
          const approvalRequestId = ApprovalRequestId.make(
            // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- Approval IDs require cryptographic opacity.
            `approval-request-${crypto.randomUUID()}`,
          );
          return yield* this.#actionApprovals.prepare(
            parsed,
            presentationId,
            approvalRequestId,
            actionDigest,
          );
        }.bind(this),
      ),
    );
  }

  /** Authorize and durably enqueue one server-routed managed conversation turn. */
  async submitManagedConversation(
    input: SubmitManagedConversationEncoded,
  ): Promise<
    AgentRequestInvalid | ManagedConversationDenied | ManagedRouteUnavailable | SubmitMessagesResult
  > {
    await this.#migrationsReady;
    const decoded = Schema.decodeResult(SubmitManagedConversationInput)(input);
    if (Result.isFailure(decoded)) return invalidRequest("submitManagedConversation");
    const admission = await runRpc(admitManagedConversation(decoded.success));
    if (!Predicate.isTagged(admission, "ManagedConversationAdmitted")) return admission;
    return this.runTurn({
      idempotencyKey: admission.idempotencyKey,
      input: admission.message,
      metadata: admission.metadata,
      mode: "submit",
      submissionId: admission.submissionId,
    });
  }

  /** Cancel one Think-owned managed conversation without creating another lifecycle. */
  async cancelManagedConversation(
    input: CancelManagedConversationEncoded,
  ): Promise<AgentRequestInvalid | ThinkSubmissionInspection | null> {
    await this.#migrationsReady;
    const decoded = Schema.decodeResult(CancelManagedConversationInput)(input);
    if (Result.isFailure(decoded)) return invalidRequest("cancelManagedConversation");
    await this.cancelSubmission(decoded.success.submissionId, decoded.success.reason);
    return this.inspectSubmission(decoded.success.submissionId);
  }

  /** Read one immutable presentation and current Approval state for an authenticated User. */
  async readActionPresentation(
    input: ReadActionPresentationEncoded,
  ): Promise<
    | ActionApprovalRecordInvalid
    | ActionApprovalStoreUnavailable
    | ActionPresentationFound
    | ActionPresentationNotFound
    | AgentRequestInvalid
    | ApprovalActorUnauthorized
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(ReadActionPresentationInput)(input).pipe(
        Effect.mapError(() => invalidRequest("readActionPresentation")),
        Effect.flatMap((parsed) => this.#actionApprovals.read(parsed)),
      ),
    );
  }

  /** Record the first authenticated exact Approval decision and dispatch it to Think. */
  async decideActionApproval(
    input: DecideActionApprovalEncoded,
  ): Promise<
    | ActionApprovalRecordInvalid
    | ActionApprovalStoreUnavailable
    | ActionPresentationNotFound
    | AgentRequestInvalid
    | ApprovalActorUnauthorized
    | ApprovalAlreadyResolved
    | ApprovalDecisionRecorded
    | ApprovalDispatchAmbiguous
    | ApprovalDispatchUnavailable
    | ApprovalExpired
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(DecideActionApprovalInput)(input).pipe(
        Effect.mapError(() => invalidRequest("decideActionApproval")),
        Effect.flatMap((parsed) => this.#actionApprovals.decide(parsed)),
      ),
    );
  }

  /** Cancel one pending Approval and its owning Think execution. */
  async cancelActionApproval(
    input: CancelActionApprovalEncoded,
  ): Promise<
    | ActionApprovalRecordInvalid
    | ActionApprovalStoreUnavailable
    | ActionPresentationNotFound
    | AgentRequestInvalid
    | ApprovalActorUnauthorized
    | ApprovalAlreadyResolved
    | ApprovalCancellationRecorded
    | ApprovalDispatchAmbiguous
    | ApprovalDispatchUnavailable
    | ApprovalExpired
  > {
    await this.#migrationsReady;
    return runRpc(
      Schema.decodeEffect(CancelActionApprovalInput)(input).pipe(
        Effect.mapError(() => invalidRequest("cancelActionApproval")),
        Effect.flatMap((parsed) => this.#actionApprovals.cancel(parsed)),
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

  async #dispatchApproval(
    presentationId: ActionPresentationId,
    executionId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalDispatchAmbiguous | ApprovalDispatchUnavailable | null> {
    const dispatch =
      decision === "approve"
        ? this.approveExecution(executionId)
        : this.rejectExecution(executionId, "The exact Action was rejected or canceled");
    const exit = await Effect.runPromiseExit(Effect.promise(() => dispatch));
    if (Exit.isFailure(exit)) {
      await Effect.runPromise(
        Effect.logError("Think Approval dispatch failed").pipe(
          Effect.annotateLogs({ decision, executionId, failureTag: "ThinkDispatchDefect" }),
        ),
      );
      return approvalDispatchUnavailable(presentationId);
    }
    const rejected = Schema.decodeUnknownOption(ThinkApprovalDispatchError)(exit.value);
    if (Option.isSome(rejected)) {
      if (/no longer pending|not paused/i.test(rejected.value.error)) {
        return approvalDispatchAmbiguous(presentationId);
      }
      await Effect.runPromise(
        Effect.logError("Think did not accept the persisted Approval decision").pipe(
          Effect.annotateLogs({ decision, executionId, failureTag: "ThinkDispatchRejected" }),
        ),
      );
      return approvalDispatchUnavailable(presentationId);
    }
    return null;
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

const approvalDispatchUnavailable = (presentationId: ActionPresentationId) =>
  new ApprovalDispatchUnavailable({
    message: "The Approval decision is durable, but Think has not accepted its handoff",
    presentationId,
  });

const approvalDispatchAmbiguous = (presentationId: ActionPresentationId) =>
  new ApprovalDispatchAmbiguous({
    message: "Think no longer exposes the exact Approval handoff outcome",
    presentationId,
  });

const modelCallUsageDispatchUnavailable = (usage: PendingModelCallUsage) =>
  new ModelCallUsageDispatchUnavailable({
    attemptId: usage.attemptId,
    message: "Durable model-call evidence has not reached Allowances",
  });

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
