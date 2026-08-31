/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/lazy-effect, eslint/no-underscore-dangle, osfo/no-unknown-parameters, unicorn/no-array-sort -- Durable Object persistence owns its Promise, wall-clock, and unknown-value boundaries; the zero-argument list operation is named explicitly; Effect outcomes use _tag and a fresh projection array is sorted. */
import { Data, Effect, Option, Schema } from "effect";

import { AllowancePeriodId, ManifestVersion, UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { GmailMessageInput } from "../../domain/integration-manifest";
import { ManagedTurnAuthorityIdentity } from "../../domain/managed-conversation";
import {
  initialActionReconciliationDelayMilliseconds,
  IntegrationConnectionBinding,
  type IntegrationConnectionEvidence,
  type Integrations,
} from "../../services/integrations";
import { ActionPresentationId } from "./think-action-approvals";

export const Candidate = Schema.Struct({
  actionId: ActionId,
  authorityIdentity: ManagedTurnAuthorityIdentity,
  connectionBinding: IntegrationConnectionBinding,
  input: GmailMessageInput,
  presentationId: ActionPresentationId,
});

export type Candidate = typeof Candidate.Type;

export const AdmittedCandidate = Schema.Struct({
  ...Candidate.fields,
  allowancePeriodId: AllowancePeriodId,
});

export type AdmittedCandidate = typeof AdmittedCandidate.Type;

export const Context = Schema.Struct({
  ...AdmittedCandidate.fields,
  retainedAt: Schema.Date,
});

export type Context = typeof Context.Type;

export const ApprovalConnectionBinding = Schema.Struct({
  actionId: ActionId,
  connectionBinding: Schema.NullOr(IntegrationConnectionBinding),
  presentationId: ActionPresentationId,
  userId: UserId,
});

export type ApprovalConnectionBinding = typeof ApprovalConnectionBinding.Type;

export const ApprovalSettlementObligation = Schema.Struct({
  ...ApprovalConnectionBinding.fields,
  status: Schema.Literals(["invalidated", "rejected"]),
});

export type ApprovalSettlementObligation = typeof ApprovalSettlementObligation.Type;

export const TerminalStatus = Schema.Struct({
  actionId: ActionId,
  presentationId: ActionPresentationId,
  settledAt: Schema.Date,
  settlementSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Union([
    Schema.Literal("applied"),
    Schema.Literal("invalidated"),
    Schema.Literal("notApplied"),
    Schema.Literal("rejected"),
    Schema.Literal("ambiguous"),
  ]),
  userId: UserId,
});

export type TerminalStatus = typeof TerminalStatus.Type;

export interface VisibleActions {
  readonly open: ReadonlyArray<Context>;
  readonly terminal: ReadonlyArray<TerminalStatus>;
}

export class Conflict extends Schema.TaggedError<Conflict>()("ImmediateGmailSendConflict", {
  actionId: ActionId,
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("ImmediateGmailSendNotFound", {
  actionId: ActionId,
  message: Schema.String,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ImmediateGmailSendUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export interface Persistence {
  readonly deleteUser: (userId: UserId) => Effect.Effect<void, Unavailable>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<unknown>, Unavailable>;
  readonly listApprovalBindings: () => Effect.Effect<ReadonlyArray<unknown>, Unavailable>;
  readonly listApprovalSettlements: () => Effect.Effect<ReadonlyArray<unknown>, Unavailable>;
  readonly listTerminal: () => Effect.Effect<ReadonlyArray<unknown>, Unavailable>;
  readonly read: (actionId: ActionId) => Effect.Effect<unknown, Unavailable>;
  readonly readApprovalBinding: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<unknown, Unavailable>;
  readonly releaseApprovalBinding: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<void, Unavailable>;
  readonly releaseApprovalSettlement: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<void, Unavailable>;
  readonly retain: (candidate: AdmittedCandidate) => Effect.Effect<unknown, Conflict | Unavailable>;
  readonly retainApprovalBinding: (
    binding: ApprovalConnectionBinding,
  ) => Effect.Effect<unknown, Conflict | Unavailable>;
  readonly retainApprovalSettlement: (
    obligation: ApprovalSettlementObligation,
  ) => Effect.Effect<unknown, Conflict | Unavailable>;
  readonly settle: (
    context: Context,
    status: TerminalStatus["status"],
  ) => Effect.Effect<void, Conflict | Unavailable>;
  readonly settleApproval: (
    binding: ApprovalConnectionBinding,
    status: "invalidated" | "rejected",
  ) => Effect.Effect<void, Conflict | Unavailable>;
}

export interface Interface {
  readonly deleteUser: (userId: UserId) => Effect.Effect<void, Unavailable>;
  readonly listAllForUser: (userId: UserId) => Effect.Effect<ReadonlyArray<Context>, Unavailable>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<Context>, Unavailable>;
  readonly listApprovalBindings: () => Effect.Effect<
    ReadonlyArray<ApprovalConnectionBinding>,
    Unavailable
  >;
  readonly listApprovalSettlements: () => Effect.Effect<
    ReadonlyArray<ApprovalSettlementObligation>,
    Unavailable
  >;
  readonly listForUser: (userId: UserId) => Effect.Effect<VisibleActions, Unavailable>;
  readonly readForUser: (
    actionId: ActionId,
    userId: UserId,
  ) => Effect.Effect<Context, NotFound | Unavailable>;
  readonly readTerminalForUser: (
    actionId: ActionId,
    userId: UserId,
  ) => Effect.Effect<TerminalStatus, NotFound | Unavailable>;
  readonly readApprovalBindingForUser: (
    presentationId: ActionPresentationId,
    userId: UserId,
  ) => Effect.Effect<ApprovalConnectionBinding, NotFound | Unavailable>;
  readonly releaseApprovalBinding: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<void, Unavailable>;
  readonly releaseApprovalSettlement: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<void, Unavailable>;
  readonly retain: (candidate: AdmittedCandidate) => Effect.Effect<Context, Conflict | Unavailable>;
  readonly retainApprovalBinding: (
    binding: ApprovalConnectionBinding,
  ) => Effect.Effect<ApprovalConnectionBinding, Conflict | Unavailable>;
  readonly retainApprovalSettlement: (
    obligation: ApprovalSettlementObligation,
  ) => Effect.Effect<ApprovalSettlementObligation, Conflict | Unavailable>;
  readonly settle: (
    context: Context,
    status: TerminalStatus["status"],
  ) => Effect.Effect<void, Conflict | Unavailable>;
  readonly settleApproval: (
    binding: ApprovalConnectionBinding,
    status: "invalidated" | "rejected",
  ) => Effect.Effect<void, Conflict | Unavailable>;
}

export interface Accounting {
  readonly record: (
    context: Context,
    basis: "conservative" | "observed",
  ) => Effect.Effect<void, Integrations.IntegrationEffectFinalizationUnavailable>;
}

export interface Scheduler {
  readonly schedule: (
    actionId: ActionId,
    userId: UserId,
    delayMilliseconds: number,
    idempotent: boolean,
  ) => Effect.Effect<void, Unavailable>;
}

const integrationIdentity = {
  manifestVersion: ManifestVersion.make("gmail-v1"),
  operation: "GMAIL_SEND_EMAIL" as const,
  toolkit: "gmail" as const,
};

const terminalStatus = (inspection: Integrations.IntegrationActionInspection) =>
  inspection._tag === "Applied"
    ? ("applied" as const)
    : inspection._tag === "TerminalAmbiguous"
      ? ("ambiguous" as const)
      : inspection._tag === "NotApplied"
        ? ("notApplied" as const)
        : inspection._tag === "NotStarted"
          ? ("invalidated" as const)
          : null;

export const makeCoordinator = (options: {
  readonly accounting: Accounting;
  readonly approvalPending: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<boolean, Unavailable>;
  readonly integrations: Pick<
    Integrations.Interface,
    "execute" | "inspectAction" | "readActionStatus"
  >;
  readonly scheduler: Scheduler;
  readonly store: Interface;
}) => {
  const finalize = Effect.fn("ImmediateGmailSend.finalize")((
    context: Context,
    outcome: Integrations.IntegrationEffectFinalOutcome,
  ) => {
    if (outcome._tag === "NotApplied") return Effect.void;
    return options.accounting.record(
      context,
      outcome._tag === "Applied" ? "observed" : "conservative",
    );
  });

  const inspectContext = Effect.fn("ImmediateGmailSend.inspectContext")((context: Context) =>
    options.integrations.inspectAction({
      actionId: context.actionId,
      finalizeEffect: (outcome) => finalize(context, outcome),
      identity: integrationIdentity,
      input: context.input,
      userId: context.authorityIdentity.userId,
    }),
  );

  const readContextStatus = Effect.fn("ImmediateGmailSend.readContextStatus")((context: Context) =>
    options.integrations.readActionStatus({
      actionId: context.actionId,
      identity: integrationIdentity,
      input: context.input,
    }),
  );

  const scheduleInspection = Effect.fn("ImmediateGmailSend.scheduleInspection")(
    (context: Candidate, delayMilliseconds: number, idempotent: boolean) =>
      options.scheduler.schedule(
        context.actionId,
        context.authorityIdentity.userId,
        delayMilliseconds,
        idempotent,
      ),
  );

  const reconcileContext = Effect.fn("ImmediateGmailSend.reconcileContext")((context: Context) =>
    inspectContext(context).pipe(
      Effect.flatMap((inspection) => {
        if (inspection._tag === "Pending") {
          return scheduleInspection(context, initialActionReconciliationDelayMilliseconds, false);
        }
        if (inspection._tag === "Ambiguous") {
          return scheduleInspection(context, inspection.retryAfterMilliseconds, false);
        }
        return options.store.settle(context, terminalStatus(inspection) ?? "notApplied");
      }),
    ),
  );

  const reconcileWithDurableRecovery = Effect.fn("ImmediateGmailSend.reconcileWithDurableRecovery")(
    (context: Context) =>
      reconcileContext(context).pipe(
        Effect.catchTags({
          IntegrationEffectFinalizationUnavailable: () =>
            scheduleInspection(context, initialActionReconciliationDelayMilliseconds, false),
          IntegrationPersistenceUnavailable: () =>
            scheduleInspection(context, initialActionReconciliationDelayMilliseconds, false),
          IntegrationProviderUnavailable: () =>
            scheduleInspection(context, initialActionReconciliationDelayMilliseconds, false),
        }),
      ),
  );

  const inspectForUser = Effect.fn("ImmediateGmailSend.inspectForUser")((userId: UserId) =>
    options.store.listForUser(userId).pipe(
      Effect.map(({ open, terminal }) => [
        ...open.map((context) => ({
          actionId: context.actionId,
          orderedAt: context.retainedAt,
          presentationId: context.presentationId,
          settlementSequence: 0,
          status: "pending" as const,
        })),
        ...terminal.map((status) => ({ ...status, orderedAt: status.settledAt })),
      ]),
      Effect.map((items) => ({
        items: [...items]
          .sort(
            (left, right) =>
              right.orderedAt.getTime() - left.orderedAt.getTime() ||
              right.settlementSequence - left.settlementSequence,
          )
          .slice(0, maximumVisibleActions)
          .map(({ actionId, presentationId, status }) => ({ actionId, presentationId, status })),
      })),
    ),
  );

  const execute = Effect.fn("ImmediateGmailSend.execute")(function* <E, R>(
    candidate: Candidate,
    admit: Effect.Effect<AllowancePeriodId, E>,
    recheck: Effect.Effect<void, R>,
  ) {
    const existing = yield* options.store
      .readForUser(candidate.actionId, candidate.authorityIdentity.userId)
      .pipe(
        Effect.map(Option.some),
        Effect.catchTag("ImmediateGmailSendNotFound", () => Effect.succeed(Option.none())),
      );
    if (Option.isNone(existing)) {
      const integrationStatus = yield* options.integrations.readActionStatus({
        actionId: candidate.actionId,
        identity: integrationIdentity,
        input: candidate.input,
      });
      if (integrationStatus._tag === "Pending" || integrationStatus._tag === "Ambiguous") {
        return yield* new Conflict({
          actionId: candidate.actionId,
          message: "The attempted Action is missing its open recovery context",
        });
      }
      if (integrationStatus._tag !== "NotStarted") {
        const terminal = yield* options.store
          .readTerminalForUser(candidate.actionId, candidate.authorityIdentity.userId)
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("ImmediateGmailSendNotFound", () => Effect.succeed(Option.none())),
          );
        if (Option.isSome(terminal) && terminal.value.presentationId !== candidate.presentationId) {
          return yield* new Conflict({
            actionId: candidate.actionId,
            message: "The Action identity is already bound to a different Approval",
          });
        }
        return yield* options.integrations.execute({
          actionId: candidate.actionId,
          authorize: Effect.void,
          expectedConnectionBinding: candidate.connectionBinding,
          identity: integrationIdentity,
          input: candidate.input,
          userId: candidate.authorityIdentity.userId,
        });
      }
    }
    const context = yield* Option.match(existing, {
      onNone: () =>
        options.store
          .retainApprovalSettlement({
            actionId: candidate.actionId,
            connectionBinding: candidate.connectionBinding,
            presentationId: candidate.presentationId,
            status: "invalidated",
            userId: candidate.authorityIdentity.userId,
          })
          .pipe(
            Effect.andThen(
              admit.pipe(
                Effect.tapError(() =>
                  options.store.settleApproval(
                    {
                      actionId: candidate.actionId,
                      connectionBinding: candidate.connectionBinding,
                      presentationId: candidate.presentationId,
                      userId: candidate.authorityIdentity.userId,
                    },
                    "invalidated",
                  ),
                ),
              ),
            ),
            Effect.flatMap((allowancePeriodId) =>
              options.store.retain({ ...candidate, allowancePeriodId }),
            ),
          ),
      onSome: (retained) =>
        options.store.retain({ ...candidate, allowancePeriodId: retained.allowancePeriodId }),
    });
    yield* scheduleInspection(context, initialActionReconciliationDelayMilliseconds, true);
    return yield* options.integrations
      .execute({
        actionId: context.actionId,
        authorize: recheck,
        expectedConnectionBinding: context.connectionBinding,
        finalizeEffect: (outcome) => finalize(context, outcome),
        identity: integrationIdentity,
        input: context.input,
        userId: context.authorityIdentity.userId,
      })
      .pipe(
        Effect.tapError(() =>
          readContextStatus(context).pipe(
            Effect.flatMap((status) =>
              status._tag === "NotStarted"
                ? options.store.settle(context, "invalidated")
                : Effect.void,
            ),
          ),
        ),
        Effect.tap(() => options.store.settle(context, "applied")),
        Effect.catchTag("IntegrationActionNotApplied", (failure) =>
          options.store.settle(context, "notApplied").pipe(Effect.andThen(Effect.fail(failure))),
        ),
      );
  });

  const quiesceUser = Effect.fn("ImmediateGmailSend.quiesceUser")((userId: UserId) =>
    options.store.listAllForUser(userId).pipe(
      Effect.flatMap((contexts) =>
        Effect.forEach(
          contexts,
          (context) =>
            inspectContext(context).pipe(
              Effect.tap((inspection) => {
                if (inspection._tag === "Pending") {
                  return scheduleInspection(
                    context,
                    initialActionReconciliationDelayMilliseconds,
                    true,
                  );
                }
                if (inspection._tag === "Ambiguous") {
                  return scheduleInspection(context, inspection.retryAfterMilliseconds, true);
                }
                return options.store.settle(context, terminalStatus(inspection) ?? "notApplied");
              }),
            ),
          { concurrency: 1 },
        ),
      ),
      Effect.flatMap((inspections) =>
        inspections.some(
          (inspection) => inspection._tag === "Pending" || inspection._tag === "Ambiguous",
        )
          ? Effect.fail(
              new Unavailable({
                cause: "provider evidence horizon remains open",
                message: "An attempted Gmail Action still requires terminal settlement",
                operation: "accountDeletion.quiesce",
              }),
            )
          : Effect.void,
      ),
    ),
  );

  const reconcile = Effect.fn("ImmediateGmailSend.reconcile")(
    (actionId: ActionId, userId: UserId) =>
      options.store.readForUser(actionId, userId).pipe(
        Effect.flatMap(reconcileWithDurableRecovery),
        Effect.catchTag("ImmediateGmailSendNotFound", () => Effect.void),
      ),
  );

  const recoverApprovalSettlement = Effect.fn("ImmediateGmailSend.recoverApprovalSettlement")(
    (obligation: ApprovalSettlementObligation) =>
      options
        .approvalPending(obligation.presentationId)
        .pipe(
          Effect.flatMap((pending) =>
            pending
              ? options.store.releaseApprovalSettlement(obligation.presentationId)
              : options.store.settleApproval(obligation, obligation.status),
          ),
        ),
  );

  const recoverOnActivation = Effect.fn("ImmediateGmailSend.recoverOnActivation")(() =>
    Effect.all({
      bindings: options.store.listApprovalBindings(),
      contexts: options.store.listOpen(),
      obligations: options.store.listApprovalSettlements(),
    }).pipe(
      Effect.flatMap(({ bindings, contexts, obligations }) =>
        Effect.all(
          [
            Effect.forEach(
              contexts,
              (context) =>
                scheduleInspection(context, initialActionReconciliationDelayMilliseconds, true),
              { concurrency: 1, discard: true },
            ),
            Effect.forEach(obligations, recoverApprovalSettlement, {
              concurrency: 1,
              discard: true,
            }),
            Effect.forEach(
              bindings.filter(
                (binding) =>
                  !obligations.some(
                    (obligation) => obligation.presentationId === binding.presentationId,
                  ),
              ),
              (binding) =>
                options
                  .approvalPending(binding.presentationId)
                  .pipe(
                    Effect.flatMap((pending) =>
                      pending
                        ? Effect.void
                        : options.store.releaseApprovalBinding(binding.presentationId),
                    ),
                  ),
              { concurrency: 1, discard: true },
            ),
          ],
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );

  return {
    deleteUser: options.store.deleteUser,
    execute,
    inspectForUser,
    quiesceUser,
    reconcile,
    recoverApprovalSettlement,
    recoverOnActivation,
  };
};

const decode = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(Context)(value).pipe(
    Effect.mapError(
      (cause) =>
        new Unavailable({
          cause,
          message: "Immediate Gmail Action context is unavailable",
          operation,
        }),
    ),
  );

const decodeTerminal = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(TerminalStatus)(value).pipe(
    Effect.mapError(
      (cause) =>
        new Unavailable({
          cause,
          message: "Immediate Gmail Action status is unavailable",
          operation,
        }),
    ),
  );

const decodeApprovalBinding = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(ApprovalConnectionBinding)(value).pipe(
    Effect.mapError((cause) => unavailable(operation, cause)),
  );

const decodeApprovalSettlement = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(ApprovalSettlementObligation)(value).pipe(
    Effect.mapError((cause) => unavailable(operation, cause)),
  );

// A corrupt owned row cannot safely authorize provider inspection. Keep valid obligations
// fail-closed and recoverable, while allowing permanent deletion to erase the raw prefix.
const decodeRecoverableContexts = (values: ReadonlyArray<unknown>, operation: string) =>
  Effect.forEach(values, (value) => decode(value, operation).pipe(Effect.option)).pipe(
    Effect.map((contexts) => contexts.filter(Option.isSome).map((context) => context.value)),
  );

const decodeRecoverableApprovalBindings = (values: ReadonlyArray<unknown>) =>
  Effect.forEach(values, (value) =>
    decodeApprovalBinding(value, "listApprovalBindings.decode").pipe(Effect.option),
  ).pipe(Effect.map((bindings) => bindings.filter(Option.isSome).map((binding) => binding.value)));

const decodeRecoverableApprovalSettlements = (values: ReadonlyArray<unknown>) =>
  Effect.forEach(values, (value) =>
    decodeApprovalSettlement(value, "listApprovalSettlements.decode").pipe(Effect.option),
  ).pipe(
    Effect.map((obligations) =>
      obligations.filter(Option.isSome).map((obligation) => obligation.value),
    ),
  );

const decodeRecoverableTerminalStatuses = (values: ReadonlyArray<unknown>) =>
  Effect.forEach(values, (value) =>
    decodeTerminal(value, "list.terminal.decode").pipe(Effect.option),
  ).pipe(Effect.map((statuses) => statuses.filter(Option.isSome).map((status) => status.value)));

const encode = Schema.encodeSync(Context);
const encodeTerminal = Schema.encodeSync(TerminalStatus);
export const maximumVisibleActions = 50;
export const maximumOpenActions = 50;

export const hasCurrentConnectionBinding = (
  evidence: IntegrationConnectionEvidence,
  expected: IntegrationConnectionBinding,
) => evidence._tag === "IntegrationConnectionConnected" && evidence.connectionBinding === expected;

export const completeApprovalDecision = Effect.fn("ImmediateGmailSend.completeApprovalDecision")(
  (options: {
    readonly binding: ApprovalConnectionBinding;
    readonly decision: "approve" | "reject";
    readonly defer: (
      retry: Effect.Effect<void, Conflict | Unavailable>,
      failure: Conflict | Unavailable,
    ) => Effect.Effect<void>;
    readonly store: Interface;
  }) => {
    const completion =
      options.decision === "reject"
        ? options.store.settleApproval(options.binding, "rejected")
        : options.store.releaseApprovalBinding(options.binding.presentationId);
    return completion.pipe(Effect.catch((failure) => options.defer(completion, failure)));
  },
);

export const make = (persistence: Persistence): Interface => ({
  deleteUser: Effect.fn("ImmediateGmailSend.Store.deleteUser")((userId) =>
    persistence.deleteUser(userId),
  ),
  listAllForUser: Effect.fn("ImmediateGmailSend.Store.listAllForUser")((userId) =>
    persistence.listOpen().pipe(
      Effect.flatMap((values) => decodeRecoverableContexts(values, "listAll.decode")),
      Effect.map((contexts) =>
        contexts.filter((context) => context.authorityIdentity.userId === userId),
      ),
    ),
  ),
  listApprovalBindings: Effect.fn("ImmediateGmailSend.Store.listApprovalBindings")(() =>
    persistence.listApprovalBindings().pipe(
      Effect.flatMap(decodeRecoverableApprovalBindings),
      Effect.map((bindings) => bindings.slice(0, maximumApprovalBindings)),
    ),
  ),
  listApprovalSettlements: Effect.fn("ImmediateGmailSend.Store.listApprovalSettlements")(() =>
    persistence.listApprovalSettlements().pipe(
      Effect.flatMap(decodeRecoverableApprovalSettlements),
      Effect.map((obligations) => obligations.slice(0, maximumApprovalBindings)),
    ),
  ),
  listOpen: Effect.fn("ImmediateGmailSend.Store.listOpen")(() =>
    persistence.listOpen().pipe(
      Effect.flatMap((values) => decodeRecoverableContexts(values, "listOpen.decode")),
      Effect.map((contexts) => contexts.slice(0, maximumOpenActions)),
    ),
  ),
  listForUser: Effect.fn("ImmediateGmailSend.Store.listForUser")((userId) =>
    Effect.all({
      open: persistence.listOpen().pipe(
        Effect.flatMap((values) => decodeRecoverableContexts(values, "list.open.decode")),
        Effect.map((contexts) =>
          contexts
            .filter((context) => context.authorityIdentity.userId === userId)
            .slice(0, maximumVisibleActions),
        ),
      ),
      terminal: persistence.listTerminal().pipe(
        Effect.flatMap(decodeRecoverableTerminalStatuses),
        Effect.map((statuses) =>
          statuses.filter((status) => status.userId === userId).slice(0, maximumVisibleActions),
        ),
      ),
    }),
  ),
  readForUser: Effect.fn("ImmediateGmailSend.Store.readForUser")((actionId, userId) =>
    persistence
      .read(actionId)
      .pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(notFound(actionId))
            : decode(value, "read.decode").pipe(
                Effect.flatMap((context) =>
                  context.authorityIdentity.userId === userId
                    ? Effect.succeed(context)
                    : Effect.fail(notFound(actionId)),
                ),
              ),
        ),
      ),
  ),
  readTerminalForUser: Effect.fn("ImmediateGmailSend.Store.readTerminalForUser")(
    (actionId, userId) =>
      persistence.listTerminal().pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) => decodeTerminal(value, "readTerminal.decode")),
        ),
        Effect.flatMap((statuses) => {
          const status = statuses.find((candidate) => candidate.actionId === actionId);
          return status?.userId === userId
            ? Effect.succeed(status)
            : Effect.fail(notFound(actionId));
        }),
      ),
  ),
  readApprovalBindingForUser: Effect.fn("ImmediateGmailSend.Store.readApprovalBindingForUser")(
    (presentationId, userId) =>
      persistence.readApprovalBinding(presentationId).pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(notFound(ActionId.make(presentationId)))
            : Schema.decodeUnknownEffect(ApprovalConnectionBinding)(value).pipe(
                Effect.mapError((cause) => unavailable("readApprovalBinding.decode", cause)),
                Effect.flatMap((binding) =>
                  binding.userId === userId
                    ? Effect.succeed(binding)
                    : Effect.fail(notFound(binding.actionId)),
                ),
              ),
        ),
      ),
  ),
  releaseApprovalBinding: Effect.fn("ImmediateGmailSend.Store.releaseApprovalBinding")(
    (presentationId) => persistence.releaseApprovalBinding(presentationId),
  ),
  releaseApprovalSettlement: Effect.fn("ImmediateGmailSend.Store.releaseApprovalSettlement")(
    (presentationId) => persistence.releaseApprovalSettlement(presentationId),
  ),
  retain: Effect.fn("ImmediateGmailSend.Store.retain")((candidate) =>
    persistence.retain(candidate).pipe(
      Effect.flatMap((retained) => decode(retained, "retain.decode")),
      Effect.flatMap((retained) =>
        JSON.stringify(Schema.encodeSync(AdmittedCandidate)(retained)) ===
        JSON.stringify(Schema.encodeSync(AdmittedCandidate)(candidate))
          ? Effect.succeed(retained)
          : Effect.fail(
              new Conflict({
                actionId: candidate.actionId,
                message: "The Action identity is already bound to different Gmail facts",
              }),
            ),
      ),
    ),
  ),
  retainApprovalBinding: Effect.fn("ImmediateGmailSend.Store.retainApprovalBinding")((candidate) =>
    persistence.retainApprovalBinding(candidate).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(ApprovalConnectionBinding)(value).pipe(
          Effect.mapError((cause) => unavailable("retainApprovalBinding.decode", cause)),
        ),
      ),
      Effect.flatMap((retained) =>
        retained.actionId === candidate.actionId &&
        retained.connectionBinding === candidate.connectionBinding &&
        retained.presentationId === candidate.presentationId &&
        retained.userId === candidate.userId
          ? Effect.succeed(retained)
          : Effect.fail(
              new Conflict({
                actionId: candidate.actionId,
                message: "The Approval identity is already bound to another Gmail Action",
              }),
            ),
      ),
    ),
  ),
  retainApprovalSettlement: Effect.fn("ImmediateGmailSend.Store.retainApprovalSettlement")(
    (candidate) =>
      persistence.retainApprovalSettlement(candidate).pipe(
        Effect.flatMap((value) =>
          decodeApprovalSettlement(value, "retainApprovalSettlement.decode"),
        ),
        Effect.flatMap((retained) =>
          retained.actionId === candidate.actionId &&
          retained.connectionBinding === candidate.connectionBinding &&
          retained.presentationId === candidate.presentationId &&
          retained.status === candidate.status &&
          retained.userId === candidate.userId
            ? Effect.succeed(retained)
            : Effect.fail(
                new Conflict({
                  actionId: candidate.actionId,
                  message: "The Approval settlement is already bound to another decision",
                }),
              ),
        ),
      ),
  ),
  settle: Effect.fn("ImmediateGmailSend.Store.settle")((context, status) =>
    persistence.settle(context, status),
  ),
  settleApproval: Effect.fn("ImmediateGmailSend.Store.settleApproval")((binding, status) =>
    persistence.settleApproval(binding, status),
  ),
});

