import { Effect, Schema } from "effect";

import type { AgentId, UserId } from "../domain";
import type { ActionId } from "../domain/action-execution";
import type { ApprovalPresentation } from "./authorization";
import { MemoryProvider } from "./memory-provider";

/** One fenced account still carrying a durable deletion obligation. */
export interface PendingAccountDeletion {
  readonly agentId: AgentId | null;
  readonly approvalActionId: ActionId;
  readonly approvalPresentation: ApprovalPresentation;
  readonly userId: UserId;
}

/** Classified retryable failure in the broader account deletion flow. */
export class AccountDeletionUnavailable extends Schema.TaggedError<AccountDeletionUnavailable>()(
  "AccountDeletionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Deletion-owned boundaries applied only after provider knowledge confirms permanent absence. */
export interface Dependencies {
  /** Recheck the still-pending self-service Deletion Case immediately before provider use. */
  readonly authorize: (
    candidate: PendingAccountDeletion,
  ) => Effect.Effect<boolean, AccountDeletionUnavailable>;
  readonly agents: {
    /** Fence new provider appends and wait for any provider append already in flight. */
    readonly quiesce: (
      agentId: AgentId,
      userId: UserId,
    ) => Effect.Effect<void, AccountDeletionUnavailable>;
    readonly remove: (agentId: AgentId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly objects: {
    readonly remove: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
  readonly persistence: {
    readonly pending: Effect.Effect<
      ReadonlyArray<PendingAccountDeletion>,
      AccountDeletionUnavailable
    >;
    readonly removeUser: (userId: UserId) => Effect.Effect<void, AccountDeletionUnavailable>;
  };
}

/** Construct the idempotent provider-first account deletion reconciler. */
export const make = (dependencies: Dependencies) => {
  const reconcileOne = Effect.fn("AccountDeletion.reconcileOne")(function* (
    candidate: PendingAccountDeletion,
  ) {
    const authorized = yield* dependencies.authorize(candidate);
    if (!authorized) {
      return yield* new AccountDeletionUnavailable({
        cause: candidate.userId,
        message: "The durable account-deletion authority is no longer current",
        operation: "recheckDeletionAuthority",
      });
    }
    if (candidate.agentId !== null) {
      yield* dependencies.agents.quiesce(candidate.agentId, candidate.userId);
    }
    const stillAuthorized = yield* dependencies.authorize(candidate);
    if (!stillAuthorized) {
      return yield* new AccountDeletionUnavailable({
        cause: candidate.userId,
        message: "The durable account-deletion authority changed during provider quiescence",
        operation: "recheckDeletionAuthority",
      });
    }
    const provider = yield* MemoryProvider.Service;
    yield* provider.deleteUserKnowledge({ userId: candidate.userId }).pipe(
      Effect.mapError(
        (cause) =>
          new AccountDeletionUnavailable({
            cause,
            message: "Provider knowledge deletion remains pending",
            operation: "deleteProviderKnowledge",
          }),
      ),
    );
    yield* dependencies.objects.remove(candidate.userId);
    if (candidate.agentId !== null) yield* dependencies.agents.remove(candidate.agentId);
    yield* dependencies.persistence.removeUser(candidate.userId);
    return undefined;
  });

  const reconcilePending = dependencies.persistence.pending.pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(
        pending,
        (candidate) =>
          reconcileOne(candidate).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Account deletion remains pending").pipe(
                Effect.annotateLogs({ cause, userId: candidate.userId }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
  );

  const reconcileUser = Effect.fn("AccountDeletion.reconcileUser")(function* (userId: UserId) {
    const pending = yield* dependencies.persistence.pending;
    const candidate = pending.find((item) => item.userId === userId);
    if (candidate !== undefined) yield* reconcileOne(candidate);
    return undefined;
  });

  return { reconcileOne, reconcilePending, reconcileUser };
};

export * as AccountDeletion from "./account-deletion";
