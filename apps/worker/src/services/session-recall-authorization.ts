import { Effect, Predicate, Schema } from "effect";

import type { ConversationRouteId, SessionId } from "../domain";
import { retainedCatalog } from "../domain/plan-policy";
import type {
  ManagedTurnAuthorityIdentity,
  ManagedTurnMetadata,
} from "../domain/managed-conversation";
import { AuthorizationContext, make as makeAuthorization } from "./authorization";
import {
  SessionRecallAuthorizationDenied,
  type SessionRecallAuthorizationUnavailable,
} from "./session-recall";

/** Current mutable facts required by Session Recall authorization. */
export const SessionRecallCurrentAuthorizationFacts = Schema.Struct({
  authority: AuthorizationContext.fields.authority,
  deletionAccess: AuthorizationContext.fields.deletionAccess,
  now: AuthorizationContext.fields.now,
  resourceOwnerUserId: AuthorizationContext.fields.resourceOwnerUserId,
  subscription: AuthorizationContext.fields.subscription,
  user: AuthorizationContext.fields.user,
});

/** Current mutable facts required by Session Recall authorization. */
export type SessionRecallCurrentAuthorizationFacts =
  typeof SessionRecallCurrentAuthorizationFacts.Type;

/** Dependencies for current Session Recall authorization. */
export interface SessionRecallAuthorizationDependencies {
  readonly inspectAuthorization: (
    identity: ManagedTurnAuthorityIdentity,
  ) => Effect.Effect<SessionRecallCurrentAuthorizationFacts, SessionRecallAuthorizationUnavailable>;
  readonly readCurrentSession: (
    routeId: ConversationRouteId,
  ) => Effect.Effect<SessionId, SessionRecallAuthorizationUnavailable>;
}

/** Current protected-effect authorization for a model-invoked Session Recall. */
export interface SessionRecallAuthorization {
  readonly authorize: (
    metadata: ManagedTurnMetadata,
  ) => Effect.Effect<
    void,
    SessionRecallAuthorizationDenied | SessionRecallAuthorizationUnavailable
  >;
}

/** Construct current Session Recall authorization from narrow fact ports. */
export const makeSessionRecallAuthorization = (
  dependencies: SessionRecallAuthorizationDependencies,
): SessionRecallAuthorization => ({
  authorize: (metadata) =>
    Effect.gen(function* () {
      const currentSessionId = yield* dependencies.readCurrentSession(metadata.routeId);
      if (currentSessionId !== metadata.sessionId) {
        return yield* new SessionRecallAuthorizationDenied({
          message: "Session Recall is no longer authorized for the active Session",
          reason: "authorityMismatch",
          routeId: metadata.routeId,
          sessionId: metadata.sessionId,
        });
      }
      const facts = yield* dependencies.inspectAuthorization(metadata.authorityIdentity);
      const { userId: _userId, ...originatingAuthority } = metadata.authorityIdentity;
      const result = makeAuthorization(retainedCatalog).recheck(
        AuthorizationContext.make({
          allowance: { _tag: "Unavailable" },
          approval: null,
          ...facts,
          gmailConnection: null,
          liveFacts: {
            activeGmSummonsInSession: 0n,
            activeReminders: 0n,
            concurrentWorkflows: 0n,
            retainedFileBytes: 0n,
          },
          originatingAuthority,
          requestVendorUsdMicros: 0n,
        }),
        { actionId: metadata.submissionId, kind: "session.recall" },
      );
      if (Predicate.isTagged(result, "Denied")) {
        return yield* new SessionRecallAuthorizationDenied({
          message: "Session Recall is no longer authorized",
          reason: result.reason,
          routeId: metadata.routeId,
          sessionId: metadata.sessionId,
        });
      }
      return undefined;
    }),
});
