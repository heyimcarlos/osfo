import { scheduledEmailNotifications, scheduledEmails } from "@osfo/db/schema/scheduled-emails";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "@osfo/db";
import { ScheduledEmail } from "../../services/scheduled-email";
import { ScheduledEmailFollowUp } from "../../services/scheduled-email-follow-up";
import { lockWorkflowUser } from "./workflow-serialization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions own notification first-write-wins truth. */

const selection = {
  acceptedAt: scheduledEmailNotifications.accepted_at,
  agentId: scheduledEmailNotifications.agent_id,
  claimedAt: scheduledEmailNotifications.claimed_at,
  deliverySessionId: scheduledEmailNotifications.delivery_session_id,
  modelAccessPolicyVersion: scheduledEmailNotifications.model_access_policy_version,
  modelRoute: scheduledEmailNotifications.model_route,
  notificationId: scheduledEmailNotifications.notification_id,
  originSessionId: scheduledEmailNotifications.origin_session_id,
  planPolicyVersion: scheduledEmailNotifications.plan_policy_version,
  resourcePriceVersion: scheduledEmailNotifications.resource_price_version,
  routeId: scheduledEmailNotifications.route_id,
  submissionId: scheduledEmailNotifications.think_submission_id,
  userId: scheduledEmailNotifications.user_id,
  workflowId: scheduledEmailNotifications.workflow_id,
};

