import { Effect } from "effect";

import type { UserId } from "../domain";
import { DeletionCasePostgres } from "../integrations/postgres/deletion-case";
import { UserSuspensionPostgres } from "../integrations/postgres/user-suspension";
import { AccountAccess } from "../services/account-access";

/** Request-scoped account access capability shared by authentication checks. */
export type Check = (userId: UserId) => ReturnType<typeof AccountAccess.canAccess>;

/** Build the request-scoped account access check from its two authority owners. */
export const make = Effect.gen(function* () {
  const deletionCases = yield* DeletionCasePostgres.make;
  const userSuspensions = yield* UserSuspensionPostgres.make;

  return (userId: UserId) => AccountAccess.canAccess(userSuspensions, deletionCases, userId);
});

export * as AccountAccess from "./account-access";
