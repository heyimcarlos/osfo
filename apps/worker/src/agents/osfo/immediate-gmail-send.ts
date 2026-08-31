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
  connectionBinding: IntegrationConnectionBinding,
  presentationId: ActionPresentationId,
  userId: UserId,
});

export type ApprovalConnectionBinding = typeof ApprovalConnectionBinding.Type;

export const TerminalStatus = Schema.Struct({
  actionId: ActionId,
  presentationId: ActionPresentationId,
  settledAt: Schema.Date,
  settlementSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Union([
    Schema.Literal("applied"),
    Schema.Literal("notApplied"),
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
  readonly listTerminal: (limit: number) => Effect.Effect<ReadonlyArray<unknown>, Unavailable>;
  readonly read: (actionId: ActionId) => Effect.Effect<unknown, Unavailable>;
  readonly readApprovalBinding: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<unknown, Unavailable>;
  readonly releaseApprovalBinding: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<void, Unavailable>;
  readonly retain: (candidate: AdmittedCandidate) => Effect.Effect<unknown, Conflict | Unavailable>;
  readonly retainApprovalBinding: (
    binding: ApprovalConnectionBinding,
  ) => Effect.Effect<unknown, Conflict | Unavailable>;
  readonly settle: (
    context: Context,
    status: TerminalStatus["status"],
  ) => Effect.Effect<void, Unavailable>;
}

export interface Interface {
  readonly deleteUser: (userId: UserId) => Effect.Effect<void, Unavailable>;
  readonly listAllForUser: (userId: UserId) => Effect.Effect<ReadonlyArray<Context>, Unavailable>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<Context>, Unavailable>;
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
  readonly retain: (candidate: AdmittedCandidate) => Effect.Effect<Context, Conflict | Unavailable>;
  readonly retainApprovalBinding: (
    binding: ApprovalConnectionBinding,
  ) => Effect.Effect<ApprovalConnectionBinding, Conflict | Unavailable>;
  readonly settle: (
    context: Context,
    status: TerminalStatus["status"],
  ) => Effect.Effect<void, Unavailable>;
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
      : inspection._tag === "NotApplied" || inspection._tag === "NotStarted"
        ? ("notApplied" as const)
        : null;

export const makeCoordinator = (options: {
  readonly accounting: Accounting;
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
      Effect.flatMap(({ open, terminal }) =>
        Effect.forEach(
          open,
          (context) =>
            readContextStatus(context).pipe(
              Effect.map((inspection) => ({
                actionId: context.actionId,
                orderedAt: context.retainedAt,
                presentationId: context.presentationId,
                settlementSequence: 0,
                status:
                  inspection._tag === "Applied"
                    ? ("applied" as const)
                    : inspection._tag === "NotApplied" || inspection._tag === "NotStarted"
                      ? ("notApplied" as const)
                      : inspection._tag === "Pending"
                        ? ("pending" as const)
                        : ("ambiguous" as const),
              })),
            ),
          { concurrency: 1 },
        ).pipe(
          Effect.map((items) => [
            ...items,
            ...terminal.map((status) => ({
              ...status,
              orderedAt: status.settledAt,
            })),
          ]),
        ),
      ),
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
          identity: integrationIdentity,
          input: candidate.input,
          userId: candidate.authorityIdentity.userId,
        });
      }
    }
    const context = yield* Option.match(existing, {
      onNone: () =>
        admit.pipe(
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
        finalizeEffect: (outcome) => finalize(context, outcome),
        identity: integrationIdentity,
        input: context.input,
        userId: context.authorityIdentity.userId,
      })
      .pipe(
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

  const recoverOnActivation = Effect.fn("ImmediateGmailSend.recoverOnActivation")(() =>
    options.store
      .listOpen()
      .pipe(
        Effect.flatMap((contexts) =>
          Effect.forEach(
            contexts,
            (context) =>
              scheduleInspection(context, initialActionReconciliationDelayMilliseconds, true),
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

const encode = Schema.encodeSync(Context);
const encodeTerminal = Schema.encodeSync(TerminalStatus);
export const maximumVisibleActions = 50;
export const maximumOpenActions = 50;

export const hasCurrentConnectionBinding = (
  evidence: IntegrationConnectionEvidence,
  expected: IntegrationConnectionBinding,
) => evidence._tag === "IntegrationConnectionConnected" && evidence.connectionBinding === expected;

export const make = (persistence: Persistence): Interface => ({
  deleteUser: Effect.fn("ImmediateGmailSend.Store.deleteUser")((userId) =>
    persistence.deleteUser(userId),
  ),
  listAllForUser: Effect.fn("ImmediateGmailSend.Store.listAllForUser")((userId) =>
    persistence.listOpen().pipe(
      Effect.flatMap((values) =>
        Effect.forEach(values, (value) => decode(value, "listAll.decode")),
      ),
      Effect.map((contexts) =>
        contexts.filter((context) => context.authorityIdentity.userId === userId),
      ),
    ),
  ),
  listOpen: Effect.fn("ImmediateGmailSend.Store.listOpen")(() =>
    persistence
      .listOpen()
      .pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) => decode(value, "listOpen.decode")),
        ),
      ),
  ),
  listForUser: Effect.fn("ImmediateGmailSend.Store.listForUser")((userId) =>
    Effect.all({
      open: persistence.listOpen().pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) => decode(value, "list.open.decode")),
        ),
        Effect.map((contexts) =>
          contexts.filter((context) => context.authorityIdentity.userId === userId),
        ),
      ),
      terminal: persistence.listTerminal(maximumVisibleActions).pipe(
        Effect.flatMap((values) =>
          Effect.forEach(values, (value) => decodeTerminal(value, "list.terminal.decode")),
        ),
        Effect.map((statuses) => statuses.filter((status) => status.userId === userId)),
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
      persistence.listTerminal(maximumVisibleActions).pipe(
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
  settle: Effect.fn("ImmediateGmailSend.Store.settle")((context, status) =>
    persistence.settle(context, status),
  ),
});

export const makeDurableObjectPersistence = (storage: DurableObjectStorage): Persistence => ({
  deleteUser: Effect.fn("ImmediateGmailSend.Persistence.deleteUser")((userId) =>
    Effect.tryPromise({
      try: async () => {
        const [approvalBindings, open, terminal] = await Promise.all([
          storage.list({ prefix: approvalBindingStoragePrefix }),
          storage.list({ prefix: openStoragePrefix }),
          storage.list({ prefix: terminalStoragePrefix }),
        ]);
        const keys = [
          settlementSequenceStorageKey,
          ...[...approvalBindings.entries()]
            .filter(([, value]) => decodedApprovalBindingUserId(value) === userId)
            .map(([key]) => key),
          ...[...open.entries()]
            .filter(([, value]) => decodedUserId(value) === userId)
            .map(([key]) => key),
          ...[...terminal.entries()]
            .filter(([, value]) => decodedTerminalUserId(value) === userId)
            .map(([key]) => key),
        ];
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
        storage
          .list({ limit: maximumOpenActions, prefix: openStoragePrefix })
          .then((records) => [...records.values()]),
      catch: (cause) => unavailable("listOpen", cause),
    }),
  ),
  listTerminal: Effect.fn("ImmediateGmailSend.Persistence.listTerminal")((limit) =>
    Effect.tryPromise({
      try: () =>
        storage
          .list({ limit, prefix: terminalStoragePrefix })
          .then((records) => [...records.values()]),
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
        try: () => storage.delete(approvalBindingStorageKey(presentationId)).then(() => undefined),
        catch: (cause) => unavailable("releaseApprovalBinding", cause),
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
            const encoded = Schema.encodeSync(ApprovalConnectionBinding)(candidate);
            await transaction.put(key, encoded);
            return encoded;
          }),
        catch: (cause) => unavailable("retainApprovalBinding", cause),
      }),
  ),
  settle: Effect.fn("ImmediateGmailSend.Persistence.settle")((context, status) =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const settlementSequence =
            ((await transaction.get<number>(settlementSequenceStorageKey)) ?? 0) + 1;
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
          await transaction.delete(openStorageKey(context.actionId));
          await transaction.delete(approvalBindingStorageKey(context.presentationId));
          const visible = await transaction.list({ prefix: terminalStoragePrefix });
          const stale = [...visible.keys()].slice(maximumVisibleActions);
          if (stale.length > 0) await transaction.delete(stale);
        }),
      catch: (cause) => unavailable("settle", cause),
    }),
  ),
});