export const make = (database: Database): ScheduledEmailFollowUp.PortInterface => ({
  claimTerminal: (email, notificationId, claimedAt) =>
    attempt("claimTerminal", () =>
      database.transaction(async (transaction) => {
        if (!(await lockWorkflowUser(transaction, email.userId)))
          return { _tag: "Suppressed" as const };
        const [current] = await transaction
          .select({
            inputDigest: scheduledEmails.input_digest,
            state: scheduledEmails.state,
            terminalAt: scheduledEmails.terminal_at,
            userId: scheduledEmails.user_id,
          })
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, email.workflowId))
          .for("update")
          .limit(1);
        if (
          current === undefined ||
          current.userId !== email.userId ||
          current.inputDigest !== email.inputDigest ||
          current.terminalAt === null ||
          !ScheduledEmail.terminalStates.has(current.state)
        ) {
          return { _tag: "NotTerminal" as const };
        }
        const [deletion] = await transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(eq(deletionCases.user_id, email.userId), isNotNull(deletionCases.access_fenced_at)),
          )
          .limit(1);
        if (deletion !== undefined) return { _tag: "Suppressed" as const };
        await transaction
          .insert(scheduledEmailNotifications)
          .values({
            agent_id: email.agentId,
            claimed_at: claimedAt,
            model_access_policy_version: email.modelAccessPolicyVersion,
            model_route: email.modelRoute,
            notification_id: notificationId,
            origin_session_id: email.sessionId,
            plan_policy_version: email.planPolicyVersion,
            resource_price_version: email.resourcePriceVersion,
            route_id: email.routeId,
            user_id: email.userId,
            workflow_id: email.workflowId,
          })
          .onConflictDoNothing({ target: scheduledEmailNotifications.notification_id });
        const [retained] = await transaction
          .select(selection)
          .from(scheduledEmailNotifications)
          .where(eq(scheduledEmailNotifications.notification_id, notificationId))
          .limit(1);
        return retained === undefined
          ? { _tag: "Suppressed" as const }
          : { _tag: "Claimed" as const, row: retained, state: current.state };
      }),
    ).pipe(
      Effect.flatMap(
        (
          outcome,
        ): Effect.Effect<ScheduledEmailFollowUp.Claim, ScheduledEmailFollowUp.Unavailable> => {
          if (outcome._tag !== "Claimed") return Effect.succeed(outcome);
          return decode(outcome.row, outcome.state).pipe(
            Effect.map((notification) => ({ _tag: "Claimed" as const, notification })),
          );
        },
      ),
    ),
  inspect: (notificationId) =>
    attempt("inspect", () =>
      database
        .select({ ...selection, state: scheduledEmails.state })
        .from(scheduledEmailNotifications)
        .innerJoin(
          scheduledEmails,
          eq(scheduledEmails.workflow_id, scheduledEmailNotifications.workflow_id),
        )
        .where(eq(scheduledEmailNotifications.notification_id, notificationId))
        .limit(1),
    ).pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.succeed(null) : decode(row, row.state),
      ),
    ),
  markAccepted: (notificationId, submissionId, acceptedAt) =>
    attempt("markAccepted", () =>
      database.transaction(async (transaction) => {
        const [identity] = await transaction
          .select({
            userId: scheduledEmails.user_id,
            workflowId: scheduledEmailNotifications.workflow_id,
          })
          .from(scheduledEmailNotifications)
          .innerJoin(
            scheduledEmails,
            eq(scheduledEmails.workflow_id, scheduledEmailNotifications.workflow_id),
          )
          .where(eq(scheduledEmailNotifications.notification_id, notificationId))
          .limit(1);
        if (identity === undefined || !(await lockWorkflowUser(transaction, identity.userId))) {
          return null;
        }
        const [email] = await transaction
          .select({ workflowId: scheduledEmails.workflow_id })
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, identity.workflowId))
          .for("update")
          .limit(1);
        if (email === undefined || (await isAccessFenced(transaction, identity.userId)))
          return null;
        const [current] = await transaction
          .select({ ...selection, state: scheduledEmails.state })
          .from(scheduledEmailNotifications)
          .innerJoin(
            scheduledEmails,
            eq(scheduledEmails.workflow_id, scheduledEmailNotifications.workflow_id),
          )
          .where(eq(scheduledEmailNotifications.notification_id, notificationId))
          .for("update")
          .limit(1);
        if (current === undefined) return null;
        if (current.submissionId !== null && current.submissionId !== submissionId) return null;
        await transaction
          .update(scheduledEmailNotifications)
          .set({ accepted_at: current.acceptedAt ?? acceptedAt, think_submission_id: submissionId })
          .where(eq(scheduledEmailNotifications.notification_id, notificationId));
        return { ...current, acceptedAt: current.acceptedAt ?? acceptedAt, submissionId };
      }),
    ).pipe(Effect.flatMap((row) => requireNotification(notificationId, row))),
  selectDeliverySession: (notificationId, sessionId) =>
    attempt("selectDeliverySession", () =>
      database.transaction(async (transaction) => {
        const [identity] = await transaction
          .select({
            userId: scheduledEmails.user_id,
            workflowId: scheduledEmailNotifications.workflow_id,
          })
          .from(scheduledEmailNotifications)
          .innerJoin(
            scheduledEmails,
            eq(scheduledEmails.workflow_id, scheduledEmailNotifications.workflow_id),
          )
          .where(eq(scheduledEmailNotifications.notification_id, notificationId))
          .limit(1);
        if (identity === undefined || !(await lockWorkflowUser(transaction, identity.userId))) {
          return null;
        }
        const [email] = await transaction
          .select({ workflowId: scheduledEmails.workflow_id })
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, identity.workflowId))
          .for("update")
          .limit(1);
        if (email === undefined || (await isAccessFenced(transaction, identity.userId)))
          return null;
        const [current] = await transaction
          .select({ ...selection, state: scheduledEmails.state })
          .from(scheduledEmailNotifications)
          .innerJoin(
            scheduledEmails,
            eq(scheduledEmails.workflow_id, scheduledEmailNotifications.workflow_id),
          )
          .where(eq(scheduledEmailNotifications.notification_id, notificationId))
          .for("update")
          .limit(1);
        if (current === undefined) return null;
        if (
          current.acceptedAt !== null &&
          current.deliverySessionId !== null &&
          current.deliverySessionId !== sessionId
        ) {
          return null;
        }
        await transaction
          .update(scheduledEmailNotifications)
          .set({ delivery_session_id: sessionId })
          .where(eq(scheduledEmailNotifications.notification_id, notificationId));
        return { ...current, deliverySessionId: sessionId };
      }),
    ).pipe(Effect.flatMap((row) => requireNotification(notificationId, row))),
});

const isAccessFenced = async (
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  userId: string,
) => {
  const [deletion] = await transaction
    .select({ id: deletionCases.deletion_case_id })
    .from(deletionCases)
    .where(and(eq(deletionCases.user_id, userId), isNotNull(deletionCases.access_fenced_at)))
    .limit(1);
  return deletion !== undefined;
};

const decode = (row: Record<string, unknown>, state: unknown) =>
  Schema.decodeUnknownEffect(ScheduledEmailFollowUp.Notification)({ ...row, state }).pipe(
    Effect.mapError((cause) => unavailable("decode", cause)),
  );

const requireNotification = (
  notificationId: ScheduledEmailFollowUp.NotificationId,
  row: (Record<string, unknown> & { readonly state: unknown }) | null,
) => (row === null ? Effect.fail(unavailable("identity", notificationId)) : decode(row, row.state));

const attempt = <Value>(operation: string, run: () => PromiseLike<Value>) =>
  Effect.tryPromise({ try: run, catch: (cause) => unavailable(operation, cause) });

const unavailable = (operation: string, cause: unknown) =>
  new ScheduledEmailFollowUp.Unavailable({
    cause,
    message: "Scheduled Email follow-up persistence is unavailable",
    operation,
  });

export * as ScheduledEmailFollowUpPostgres from "./scheduled-email-follow-up";
