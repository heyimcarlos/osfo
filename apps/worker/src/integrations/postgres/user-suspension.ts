import { userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { users } from "@osfo/db/schema/auth";
import { desc, eq, sql } from "drizzle-orm";
import { Effect, Layer, Predicate, Result, Schema } from "effect";

import { Db } from "../../db";
import { AdminActorId, AdminReason } from "../../domain/account-administration";
import { UserSuspensionEventId } from "../../domain/user-suspension";
import { UserSuspension } from "../../services/user-suspension";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle transactions and domain tags require these forms. */

const SuspensionAction = Schema.Literals(["restored", "suspended"]);

const LatestAction = Schema.Struct({ action: SuspensionAction });

const History = Schema.Array(
  Schema.Struct({
    action: SuspensionAction,
    adminActorId: AdminActorId,
    eventId: UserSuspensionEventId,
    occurredAt: Schema.Date,
    reason: AdminReason,
  }),
);

/** Build the User Suspension persistence adapter from Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  return UserSuspension.Persistence.of({
    history: (userId) =>
      Db.execute("inspectUserSuspension", () =>
        database
          .select({
            action: userSuspensionEvents.action,
            adminActorId: userSuspensionEvents.admin_actor_id,
            eventId: userSuspensionEvents.event_id,
            occurredAt: userSuspensionEvents.occurred_at,
            reason: userSuspensionEvents.reason,
          })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.user_id, userId))
          .orderBy(userSuspensionEvents.occurred_at, userSuspensionEvents.event_id),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(History)),
        Effect.mapError((cause) =>
          cause._tag === "DbUnavailable" ? cause : Db.dbUnavailable("inspectUserSuspension", cause),
        ),
      ),
    inspect: (userId) =>
      Db.execute("inspectUserSuspension", () =>
        database
          .select({ action: userSuspensionEvents.action })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.user_id, userId))
          .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
          .limit(1),
      ).pipe(
        Effect.flatMap(([latest]) =>
          Db.decodeOptionalRow(LatestAction, latest, "inspectUserSuspension"),
        ),
        Effect.map((latest) =>
          latest === undefined || latest.action === "restored"
            ? ({ _tag: "ActiveUser", userId } as const)
            : ({ _tag: "SuspendedUser", userId } as const),
        ),
      ),
    transition: (command, eventId, action) => {
      const operation = action === "suspended" ? "suspendUser" : "restoreUser";
      return Db.execute(operation, () =>
        database.transaction(async (transaction) => {
          const [user] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, command.userId))
            .for("update")
            .limit(1);
          if (user === undefined) return "missing-user" as const;
          const [latest] = await transaction
            .select({ action: userSuspensionEvents.action })
            .from(userSuspensionEvents)
            .where(eq(userSuspensionEvents.user_id, command.userId))
            .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
            .limit(1);
          let suspended = false;
          if (latest !== undefined) {
            const decoded = Schema.decodeUnknownResult(LatestAction)(latest);
            if (Result.isFailure(decoded)) {
              return { _tag: "CorruptSuspensionAction", cause: decoded.failure } as const;
            }
            suspended = decoded.success.action === "suspended";
          }
          if ((action === "suspended" && suspended) || (action === "restored" && !suspended)) {
            return "unchanged" as const;
          }
          await transaction.insert(userSuspensionEvents).values({
            action,
            admin_actor_id: command.adminActorId,
            event_id: eventId,
            occurred_at: sql`clock_timestamp()`,
            reason: command.reason,
            user_id: command.userId,
          });
          return "changed" as const;
        }),
      ).pipe(
        Effect.flatMap((result) =>
          Predicate.isTagged(result, "CorruptSuspensionAction")
            ? Effect.fail(Db.dbUnavailable(operation, result.cause))
            : Effect.succeed(result),
        ),
      );
    },
  });
});

/** User Suspension persistence Layer backed by Postgres. */
export const layerWithoutDependencies = Layer.effect(UserSuspension.Persistence, make);

export * as UserSuspensionPostgres from "./user-suspension";
