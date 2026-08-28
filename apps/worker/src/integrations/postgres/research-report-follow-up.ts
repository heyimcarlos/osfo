import { allowancePeriods } from "@osfo/db/schema/allowances";
import { researchReportNotifications, researchReports } from "@osfo/db/schema/research-reports";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
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
import { ResearchReport } from "../../services/research-report";
import { ResearchReportFollowUp } from "../../services/research-report-follow-up";
import { ResearchReportPostgres } from "./research-report";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions own PostgreSQL serialization. */
/* oxlint-disable eslint/no-underscore-dangle, osfo/no-unknown-parameters -- Effect result tags and the schema-decoded Drizzle row are owned by this adapter. */
/* oxlint-disable effecttsgo/global-date -- Rolling-window arithmetic is derived from the injected product clock before the PostgreSQL query. */

const milestoneDelayMilliseconds = 15 * 60 * 1_000;
const notificationWindowMilliseconds = 24 * 60 * 60 * 1_000;
const milestoneLimit = 3;

export const deadlineDisposition = (state: ResearchReport.State, now: Date, deadlineAt: Date) => {
  if (ResearchReport.terminalStates.has(state)) return "Terminal" as const;
  if (now.getTime() < deadlineAt.getTime()) return "NotDue" as const;
  if (state === "publication_committed") return "PublicationPending" as const;
  return "Canceled" as const;
};

