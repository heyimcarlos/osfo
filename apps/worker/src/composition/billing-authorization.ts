import type { CurrentUserValue } from "@osfo/api";
import { DateTime, Effect, Schema } from "effect";

import { Db } from "../db";
import { inspectAndRepairBillingAuthorization } from "../db/billing/stripe-inspect";
import { type AllowancePeriodId, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import { DeletionCasePostgres } from "../integrations/postgres/deletion-case";
import { UserSuspensionPostgres } from "../integrations/postgres/user-suspension";
import { AuthSessionAdapter } from "../integrations/auth/auth-session";
import { AuthSession } from "../services/auth-session";
import { admit, type BillingOperation } from "../services/billing-authorization";

/* oxlint-disable effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- This composition boundary owns concrete PostgreSQL adapters and branches on Effect tags. */

/** Build the live billing authorization check from the current authority owners. */
export const make = (
  database: Db.Database,
  environment: {
    readonly allowancePeriodId: Effect.Effect<AllowancePeriodId>;
    readonly now: Effect.Effect<Date>;
  },
) =>
  Effect.gen(function* () {
    const databaseLayer = Db.layerFromDatabase(database);
    const deletionCases = yield* DeletionCasePostgres.make.pipe(Effect.provide(databaseLayer));
    const userSuspensions = yield* UserSuspensionPostgres.make.pipe(Effect.provide(databaseLayer));
    const authSessionStore = yield* AuthSessionAdapter.make.pipe(Effect.provide(databaseLayer));
    const authSessions = yield* AuthSession.make.pipe(
      Effect.provideService(AuthSession.Store, authSessionStore),
    );

    return (currentUser: CurrentUserValue, operation: BillingOperation) =>
      Effect.gen(function* () {
        const userId = yield* Schema.decodeEffect(UserId)(currentUser.userId);
        const authSessionId = yield* Schema.decodeEffect(AuthSessionId)(currentUser.authSessionId);
        const now = yield* environment.now;
        const allowancePeriodId = yield* environment.allowancePeriodId;
        const authSession = yield* authSessions.inspect(userId, authSessionId);
        if (authSession._tag === "RevokedAuthSession") return false;
        const freePeriodEnd = DateTime.toDateUtc(
          DateTime.add(DateTime.fromDateUnsafe(now), { days: 30 }),
        );
        const [subscription, deletionAccess, user] = yield* Effect.all([
          inspectAndRepairBillingAuthorization(database, userId, now, {
            allowancePeriodId,
            freePeriodEnd,
          }),
          deletionCases.inspect(userId),
          userSuspensions.inspect(userId),
        ]);
        return admit(
          {
            authSessionExpiresAt: authSession.expiresAt,
            authSessionId,
            deletionAccess,
            ...subscription,
            user,
            userId,
          },
          operation,
          now,
        );
      });
  });

export * as BillingAuthorization from "./billing-authorization";