const storagePrefix = "osfo:immediate-gmail-send:";
const maximumBulkDeleteKeys = 128;
const approvalBindingStoragePrefix = `${storagePrefix}approval:`;
const openStoragePrefix = `${storagePrefix}open:`;
const terminalStoragePrefix = `${storagePrefix}terminal:`;
const settlementSequenceStorageKey = `${storagePrefix}settlement-sequence`;
const approvalBindingStorageKey = (presentationId: ActionPresentationId) =>
  `${approvalBindingStoragePrefix}${presentationId}`;
const openStorageKey = (actionId: ActionId) => `${openStoragePrefix}${actionId}`;
const terminalStorageKey = (settlementSequence: number, actionId: ActionId) =>
  `${terminalStoragePrefix}${String(Number.MAX_SAFE_INTEGER - settlementSequence).padStart(16, "0")}:${actionId}`;

const decodedUserId = (value: unknown) =>
  Schema.decodeUnknownSync(Context)(value).authorityIdentity.userId;
const decodedTerminalUserId = (value: unknown) =>
  Schema.decodeUnknownSync(TerminalStatus)(value).userId;
const decodedApprovalBindingUserId = (value: unknown) =>
  Schema.decodeUnknownSync(ApprovalConnectionBinding)(value).userId;

class OpenActionLimitReached extends Data.TaggedError("OpenActionLimitReached") {}

const notFound = (actionId: ActionId) =>
  new NotFound({ actionId, message: "The Gmail Action does not belong to this User" });

const unavailable = (operation: string, cause: unknown) =>
  new Unavailable({
    cause,
    message: "Immediate Gmail Action context is unavailable",
    operation,
  });

export * as ImmediateGmailSend from "./immediate-gmail-send";
