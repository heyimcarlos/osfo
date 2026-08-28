import { sessions, users } from "@osfo/db/schema/auth";
import { administrativeAuthorities, deletionCases } from "@osfo/db/schema/user-lifecycle";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@osfo/db";
import type { UserId } from "../../domain";
import type { AdminActorId, AdminReason } from "../../domain/account-administration";
import type { ActionId } from "../../domain/action-execution";
import type { DeletionCaseId } from "../../domain/deletion-case";
import type { ApprovalPresentation } from "../../services/authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Exact authority variants use the domain discriminator. */
/* oxlint-disable effecttsgo/async-function -- Drizzle transaction boundaries require async functions. */

/** Exact immutable authority retained by one Deletion Case. */
export type ExactDeletionAuthority =
  | {
      readonly _tag: "Administrative";
      readonly adminActorId: AdminActorId;
      readonly reason: AdminReason;
      readonly userId: UserId;
    }
  | {
      readonly _tag: "SelfService";
      readonly approvalActionId: ActionId;
      readonly approvalPresentation: ApprovalPresentation;
      readonly userId: UserId;
    };

/** One exact retained Deletion Case whose access fence may advance atomically. */
export type ExactDeletionCaseAuthority = ExactDeletionAuthority & {
  readonly deletionCaseId: DeletionCaseId;
};

type DeletionTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Acquire the canonical first lock for every authoritative User/Deletion Case transaction. */
export const lockDeletionCaseUser = async (transaction: DeletionTransaction, userId: UserId) => {
  const [user] = await transaction
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  return user;
};

/** Match only the retained case shape and exact authority that may advance deletion progress. */
export const exactDeletionAuthority = (authority: ExactDeletionAuthority) =>
  authority._tag === "SelfService"
    ? sql`${deletionCases.requested_by_user_id} = ${authority.userId}
        and ${deletionCases.requested_by_admin_id} is null
        and ${deletionCases.approval_action_id} = ${authority.approvalActionId}
        and ${deletionCases.approval_presentation} = ${authority.approvalPresentation}`
    : sql`${deletionCases.requested_by_admin_id} = ${authority.adminActorId}
        and ${deletionCases.requested_by_user_id} is null
        and ${deletionCases.reason} = ${authority.reason}
        and ${deletionCases.approval_action_id} is null
        and ${deletionCases.approval_presentation} is null
        and exists (
          select 1
          from ${administrativeAuthorities}
          where ${administrativeAuthorities.admin_actor_id} = ${authority.adminActorId}
            and ${administrativeAuthorities.revoked_at} is null
        )`;

/** Recheck exact retained authority, revoke sessions, and durably mark the fence atomically. */
export const fenceDeletionCaseAccess = (
  database: Database,
  candidate: ExactDeletionCaseAuthority,
) =>
  database.transaction(async (transaction) => {
    // User is the canonical first lock for every authoritative User/Deletion Case transaction.
    const user = await lockDeletionCaseUser(transaction, candidate.userId);
    if (user === undefined) return false;
    // Serialize the durable deletion fence with every Research Report admission and callback.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`research-report:user:${candidate.userId}`}, 0))`,
    );
    if (candidate._tag === "Administrative") {
      // Serialize revocation with the whole fence transaction; the case lock alone cannot
      // keep a distinct Administrative Authority current through session deletion.
      const [administrator] = await transaction
        .select({ adminActorId: administrativeAuthorities.admin_actor_id })
        .from(administrativeAuthorities)
        .where(
          and(
            eq(administrativeAuthorities.admin_actor_id, candidate.adminActorId),
            sql`${administrativeAuthorities.revoked_at} is null`,
          ),
        )
        .limit(1)
        .for("update");
      if (administrator === undefined) return false;
    }
    const caseIdentity = sql`${deletionCases.deletion_case_id} = ${candidate.deletionCaseId}
      and ${deletionCases.user_id} = ${candidate.userId}
      and ${exactDeletionAuthority(candidate)}`;
    const [retained] = await transaction
      .select({ deletionCaseId: deletionCases.deletion_case_id })
      .from(deletionCases)
      .where(caseIdentity)
      .limit(1)
      .for("update");
    if (retained === undefined) return false;
    // Write the durable fence first so no successful transaction can delete sessions while
    // leaving scheduled reconciliation unable to prove that access was fenced.
    const fenced = await transaction
      .update(deletionCases)
      .set({ access_fenced_at: sql`clock_timestamp()` })
      .where(caseIdentity)
      .returning({ deletionCaseId: deletionCases.deletion_case_id });
    if (fenced.length !== 1) {
      throw new Error("The exact Deletion Case changed while its access fence was locked");
    }
    await transaction.delete(sessions).where(eq(sessions.userId, candidate.userId));
    return true;
  });
