import { agents } from "@osfo/db/schema/agents";
import { users, verifications } from "@osfo/db/schema/auth";
import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
} from "@osfo/db/schema/billing";
import {
  administrativeAuthorities,
  deletionCases,
  userSuspensionEvents,
} from "@osfo/db/schema/user-lifecycle";
import { webhookEvents } from "@osfo/db/schema/webhooks";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect, Result, Schema } from "effect";

import type { Database } from "@osfo/db";
import { AgentId, PlanPolicyVersion, UserId } from "../../domain";
import { AdminActorId, AdminReason } from "../../domain/account-administration";
import { ActionId } from "../../domain/action-execution";
import { DeletionCaseId } from "../../domain/deletion-case";
import { retainedCatalog } from "../../domain/plan-policy";
import { AccountDeletion } from "../../services/account-deletion";
import { ApprovalPresentation } from "../../services/authorization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction boundaries require async functions. */
/* oxlint-disable eslint/no-underscore-dangle -- Durable candidate variants use the canonical _tag discriminator. */

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
          reason: deletionCases.reason,
          requestedByAdminId: deletionCases.requested_by_admin_id,
          requestedByUserId: deletionCases.requested_by_user_id,
          userId: deletionCases.user_id,
        })
        .from(deletionCases)
        .leftJoin(agents, eq(agents.user_id, deletionCases.user_id)),
    );
    return rows.flatMap<AccountDeletion.PendingAccountDeletion>(
      ({
        agentId,
        approvalActionId,
        approvalPresentation,
        deletionCaseId,
        reason,
        requestedByAdminId,
        requestedByUserId,
        userId,
      }) => {
        const common = {
          agentId: agentId === null ? null : AgentId.make(agentId),
          deletionCaseId: DeletionCaseId.make(deletionCaseId),
          userId: UserId.make(userId),
        };
        if (requestedByAdminId !== null) {
          return [
            {
              ...common,
              _tag: "Administrative" as const,
              adminActorId: AdminActorId.make(requestedByAdminId),
              reason: AdminReason.make(reason),
            },
          ];
        }
        return requestedByUserId === userId &&
          approvalActionId !== null &&
          approvalPresentation !== null
          ? [
              {
                ...common,
                _tag: "SelfService" as const,
                approvalActionId: ActionId.make(approvalActionId),
                approvalPresentation: ApprovalPresentation.make(approvalPresentation),
              },
            ]
          : [];
      },
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
  const updateIntegrationTargets = Effect.fn("AccountDeletionPostgres.updateIntegrationTargets")(
    function* <A>(
      operation: "confirmIntegrationTarget" | "stageIntegrationTargets",
      candidate: AccountDeletion.PendingAccountDeletion,
      mutate: (
        retained: ReadonlyArray<AccountDeletion.IntegrationAuthorityTargetProgress>,
      ) => Result.Result<IntegrationTargetProgressUpdate<A>, Error>,
    ) {
      const outcome = yield* attempt(operation, () =>
        database.transaction(async (transaction) => {
          const caseIdentity = sql`${deletionCases.deletion_case_id} = ${candidate.deletionCaseId}
            and ${deletionCases.user_id} = ${candidate.userId}
            and ${exactDeletionAuthority(candidate)}`;
          const [row] = await transaction
            .select({ targets: deletionCases.integration_targets })
            .from(deletionCases)
            .where(caseIdentity)
            .limit(1)
            .for("update");
          if (row === undefined) {
            return {
              _tag: "ProgressInvalid" as const,
              cause: new Error("Deletion Case integration progress is missing"),
            };
          }
          const decoded = Schema.decodeUnknownResult(
            AccountDeletion.IntegrationAuthorityTargetProgresses,
          )(row.targets);
          if (Result.isFailure(decoded)) {
            return { _tag: "ProgressInvalid" as const, cause: decoded.failure };
          }
          const update = mutate(decoded.success);
          if (Result.isFailure(update)) {
            return { _tag: "ProgressInvalid" as const, cause: update.failure };
          }
          const updated = await transaction
            .update(deletionCases)
            .set({ integration_targets: update.success.progress })
            .where(caseIdentity)
            .returning({ deletionCaseId: deletionCases.deletion_case_id });
          if (updated.length !== 1) {
            return {
              _tag: "ProgressInvalid" as const,
              cause: new Error("Deletion Case integration authority changed"),
            };
          }
          return { _tag: "ProgressUpdated" as const, value: update.success.value };
        }),
      );
      if (outcome._tag === "ProgressInvalid") {
        return yield* new AccountDeletion.AccountDeletionUnavailable({
          cause: outcome.cause,
          message: "PostgreSQL Deletion Case integration progress is invalid",
          operation,
        });
      }
      return outcome.value;
    },
  );
  const stageIntegrationTargets = Effect.fn("AccountDeletionPostgres.stageIntegrationTargets")(
    function* (
      candidate: AccountDeletion.PendingAccountDeletion,
      discovered: ReadonlyArray<AccountDeletion.IntegrationAuthorityTarget>,
    ) {
      return yield* updateIntegrationTargets("stageIntegrationTargets", candidate, (retained) => {
        const targets = new Map(retained.map((target) => [target.connectionId, target]));
        for (const target of discovered) {
          targets.set(target.connectionId, { ...target, status: "pending" });
        }
        const progress = [...targets.values()];
        return Result.succeed({
          progress,
          value: progress.flatMap(({ connectionId, status, userId }) =>
            status === "pending" ? [{ connectionId, userId }] : [],
          ),
        });
      });
    },
  );
  const confirmIntegrationTarget = Effect.fn("AccountDeletionPostgres.confirmIntegrationTarget")(
    function* (
      candidate: AccountDeletion.PendingAccountDeletion,
      target: AccountDeletion.IntegrationAuthorityTarget,
    ) {
      yield* updateIntegrationTargets("confirmIntegrationTarget", candidate, (retained) => {
        const found = retained.some(
          (item) => item.connectionId === target.connectionId && item.userId === target.userId,
        );
        if (!found) {
          return Result.fail(new Error("Integration target was not staged before confirmation"));
        }
        const progress = retained.map((item) => {
          if (item.connectionId !== target.connectionId || item.userId !== target.userId) {
            return item;
          }
          return {
            connectionId: item.connectionId,
            status: "confirmed" as const,
            userId: item.userId,
          };
        });
        return Result.succeed({ progress, value: undefined });
      });
    },
  );
  return {
    confirmIntegrationTarget,
    pending: pending(),
    removeUser,
    stageIntegrationTargets,
  };
};

