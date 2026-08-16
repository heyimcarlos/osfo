import { Effect, Predicate } from "effect";

import type { UserId } from "../domain";
import {
  type ActionApprovalRecordInvalid,
  type ActionApprovalStoreUnavailable,
  type ActionDigest,
  type ActionMaterialityConflict,
  type ActionPresentationFound,
  type ActionPresentationId,
  type ActionPresentationNotFound,
  type ActionPresentationPrepared,
  ApprovalActorUnauthorized,
  type ApprovalAlreadyResolved,
  type ApprovalCancellationRecorded,
  type ApprovalDecisionRecorded,
  type ApprovalDispatchAmbiguous,
  type ApprovalDispatchUnavailable,
  ApprovalExpired,
  type ApprovalRequestId,
  type CancelActionApprovalInput,
  type DecideActionApprovalInput,
  type PrepareActionPresentationInput,
  type ReadActionPresentationInput,
} from "../domain/action-approval";

type PersistenceFailure = ActionApprovalRecordInvalid | ActionApprovalStoreUnavailable;

/** Current persisted Approval projection required by application policy. */
export interface ApprovalSnapshot {
  readonly found: ActionPresentationFound;
  readonly userId: UserId;
}

/** Persisted human decision awaiting exact Think handoff. */
export interface ApprovalDecisionDispatch {
  readonly decision: "approve" | "reject";
  readonly executionId: string;
  readonly recorded: ApprovalDecisionRecorded;
}

/** Persisted cancellation awaiting exact Think handoff. */
export interface ApprovalCancellationDispatch {
  readonly executionId: string;
  readonly recorded: ApprovalCancellationRecorded;
}

/** Undelivered persisted terminal decision read during activation. */
export interface ApprovalTerminalDispatch {
  readonly decision: "approve" | "reject";
  readonly executionId: string;
  readonly presentationId: ActionPresentationId;
}

/** Narrow Agent SQLite port required by exact Approval policy. */
export interface ApprovalPersistence {
  readonly cancel: (
    input: CancelActionApprovalInput,
    canceledAt: Date,
  ) => Effect.Effect<
    ApprovalCancellationDispatch,
    PersistenceFailure | ActionPresentationNotFound | ApprovalAlreadyResolved
  >;
  readonly decide: (
    input: DecideActionApprovalInput,
    decidedAt: Date,
  ) => Effect.Effect<
    ApprovalDecisionDispatch,
    PersistenceFailure | ActionPresentationNotFound | ApprovalAlreadyResolved | ApprovalExpired
  >;
  readonly expire: (
    presentationId: ActionPresentationId,
    expiredAt: Date,
  ) => Effect.Effect<ApprovalSnapshot, PersistenceFailure | ActionPresentationNotFound>;
  readonly inspect: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<ApprovalSnapshot, PersistenceFailure | ActionPresentationNotFound>;
  readonly markDispatched: (
    presentationId: ActionPresentationId,
    dispatchedAt: Date,
  ) => Effect.Effect<void, ActionApprovalStoreUnavailable>;
  readonly markDispatchAmbiguous: (
    presentationId: ActionPresentationId,
    observedAt: Date,
  ) => Effect.Effect<void, ActionApprovalStoreUnavailable>;
  readonly prepare: (
    input: PrepareActionPresentationInput,
    presentationId: ActionPresentationId,
    approvalRequestId: ApprovalRequestId,
    actionDigest: ActionDigest,
  ) => Effect.Effect<ActionPresentationPrepared, PersistenceFailure | ActionMaterialityConflict>;
  readonly readTerminalDispatches: Effect.Effect<
    ReadonlyArray<ApprovalTerminalDispatch>,
    ActionApprovalStoreUnavailable
  >;
}

/** Think handoff required after one Approval Request reaches a terminal state. */
export interface ApprovalDispatch {
  readonly dispatch: (
    terminal: ApprovalTerminalDispatch,
  ) => Effect.Effect<void, ApprovalDispatchAmbiguous | ApprovalDispatchUnavailable>;
}

