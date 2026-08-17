import { Effect, Schema, type DateTime } from "effect";

import { ConversationRouteId, SessionId } from "../domain";
import type { ManagedSessionReplacementAdmitted } from "./managed-conversation";
import type { SessionLifecycleNotFound, SessionLifecycleUnavailable } from "./session-lifecycle";

/** Application input for replacing one route current Session. */
export interface ReplaceCurrentSessionInput {
  readonly expectedCurrentSessionId: SessionId;
  readonly replacedAt: DateTime.Utc;
  readonly replacementSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

/** Successful replacement of one route current Session. */
export const CurrentSessionReplaced = Schema.TaggedStruct("CurrentSessionReplaced", {
  currentSessionId: SessionId,
  historicalSessionId: SessionId,
  routeId: ConversationRouteId,
});

/** Successful replacement of one route current Session. */
export type CurrentSessionReplaced = typeof CurrentSessionReplaced.Type;

/** Expected conflict when current Session state changed before replacement. */
export class CurrentSessionReplacementConflict extends Schema.TaggedError<CurrentSessionReplacementConflict>()(
  "CurrentSessionReplacementConflict",
  {
    actualCurrentSessionId: Schema.NullOr(SessionId),
    expectedCurrentSessionId: SessionId,
    message: Schema.String,
    replacementOwnerRouteId: Schema.NullOr(ConversationRouteId),
    replacementSessionId: SessionId,
    routeId: ConversationRouteId,
  },
) {}

/** Expected failure when Think cannot activate a committed replacement Session. */
export class CurrentSessionActivationUnavailable extends Schema.TaggedError<CurrentSessionActivationUnavailable>()(
  "CurrentSessionActivationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Application-owned persistence port for Session replacement. */
export interface SessionReplacementStore {
  readonly readRoute: (routeId: ConversationRouteId) => Effect.Effect<
    {
      readonly currentSessionId: SessionId;
      readonly historicalSessionIds: ReadonlyArray<SessionId>;
      readonly routeId: ConversationRouteId;
    },
    SessionLifecycleNotFound | SessionLifecycleUnavailable
  >;
  readonly replaceCurrent: (
    input: ReplaceCurrentSessionInput,
  ) => Effect.Effect<
    CurrentSessionReplaced,
    CurrentSessionReplacementConflict | SessionLifecycleNotFound | SessionLifecycleUnavailable
  >;
}

/** Application-owned dependencies for one authorized Session replacement. */
export interface SessionReplacementDependencies {
  readonly activateCurrent: Effect.Effect<void, CurrentSessionActivationUnavailable>;
  readonly now: Effect.Effect<DateTime.Utc>;
  readonly store: SessionReplacementStore;
}

/** Construct authorized Session replacement sequencing. */
export const makeSessionReplacement = (dependencies: SessionReplacementDependencies) => ({
  replaceCurrent: (command: ManagedSessionReplacementAdmitted) =>
    Effect.gen(function* () {
      const replacementSessionId = SessionId.make(`session-${command.submissionId}`);
      const route = yield* dependencies.store.readRoute(command.routeId);
      if (route.currentSessionId === replacementSessionId) {
        const historicalSessionId = route.historicalSessionIds.at(-1);
        if (historicalSessionId !== undefined) {
          yield* dependencies.activateCurrent;
          return CurrentSessionReplaced.make({
            currentSessionId: replacementSessionId,
            historicalSessionId,
            routeId: command.routeId,
          });
        }
      }
      const replacedAt = yield* dependencies.now;
      const replaced = yield* dependencies.store.replaceCurrent({
        expectedCurrentSessionId: route.currentSessionId,
        replacedAt,
        replacementSessionId,
        routeId: command.routeId,
      });
      yield* dependencies.activateCurrent;
      return replaced;
    }),
});
