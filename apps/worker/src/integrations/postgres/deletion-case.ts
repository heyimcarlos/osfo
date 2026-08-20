import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { users } from "@osfo/db/schema/auth";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { Db } from "../../db";
import { DeletionCaseId } from "../../domain/deletion-case";
import { DeletionCase } from "../../services/deletion-case";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction boundaries require async functions. */

/** Build the Deletion Case persistence adapter from Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  return DeletionCase.Persistence.of({
    inspect: (userId) =>
      Db.execute("inspectDeletionCase", () =>
        database
          .select({ deletionCaseId: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(eq(deletionCases.user_id, userId))
          .limit(1),
      ).pipe(
        Effect.map(([record]) =>
          record === undefined
            ? ({ _tag: "DeletionAccessAvailable" } as const)
            : ({ _tag: "DeletionAccessRevoked" } as const),
        ),
      ),
    request: (command, deletion_case_id) =>
      Db.execute("requestDeletion", () =>
        database.transaction(async (transaction) => {
          const [user] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, command.userId))
            .for("update")
            .limit(1);
          if (user === undefined) return { _tag: "MissingUser" } as const;
          const [existing] = await transaction
            .select({ deletionCaseId: deletionCases.deletion_case_id })
            .from(deletionCases)
            .where(eq(deletionCases.user_id, command.userId))
            .limit(1);
          if (existing !== undefined) {
            return {
              _tag: "Existing",
              deletionCaseId: DeletionCaseId.make(existing.deletionCaseId),
            } as const;
          }
          await transaction.insert(deletionCases).values({
            deletion_case_id: deletion_case_id,
            reason: command.reason,
            requested_by_admin_id: command.adminActorId,
            user_id: command.userId,
          });
          return { _tag: "Created" } as const;
        }),
      ),
  });
});

/** Deletion Case persistence Layer backed by Postgres. */
export const layerWithoutDependencies = Layer.effect(DeletionCase.Persistence, make);

export * as DeletionCasePostgres from "./deletion-case";
