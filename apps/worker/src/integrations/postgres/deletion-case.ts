import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import {
  administrativeAuthorities,
  deletionCases,
  userSuspensionEvents,
} from "@osfo/db/schema/user-lifecycle";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { Db } from "../../db";
import { DeletionCaseId } from "../../domain/deletion-case";
import { DeletionCase } from "../../services/deletion-case";
import { exactDeletionAuthority, fenceDeletionCaseAccess } from "./deletion-case-authority";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction boundaries require async functions. */

/** Build the Deletion Case persistence adapter from Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const requestSelf = Effect.fn("DeletionCasePostgres.requestSelf")(function* (
    userId: Parameters<DeletionCase.PersistencePort["requestSelf"]>[0],
    deletion_case_id: Parameters<DeletionCase.PersistencePort["requestSelf"]>[1],
    approval: Parameters<DeletionCase.PersistencePort["requestSelf"]>[2],
    authority: Parameters<DeletionCase.PersistencePort["requestSelf"]>[3],
  ) {
    return yield* Db.execute("requestDeletion", () =>
      database.transaction(async (transaction) => {
        const [user] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for("update")
          .limit(1);
        if (user === undefined) return { _tag: "MissingUser" } as const;
        const [[authSession], [subscription], [latestSuspension]] = await Promise.all([
          transaction
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.id, authority.authSessionId),
                eq(sessions.userId, userId),
                gt(sessions.expiresAt, sql`clock_timestamp()`),
              ),
            )
            .for("update")
            .limit(1),
          transaction
            .select({
              plan: billingSubscriptions.plan,
              planPolicyVersion: billingSubscriptions.plan_policy_version,
            })
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.user_id, userId))
            .for("update")
            .limit(1),
          transaction
            .select({ action: userSuspensionEvents.action })
            .from(userSuspensionEvents)
            .where(eq(userSuspensionEvents.user_id, userId))
            .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
            .limit(1),
        ]);
        if (
          authSession === undefined ||
          subscription === undefined ||
          subscription.plan !== authority.plan ||
          subscription.planPolicyVersion !== authority.planPolicyVersion ||
          latestSuspension?.action === "suspended"
        ) {
          return { _tag: "AuthorityChanged" } as const;
        }
        const selfAuthority = {
          _tag: "SelfService" as const,
          approvalActionId: approval.actionId,
          approvalPresentation: approval.presentation,
          userId,
        };
        const [existing] = await transaction
          .select({ deletionCaseId: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(eq(deletionCases.user_id, userId))
          .limit(1);
        if (existing !== undefined) {
          const exactCase = sql`${deletionCases.deletion_case_id} = ${existing.deletionCaseId}
            and ${deletionCases.user_id} = ${userId}
            and ${exactDeletionAuthority(selfAuthority)}`;
          const retained = await transaction
            .select({ deletionCaseId: deletionCases.deletion_case_id })
            .from(deletionCases)
            .where(exactCase)
            .limit(1)
            .for("update");
          if (retained.length !== 1) return { _tag: "AuthorityChanged" } as const;
          const fenced = await transaction
            .update(deletionCases)
            .set({ access_fenced_at: sql`clock_timestamp()` })
            .where(exactCase)
            .returning({ deletionCaseId: deletionCases.deletion_case_id });
          if (fenced.length !== 1) return { _tag: "AuthorityChanged" } as const;
          await transaction.delete(sessions).where(eq(sessions.userId, userId));
          return {
            _tag: "Existing",
            deletionCaseId: DeletionCaseId.make(existing.deletionCaseId),
          } as const;
        }
        await transaction.insert(deletionCases).values({
          access_fenced_at: sql`clock_timestamp()`,
          approval_action_id: approval.actionId,
          approval_presentation: approval.presentation,
          deletion_case_id,
          reason: "User requested permanent account deletion",
          requested_by_user_id: userId,
          user_id: userId,
        });
        await transaction.delete(sessions).where(eq(sessions.userId, userId));
        return { _tag: "Created" } as const;
      }),
    );
  });
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
    markAccessFenced: (command, deletionCaseId) =>
      Db.execute("requestDeletion", async () => {
        const fenced = await fenceDeletionCaseAccess(database, {
          _tag: "Administrative",
          adminActorId: command.adminActorId,
          deletionCaseId,
          reason: command.reason,
          userId: command.userId,
        });
        return fenced ? ({ _tag: "Fenced" } as const) : ({ _tag: "AuthorityChanged" } as const);
      }),
    request: (command, deletion_case_id) =>
      Db.execute("requestDeletion", () =>
        database.transaction(async (transaction) => {
          const [administrator] = await transaction
            .select({ adminActorId: administrativeAuthorities.admin_actor_id })
            .from(administrativeAuthorities)
            .where(
              and(
                eq(administrativeAuthorities.admin_actor_id, command.adminActorId),
                sql`${administrativeAuthorities.revoked_at} is null`,
              ),
            )
            .for("update")
            .limit(1);
          if (administrator === undefined) return { _tag: "AuthorityChanged" } as const;
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
    requestSelf,
  });
});

/** Deletion Case persistence Layer backed by Postgres. */
export const layerWithoutDependencies = Layer.effect(DeletionCase.Persistence, make);

export * as DeletionCasePostgres from "./deletion-case";
