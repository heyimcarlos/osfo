import { Effect, Predicate } from "effect";

import { CurrentSessionActivationUnavailable } from "../../services/session-replacement";
import type { ConversationRouteId } from "../../domain";
import {
  SessionLifecycleNotFound,
  SessionLifecycleUnavailable,
} from "../../services/session-lifecycle";
import type {
  AgentStateNotFound,
  AgentStoreRecordInvalid,
  AgentStoreUnavailable,
} from "./db/errors";
import type { makeAgentStore } from "./db/store";

type StoreFailure = AgentStateNotFound | AgentStoreRecordInvalid | AgentStoreUnavailable;

/** Adapt Think current-Session activation to the application-owned typed failure. */
export const activateCurrentSession = (activate: () => Promise<void>, message: string) =>
  Effect.tryPromise({
    try: activate,
    catch: (cause) => new CurrentSessionActivationUnavailable({ cause, message }),
  });

/** Preserve exact Agent SQLite lifecycle operation context at the adapter boundary. */
export const translateSessionLifecycleFailure = (
  operation: "readRoute" | "replaceCurrentSession",
  failure: StoreFailure,
): SessionLifecycleNotFound | SessionLifecycleUnavailable =>
  Predicate.isTagged(failure, "AgentStateNotFound")
    ? new SessionLifecycleNotFound({
        message: failure.message,
        subject: failure.subject === "agent" ? "agent" : "route",
      })
    : new SessionLifecycleUnavailable({
        cause: failure,
        message: "Agent-owned Session lifecycle storage is unavailable",
        operation,
      });

/** Read one Agent-owned Session route with shared application failure translation. */
export const readSessionRoute = (
  store: Pick<ReturnType<typeof makeAgentStore>, "readRoute">,
  routeId: ConversationRouteId,
) =>
  store.readRoute(routeId).pipe(
    Effect.mapError((failure) => translateSessionLifecycleFailure("readRoute", failure)),
    Effect.map(({ currentSessionId, historicalSessionIds, routeId: foundRouteId }) => ({
      currentSessionId,
      historicalSessionIds,
      routeId: foundRouteId,
    })),
  );
