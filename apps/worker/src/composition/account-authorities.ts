import { Effect } from "effect";

import * as AuthSessionAdapter from "../integrations/auth/auth-session";
import * as ChannelBindingPostgres from "../integrations/postgres/channel-binding";
import * as DeletionCasePostgres from "../integrations/postgres/deletion-case";
import * as UserSuspensionPostgres from "../integrations/postgres/user-suspension";
import * as AuthSession from "../services/auth-session";
import type * as ChannelBinding from "../services/channel-binding";
import * as DeletionCase from "../services/deletion-case";
import * as UserSuspension from "../services/user-suspension";

/** Current separate authorities composed for request authentication and protected effects. */
export interface AccountAuthorities {
  readonly authSessions: AuthSession.Interface;
  readonly channelBindings: ChannelBinding.Interface;
  readonly deletionCases: DeletionCase.Interface;
  readonly userSuspensions: UserSuspension.Interface;
}

/** Construct separate request-scoped account authorities from their owner-specific adapters. */
export const make = Effect.gen(function* () {
  const authSessionStore = yield* AuthSessionAdapter.make;
  const channelBindings = yield* ChannelBindingPostgres.make;
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
    channelBindings,
    deletionCases,
    userSuspensions,
  } satisfies AccountAuthorities;
});
