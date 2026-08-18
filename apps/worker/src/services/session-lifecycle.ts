import { Effect, Schema } from "effect";

import type { AgentId, ConversationRouteId, SessionId } from "../domain";

/** Expected failure when Agent-owned Session lifecycle state does not exist. */
export class SessionLifecycleNotFound extends Schema.TaggedError<SessionLifecycleNotFound>()(
  "SessionLifecycleNotFound",
  { message: Schema.String, subject: Schema.Literals(["agent", "route"]) },
) {}

/** Expected failure when Agent-owned Session lifecycle storage is unavailable or invalid. */
export class SessionLifecycleUnavailable extends Schema.TaggedError<SessionLifecycleUnavailable>()(
  "SessionLifecycleUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["inspect", "readRoute", "replaceCurrentSession"]),
  },
) {}

/** Agent ownership and current Session facts consumed by launch Authorization callers. */
export interface SessionAuthorizationFactsFound {
  readonly _tag: "SessionAuthorizationFactsFound";
  readonly agentId: AgentId;
  readonly currentSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

/** Narrow persistence port for Session lifecycle authorization reads. */
export interface SessionLifecycleStore {
  readonly inspect: Effect.Effect<
    { readonly agentId: AgentId },
    SessionLifecycleNotFound | SessionLifecycleUnavailable
  >;
  readonly readRoute: (
    routeId: ConversationRouteId,
  ) => Effect.Effect<
    { readonly currentSessionId: SessionId; readonly routeId: ConversationRouteId },
    SessionLifecycleNotFound | SessionLifecycleUnavailable
  >;
}

/** Focused Session lifecycle authorization policy. */
export interface SessionLifecycle {
  readonly readAuthorizationFacts: (
    routeId: ConversationRouteId,
  ) => Effect.Effect<
    SessionAuthorizationFactsFound,
    SessionLifecycleNotFound | SessionLifecycleUnavailable
  >;
}

/** Construct the Session lifecycle authorization policy. */
export const makeSessionLifecycle = (store: SessionLifecycleStore): SessionLifecycle => ({
  readAuthorizationFacts: (routeId) =>
    Effect.gen(function* () {
      const agent = yield* store.inspect;
      const route = yield* store.readRoute(routeId);
      return {
        _tag: "SessionAuthorizationFactsFound",
        agentId: agent.agentId,
        currentSessionId: route.currentSessionId,
        routeId: route.routeId,
      } as const;
    }),
});