export const makeDurableObjectPersistence = (storage: DurableObjectStorage): Persistence => ({
  deleteUser: Effect.fn("ImmediateGmailSend.Persistence.deleteUser")((_userId) =>
    Effect.tryPromise({
      try: async () => {
        // The OsfoAgent Durable Object is User-owned, so every module row belongs to the
        // deleting User. Key ownership remains recoverable even when a value is malformed.
        const keys = [...(await storage.list({ prefix: storagePrefix })).keys()];
        const batches = Array.from(
          { length: Math.ceil(keys.length / maximumBulkDeleteKeys) },
          (_, index) =>
            keys.slice(index * maximumBulkDeleteKeys, (index + 1) * maximumBulkDeleteKeys),
        );
        await Promise.all(batches.map((batch) => storage.delete(batch)));
      },
      catch: (cause) => unavailable("deleteUser", cause),
    }),
  ),
  listOpen: Effect.fn("ImmediateGmailSend.Persistence.listOpen")(() =>
    Effect.tryPromise({
      try: () =>
        // Scan the owned prefix before applying the valid-record cap. Corrupt rows must
        // never occupy the bounded recovery window and hide a later trusted obligation.
        storage.list({ prefix: openStoragePrefix }).then((records) => [...records.values()]),
      catch: (cause) => unavailable("listOpen", cause),
    }),
  ),
  listApprovalBindings: Effect.fn("ImmediateGmailSend.Persistence.listApprovalBindings")(() =>
    Effect.tryPromise({
      try: () =>
        storage
          .list({ prefix: approvalBindingStoragePrefix })
          .then((records) => [...records.values()]),
      catch: (cause) => unavailable("listApprovalBindings", cause),
    }),
  ),
  listApprovalSettlements: Effect.fn("ImmediateGmailSend.Persistence.listApprovalSettlements")(() =>
    Effect.tryPromise({
      try: () =>
        storage
          .list({ prefix: approvalSettlementStoragePrefix })
          .then((records) => [...records.values()]),
      catch: (cause) => unavailable("listApprovalSettlements", cause),
    }),
  ),
  listTerminal: Effect.fn("ImmediateGmailSend.Persistence.listTerminal")(() =>
    Effect.tryPromise({
      try: () =>
        storage.list({ prefix: terminalStoragePrefix }).then((records) => [...records.values()]),
      catch: (cause) => unavailable("listTerminal", cause),
    }),
  ),
  read: Effect.fn("ImmediateGmailSend.Persistence.read")((actionId) =>
    Effect.tryPromise({
      try: () => storage.get(openStorageKey(actionId)).then((value) => value ?? null),
      catch: (cause) => unavailable("read", cause),
    }),
  ),
  readApprovalBinding: Effect.fn("ImmediateGmailSend.Persistence.readApprovalBinding")(
    (presentationId) =>
      Effect.tryPromise({
        try: () =>
          storage.get(approvalBindingStorageKey(presentationId)).then((value) => value ?? null),
        catch: (cause) => unavailable("readApprovalBinding", cause),
      }),
  ),
  releaseApprovalBinding: Effect.fn("ImmediateGmailSend.Persistence.releaseApprovalBinding")(
    (presentationId) =>
      Effect.tryPromise({
        try: () =>
          storage
            .delete([
              approvalBindingStorageKey(presentationId),
              approvalSettlementStorageKey(presentationId),
            ])
            .then(() => undefined),
        catch: (cause) => unavailable("releaseApprovalBinding", cause),
      }),
  ),
  releaseApprovalSettlement: Effect.fn("ImmediateGmailSend.Persistence.releaseApprovalSettlement")(
    (presentationId) =>
      Effect.tryPromise({
        try: () =>
          storage.delete(approvalSettlementStorageKey(presentationId)).then(() => undefined),
        catch: (cause) => unavailable("releaseApprovalSettlement", cause),
      }),
  ),
  retain: Effect.fn("ImmediateGmailSend.Persistence.retain")((candidate) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const key = openStorageKey(candidate.actionId);
          const retained = await transaction.get(key);
          if (retained !== undefined) return retained;
          const open = await transaction.list({
            limit: maximumOpenActions,
            prefix: openStoragePrefix,
          });
          if (open.size >= maximumOpenActions) throw new OpenActionLimitReached();
          const context = { ...candidate, retainedAt: new Date() };
          const encoded = encode(context);
          await transaction.put(key, encoded);
          await transaction.delete(approvalBindingStorageKey(candidate.presentationId));
          await transaction.delete(approvalSettlementStorageKey(candidate.presentationId));
          return encoded;
        }),
      catch: (cause) =>
        cause instanceof OpenActionLimitReached
          ? new Conflict({
              actionId: candidate.actionId,
              message: "The Agent already has the maximum open Gmail Actions",
            })
          : unavailable("retain", cause),
    }),
  ),
  retainApprovalBinding: Effect.fn("ImmediateGmailSend.Persistence.retainApprovalBinding")(
    (candidate) =>
      Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const key = approvalBindingStorageKey(candidate.presentationId);
            const retained = await transaction.get(key);
            if (retained !== undefined) return retained;
            const bindings = await transaction.list({
              limit: maximumApprovalBindings,
              prefix: approvalBindingStoragePrefix,
            });
            if (bindings.size >= maximumApprovalBindings) {
              throw new ApprovalBindingLimitReached();
            }
            const encoded = Schema.encodeSync(ApprovalConnectionBinding)(candidate);
            await transaction.put(key, encoded);
            return encoded;
          }),
        catch: (cause) =>
          cause instanceof ApprovalBindingLimitReached
            ? new Conflict({
                actionId: candidate.actionId,
                message: "The Agent already has the maximum pending Gmail Approvals",
              })
            : unavailable("retainApprovalBinding", cause),
      }),
  ),
  retainApprovalSettlement: Effect.fn("ImmediateGmailSend.Persistence.retainApprovalSettlement")(
    (candidate) =>
      Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const key = approvalSettlementStorageKey(candidate.presentationId);
            const retained = await transaction.get(key);
            if (retained !== undefined) return retained;
            const encoded = Schema.encodeSync(ApprovalSettlementObligation)(candidate);
            await transaction.put(key, encoded);
            return encoded;
          }),
        catch: (cause) => unavailable("retainApprovalSettlement", cause),
      }),
  ),
  settle: Effect.fn("ImmediateGmailSend.Persistence.settle")((context, status) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const openKey = openStorageKey(context.actionId);
          const retained = await transaction.get(openKey);
          if (retained === undefined) return;
          const decoded = Schema.decodeUnknownSync(Context)(retained);
          if (
            JSON.stringify(Schema.encodeSync(AdmittedCandidate)(decoded)) !==
            JSON.stringify(Schema.encodeSync(AdmittedCandidate)(context))
          ) {
            throw new RetainedContextConflict();
          }
          const settlementSequence = await nextSettlementSequence(transaction);
          const terminal = encodeTerminal({
            actionId: context.actionId,
            presentationId: context.presentationId,
            settledAt: new Date(),
            settlementSequence,
            status,
            userId: context.authorityIdentity.userId,
          });
          await transaction.put(settlementSequenceStorageKey, settlementSequence);
          await transaction.put(terminalStorageKey(settlementSequence, context.actionId), terminal);
          await transaction.delete(openKey);
          await transaction.delete(approvalBindingStorageKey(context.presentationId));
          await transaction.delete(approvalSettlementStorageKey(context.presentationId));
          await compactTerminalStatuses(transaction);
        }),
      catch: (cause) =>
        cause instanceof RetainedContextConflict
          ? new Conflict({
              actionId: context.actionId,
              message: "The retained Action context changed before settlement",
            })
          : unavailable("settle", cause),
    }),
  ),
  settleApproval: Effect.fn("ImmediateGmailSend.Persistence.settleApproval")((binding, status) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const approvalKey = approvalBindingStorageKey(binding.presentationId);
          const retained = await transaction.get(approvalKey);
          if (retained === undefined) return;
          const decoded = Schema.decodeUnknownSync(ApprovalConnectionBinding)(retained);
          if (
            decoded.actionId !== binding.actionId ||
            decoded.connectionBinding !== binding.connectionBinding ||
            decoded.presentationId !== binding.presentationId ||
            decoded.userId !== binding.userId
          ) {
            throw new RetainedApprovalConflict();
          }
          const settlementSequence = await nextSettlementSequence(transaction);
          const terminal = encodeTerminal({
            actionId: binding.actionId,
            presentationId: binding.presentationId,
            settledAt: new Date(),
            settlementSequence,
            status,
            userId: binding.userId,
          });
          await transaction.put(settlementSequenceStorageKey, settlementSequence);
          await transaction.put(terminalStorageKey(settlementSequence, binding.actionId), terminal);
          await transaction.delete(approvalKey);
          await transaction.delete(approvalSettlementStorageKey(binding.presentationId));
          await compactTerminalStatuses(transaction);
        }),
      catch: (cause) =>
        cause instanceof RetainedApprovalConflict
          ? new Conflict({
              actionId: binding.actionId,
              message: "The retained Approval identity changed before settlement",
            })
          : unavailable("settleApproval", cause),
    }),
  ),
});

