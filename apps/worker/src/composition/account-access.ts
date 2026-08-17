import { Effect } from "effect";

import type { UserId } from "../domain";
import * as DeletionCasePostgres from "../integrations/postgres/deletion-case";
import * as UserSuspensionPostgres from "../integrations/postgres/user-suspension";
import * as AccountAccess from "../services/account-access";

/** Build the request-scoped account access check from its two authority owners. */
export const make = Effect.gen(function* () {
  const deletionCases = yield* DeletionCasePostgres.make;
  const userSuspensions = yield* UserSuspensionPostgres.make;

  return (userId: UserId) => AccountAccess.canAccess(userSuspensions, deletionCases, userId);
});
