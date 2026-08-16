import { Effect, Predicate, Schema } from "effect";

import { ActionId } from "../domain/action-execution";
import type { ActionExecutionResult } from "../domain/action-execution";
import { AuthorizationOperation } from "../domain/authorization-operation";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";

/** Exact Action execution that Think released from one durable Approval. */
export const ThinkApprovedActionExecution = Schema.TaggedStruct("ThinkApprovedActionExecution", {
  actionId: ActionId,
  operation: Schema.Literal("gmail.send"),
});

/** Exact Action execution that Think released from one durable Approval. */
export type ThinkApprovedActionExecution = typeof ThinkApprovedActionExecution.Type;

/** Execute a Think-approved Action only after its current authority passes Osfo recheck. */
export const executeThinkApprovedAction = (
  authorization: Authorization,
  context: AuthorizationContext,
  approvedExecution: ThinkApprovedActionExecution,
  contactProvider: (actionId: ActionId) => Effect.Effect<ActionExecutionResult>,
): Effect.Effect<ActionExecutionResult | Denied> => {
  const operation = AuthorizationOperation.make({
    actionId: approvedExecution.actionId,
    kind: approvedExecution.operation,
  });
  return Effect.gen(function* () {
    const recheck = authorization.recheck(
      {
        ...context,
        approval: {
          actionId: approvedExecution.actionId,
          operation: approvedExecution.operation,
          userId: context.user.userId,
        },
      },
      operation,
    );
    if (Predicate.isTagged(recheck, "Denied")) return recheck;
    return yield* contactProvider(approvedExecution.actionId);
  });
};
