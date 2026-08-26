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

export interface LocalSessionDeletionDependencies<A, E, PreparedSession> {
  readonly activateSession: (sessionId: SessionId) => Effect.Effect<void, E>;
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Each destructive boundary must construct and execute a fresh current-authority recheck.
  readonly authorizeDeletion: () => Effect.Effect<void, E>;
  readonly clearMessages: (sessionId: SessionId) => Effect.Effect<void, E>;
  readonly inspectSession: (sessionId: SessionId) => Effect.Effect<
    | {
        readonly currentReplacesTarget?: boolean;
        readonly currentSessionId: SessionId;
        readonly routeId: ConversationRouteId;
      }
    | undefined,
    E
  >;
  readonly prepareSession: (sessionId: SessionId) => Effect.Effect<PreparedSession, E>;
  readonly readReplacementGeneration?: (
    historicalSessionId: SessionId,
    replacementSessionId: SessionId,
  ) => Effect.Effect<SessionReplacementGeneration, E>;
  readonly replacedAt: Effect.Effect<DbTimestamp, E>;
  readonly retainIntent: (
    sessionId: SessionId,
    replacementGeneration?: SessionReplacementGeneration,
  ) => Effect.Effect<void, E>;
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
  readonly selectSessionForWrites: (prepared: PreparedSession) => Effect.Effect<void>;
  readonly settle: (
    sessionId: SessionId,
    replacementGeneration?: SessionReplacementGeneration,
  ) => Effect.Effect<A, E>;
}

/** Replace a current Session first, clear its complete Think history, then settle ownership. */
export const deleteLocalSession = Effect.fn("SessionDeletion.deleteLocalSession")(function* <
  A,
  E,
  PreparedSession,
>(
  input: { readonly replacementSessionId: SessionId; readonly sessionId: SessionId },
  dependencies: LocalSessionDeletionDependencies<A, E, PreparedSession>,
) {
  const target = yield* dependencies.inspectSession(input.sessionId);
  if (target === undefined) return yield* dependencies.settle(input.sessionId);
  if (target.currentSessionId === input.sessionId) {
    const [historicalSession, replacementSession] = yield* Effect.all([
      dependencies.prepareSession(input.sessionId),
      dependencies.prepareSession(input.replacementSessionId),
    ]);
    const replacedAt = yield* dependencies.replacedAt;
    yield* dependencies.authorizeDeletion();
    const replacement = {
      expectedCurrentSessionId: input.sessionId,
      replacedAt,
      replacementSessionId: input.replacementSessionId,
      routeId: target.routeId,
    };
    yield* dependencies.replaceCurrentSession(replacement);
    // Think's base writers dereference the mutable Session at write time. Select the
    // exact replacement synchronously after SQLite commits so this turn cannot append
    // its failure or assistant output to the now-historical Session.
    yield* dependencies.selectSessionForWrites(replacementSession);
    const rollbackAfter = (failure: E) =>
      Effect.gen(function* () {
        yield* dependencies.authorizeDeletion();
        yield* dependencies.rollbackCurrentSessionReplacement(replacement);
        // SQLite is now safely resumable even if authority changes before Think can follow it.
        yield* dependencies.authorizeDeletion();
        yield* dependencies.selectSessionForWrites(historicalSession);
        yield* dependencies.activateSession(input.sessionId);
        return yield* Effect.fail(failure);
      });

    yield* dependencies.authorizeDeletion();
    const activation = yield* dependencies
      .activateSession(input.replacementSessionId)
      .pipe(Effect.result);
    if (Result.isFailure(activation)) return yield* rollbackAfter(activation.failure);

    yield* dependencies.authorizeDeletion();
    yield* dependencies.retainIntent(input.sessionId, replacement);
    yield* dependencies.authorizeDeletion();
    yield* dependencies.clearMessages(input.sessionId);

    yield* dependencies.authorizeDeletion();
    return yield* dependencies.settle(input.sessionId, replacement);
  }
  if (
    target.currentReplacesTarget === true &&
    target.currentSessionId !== input.replacementSessionId
  ) {
    return yield* new CurrentSessionReplacementConflict({
      actualCurrentSessionId: target.currentSessionId,
      expectedCurrentSessionId: input.sessionId,
      message: "A different deletion Action owns the current replacement Session",
      replacementOwnerRouteId: target.routeId,
      replacementSessionId: input.replacementSessionId,
      routeId: target.routeId,
    });
  }
  if (target.currentSessionId === input.replacementSessionId) {
    if (dependencies.readReplacementGeneration === undefined) {
      return yield* new CurrentSessionReplacementConflict({
        actualCurrentSessionId: target.currentSessionId,
        expectedCurrentSessionId: input.sessionId,
        message: "The exact replacement generation is unavailable",
        replacementOwnerRouteId: target.routeId,
        replacementSessionId: input.replacementSessionId,
        routeId: target.routeId,
      });
    }
    const replacementGeneration = yield* dependencies.readReplacementGeneration(
      input.sessionId,
      input.replacementSessionId,
    );
    const replacementSession = yield* dependencies.prepareSession(input.replacementSessionId);
    yield* dependencies.selectSessionForWrites(replacementSession);
    yield* dependencies.authorizeDeletion();
    yield* dependencies.activateSession(input.replacementSessionId);
    yield* dependencies.authorizeDeletion();
    yield* dependencies.retainIntent(input.sessionId, replacementGeneration);
    yield* dependencies.authorizeDeletion();
    yield* dependencies.clearMessages(input.sessionId);
    yield* dependencies.authorizeDeletion();
    return yield* dependencies.settle(input.sessionId, replacementGeneration);
  }
  yield* dependencies.authorizeDeletion();
  yield* dependencies.retainIntent(input.sessionId);
  yield* dependencies.authorizeDeletion();
  yield* dependencies.clearMessages(input.sessionId);
  yield* dependencies.authorizeDeletion();
  return yield* dependencies.settle(input.sessionId);
});

export * as SessionDeletion from "./session-deletion";
