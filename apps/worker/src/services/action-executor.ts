import { Effect, Predicate, Result, Schema } from "effect";

import {
  ActionId,
  type ActionNotApproved,
  type CommittedApprovedAction,
} from "../domain/action-approval";
import type { ActionExecutionResult } from "../domain/action-execution";
import { AuthorizationOperation } from "../domain/authorization-operation";
import type { AuthorizationOperationInput } from "../domain/authorization-operation";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";

/** Narrow persisted Approval port required by protected Action execution. */
export interface ApprovedActionReader {
  readonly readApproved: (
    actionId: ActionId,
  ) => Effect.Effect<CommittedApprovedAction, ActionNotApproved>;
}

/** Execute a committed Action only after its original acting authority passes current recheck. */
export const executeAuthorizedAction = (
  approvals: ApprovedActionReader,
  authorization: Authorization,
  context: AuthorizationContext,
  operationInput: AuthorizationOperationInput,
  contactProvider: (actionId: ActionId) => Effect.Effect<ActionExecutionResult>,
): Effect.Effect<ActionExecutionResult | Denied, ActionNotApproved> => {
  const operation = Schema.decodeUnknownResult(AuthorizationOperation)(operationInput);
  if (Result.isFailure(operation)) {
    return Effect.succeed({ _tag: "Denied", reason: "unknownOperation", resetAt: null });
  }
  const actionId = ActionId.make(operation.success.actionId);
  return Effect.gen(function* () {
    const approved = yield* approvals.readApproved(actionId);
    if (approved.operation !== operation.success.kind || approved.userId !== context.user.userId) {
      return {
        _tag: "Denied",
        reason: "approvalRequired",
        resetAt: null,
      } satisfies Denied;
    }
    const recheck = authorization.recheck(
      {
        ...context,
        approval: {
          actionId: approved.actionId,
          operation: approved.operation,
          userId: approved.userId,
        },
        originatingAuthority: approved.originatingAuthority,
      },
      operationInput,
    );
    if (Predicate.isTagged(recheck, "Denied")) return recheck;
    return yield* contactProvider(actionId);
  });
};
