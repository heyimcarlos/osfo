import { Effect, Predicate, Semaphore } from "effect";

import type { UserId } from "../domain";
import {
  ActionPresentationFound,
  ActionPresentationId,
  ActionPresentationsFound,
  ApprovalActorUnauthorized,
  ApprovalDecisionAccepted,
  type ActionPresentation,
  type ActionPresentationNotFound,
  type ActionPresentationUnavailable,
  type ApprovalActor,
  type ApprovalActorAuthorizationUnavailable,
  type ApprovalAlreadyResolved,
  type PendingThinkAction,
  type ThinkApprovalUnavailable,
} from "../agents/osfo/think-action-approvals";

/** Current Agent ownership check required before an Approval can be observed or changed. */
export interface ApprovalActorAuthorizer {
  readonly ownsAgent: (
    userId: UserId,
  ) => Effect.Effect<boolean, ApprovalActorAuthorizationUnavailable>;
}

/** Think-owned Approval lifecycle operations used by the application service. */
export interface ActionApprovalLifecycle {
  readonly listPending: Effect.Effect<ReadonlyArray<PendingThinkAction>, ThinkApprovalUnavailable>;
  readonly findPending: (
    presentationId: ActionPresentationId,
  ) => Effect.Effect<PendingThinkAction, ActionPresentationNotFound | ThinkApprovalUnavailable>;
  readonly resolve: (
    presentationId: ActionPresentationId,
    decision: "approved" | "rejected" | "canceled",
    reason?: string,
  ) => Effect.Effect<void, ApprovalAlreadyResolved | ThinkApprovalUnavailable>;
}

/** Project one registered Think Action into its definition-owned safe presentation. */
export type PresentAction = (
  pending: PendingThinkAction,
  userId: UserId,
) => Effect.Effect<ActionPresentation, ActionPresentationUnavailable>;

/** Durable first-write-wins storage for one immutable Action presentation. */
export interface ActionPresentationPersistence {
  readonly retain: (
    candidate: ActionPresentation,
  ) => Effect.Effect<ActionPresentation, ThinkApprovalUnavailable>;
}

export interface ActionApprovalSelection {
  readonly maximum: number;
  readonly select: (pending: PendingThinkAction) => boolean;
}

/** Apply Osfo authority and sequencing around Think's sole Approval lifecycle. */
export const makeActionApprovals = (options: {
  readonly authorizer: ApprovalActorAuthorizer;
  readonly lifecycle: ActionApprovalLifecycle;
  readonly now: Effect.Effect<Date>;
  readonly present: PresentAction;
  readonly presentations: ActionPresentationPersistence;
}) => {
  const decisionSemaphore = Semaphore.makeUnsafe(1);

  const authorize = Effect.fn("ActionApprovals.authorize")(function* (
    actor: ApprovalActor,
    presentationId: ActionPresentationId,
  ) {
    const now = yield* options.now;
    if (Predicate.isTagged(actor, "AuthSession") && actor.expiresAt.getTime() <= now.getTime()) {
      return yield* unauthorized(actor.userId, presentationId);
    }
    const ownsAgent = yield* options.authorizer.ownsAgent(actor.userId);
    if (!ownsAgent) return yield* unauthorized(actor.userId, presentationId);
    return undefined;
  });

  const read = Effect.fn("ActionApprovals.read")(function* (
    actor: ApprovalActor,
    presentationId: ActionPresentationId,
  ) {
    return yield* authorize(actor, presentationId).pipe(
      Effect.andThen(options.lifecycle.findPending(presentationId)),
      Effect.flatMap((pending) => options.present(pending, actor.userId)),
      Effect.flatMap(options.presentations.retain),
      Effect.map((presentation) => ActionPresentationFound.make({ presentation })),
    );
  });

  const dispatch = Effect.fn("ActionApprovals.dispatch")(function* (
    actor: ApprovalActor,
    presentationId: ActionPresentationId,
    decision: "approved" | "rejected" | "canceled",
    reason?: string,
  ) {
    return yield* authorize(actor, presentationId).pipe(
      Effect.andThen(options.lifecycle.findPending(presentationId)),
      Effect.andThen(options.lifecycle.resolve(presentationId, decision, reason)),
      Effect.as(ApprovalDecisionAccepted.make({ decision, presentationId })),
    );
  });

  const list = Effect.fn("ActionApprovals.list")(function* (
    actor: ApprovalActor,
    selection?: ActionApprovalSelection,
  ) {
    const pending = yield* options.lifecycle.listPending;
    yield* authorize(
      actor,
      pending[0]?.executionId ?? ActionPresentationId.make("pending-action-list"),
    );
    const selected =
      selection === undefined
        ? pending
        : pending.filter(selection.select).slice(0, selection.maximum);
    const presentations = yield* Effect.forEach(
      selected,
      (candidate) =>
        options.present(candidate, actor.userId).pipe(Effect.flatMap(options.presentations.retain)),
      { concurrency: 1 },
    );
    return ActionPresentationsFound.make({ presentations });
  });

  return {
    dispatch,
    list,
    read,
    /** Serialize the complete read, durable handoff, and Think claim for one User decision. */
    runDecision: <A, E, R>(effect: Effect.Effect<A, E, R>) => decisionSemaphore.withPermit(effect),
  };
};

const unauthorized = (userId: UserId, presentationId: ActionPresentationId) =>
  new ApprovalActorUnauthorized({
    message: "The authenticated actor does not own this Agent",
    presentationId,
    userId,
  });