const storagePrefix = "osfo:immediate-gmail-send:";
const maximumBulkDeleteKeys = 128;
const maximumApprovalBindings = 50;
const approvalBindingStoragePrefix = `${storagePrefix}approval:`;
const approvalSettlementStoragePrefix = `${storagePrefix}approval-settlement:`;
const openStoragePrefix = `${storagePrefix}open:`;
const terminalStoragePrefix = `${storagePrefix}terminal:`;
const settlementSequenceStorageKey = `${storagePrefix}settlement-sequence`;
const approvalBindingStorageKey = (presentationId: ActionPresentationId) =>
  `${approvalBindingStoragePrefix}${presentationId}`;
const approvalSettlementStorageKey = (presentationId: ActionPresentationId) =>
  `${approvalSettlementStoragePrefix}${presentationId}`;
const openStorageKey = (actionId: ActionId) => `${openStoragePrefix}${actionId}`;
const terminalStorageKey = (settlementSequence: number, actionId: ActionId) =>
  `${terminalStoragePrefix}${String(Number.MAX_SAFE_INTEGER - settlementSequence).padStart(16, "0")}:${actionId}`;

const SettlementSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const nextSettlementSequence = async (transaction: DurableObjectTransaction) => {
  const retained = Schema.decodeUnknownOption(SettlementSequence)(
    await transaction.get(settlementSequenceStorageKey),
  );
  if (Option.isSome(retained)) return retained.value + 1;
  const terminals = await transaction.list({ prefix: terminalStoragePrefix });
  const maximum = [...terminals.values()].reduce<number>((current, value) => {
    const decoded = Schema.decodeUnknownOption(TerminalStatus)(value);
    return Option.isSome(decoded) ? Math.max(current, decoded.value.settlementSequence) : current;
  }, 0);
  return maximum + 1;
};

