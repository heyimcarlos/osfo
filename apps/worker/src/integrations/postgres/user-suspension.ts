import { userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { users } from "@osfo/db/schema/auth";
import { desc, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import * as Db from "../../db";
import { AdminActorId, AdminReason } from "../../domain/account-administration";
import { UserSuspensionEventId } from "../../domain/user-suspension";
import * as UserSuspension from "../../services/user-suspension";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle transactions and domain tags require these forms. */

const History = Schema.Array(
  Schema.Struct({
    action: Schema.Literals(["restored", "suspended"]),
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
            adminActorId: userSuspensionEvents.adminActorId,
            eventId: userSuspensionEvents.eventId,
            occurredAt: userSuspensionEvents.occurredAt,
            reason: userSuspensionEvents.reason,
          })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.userId, userId))
          .orderBy(userSuspensionEvents.occurredAt, userSuspensionEvents.eventId),
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
          .where(eq(userSuspensionEvents.userId, userId))
          .orderBy(desc(userSuspensionEvents.occurredAt), desc(userSuspensionEvents.eventId))
          .limit(1),
      ).pipe(
        Effect.map(([latest]) =>
          latest?.action === "suspended"
            ? ({ _tag: "SuspendedUser", userId } as const)
            : ({ _tag: "ActiveUser", userId } as const),
        ),
      ),
    transition: (command, eventId, action) =>
      Db.execute(action === "suspended" ? "suspendUser" : "restoreUser", () =>
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
            .where(eq(userSuspensionEvents.userId, command.userId))
            .orderBy(desc(userSuspensionEvents.occurredAt), desc(userSuspensionEvents.eventId))
            .limit(1);
          const suspended = latest?.action === "suspended";
          if ((action === "suspended" && suspended) || (action === "restored" && !suspended)) {
            return "unchanged" as const;
          }
          await transaction.insert(userSuspensionEvents).values({
            action,
            adminActorId: command.adminActorId,
            eventId,
            occurredAt: sql`clock_timestamp()`,
            reason: command.reason,
            userId: command.userId,
          });
          return "changed" as const;
        }),
      ),
  });
});

/** User Suspension persistence Layer backed by Postgres. */
export const layerWithoutDependencies = Layer.effect(UserSuspension.Persistence, make);