interface IntegrationTargetProgressUpdate<A> {
  readonly progress: ReadonlyArray<AccountDeletion.IntegrationAuthorityTargetProgress>;
  readonly value: A;
}

/** Read current facts only while the exact Deletion Case remains the durable authority. */
export const inspectAuthorization = (
  database: Database,
): AccountDeletion.PortInterface["inspectAuthorization"] =>
  Effect.fn("AccountDeletionPostgres.inspectAuthorization")(function* (candidate) {
    const rows = yield* attempt("recheckDeletionAuthority", () =>
      database
        .select({
          adminActorId: administrativeAuthorities.admin_actor_id,
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
        .leftJoin(
          administrativeAuthorities,
          eq(administrativeAuthorities.admin_actor_id, deletionCases.requested_by_admin_id),
        )
        .leftJoin(billingSubscriptions, eq(billingSubscriptions.user_id, deletionCases.user_id))
        .where(
          sql`${deletionCases.deletion_case_id} = ${candidate.deletionCaseId}
            and ${deletionCases.user_id} = ${candidate.userId}
            and ${exactDeletionAuthority(candidate)}`,
        )
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (candidate._tag === "SelfService" && (row.plan === null || row.planPolicyVersion === null)) {
      return null;
    }
    const userId = UserId.make(row.userId);
    return {
      administrativeAuthority:
        row.adminActorId === null ? null : { adminActorId: AdminActorId.make(row.adminActorId) },
      resourceOwnerUserId: userId,
      subscription: {
        plan: row.plan ?? "free",
        planPolicyVersion: PlanPolicyVersion.make(
          row.planPolicyVersion ?? retainedCatalog.currentVersion,
        ),
      },
      user:
        row.suspensionAction === "suspended"
          ? ({ _tag: "SuspendedUser", userId } as const)
          : ({ _tag: "ActiveUser", userId } as const),
    };
  });

const exactDeletionAuthority = (candidate: AccountDeletion.PendingAccountDeletion) =>
  candidate._tag === "SelfService"
    ? sql`${deletionCases.requested_by_user_id} = ${candidate.userId}
        and ${deletionCases.requested_by_admin_id} is null
        and ${deletionCases.approval_action_id} = ${candidate.approvalActionId}
        and ${deletionCases.approval_presentation} = ${candidate.approvalPresentation}`
    : sql`${deletionCases.requested_by_admin_id} = ${candidate.adminActorId}
        and ${deletionCases.requested_by_user_id} is null
        and ${deletionCases.reason} = ${candidate.reason}
        and ${deletionCases.approval_action_id} is null
        and ${deletionCases.approval_presentation} is null
        and exists (
          select 1
          from ${administrativeAuthorities}
          where ${administrativeAuthorities.admin_actor_id} = ${candidate.adminActorId}
            and ${administrativeAuthorities.revoked_at} is null
        )`;

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
