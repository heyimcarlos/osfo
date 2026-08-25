import { Effect } from "effect";

import type { ConversationRouteId, SessionId } from "../../domain";
import type { DbTimestamp } from "../../db";

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
  readonly replacedAt: Effect.Effect<DbTimestamp, E>;
  readonly replaceCurrentSession: (input: {
    readonly expectedCurrentSessionId: SessionId;
    readonly replacedAt: DbTimestamp;
    readonly replacementSessionId: SessionId;
    readonly routeId: ConversationRouteId;
  }) => Effect.Effect<unknown, E>;
  readonly settle: (sessionId: SessionId) => Effect.Effect<A, E>;
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
    yield* dependencies.replaceCurrentSession({
      expectedCurrentSessionId: input.sessionId,
      replacedAt,
      replacementSessionId: input.replacementSessionId,
      routeId: agent.routeId,
    });
    yield* dependencies.activateCurrentSession;
  }
  yield* dependencies.authorizeDeletion();
  yield* dependencies.clearMessages(input.sessionId);
  yield* dependencies.authorizeDeletion();
  return yield* dependencies.settle(input.sessionId);
});

export * as SessionDeletion from "./session-deletion";
