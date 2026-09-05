import { Effect, Predicate } from "effect";

import type { AgentId, UserId } from "../domain";
import { DeletionCasePostgres } from "../integrations/postgres/deletion-case";
import { AccountDeletion } from "../services/account-deletion";
import { AgentDirectory } from "../services/agent-directory";

/** Require the exact Agent owner and a retained deletion fence at the storage boundary. */
export const authorizeErasure = Effect.fn("AccountDeletionAgent.authorizeErasure")(function* (
  agentId: AgentId,
  userId: UserId,
) {
  const directory = yield* AgentDirectory.make;
  const cases = yield* DeletionCasePostgres.make;
  const owner = yield* directory.resolveAgent(agentId);
  const access = yield* cases.inspect(userId);
  if (owner.userId !== userId || !Predicate.isTagged(access, "DeletionAccessRevoked")) {
    return yield* new AccountDeletion.AccountDeletionUnavailable({
      cause: "Agent owner or account deletion fence changed",
      message: "Agent storage erasure requires the exact deleting owner",
      operation: "eraseAgentStorage",
    });
  }
  return yield* Effect.void;
});

export * as AccountDeletionAgent from "./account-deletion-agent";