const compactTerminalStatuses = async (transaction: DurableObjectTransaction) => {
  const terminals = await transaction.list({ prefix: terminalStoragePrefix });
  const partitioned = [...terminals.entries()].reduce<{
    readonly invalid: Array<string>;
    readonly valid: Array<{ readonly key: string; readonly status: TerminalStatus }>;
  }>(
    (current, [key, value]) => {
      const decoded = Schema.decodeUnknownOption(TerminalStatus)(value);
      if (Option.isNone(decoded)) {
        current.invalid.push(key);
        return current;
      }
      current.valid.push({ key, status: decoded.value });
      return current;
    },
    { invalid: [], valid: [] },
  );
  const overflow = partitioned.valid
    .sort((left, right) => right.status.settlementSequence - left.status.settlementSequence)
    .slice(maximumVisibleActions)
    .map(({ key }) => key);
  const stale = [...partitioned.invalid, ...overflow];
  if (stale.length > 0) await transaction.delete(stale);
};

class OpenActionLimitReached extends Data.TaggedError("OpenActionLimitReached") {}
class ApprovalBindingLimitReached extends Data.TaggedError("ApprovalBindingLimitReached") {}
class RetainedApprovalConflict extends Data.TaggedError("RetainedApprovalConflict") {}
class RetainedContextConflict extends Data.TaggedError("RetainedContextConflict") {}

const notFound = (actionId: ActionId) =>
  new NotFound({ actionId, message: "The Gmail Action does not belong to this User" });

const unavailable = (operation: string, cause: unknown) =>
  new Unavailable({
    cause,
    message: "Immediate Gmail Action context is unavailable",
    operation,
  });

export * as ImmediateGmailSend from "./immediate-gmail-send";
