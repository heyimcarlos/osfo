import { Effect, Predicate, Result, Schema } from "effect";

import { ActionId } from "../domain/action-execution";
import type { ActionExecutionResult } from "../domain/action-execution";
import { AuthorizationOperation } from "../domain/authorization-operation";
import type { AuthorizationOperationInput } from "../domain/authorization-operation";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";

/** Execute a Think-approved Action only after its current authority passes Osfo recheck. */
export const executeApprovedAction = (
  authorization: Authorization,
  context: AuthorizationContext,
  operationInput: AuthorizationOperationInput,
  contactProvider: (actionId: ActionId) => Effect.Effect<ActionExecutionResult>,
): Effect.Effect<ActionExecutionResult | Denied> => {
  const operation = Schema.decodeUnknownResult(AuthorizationOperation)(operationInput);
  if (Result.isFailure(operation)) {
    return Effect.succeed({ _tag: "Denied", reason: "unknownOperation", resetAt: null });
  }
  const actionId = ActionId.make(operation.success.actionId);
  return Effect.gen(function* () {
    const recheck = authorization.recheck(
      {
        ...context,
        approval: {
          actionId,
          operation: operation.success.kind,
          userId: context.user.userId,
        },
      },
      operationInput,
    );
    if (Predicate.isTagged(recheck, "Denied")) return recheck;
    return yield* contactProvider(actionId);
  });
};