const notificationSelection = {
  acceptedAt: researchReportNotifications.delivered_at,
  agentId: researchReports.agent_id,
  allowancePeriodId: researchReports.allowance_period_id,
  artifactContentId: researchReports.artifact_content_id,
  capabilityCatalogVersion: researchReports.capability_catalog_version,
  claimedAt: researchReportNotifications.claimed_at,
  inputDigest: researchReports.input_digest,
  kind: researchReportNotifications.kind,
  modelAccessPolicyVersion: researchReports.model_access_policy_version,
  modelRoute: researchReports.model_route,
  notificationId: researchReportNotifications.notification_id,
  plan: allowancePeriods.plan,
  planPolicyVersion: researchReports.plan_policy_version,
  reportState: researchReports.state,
  routeId: researchReports.route_id,
  resourcePriceVersion: researchReports.resource_price_version,
  safeFailureCode: researchReports.safe_failure_code,
  sessionId: researchReports.session_id,
  sourceExposedAt: researchReportNotifications.source_exposed_at,
  userId: researchReports.user_id,
  workflowId: researchReports.workflow_id,
  whatsAppChannelLinkId: sql<string | null>`(
    select channel_link_id
    from channel_links
    where channel_link_id = (${researchReports.originating_authority_json}::jsonb ->> 'channelLinkId')
      and user_id = ${researchReports.user_id}
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
  capabilityCatalogVersion: CapabilityCatalogVersion,
  claimedAt: Schema.Date,
  inputDigest: ResearchReport.InputDigest,
  kind: ResearchReportFollowUp.NotificationKind,
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  notificationId: ResearchReportFollowUp.NotificationId,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  reportState: ResearchReport.State,
  routeId: ConversationRouteId,
  resourcePriceVersion: ResourcePriceVersion,
  safeFailureCode: Schema.NullOr(Schema.String),
  sessionId: SessionId,
  sourceExposedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
  workflowId: ResearchReport.WorkflowId,
  whatsAppChannelLinkId: Schema.NullOr(ChannelLinkId),
});

export const make = (database: Database): ResearchReportFollowUp.PortInterface => {
  const reports = ResearchReportPostgres.make(database);

  const inspect = (notificationId: ResearchReportFollowUp.NotificationId) =>
    attempt("inspect", () =>
      database
        .select(notificationSelection)
        .from(researchReportNotifications)
        .innerJoin(
          researchReports,
          eq(researchReports.workflow_id, researchReportNotifications.workflow_id),
        )
        .innerJoin(
          allowancePeriods,
          and(
            eq(allowancePeriods.user_id, researchReports.user_id),
            eq(allowancePeriods.allowance_period_id, researchReports.allowance_period_id),
          ),
        )
        .where(
          and(
            eq(researchReportNotifications.notification_id, notificationId),
            notExists(
              database
                .select({ deletionCaseId: deletionCases.deletion_case_id })
                .from(deletionCases)
                .where(
                  and(
                    eq(deletionCases.user_id, researchReports.user_id),
                    isNotNull(deletionCases.access_fenced_at),
                  ),
                ),
            ),
          ),
        )
        .limit(1),
    ).pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decode(row))));

  const readReport = (
    workflowId: ResearchReport.WorkflowId,
    result: "Canceled" | "NotDue" | "PublicationPending" | "Terminal",
  ) =>
    reports.inspect(workflowId).pipe(
      Effect.flatMap((report) =>
        report === null
          ? Effect.fail(
              new ResearchReportFollowUp.Conflict({
                message: "The deadline transition lost its Research Report row",
                notificationId: null,
                workflowId,
              }),
            )
          : Effect.succeed({ _tag: result, report } as const),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ResearchReportFollowUpConflict"
          ? cause
          : unavailable("deadline.inspect", cause),
      ),
    );

  return {
    deliveredForUser: (userId) =>
      attempt("deliveredForUser", () =>
        database
          .select(notificationSelection)
          .from(researchReportNotifications)
          .innerJoin(
            researchReports,
            eq(researchReports.workflow_id, researchReportNotifications.workflow_id),
          )
          .innerJoin(
            allowancePeriods,
            and(
              eq(allowancePeriods.user_id, researchReports.user_id),
              eq(allowancePeriods.allowance_period_id, researchReports.allowance_period_id),
            ),
          )
          .where(
            and(
              eq(researchReportNotifications.user_id, userId),
              isNotNull(researchReportNotifications.delivered_at),
            ),
          )
          .orderBy(desc(researchReportNotifications.delivered_at))
          .limit(20),
      ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decode))),
    claimMilestone: (payload, now) =>
      Effect.gen(function* () {
        const result = yield* attempt("claimMilestone", () =>
          database.transaction(async (transaction) => {
            if (!(await lockWorkflowUser(transaction, payload))) {
              return { _tag: "Conflict" as const };
            }
            const [row] = await transaction
              .select({
                admittedAt: researchReports.admitted_at,
                inputDigest: researchReports.input_digest,
                milestoneClaimedAt: researchReports.milestone_claimed_at,
                state: researchReports.state,
                userId: researchReports.user_id,
                workflowId: researchReports.workflow_id,
              })
              .from(researchReports)
              .where(eq(researchReports.workflow_id, payload.workflowId))
              .for("update")
              .limit(1);
            if (row === undefined || row.inputDigest !== payload.inputDigest) {
              return { _tag: "Conflict" as const };
            }
            const [deletion] = await transaction
              .select({ deletionCaseId: deletionCases.deletion_case_id })
              .from(deletionCases)
              .where(
                and(
                  eq(deletionCases.user_id, row.userId),
                  isNotNull(deletionCases.access_fenced_at),
                ),
              )
              .limit(1);
            if (deletion !== undefined) return { _tag: "Suppressed" as const };
            const notificationId = ResearchReportFollowUp.notificationIdFor(
              payload.workflowId,
              "sourcesCollected",
            );
            if (row.milestoneClaimedAt !== null) {
              const [existing] = await transaction
                .select({ notificationId: researchReportNotifications.notification_id })
                .from(researchReportNotifications)
                .where(eq(researchReportNotifications.notification_id, notificationId))
                .limit(1);
              return {
                _tag: "AlreadyClaimed" as const,
                notificationId: existing?.notificationId ?? null,
              };
            }
            if (ResearchReport.terminalStates.has(ResearchReport.State.make(row.state))) {
              return { _tag: "Terminal" as const };
            }
            if (
              row.state !== "sources_committed" &&
              row.state !== "artifact_stored" &&
              row.state !== "publication_committed"
            ) {
              return { _tag: "AwaitingSources" as const };
            }
            if (now.getTime() < row.admittedAt.getTime() + milestoneDelayMilliseconds) {
              return { _tag: "NotDue" as const };
            }
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${row.userId}, 0))`,
            );
            await transaction
              .update(researchReports)
              .set({ milestone_claimed_at: now, updated_at: now })
              .where(eq(researchReports.workflow_id, payload.workflowId));
            const [countRow] = await transaction
              .select({ count: sql<number>`count(*)::integer` })
              .from(researchReportNotifications)
              .where(
                and(
                  eq(researchReportNotifications.user_id, row.userId),
                  eq(researchReportNotifications.kind, "sourcesCollected"),
                  gt(
                    researchReportNotifications.claimed_at,
                    new Date(now.getTime() - notificationWindowMilliseconds),
                  ),
                ),
              );
            if ((countRow?.count ?? 0) >= milestoneLimit) {
              return { _tag: "Suppressed" as const };
            }
            await transaction.insert(researchReportNotifications).values({
              claimed_at: now,
              kind: "sourcesCollected",
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
            ResearchReportFollowUp.NotificationId.make(result.notificationId),
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
            if (!(await lockWorkflowUser(transaction, payload))) {
              return { _tag: "Conflict" as const };
            }
            const [row] = await transaction
              .select({
                inputDigest: researchReports.input_digest,
                state: researchReports.state,
                terminalFollowUpClaimedAt: researchReports.terminal_followup_claimed_at,
                userId: researchReports.user_id,
                workflowId: researchReports.workflow_id,
              })
              .from(researchReports)
              .where(eq(researchReports.workflow_id, payload.workflowId))
              .for("update")
              .limit(1);
            if (row === undefined || row.inputDigest !== payload.inputDigest) {
              return { _tag: "Conflict" as const };
            }
            if (!ResearchReport.terminalStates.has(ResearchReport.State.make(row.state))) {
              return { _tag: "NotTerminal" as const };
            }
            const [deletion] = await transaction
              .select({ deletionCaseId: deletionCases.deletion_case_id })
              .from(deletionCases)
              .where(
                and(
                  eq(deletionCases.user_id, row.userId),
                  isNotNull(deletionCases.access_fenced_at),
                ),
              )
              .limit(1);
            if (deletion !== undefined) return { _tag: "Suppressed" as const };
            const notificationId = ResearchReportFollowUp.notificationIdFor(
              payload.workflowId,
              "terminal",
            );
            if (row.terminalFollowUpClaimedAt === null) {
              await transaction.insert(researchReportNotifications).values({
                claimed_at: now,
                kind: "terminal",
                notification_id: notificationId,
                user_id: row.userId,
                workflow_id: row.workflowId,
              });
              await transaction
                .update(researchReports)
                .set({ terminal_followup_claimed_at: now, updated_at: now })
                .where(eq(researchReports.workflow_id, payload.workflowId));
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
          const [row] = await transaction
            .select({
              deadlineAt: researchReports.deadline_at,
              inputDigest: researchReports.input_digest,
              state: researchReports.state,
            })
            .from(researchReports)
            .where(eq(researchReports.workflow_id, payload.workflowId))
            .for("update")
            .limit(1);
          if (row === undefined || row.inputDigest !== payload.inputDigest) {
            return { _tag: "Conflict" as const };
          }
          const disposition = deadlineDisposition(
            ResearchReport.State.make(row.state),
            now,
            row.deadlineAt,
          );
          if (disposition !== "Canceled") return { _tag: disposition };
          await transaction
            .update(researchReports)
            .set({
              safe_failure_code: "deadline-exceeded",
              state: "canceled",
              terminal_at: now,
              updated_at: now,
            })
            .where(eq(researchReports.workflow_id, payload.workflowId));
          return { _tag: "Canceled" as const };
        }),
      ).pipe(
        Effect.flatMap((result) =>
          result._tag === "Conflict"
            ? conflict(payload, null)
            : readReport(payload.workflowId, result._tag),
        ),
      ),
    exposeSources: (userId, notificationIds, exposedAt) => {
      if (notificationIds.length === 0) return Effect.void;
      return attempt("exposeSources", () =>
        database
          .update(researchReportNotifications)
          .set({ source_exposed_at: exposedAt })
          .where(
            and(
              eq(researchReportNotifications.user_id, userId),
              inArray(researchReportNotifications.notification_id, notificationIds),
              isNotNull(researchReportNotifications.delivered_at),
              isNull(researchReportNotifications.source_exposed_at),
            ),
          ),
      ).pipe(Effect.asVoid);
    },
    inspect,
    inspectSchedule: (payload) =>
      attempt("inspectSchedule", () =>
        database
          .select({
            admittedAt: researchReports.admitted_at,
            deadlineAt: researchReports.deadline_at,
            inputDigest: researchReports.input_digest,
            state: researchReports.state,
          })
          .from(researchReports)
          .where(eq(researchReports.workflow_id, payload.workflowId))
          .limit(1),
      ).pipe(
        Effect.flatMap(([row]) => {
          if (row === undefined || row.inputDigest !== payload.inputDigest) {
            return conflict(payload, null);
          }
          return Effect.succeed({
            admittedAt: row.admittedAt,
            deadlineAt: row.deadlineAt,
            state: ResearchReport.State.make(row.state),
          });
        }),
      ),
    markAccepted: (notificationId, submissionId, acceptedAt) =>
      Effect.gen(function* () {
        const result = yield* attempt("markAccepted", () =>
          database.transaction(async (transaction) => {
            const [row] = await transaction
              .select({
                deliveredAt: researchReportNotifications.delivered_at,
                kind: researchReportNotifications.kind,
                submissionId: researchReportNotifications.think_submission_id,
                workflowId: researchReportNotifications.workflow_id,
              })
              .from(researchReportNotifications)
              .where(eq(researchReportNotifications.notification_id, notificationId))
              .for("update")
              .limit(1);
            if (row === undefined) return { _tag: "Missing" as const };
            if (row.submissionId !== null && row.submissionId !== submissionId) {
              return { _tag: "Conflict" as const, workflowId: row.workflowId };
            }
            if (row.deliveredAt === null) {
              await transaction
                .update(researchReportNotifications)
                .set({ delivered_at: acceptedAt, think_submission_id: submissionId })
                .where(eq(researchReportNotifications.notification_id, notificationId));
              await transaction
                .update(researchReports)
                .set(
                  row.kind === "sourcesCollected"
                    ? { milestone_followup_at: acceptedAt, updated_at: acceptedAt }
                    : { terminal_followup_at: acceptedAt, updated_at: acceptedAt },
                )
                .where(eq(researchReports.workflow_id, row.workflowId));
            }
            return { _tag: "Accepted" as const };
          }),
        );
        if (result._tag === "Missing") {
          return yield* new ResearchReportFollowUp.Unavailable({
            cause: notificationId,
            operation: "markAccepted.missing",
          });
        }
        if (result._tag === "Conflict") {
          return yield* new ResearchReportFollowUp.Conflict({
            message: "The notification already names a different Think Submission",
            notificationId,
            workflowId: ResearchReport.WorkflowId.make(result.workflowId),
          });
        }
        const notification = yield* inspect(notificationId);
        if (notification === null) {
          return yield* new ResearchReportFollowUp.Unavailable({
            cause: notificationId,
            operation: "markAccepted.inspect",
          });
        }
        return notification;
      }),
    pendingSources: (userId) =>
      attempt("pendingSources", () =>
        database
          .select(notificationSelection)
          .from(researchReportNotifications)
          .innerJoin(
            researchReports,
            eq(researchReports.workflow_id, researchReportNotifications.workflow_id),
          )
          .innerJoin(
            allowancePeriods,
            and(
              eq(allowancePeriods.user_id, researchReports.user_id),
              eq(allowancePeriods.allowance_period_id, researchReports.allowance_period_id),
            ),
          )
          .where(
            and(
              eq(researchReportNotifications.user_id, userId),
              isNotNull(researchReportNotifications.delivered_at),
              isNull(researchReportNotifications.source_exposed_at),
            ),
          ),
      ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decode))),
  };
};

