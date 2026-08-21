import { Effect } from "effect";

import { AuthSessionAdapter } from "../integrations/auth/auth-session";
import { DeletionCasePostgres } from "../integrations/postgres/deletion-case";
import { UserSuspensionPostgres } from "../integrations/postgres/user-suspension";
import { AuthSession } from "../services/auth-session";
import { DeletionCase } from "../services/deletion-case";
import { UserSuspension } from "../services/user-suspension";

/** Current separate authorities composed for request authentication and protected effects. */
export interface Interface {
  readonly authSessions: AuthSession.Interface;
  readonly deletionCases: DeletionCase.Interface;
  readonly userSuspensions: UserSuspension.Interface;
}

/** Construct separate request-scoped account authorities from their owner-specific adapters. */
export const make = Effect.gen(function* () {
  const authSessionStore = yield* AuthSessionAdapter.make;
  const authSessions = yield* AuthSession.make.pipe(
    Effect.provideService(AuthSession.Store, authSessionStore),
  );
  const deletionPersistence = yield* DeletionCasePostgres.make;
  const deletionCases = yield* DeletionCase.make.pipe(
    Effect.provideService(AuthSession.Service, authSessions),
    Effect.provideService(DeletionCase.Persistence, deletionPersistence),
  );
  const userSuspensionPersistence = yield* UserSuspensionPostgres.make;
  const userSuspensions = yield* UserSuspension.make.pipe(
    Effect.provideService(UserSuspension.Persistence, userSuspensionPersistence),
  );
  return {
    authSessions,
    deletionCases,
    userSuspensions,
  } satisfies Interface;
});

export * as AccountAuthorities from "./account-authorities";
