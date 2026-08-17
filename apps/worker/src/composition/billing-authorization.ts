import type { CurrentUserValue } from "@osfo/api";
import { DateTime, Effect, Schema } from "effect";

import * as Db from "../db";
import { inspectAndRepairBillingAuthorization } from "../db/billing/stripe-inspect";
import { type AllowancePeriodId, UserId } from "../domain";
import { AuthSessionId } from "../domain/auth-session";
import * as DeletionCasePostgres from "../integrations/postgres/deletion-case";
import * as UserSuspensionPostgres from "../integrations/postgres/user-suspension";
import { admit, type BillingOperation } from "../services/billing-authorization";

/* oxlint-disable effecttsgo/strict-effect-provide -- This composition boundary owns the concrete request-scoped PostgreSQL adapters. */

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

    return (currentUser: CurrentUserValue, operation: BillingOperation) =>
      Effect.gen(function* () {
        const userId = yield* Schema.decodeEffect(UserId)(currentUser.userId);
        const authSessionId = yield* Schema.decodeEffect(AuthSessionId)(currentUser.authSessionId);
        const now = yield* environment.now;
        const allowancePeriodId = yield* environment.allowancePeriodId;
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
            authSessionExpiresAt: currentUser.authSessionExpiresAt,
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
