import { allowancePeriods } from "@osfo/db/schema/allowances";
import { documentBuildNotifications, documentBuilds } from "@osfo/db/schema/document-builds";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { and, desc, eq, isNotNull, notExists, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "@osfo/db";
import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ChannelLinkId,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  Plan,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../../domain";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { DocumentBuild } from "../../services/document-build";
import { DocumentBuildFollowUp } from "../../services/document-build-follow-up";
import { DocumentBuildPostgres } from "./document-build";
import { countWorkflowMilestones, lockWorkflowUser } from "./workflow-serialization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions own PostgreSQL serialization. */
/* oxlint-disable eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Effect result tags and decoded rows are owned here. */
/* oxlint-disable effecttsgo/global-date -- Rolling-window arithmetic uses the injected product clock. */

const previewDelayMilliseconds = 15 * 60 * 1_000;
const notificationWindowMilliseconds = 24 * 60 * 60 * 1_000;
const milestoneLimit = 3;

export const deadlineDisposition = (state: DocumentBuild.State, now: Date, deadlineAt: Date) => {
  if (DocumentBuild.terminalStates.has(state) || state === "publication_committed") {
    return "Terminal" as const;
  }
  if (now.getTime() < deadlineAt.getTime()) return "NotDue" as const;
  return "Canceled" as const;
};

const notificationSelection = {
  acceptedAt: documentBuildNotifications.delivered_at,
  agentId: documentBuilds.agent_id,
  allowancePeriodId: documentBuilds.allowance_period_id,
  artifactContentId: documentBuilds.artifact_content_id,
  buildState: documentBuilds.state,
  capabilityCatalogVersion: documentBuilds.capability_catalog_version,
  claimedAt: documentBuildNotifications.claimed_at,
  format: sql<string>`${documentBuilds.request_json}::jsonb ->> 'format'`,
  inputDigest: documentBuilds.input_digest,
  kind: documentBuildNotifications.kind,
  modelAccessPolicyVersion: documentBuilds.model_access_policy_version,
  modelRoute: documentBuilds.model_route,
  notificationId: documentBuildNotifications.notification_id,
  plan: allowancePeriods.plan,
  planPolicyVersion: documentBuilds.plan_policy_version,
  resourcePriceVersion: documentBuilds.resource_price_version,
  routeId: documentBuilds.route_id,
  safeFailureCode: documentBuilds.safe_failure_code,
  sessionId: documentBuilds.session_id,
  userId: documentBuilds.user_id,
  workflowId: documentBuilds.workflow_id,
  whatsAppChannelLinkId: sql<string | null>`(
    select channel_link_id
    from channel_links
    where channel_link_id = (${documentBuilds.originating_authority_json}::jsonb ->> 'channelLinkId')
      and user_id = ${documentBuilds.user_id}
      and channel_id = 'whatsapp'
      and revoked_at is null
    limit 1
  )`,
};

const EncodedNotification = Schema.Struct({
  acceptedAt: Schema.NullOr(Schema.Date),
  agentId: AgentId,
  allowancePeriodId: AllowancePeriodId,
  artifactContentId: Schema.NullOr(Schema.String),
  buildState: DocumentBuild.State,
  capabilityCatalogVersion: CapabilityCatalogVersion,
  claimedAt: Schema.Date,
  format: Schema.Literals(["pdf", "docx"]),
  inputDigest: DocumentBuild.InputDigest,
  kind: DocumentBuildFollowUp.NotificationKind,
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  notificationId: DocumentBuildFollowUp.NotificationId,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  resourcePriceVersion: ResourcePriceVersion,
  routeId: ConversationRouteId,
  safeFailureCode: Schema.NullOr(Schema.String),
  sessionId: SessionId,
  userId: UserId,
  workflowId: DocumentBuild.WorkflowId,
  whatsAppChannelLinkId: Schema.NullOr(ChannelLinkId),
});

export const make = (database: Database): DocumentBuildFollowUp.PortInterface => {
  const builds = DocumentBuildPostgres.make(database);

  const inspect = (notificationId: DocumentBuildFollowUp.NotificationId) =>
    attempt("inspect", () =>
      database
        .select(notificationSelection)
        .from(documentBuildNotifications)
        .innerJoin(
          documentBuilds,
          eq(documentBuilds.workflow_id, documentBuildNotifications.workflow_id),
        )
        .innerJoin(
          allowancePeriods,
          and(
            eq(allowancePeriods.user_id, documentBuilds.user_id),
            eq(allowancePeriods.allowance_period_id, documentBuilds.allowance_period_id),
          ),
        )
        .where(
          and(
            eq(documentBuildNotifications.notification_id, notificationId),
            notExists(
              database
                .select({ deletionCaseId: deletionCases.deletion_case_id })
                .from(deletionCases)
                .where(
                  and(
                    eq(deletionCases.user_id, documentBuilds.user_id),
                    isNotNull(deletionCases.access_fenced_at),
                  ),
                ),
            ),
          ),
        )
        .limit(1),
    ).pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decode(row))));

  const readBuild = (
    workflowId: DocumentBuild.WorkflowId,
    result: "Canceled" | "NotDue" | "Terminal",
  ) =>
    builds.inspect(workflowId).pipe(
      Effect.flatMap((build) =>
        build === null
          ? Effect.fail(
              new DocumentBuildFollowUp.Conflict({
                message: "The deadline transition lost its Document Build row",
                notificationId: null,
                workflowId,
              }),
            )
          : Effect.succeed({ _tag: result, build } as const),
      ),
      Effect.mapError((cause) =>
        Schema.is(DocumentBuildFollowUp.Conflict)(cause)
          ? cause
          : unavailable("deadline.inspect", cause),
      ),
    );

  return {
    deliveredForUser: (userId) =>
      attempt("deliveredForUser", () =>
        database
          .select(notificationSelection)
          .from(documentBuildNotifications)
          .innerJoin(
            documentBuilds,
            eq(documentBuilds.workflow_id, documentBuildNotifications.workflow_id),
          )
          .innerJoin(
            allowancePeriods,
            and(
              eq(allowancePeriods.user_id, documentBuilds.user_id),
              eq(allowancePeriods.allowance_period_id, documentBuilds.allowance_period_id),
            ),
          )
          .where(
            and(
              eq(documentBuildNotifications.user_id, userId),
              isNotNull(documentBuildNotifications.delivered_at),
            ),
          )
          .orderBy(desc(documentBuildNotifications.delivered_at))
          .limit(20),
      ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decode))),
    claimPreview: (payload, now) =>
      Effect.gen(function* () {
        const result = yield* attempt("claimPreview", () =>
          database.transaction(async (transaction) => {
            const identity = await lockNotificationWorkflowUser(transaction, payload);
            if (identity === null) return { _tag: "Conflict" as const };
            const [row] = await transaction
              .select({
                admittedAt: documentBuilds.admitted_at,
                artifactContentId: documentBuilds.artifact_content_id,
                milestoneClaimedAt: documentBuilds.milestone_claimed_at,
                previewStoredAt: documentBuilds.preview_stored_at,
                state: documentBuilds.state,
                userId: documentBuilds.user_id,
                workflowId: documentBuilds.workflow_id,
              })
              .from(documentBuilds)
              .where(eq(documentBuilds.workflow_id, payload.workflowId))
              .for("update")
              .limit(1);
            if (row === undefined) return { _tag: "Conflict" as const };
            const [deletion] = await transaction
              .select({ id: deletionCases.deletion_case_id })
              .from(deletionCases)
              .where(
                and(
                  eq(deletionCases.user_id, row.userId),
                  isNotNull(deletionCases.access_fenced_at),
                ),
              )
              .limit(1);
            if (deletion !== undefined) return { _tag: "Suppressed" as const };
            const notificationId = DocumentBuildFollowUp.notificationIdFor(
              payload.workflowId,
              "previewReady",
            );
            if (row.milestoneClaimedAt !== null) {
              const [existing] = await transaction
                .select({ id: documentBuildNotifications.notification_id })
                .from(documentBuildNotifications)
                .where(eq(documentBuildNotifications.notification_id, notificationId))
                .limit(1);
              return { _tag: "AlreadyClaimed" as const, notificationId: existing?.id ?? null };
            }
            if (
              DocumentBuild.terminalStates.has(DocumentBuild.State.make(row.state)) ||
              row.state === "publication_committed"
            ) {
              return { _tag: "Terminal" as const };
            }
            if (
              row.state !== "preview_stored" ||
              row.artifactContentId === null ||
              row.previewStoredAt === null
            ) {
              return { _tag: "AwaitingPreview" as const };
            }
            if (now.getTime() < row.admittedAt.getTime() + previewDelayMilliseconds) {
              return { _tag: "NotDue" as const };
            }
            const windowStart = new Date(now.getTime() - notificationWindowMilliseconds);
            const milestoneCount = await countWorkflowMilestones(
              transaction,
              row.userId,
              windowStart,
            );
            await transaction
              .update(documentBuilds)
              .set({ milestone_claimed_at: now, updated_at: now })
              .where(eq(documentBuilds.workflow_id, payload.workflowId));
            if (milestoneCount >= milestoneLimit) {
              return { _tag: "Suppressed" as const };
            }
            await transaction.insert(documentBuildNotifications).values({
              claimed_at: now,
              kind: "previewReady",
              notification_id: notificationId,
              user_id: row.userId,
              workflow_id: row.workflowId,
            });
            return { _tag: "Claimed" as const, notificationId };
          }),
        );
        if (result._tag === "Conflict") return yield* conflict(payload, null);
        if (result._tag === "Claimed") {
          const notification = yield* inspect(result.notificationId);
          if (notification === null) return yield* conflict(payload, result.notificationId);
          return { _tag: "Claimed" as const, notification };
        }
        if (result._tag === "AlreadyClaimed" && result.notificationId !== null) {
          const notification = yield* inspect(
            DocumentBuildFollowUp.NotificationId.make(result.notificationId),
          );
          return { _tag: "AlreadyClaimed" as const, notification };
        }
        if (result._tag === "AlreadyClaimed") {
          return { _tag: "AlreadyClaimed" as const, notification: null };
        }
        return result;
      }),
    claimTerminal: (payload, now) =>
      Effect.gen(function* () {
        const result = yield* attempt("claimTerminal", () =>
          database.transaction(async (transaction) => {
            if ((await lockNotificationWorkflowUser(transaction, payload)) === null) {
              return { _tag: "Conflict" as const };
            }
            const [row] = await transaction
              .select({
                state: documentBuilds.state,
                terminalFollowUpClaimedAt: documentBuilds.terminal_followup_claimed_at,
                userId: documentBuilds.user_id,
                workflowId: documentBuilds.workflow_id,
              })
              .from(documentBuilds)
              .where(eq(documentBuilds.workflow_id, payload.workflowId))
              .for("update")
              .limit(1);
            if (row === undefined) return { _tag: "Conflict" as const };
            if (!DocumentBuild.terminalStates.has(DocumentBuild.State.make(row.state))) {
              return { _tag: "NotTerminal" as const };
            }
            const [deletion] = await transaction
              .select({ id: deletionCases.deletion_case_id })
              .from(deletionCases)
              .where(
                and(
                  eq(deletionCases.user_id, row.userId),
                  isNotNull(deletionCases.access_fenced_at),
                ),
              )
              .limit(1);
            if (deletion !== undefined) return { _tag: "Suppressed" as const };
            const notificationId = DocumentBuildFollowUp.notificationIdFor(
              payload.workflowId,
              "terminal",
            );
            if (row.terminalFollowUpClaimedAt === null) {
              await transaction.insert(documentBuildNotifications).values({
                claimed_at: now,
                kind: "terminal",
                notification_id: notificationId,
                user_id: row.userId,
                workflow_id: row.workflowId,
              });
              await transaction
                .update(documentBuilds)
                .set({ terminal_followup_claimed_at: now, updated_at: now })
                .where(eq(documentBuilds.workflow_id, payload.workflowId));
              return { _tag: "Claimed" as const, notificationId };
            }
            return { _tag: "AlreadyClaimed" as const, notificationId };
          }),
        );
        if (result._tag === "Conflict") return yield* conflict(payload, null);
        if (result._tag === "NotTerminal" || result._tag === "Suppressed") return result;
        const notification = yield* inspect(result.notificationId);
        if (notification === null) return yield* conflict(payload, result.notificationId);
        return result._tag === "Claimed"
          ? { _tag: "Claimed" as const, notification }
          : { _tag: "AlreadyClaimed" as const, notification };
      }),
    enforceDeadline: (payload, now) =>
      attempt("enforceDeadline", () =>
        database.transaction(async (transaction) => {
          if ((await lockNotificationWorkflowUser(transaction, payload)) === null) {
            return { _tag: "Conflict" as const };
          }
          const [row] = await transaction
            .select({
              deadlineAt: documentBuilds.deadline_at,
              inputDigest: documentBuilds.input_digest,
              state: documentBuilds.state,
            })
            .from(documentBuilds)
            .where(eq(documentBuilds.workflow_id, payload.workflowId))
            .for("update")
            .limit(1);
          if (row === undefined || row.inputDigest !== payload.inputDigest) {
            return { _tag: "Conflict" as const };
          }
          const disposition = deadlineDisposition(
            DocumentBuild.State.make(row.state),
            now,
            row.deadlineAt,
          );
          if (disposition !== "Canceled") return { _tag: disposition };
          await transaction
            .update(documentBuilds)
            .set({
              safe_failure_code: "deadline-exceeded",
              state: "canceled",
              terminal_at: row.deadlineAt,
              updated_at: now,
            })
            .where(eq(documentBuilds.workflow_id, payload.workflowId));
          return { _tag: "Canceled" as const };
        }),
      ).pipe(
        Effect.flatMap((result) =>
          result._tag === "Conflict"
            ? conflict(payload, null)
            : readBuild(payload.workflowId, result._tag),
        ),
      ),
    inspect,
    inspectSchedule: (payload) =>
      attempt("inspectSchedule", () =>
        database
          .select({
            admittedAt: documentBuilds.admitted_at,
            deadlineAt: documentBuilds.deadline_at,
            inputDigest: documentBuilds.input_digest,
            state: documentBuilds.state,
          })
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, payload.workflowId))
          .limit(1),
      ).pipe(
        Effect.flatMap(([row]) =>
          row === undefined || row.inputDigest !== payload.inputDigest
            ? conflict(payload, null)
            : Effect.succeed({
                admittedAt: row.admittedAt,
                deadlineAt: row.deadlineAt,
                state: DocumentBuild.State.make(row.state),
              }),
        ),
      ),
    markAccepted: (notificationId, submissionId, acceptedAt) =>
      Effect.gen(function* () {
        const result = yield* attempt("markAccepted", () =>
          database.transaction(async (transaction) => {
            const [row] = await transaction
              .select({
                deliveredAt: documentBuildNotifications.delivered_at,
                kind: documentBuildNotifications.kind,
                submissionId: documentBuildNotifications.think_submission_id,
                workflowId: documentBuildNotifications.workflow_id,
              })
              .from(documentBuildNotifications)
              .where(eq(documentBuildNotifications.notification_id, notificationId))
              .for("update")
              .limit(1);
            if (row === undefined) return { _tag: "Missing" as const };
            if (row.submissionId !== null && row.submissionId !== submissionId) {
              return { _tag: "Conflict" as const, workflowId: row.workflowId };
            }
            if (row.deliveredAt === null) {
              await transaction
                .update(documentBuildNotifications)
                .set({ delivered_at: acceptedAt, think_submission_id: submissionId })
                .where(eq(documentBuildNotifications.notification_id, notificationId));
              await transaction
                .update(documentBuilds)
                .set(
                  row.kind === "previewReady"
                    ? { milestone_followup_at: acceptedAt, updated_at: acceptedAt }
                    : { terminal_followup_at: acceptedAt, updated_at: acceptedAt },
                )
                .where(eq(documentBuilds.workflow_id, row.workflowId));
            }
            return { _tag: "Accepted" as const };
          }),
        );
        if (result._tag === "Missing") {
          return yield* unavailable("markAccepted.missing", notificationId);
        }
        if (result._tag === "Conflict") {
          return yield* new DocumentBuildFollowUp.Conflict({
            message: "The notification already names a different Think Submission",
            notificationId,
            workflowId: DocumentBuild.WorkflowId.make(result.workflowId),
          });
        }
        const notification = yield* inspect(notificationId);
        if (notification === null) {
          return yield* unavailable("markAccepted.inspect", notificationId);
        }
        return notification;
      }),
  };
};

