import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import {
  accountDeletionActions,
  administrativeAuthorities,
  deletionCases,
  userSuspensionEvents,
} from "@osfo/db/schema/user-lifecycle";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { Db } from "../../db";
import { UserId } from "../../domain";
import { DeletionCaseId } from "../../domain/deletion-case";
import { DeletionCase } from "../../services/deletion-case";
import { fenceDeletionCaseAccess, lockDeletionCaseUser } from "./deletion-case-authority";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction boundaries require async functions. */

/** Build the Deletion Case persistence adapter from Postgres. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const authenticateSelfReplay = Effect.fn("DeletionCasePostgres.authenticateSelfReplay")(
    function* (replay: Parameters<DeletionCase.PersistencePort["authenticateSelfReplay"]>[0]) {
      const rows = yield* Db.execute("requestDeletion", () =>
        database
          .select({
            deletionCaseId: deletionCases.deletion_case_id,
            userId: deletionCases.user_id,
          })
          .from(accountDeletionActions)
          .innerJoin(
            deletionCases,
            and(
              eq(deletionCases.deletion_case_id, accountDeletionActions.deletion_case_id),
              eq(deletionCases.user_id, accountDeletionActions.user_id),
            ),
          )
          .where(
            and(
              eq(accountDeletionActions.action_id, replay.actionId),
              eq(accountDeletionActions.presentation, replay.presentation),
              eq(accountDeletionActions.presentation_version, replay.presentationVersion),
              eq(accountDeletionActions.replay_token_hash, replay.replayTokenHash),
              isNotNull(accountDeletionActions.consumed_at),
              isNull(accountDeletionActions.invalidated_at),
              isNotNull(deletionCases.access_fenced_at),
              isNull(deletionCases.requested_by_admin_id),
              eq(deletionCases.requested_by_user_id, accountDeletionActions.user_id),
              eq(deletionCases.approval_action_id, accountDeletionActions.action_id),
              eq(deletionCases.approval_presentation, accountDeletionActions.presentation),
            ),
          )
          .limit(1),
      );
      const replayed = rows[0];
      return replayed === undefined
        ? ({ _tag: "Denied" } as const)
        : ({
            _tag: "Authenticated",
            deletionCaseId: DeletionCaseId.make(replayed.deletionCaseId),
            userId: UserId.make(replayed.userId),
          } as const);
    },
  );
  const presentSelf = Effect.fn("DeletionCasePostgres.presentSelf")(function* (
    userId: Parameters<DeletionCase.PersistencePort["presentSelf"]>[0],
    action: Parameters<DeletionCase.PersistencePort["presentSelf"]>[1],
  ) {
    return yield* Db.execute("requestDeletion", () =>
      database.transaction(async (transaction) => {
        const user = await lockDeletionCaseUser(transaction, userId);
        if (user === undefined) return { _tag: "MissingUser" } as const;
        const [authSession] = await transaction
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, action.authSessionId),
              eq(sessions.userId, userId),
              gt(sessions.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .for("update")
          .limit(1);
        const [existingCase] = await transaction
          .select({ deletionCaseId: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(eq(deletionCases.user_id, userId))
          .limit(1);
        if (authSession === undefined || existingCase !== undefined) {
          return { _tag: "AuthorityChanged" } as const;
        }
        await transaction
          .update(accountDeletionActions)
          .set({ invalidated_at: sql`clock_timestamp()` })
          .where(
            and(
              eq(accountDeletionActions.user_id, userId),
              isNull(accountDeletionActions.consumed_at),
              isNull(accountDeletionActions.invalidated_at),
            ),
          );
        await transaction.insert(accountDeletionActions).values({
          action_id: action.actionId,
          auth_session_id: action.authSessionId,
          expires_at: action.expiresAt,
          presentation: action.presentation,
          presentation_version: action.presentationVersion,
          replay_token_hash: action.replayTokenHash,
          user_id: userId,
        });
        return { _tag: "Presented" } as const;
      }),
    );
  });
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
        const [retainedAction] = await transaction
          .select({
            actionId: accountDeletionActions.action_id,
            consumedAt: accountDeletionActions.consumed_at,
            deletionCaseId: accountDeletionActions.deletion_case_id,
            isUnexpired: sql<boolean>`${accountDeletionActions.expires_at} > clock_timestamp()`,
          })
          .from(accountDeletionActions)
          .where(
            and(
              eq(accountDeletionActions.action_id, approval.actionId),
              eq(accountDeletionActions.user_id, userId),
              eq(accountDeletionActions.auth_session_id, authority.authSessionId),
              eq(accountDeletionActions.presentation, approval.presentation),
              eq(accountDeletionActions.presentation_version, approval.presentationVersion),
              eq(accountDeletionActions.replay_token_hash, approval.replayTokenHash),
              isNull(accountDeletionActions.invalidated_at),
            ),
          )
          .for("update")
          .limit(1);
        if (retainedAction === undefined) return { _tag: "AuthorityChanged" } as const;
        if (retainedAction.consumedAt !== null) {
          if (retainedAction.deletionCaseId === null) return { _tag: "AuthorityChanged" } as const;
          const [exactCase] = await transaction
            .select({ deletionCaseId: deletionCases.deletion_case_id })
            .from(deletionCases)
            .where(
              and(
                eq(deletionCases.deletion_case_id, retainedAction.deletionCaseId),
                eq(deletionCases.user_id, userId),
                eq(deletionCases.requested_by_user_id, userId),
                isNull(deletionCases.requested_by_admin_id),
                eq(deletionCases.approval_action_id, approval.actionId),
                eq(deletionCases.approval_presentation, approval.presentation),
                isNotNull(deletionCases.access_fenced_at),
              ),
            )
            .for("update")
            .limit(1);
          return exactCase === undefined
            ? ({ _tag: "AuthorityChanged" } as const)
            : ({
                _tag: "Existing",
                deletionCaseId: DeletionCaseId.make(exactCase.deletionCaseId),
              } as const);
        }
        if (!retainedAction.isUnexpired) return { _tag: "AuthorityChanged" } as const;
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
        const [existing] = await transaction
          .select({ deletionCaseId: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(eq(deletionCases.user_id, userId))
          .limit(1);
        if (existing !== undefined) {
          return { _tag: "AuthorityChanged" } as const;
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
        const consumed = await transaction
          .update(accountDeletionActions)
          .set({
            consumed_at: sql`clock_timestamp()`,
            deletion_case_id,
          })
          .where(
            and(
              eq(accountDeletionActions.action_id, approval.actionId),
              isNull(accountDeletionActions.consumed_at),
              isNull(accountDeletionActions.invalidated_at),
            ),
          )
          .returning({ actionId: accountDeletionActions.action_id });
        if (consumed.length !== 1) {
          throw new Error("The retained account-deletion Action was not consumed");
        }
        await transaction.delete(sessions).where(eq(sessions.userId, userId));
        return { _tag: "Created" } as const;
      }),
    );
  });
  return DeletionCase.Persistence.of({
    authenticateSelfReplay,
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
          const user = await lockDeletionCaseUser(transaction, command.userId);
          if (user === undefined) return { _tag: "MissingUser" } as const;
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
    presentSelf,
    requestSelf,
  });
});

/** Deletion Case persistence Layer backed by Postgres. */
export const layerWithoutDependencies = Layer.effect(DeletionCase.Persistence, make);

export * as DeletionCasePostgres from "./deletion-case";
