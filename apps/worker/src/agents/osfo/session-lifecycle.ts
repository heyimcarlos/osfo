import { DateTime, Effect, Predicate } from "effect";

import { DbTimestamp } from "../../db";
import { makeSessionReplacement } from "../../services/session-replacement";
import type { makeAgentStore } from "./db/store";
import {
  activateCurrentSession,
  readSessionRoute,
  translateSessionLifecycleFailure,
} from "./session-lifecycle-adapter";

/** Concrete Agent dependencies adapted to Session replacement ports. */
export interface AgentSessionLifecycleDependencies {
  readonly activateCurrentSession: () => Promise<void>;
  readonly store: Pick<ReturnType<typeof makeAgentStore>, "readRoute" | "replaceCurrentSession">;
}

/** Adapt Agent SQLite and Think activation to application-owned Session replacement ports. */
export const makeAgentSessionLifecycle = (dependencies: AgentSessionLifecycleDependencies) =>
  makeSessionReplacement({
    activateCurrent: activateCurrentSession(
      dependencies.activateCurrentSession,
      "Think could not activate the current Session",
    ),
    now: DateTime.now,
    store: {
      readRoute: (routeId) => readSessionRoute(dependencies.store, routeId),
      replaceCurrent: (input) =>
        dependencies.store
          .replaceCurrentSession({
            ...input,
            replacedAt: DbTimestamp.make(DateTime.formatIso(input.replacedAt)),
          })
          .pipe(
            Effect.mapError((failure) =>
              Predicate.isTagged(failure, "CurrentSessionReplacementConflict")
                ? failure
                : translateSessionLifecycleFailure("replaceCurrentSession", failure),
            ),
          ),
    },
  });
