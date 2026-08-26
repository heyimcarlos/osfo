import { Effect, Result } from "effect";

import type { ConversationRouteId, SessionId } from "../../domain";
import type { DbTimestamp } from "../../db";
import { CurrentSessionReplacementConflict } from "../../services/session-replacement";

export interface SessionReplacementGeneration {
  readonly expectedCurrentSessionId: SessionId;
  readonly replacedAt: DbTimestamp;
  readonly replacementSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

export interface LocalSessionDeletionDependencies<A, E> {
  readonly activateCurrentSession: Effect.Effect<void, E>;
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Each destructive boundary must construct and execute a fresh current-authority recheck.
  readonly authorizeDeletion: () => Effect.Effect<void, E>;
  readonly clearMessages: (sessionId: SessionId) => Effect.Effect<void, E>;
  readonly inspect: Effect.Effect<
    { readonly currentSessionId: SessionId; readonly routeId: ConversationRouteId },
    E
  >;
  readonly ownsSession: (sessionId: SessionId) => Effect.Effect<boolean, E>;
  readonly readReplacementGeneration?: (
    historicalSessionId: SessionId,
    replacementSessionId: SessionId,
  ) => Effect.Effect<SessionReplacementGeneration, E>;
  readonly replacedAt: Effect.Effect<DbTimestamp, E>;
  readonly replaceCurrentSession: (input: {
    readonly expectedCurrentSessionId: SessionId;
    readonly replacedAt: DbTimestamp;
    readonly replacementSessionId: SessionId;
    readonly routeId: ConversationRouteId;
  }) => Effect.Effect<unknown, E>;
  readonly rollbackCurrentSessionReplacement: (input: {
    readonly expectedCurrentSessionId: SessionId;
    readonly replacedAt: DbTimestamp;
    readonly replacementSessionId: SessionId;
    readonly routeId: ConversationRouteId;
  }) => Effect.Effect<void, E>;
  readonly settle: (
    sessionId: SessionId,
    replacementGeneration?: SessionReplacementGeneration,
  ) => Effect.Effect<A, E>;
}

/** Replace a current Session first, clear its complete Think history, then settle ownership. */
export const deleteLocalSession = Effect.fn("SessionDeletion.deleteLocalSession")(function* <A, E>(
  input: { readonly replacementSessionId: SessionId; readonly sessionId: SessionId },
  dependencies: LocalSessionDeletionDependencies<A, E>,
) {
  const owned = yield* dependencies.ownsSession(input.sessionId);
  if (!owned) return yield* dependencies.settle(input.sessionId);
  const agent = yield* dependencies.inspect;
  if (agent.currentSessionId === input.sessionId) {
    const replacedAt = yield* dependencies.replacedAt;
    yield* dependencies.authorizeDeletion();
    const replacement = {
      expectedCurrentSessionId: input.sessionId,
      replacedAt,
      replacementSessionId: input.replacementSessionId,
      routeId: agent.routeId,
    };
    yield* dependencies.replaceCurrentSession(replacement);
    const rollbackAfter = (failure: E) =>
      Effect.gen(function* () {
        yield* dependencies.authorizeDeletion();
        yield* dependencies.rollbackCurrentSessionReplacement(replacement);
        return yield* Effect.fail(failure);
      });

    yield* dependencies.authorizeDeletion();
    const activation = yield* dependencies.activateCurrentSession.pipe(Effect.result);
    if (Result.isFailure(activation)) return yield* rollbackAfter(activation.failure);

    yield* dependencies.authorizeDeletion();
    const clearing = yield* dependencies.clearMessages(input.sessionId).pipe(Effect.result);
    if (Result.isFailure(clearing)) return yield* rollbackAfter(clearing.failure);

    yield* dependencies.authorizeDeletion();
    const settlement = yield* dependencies.settle(input.sessionId, replacement).pipe(Effect.result);
    if (Result.isFailure(settlement)) {
      return yield* rollbackAfter(settlement.failure);
    }
    return settlement.success;
  }
  if (
    isSessionDeletionReplacement(agent.currentSessionId) &&
    agent.currentSessionId !== input.replacementSessionId
  ) {
    return yield* new CurrentSessionReplacementConflict({
      actualCurrentSessionId: agent.currentSessionId,
      expectedCurrentSessionId: input.sessionId,
      message: "A different deletion Action owns the current replacement Session",
      replacementOwnerRouteId: agent.routeId,
      replacementSessionId: input.replacementSessionId,
      routeId: agent.routeId,
    });
  }
  if (agent.currentSessionId === input.replacementSessionId) {
    if (dependencies.readReplacementGeneration === undefined) {
      return yield* new CurrentSessionReplacementConflict({
        actualCurrentSessionId: agent.currentSessionId,
        expectedCurrentSessionId: input.sessionId,
        message: "The exact replacement generation is unavailable",
        replacementOwnerRouteId: agent.routeId,
        replacementSessionId: input.replacementSessionId,
        routeId: agent.routeId,
      });
    }
    const replacementGeneration = yield* dependencies.readReplacementGeneration(
      input.sessionId,
      input.replacementSessionId,
    );
    yield* dependencies.authorizeDeletion();
    yield* dependencies.clearMessages(input.sessionId);
    yield* dependencies.authorizeDeletion();
    return yield* dependencies.settle(input.sessionId, replacementGeneration);
  }
  yield* dependencies.authorizeDeletion();
  yield* dependencies.clearMessages(input.sessionId);
  yield* dependencies.authorizeDeletion();
  return yield* dependencies.settle(input.sessionId);
});

const isSessionDeletionReplacement = (sessionId: SessionId) =>
  sessionId.startsWith("session-delete-");

export * as SessionDeletion from "./session-deletion";