const decode = (row: unknown) =>
  Schema.decodeUnknownEffect(EncodedNotification)(row).pipe(
    Effect.mapError((cause) => unavailable("decode", cause)),
  );

const conflict = (
  payload: DocumentBuild.WorkflowPayload,
  notificationId: DocumentBuildFollowUp.NotificationId | null,
) =>
  Effect.fail(
    new DocumentBuildFollowUp.Conflict({
      message: "The notification does not match the committed Document Build",
      notificationId,
      workflowId: payload.workflowId,
    }),
  );

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const lockNotificationWorkflowUser = async (
  transaction: Transaction,
  payload: DocumentBuild.WorkflowPayload,
) => {
  const [identity] = await transaction
    .select({ inputDigest: documentBuilds.input_digest, userId: documentBuilds.user_id })
    .from(documentBuilds)
    .where(eq(documentBuilds.workflow_id, payload.workflowId))
    .limit(1);
  if (identity === undefined || identity.inputDigest !== payload.inputDigest) return null;
  await lockWorkflowUser(transaction, identity.userId);
  return identity;
};

const attempt = <A>(operation: string, query: () => Promise<A>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) => unavailable(operation, cause),
  });

const unavailable = (operation: string, cause: unknown) =>
  new DocumentBuildFollowUp.Unavailable({ cause, operation });

export * as DocumentBuildFollowUpPostgres from "./document-build-follow-up";
