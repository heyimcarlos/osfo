import { DateTime, Effect, Predicate } from "effect";

import { DbTimestamp } from "../../db";
import { makeSessionCommand } from "../../services/session-command";
import type { makeAgentStore } from "./db/store";
import {
  activateCurrentSession,
  readSessionRoute,
  translateSessionLifecycleFailure,
} from "./session-lifecycle-adapter";

/** Concrete Agent dependencies adapted to the Session-command application port. */
export interface AgentSessionCommandDependencies {
  readonly activateCurrentSession: () => Promise<void>;
  readonly store: Pick<
    ReturnType<typeof makeAgentStore>,
    "readRoute" | "replaceCurrentSessionWithCommandReceipt"
  >;
}

/** Adapt Agent SQLite and Think activation to atomic Session commands. */
export const makeAgentSessionCommand = (dependencies: AgentSessionCommandDependencies) =>
  makeSessionCommand({
    activateCurrent: activateCurrentSession(
      dependencies.activateCurrentSession,
      "Think could not activate the accepted Session command",
    ),
    now: DateTime.now,
    store: {
      readRoute: (routeId) => readSessionRoute(dependencies.store, routeId),
      replaceCurrentWithCommandReceipt: (input) =>
        dependencies.store
          .replaceCurrentSessionWithCommandReceipt({
            ...input,
            replacedAt: DbTimestamp.make(DateTime.formatIso(input.replacedAt)),
          })
          .pipe(
            Effect.mapError((failure) =>
              Predicate.isTagged(failure, "CurrentSessionReplacementConflict") ||
              Predicate.isTagged(failure, "SessionCommandReceiptConflict")
                ? failure
                : translateSessionLifecycleFailure(
                    "replaceCurrentSessionWithCommandReceipt",
                    failure,
                  ),
            ),
          ),
    },
  });
