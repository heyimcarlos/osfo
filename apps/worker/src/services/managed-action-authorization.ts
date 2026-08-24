import { Effect } from "effect";

import type { AuthorizationOperation } from "../domain/authorization-operation";
import type { ManagedTurnAuthorityIdentity } from "../domain/managed-conversation";
import { retainedCatalog } from "../domain/plan-policy";
import {
  approvalFor,
  type ApprovalPresentation,
  Authorization,
  AuthorizationContext,
  emptyLiveResourceFacts,
} from "./authorization";
import type { SessionRecallCurrentAuthorizationFacts } from "./session-recall-authorization";

/** Current fact owner used immediately before a Think-approved managed Action executes. */
export interface ManagedActionAuthorizationDependencies<E> {
  readonly inspectAuthorization: (
    identity: ManagedTurnAuthorityIdentity,
  ) => Effect.Effect<SessionRecallCurrentAuthorizationFacts, E>;
}

/** Recheck one retained Approval against current authority at protected-effect time. */
export const makeManagedActionAuthorization = <E>(
  dependencies: ManagedActionAuthorizationDependencies<E>,
) => {
  const recheck = Effect.fn("ManagedActionAuthorization.recheck")(function* (
    identity: ManagedTurnAuthorityIdentity,
    operation: AuthorizationOperation,
    presentation: ApprovalPresentation,
  ) {
    const facts = yield* dependencies.inspectAuthorization(identity);
    const { userId: _userId, ...originatingAuthority } = identity;
    return Authorization.make(retainedCatalog).recheck(
      AuthorizationContext.make({
        allowance: { _tag: "Unavailable" },
        approval: approvalFor(facts.user.userId, operation, presentation),
        ...facts,
        gmailConnection: null,
        integrationConnections: [],
        liveFacts: emptyLiveResourceFacts,
        originatingAuthority,
        requestVendorUsdMicros: 0n,
      }),
      operation,
    );
  });

  return { recheck };
};

export * as ManagedActionAuthorization from "./managed-action-authorization";
