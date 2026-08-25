import { agents } from "@osfo/db/schema/agents";
import { users, verifications } from "@osfo/db/schema/auth";
import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
} from "@osfo/db/schema/billing";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { webhookEvents } from "@osfo/db/schema/webhooks";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "@osfo/db";
import { AgentId, PlanPolicyVersion, UserId } from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { DeletionCaseId } from "../../domain/deletion-case";
import { AccountDeletion } from "../../services/account-deletion";
import { ApprovalPresentation } from "../../services/authorization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction boundaries require async functions. */

/** Build durable pending-account discovery and final PostgreSQL erasure. */
export const make = (database: Database): AccountDeletion.PortInterface["persistence"] => {
  const pending = Effect.fn("AccountDeletionPostgres.listPending")(function* () {
    const rows = yield* attempt("listPending", () =>
      database
        .select({
          agentId: agents.agent_id,
          approvalActionId: deletionCases.approval_action_id,
          approvalPresentation: deletionCases.approval_presentation,
          deletionCaseId: deletionCases.deletion_case_id,
          userId: deletionCases.user_id,
        })
        .from(deletionCases)
        .leftJoin(agents, eq(agents.user_id, deletionCases.user_id))
        .where(sql`${deletionCases.requested_by_user_id} = ${deletionCases.user_id}`),
    );
    return rows.flatMap(
      ({ agentId, approvalActionId, approvalPresentation, deletionCaseId, userId }) =>
        approvalActionId === null || approvalPresentation === null
          ? []
          : [
              {
                agentId: agentId === null ? null : AgentId.make(agentId),
                approvalActionId: ActionId.make(approvalActionId),
                approvalPresentation: ApprovalPresentation.make(approvalPresentation),
                deletionCaseId: DeletionCaseId.make(deletionCaseId),
                userId: UserId.make(userId),
              },
            ],
    );
  });
  const removeUser = Effect.fn("AccountDeletionPostgres.removeUser")(function* (userId: UserId) {
    yield* attempt("removeUser", () =>
      database.transaction(async (transaction) => {
        const [user] = await transaction
          .select({ email: users.email, phoneNumber: users.phoneNumber })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (user === undefined) return;
        const identifiers = [user.email, user.phoneNumber].filter(
          (identifier): identifier is string => identifier !== null,
        );
        if (identifiers.length > 0) {
          await transaction
            .delete(verifications)
            .where(inArray(verifications.identifier, identifiers));
        }
        const [customer, subscription, checkoutSessions] = await Promise.all([
          transaction
            .select({ stripeId: billingCustomers.stripe_customer_id })
            .from(billingCustomers)
            .where(eq(billingCustomers.user_id, userId))
            .limit(1),
          transaction
            .select({ stripeId: billingSubscriptions.stripe_subscription_id })
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.user_id, userId))
            .limit(1),
          transaction
            .select({ stripeId: billingCheckoutSessions.stripe_checkout_session_id })
            .from(billingCheckoutSessions)
            .where(eq(billingCheckoutSessions.user_id, userId)),
        ]);
        const stripeObjectIds = [
          customer[0]?.stripeId,
          subscription[0]?.stripeId,
          ...checkoutSessions.map(({ stripeId }) => stripeId),
        ].filter((stripeId): stripeId is string => stripeId !== null && stripeId !== undefined);
        if (stripeObjectIds.length > 0) {
          await transaction
            .delete(webhookEvents)
            .where(
              inArray(
                sql<string>`${webhookEvents.payload_json}::jsonb ->> 'externalObjectId'`,
                stripeObjectIds,
              ),
            );
        }
        await transaction.delete(users).where(eq(users.id, userId));
      }),
    );
  });
  return {
    pending: pending(),
    removeUser,
  };
};

/** Read current facts only while the exact Deletion Case remains the durable authority. */
export const inspectAuthorization = (
  database: Database,
): AccountDeletion.PortInterface["inspectAuthorization"] =>
  Effect.fn("AccountDeletionPostgres.inspectAuthorization")(function* (candidate) {
    const rows = yield* attempt("recheckDeletionAuthority", () =>
      database
        .select({
          plan: billingSubscriptions.plan,
          planPolicyVersion: billingSubscriptions.plan_policy_version,
          suspensionAction: sql<string | null>`(
            select ${userSuspensionEvents.action}
            from ${userSuspensionEvents}
            where ${userSuspensionEvents.user_id} = ${candidate.userId}
            order by ${userSuspensionEvents.occurred_at} desc, ${userSuspensionEvents.event_id} desc
            limit 1
          )`,
          userId: users.id,
        })
        .from(deletionCases)
        .innerJoin(users, eq(users.id, deletionCases.user_id))
        .innerJoin(billingSubscriptions, eq(billingSubscriptions.user_id, deletionCases.user_id))
        .where(
          sql`${deletionCases.deletion_case_id} = ${candidate.deletionCaseId}
            and ${deletionCases.user_id} = ${candidate.userId}
            and ${deletionCases.requested_by_user_id} = ${candidate.userId}
            and ${deletionCases.approval_action_id} = ${candidate.approvalActionId}
            and ${deletionCases.approval_presentation} = ${candidate.approvalPresentation}`,
        )
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const userId = UserId.make(row.userId);
    return {
      resourceOwnerUserId: userId,
      subscription: {
        plan: row.plan,
        planPolicyVersion: PlanPolicyVersion.make(row.planPolicyVersion),
      },
      user:
        row.suspensionAction === "suspended"
          ? ({ _tag: "SuspendedUser", userId } as const)
          : ({ _tag: "ActiveUser", userId } as const),
    };
  });

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new AccountDeletion.AccountDeletionUnavailable({
        cause,
        message: "PostgreSQL account deletion is unavailable",
        operation,
      }),
  });

export * as AccountDeletionPostgres from "./account-deletion";
