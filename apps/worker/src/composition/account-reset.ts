import { Effect } from "effect";

import type { AgentId, UserId } from "../domain";
import { AccountResetFence } from "../agents/osfo/account-reset-fence";
import { UserSuspensionPostgres } from "../integrations/postgres/user-suspension";
import { AgentDirectory } from "../services/agent-directory";

/** Only trusted internal RPC may prepare a currently suspended User's exact Agent for reset. */
export const authorize = Effect.fn("AccountReset.authorize")(function* (
  agentId: AgentId,
  userId: UserId,
) {
  const directory = yield* AgentDirectory.make;
  const suspensions = yield* UserSuspensionPostgres.make;
  const owner = yield* directory.resolveAgent(agentId);
  const user = yield* suspensions.inspect(userId);
  yield* AccountResetFence.requireResetAuthority(userId, owner.userId, user);
});

export * as AccountResetComposition from "./account-reset";