const decode = (row: unknown) =>
  Schema.decodeUnknownEffect(EncodedNotification)(row).pipe(
    Effect.mapError((cause) => unavailable("decode", cause)),
  );

const conflict = (
  payload: ResearchReport.WorkflowPayload,
  notificationId: ResearchReportFollowUp.NotificationId | null,
) =>
  Effect.fail(
    new ResearchReportFollowUp.Conflict({
      message: "The notification does not match the committed Research Report",
      notificationId,
      workflowId: payload.workflowId,
    }),
  );

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const lockWorkflowUser = async (
  transaction: Transaction,
  payload: ResearchReport.WorkflowPayload,
) => {
  const [identity] = await transaction
    .select({
      inputDigest: researchReports.input_digest,
      userId: researchReports.user_id,
    })
    .from(researchReports)
    .where(eq(researchReports.workflow_id, payload.workflowId))
    .limit(1);
  if (identity === undefined || identity.inputDigest !== payload.inputDigest) return false;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`research-report:user:${identity.userId}`}, 0))`,
  );
  return true;
};

const attempt = <A>(operation: string, query: () => Promise<A>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) => unavailable(operation, cause),
  });

const unavailable = (operation: string, cause: unknown) =>
  new ResearchReportFollowUp.Unavailable({ cause, operation });

export * as ResearchReportFollowUpPostgres from "./research-report-follow-up";