/** Construct exact Approval application policy above persistence and Think adapters. */
export const makeActionApprovalService = (options: {
  readonly dispatch: ApprovalDispatch;
  readonly now: Effect.Effect<Date>;
  readonly persistence: ApprovalPersistence;
}) => {
  const read = (input: ReadActionPresentationInput) =>
    Effect.gen(function* () {
      const now = yield* options.now;
      const snapshot = yield* options.persistence.inspect(input.presentationId);
      yield* authorizeActor(input.actor, snapshot, now);
      return (yield* observeExpiry(snapshot, now)).snapshot.found;
    });

  const decide = (input: DecideActionApprovalInput) =>
    Effect.gen(function* () {
      const now = yield* options.now;
      const snapshot = yield* options.persistence.inspect(input.presentationId);
      yield* authorizeActor(input.actor, snapshot, now);
      const observed = yield* observeExpiry(snapshot, now);
      if (observed.expired) return yield* expired(observed.snapshot);
      const terminal = yield* options.persistence.decide(input, now);
      yield* handoff({
        decision: terminal.decision,
        executionId: terminal.executionId,
        presentationId: terminal.recorded.presentationId,
      });
      return terminal.recorded;
    });

  const cancel = (input: CancelActionApprovalInput) =>
    Effect.gen(function* () {
      const now = yield* options.now;
      const snapshot = yield* options.persistence.inspect(input.presentationId);
      if (snapshot.userId !== input.userId) {
        return yield* unauthorized(input.presentationId, input.userId);
      }
      const observed = yield* observeExpiry(snapshot, now);
      if (observed.expired) return yield* expired(observed.snapshot);
      const terminal = yield* options.persistence.cancel(input, now);
      yield* handoff({
        decision: "reject",
        executionId: terminal.executionId,
        presentationId: terminal.recorded.presentationId,
      });
      return terminal.recorded;
    });

  const observeExpiry = (snapshot: ApprovalSnapshot, observedAt: Date) => {
    const { presentation, status } = snapshot.found;
    if (
      !Predicate.isTagged(status, "Pending") ||
      observedAt.getTime() < presentation.expiresAt.getTime()
    ) {
      return Effect.succeed({ expired: false as const, snapshot });
    }
    return options.persistence
      .expire(presentation.presentationId, presentation.expiresAt)
      .pipe(
        Effect.map((expiredSnapshot) => ({ expired: true as const, snapshot: expiredSnapshot })),
      );
  };

  const handoff = (terminal: ApprovalTerminalDispatch) =>
    options.dispatch.dispatch(terminal).pipe(
      Effect.catchTag("ApprovalDispatchAmbiguous", (failure) =>
        options.now.pipe(
          Effect.flatMap((observedAt) =>
            options.persistence.markDispatchAmbiguous(terminal.presentationId, observedAt),
          ),
          Effect.andThen(Effect.fail(failure)),
        ),
      ),
      Effect.andThen(options.now),
      Effect.flatMap((dispatchedAt) =>
        options.persistence.markDispatched(terminal.presentationId, dispatchedAt),
      ),
    );

  const reconcile = options.persistence.readTerminalDispatches.pipe(
    Effect.flatMap((terminal) =>
      Effect.forEach(terminal, handoff, { concurrency: 1, discard: true }),
    ),
    Effect.catch(() =>
      Effect.logError("Approval handoff reconciliation remains pending").pipe(
        Effect.annotateLogs({ failureTag: "ApprovalHandoffFailure" }),
      ),
    ),
  );

  return {
    cancel,
    decide,
    prepare: options.persistence.prepare,
    read,
    reconcile,
  };
};

const authorizeActor = (
  actor: ReadActionPresentationInput["actor"],
  snapshot: ApprovalSnapshot,
  observedAt: Date,
) => {
  const invalidSession =
    Predicate.isTagged(actor, "AuthSession") && actor.expiresAt.getTime() <= observedAt.getTime();
  return actor.userId === snapshot.userId && !invalidSession
    ? Effect.void
    : Effect.fail(unauthorized(snapshot.found.presentation.presentationId, actor.userId));
};

const unauthorized = (presentationId: ActionPresentationId, userId: UserId) =>
  new ApprovalActorUnauthorized({
    message: "The current authenticated authority cannot access this Action Presentation",
    presentationId,
    userId,
  });

const expired = (snapshot: ApprovalSnapshot) =>
  Effect.fail(
    new ApprovalExpired({
      expiredAt: snapshot.found.presentation.expiresAt,
      message: "The Approval Request expired before the operation",
      presentationId: snapshot.found.presentation.presentationId,
    }),
  );
