import { administrativeAuthorities, deletionCases } from "@osfo/db/schema/user-lifecycle";
import { sql } from "drizzle-orm";

import type { UserId } from "../../domain";
import type { AdminActorId, AdminReason } from "../../domain/account-administration";
import type { ActionId } from "../../domain/action-execution";
import type { ApprovalPresentation } from "../../services/authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Exact authority variants use the domain discriminator. */

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
