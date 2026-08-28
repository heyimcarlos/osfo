import { agents } from "@osfo/db/schema/agents";
import { sessions } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { researchReports } from "@osfo/db/schema/research-reports";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { DateTime, Effect, Predicate, Schema } from "effect";

import type { Database } from "@osfo/db";
import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { ChannelAuthorId, ChannelId } from "../../domain/channel-link";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { ResearchReport } from "../../services/research-report";
import {
  Approval,
  AuthorizationContext,
  emptyLiveResourceFacts,
  OriginatingAuthority,
} from "../../services/authorization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions are the PostgreSQL serialization boundary. */
/* oxlint-disable eslint/no-underscore-dangle -- Persistence outcomes use the standard Effect _tag discriminator. */

const rowSelection = {
  acceptedAt: researchReports.accepted_at,
  actionId: researchReports.action_id,
  approvalJson: researchReports.approval_json,
  admittedAt: researchReports.admitted_at,
  artifactContentId: researchReports.artifact_content_id,
  artifactStoredAt: researchReports.artifact_stored_at,
  agentId: researchReports.agent_id,
  allowancePeriodId: researchReports.allowance_period_id,
  cancelRequestedAt: researchReports.cancel_requested_at,
  capabilityCatalogVersion: researchReports.capability_catalog_version,
  cloudflareInstanceId: researchReports.cloudflare_instance_id,
  deadlineAt: researchReports.deadline_at,
  inputDigest: researchReports.input_digest,
  manifestVersion: researchReports.manifest_version,
  modelAccessPolicyVersion: researchReports.model_access_policy_version,
  modelRoute: researchReports.model_route,
  originatingAuthorityJson: researchReports.originating_authority_json,
  planPolicyVersion: researchReports.plan_policy_version,
  requestJson: researchReports.request_json,
  resourcePriceVersion: researchReports.resource_price_version,
  routeId: researchReports.route_id,
  safeFailureCode: researchReports.safe_failure_code,
  sessionId: researchReports.session_id,
  sourceManifestKey: researchReports.source_manifest_key,
  sourceManifestDigest: researchReports.source_manifest_digest,
  state: researchReports.state,
  startedAt: researchReports.started_at,
  terminalAt: researchReports.terminal_at,
  userId: researchReports.user_id,
  workflowId: researchReports.workflow_id,
};

type Row = {
  readonly acceptedAt: Date | null;
  readonly actionId: string;
  readonly approvalJson: string | null;
  readonly admittedAt: Date;
  readonly artifactContentId: string | null;
  readonly artifactStoredAt: Date | null;
  readonly agentId: string;
  readonly allowancePeriodId: string;
  readonly cancelRequestedAt: Date | null;
  readonly capabilityCatalogVersion: string;
  readonly cloudflareInstanceId: string;
  readonly deadlineAt: Date;
  readonly inputDigest: string;
  readonly manifestVersion: string | null;
  readonly modelAccessPolicyVersion: string;
  readonly modelRoute: string;
  readonly originatingAuthorityJson: string;
  readonly planPolicyVersion: string;
  readonly requestJson: string;
  readonly resourcePriceVersion: string;
  readonly routeId: string;
  readonly safeFailureCode: string | null;
  readonly sessionId: string;
  readonly sourceManifestKey: string | null;
  readonly sourceManifestDigest: string | null;
  readonly state: string;
  readonly startedAt: Date | null;
  readonly terminalAt: Date | null;
  readonly userId: string;
  readonly workflowId: string;
};

const EncodedRecord = Schema.Struct({
  acceptedAt: Schema.NullOr(Schema.Date),
  actionId: ActionId,
  approval: Schema.NullOr(Approval),
  admittedAt: Schema.Date,
  artifactContentId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  artifactStoredAt: Schema.NullOr(Schema.Date),
  agentId: AgentId,
  allowancePeriodId: AllowancePeriodId,
  cancelRequestedAt: Schema.NullOr(Schema.Date),
  capabilityCatalogVersion: CapabilityCatalogVersion,
  cloudflareInstanceId: ResearchReport.CloudflareInstanceId,
  deadlineAt: Schema.Date,
  inputDigest: ResearchReport.InputDigest,
  manifestVersion: Schema.NullOr(Schema.String),
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  originatingAuthority: OriginatingAuthority,
  planPolicyVersion: PlanPolicyVersion,
  request: ResearchReport.Request,
  resourcePriceVersion: ResourcePriceVersion,
  routeId: ConversationRouteId,
  safeFailureCode: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  ),
  sessionId: SessionId,
  sourceManifestKey: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  sourceManifestDigest: Schema.NullOr(ResearchReport.InputDigest),
  state: ResearchReport.State,
  startedAt: Schema.NullOr(Schema.Date),
  terminalAt: Schema.NullOr(Schema.Date),
  userId: UserId,
  workflowId: ResearchReport.WorkflowId,
});

/** PostgreSQL product-state adapter for Research Report admission and cancellation. */
export const make = (database: Database): ResearchReport.PortInterface["persistence"] => ({
  admit: (record) =>
    attempt("admit", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${record.workflowId}, 0))`,
        );
        const [existing] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(eq(researchReports.workflow_id, record.workflowId))
          .limit(1)
          .for("update");
        if (existing !== undefined) return { _tag: "Existing" as const, row: existing };
        await transaction.insert(researchReports).values({
          accepted_at: record.acceptedAt,
          action_id: record.actionId,
          approval_json: encodeApproval(record.approval),
          admitted_at: record.admittedAt,
          artifact_content_id: record.artifactContentId,
          artifact_stored_at: record.artifactStoredAt,
          agent_id: record.agentId,
          allowance_period_id: record.allowancePeriodId,
          cancel_requested_at: record.cancelRequestedAt,
          capability_catalog_version: record.capabilityCatalogVersion,
          cloudflare_instance_id: record.cloudflareInstanceId,
          deadline_at: record.deadlineAt,
          input_digest: record.inputDigest,
          manifest_version: record.manifestVersion,
          model_access_policy_version: record.modelAccessPolicyVersion,
          model_route: record.modelRoute,
          originating_authority_json: encodeAuthority(record.originatingAuthority),
          plan_policy_version: record.planPolicyVersion,
          request_json: encodeRequest(record.request),
          resource_price_version: record.resourcePriceVersion,
          route_id: record.routeId,
          safe_failure_code: record.safeFailureCode,
          session_id: record.sessionId,
          source_manifest_key: record.sourceManifestKey,
          source_manifest_digest: record.sourceManifestDigest,
          state: record.state,
          started_at: record.startedAt,
          terminal_at: record.terminalAt,
          user_id: record.userId,
          workflow_id: record.workflowId,
        });
        const [created] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(eq(researchReports.workflow_id, record.workflowId))
          .limit(1);
        return created === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "Created" as const, row: created };
      }),
    ).pipe(
      Effect.flatMap((outcome) => {
        if (outcome._tag === "Missing") {
          return Effect.fail(unavailable("admit", "PostgreSQL did not return the admitted row"));
        }
        return decodeRow(outcome.row).pipe(
          Effect.flatMap((report) => {
            if (report.inputDigest !== record.inputDigest || report.userId !== record.userId) {
              return Effect.fail(
                new ResearchReport.Conflict({
                  message: "The Research Report identity already owns different immutable facts",
                  workflowId: record.workflowId,
                }),
              );
            }
            return Effect.succeed({ _tag: outcome._tag, report } as const);
          }),
        );
      }),
    ),
  inspect: (workflowId) =>
    attempt("inspect", () =>
      database
        .select(rowSelection)
        .from(researchReports)
        .where(eq(researchReports.workflow_id, workflowId))
        .limit(1),
    ).pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeRow(row)))),
  markAccepted: (workflowId, inputDigest, acceptedAt) =>
    attempt("markAccepted", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${workflowId}, 0))`,
        );
        const [row] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(eq(researchReports.workflow_id, workflowId))
          .limit(1)
          .for("update");
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== inputDigest) return { _tag: "Conflict" as const };
        if (row.state !== "admitted") return { _tag: "Found" as const, row };
        const [updated] = await transaction
          .update(researchReports)
          .set({ accepted_at: acceptedAt, state: "accepted", updated_at: acceptedAt })
          .where(
            and(
              eq(researchReports.workflow_id, workflowId),
              eq(researchReports.input_digest, inputDigest),
              eq(researchReports.state, "admitted"),
            ),
          )
          .returning(rowSelection);
        return updated === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "Found" as const, row: updated };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Missing") {
            return yield* new ResearchReport.NotFound({ workflowId });
          }
          if (outcome._tag === "Conflict") {
            return yield* new ResearchReport.Conflict({
              message: "Cloudflare acceptance named a changed Research Report input digest",
              workflowId,
            });
          }
          return yield* decodeRow(outcome.row);
        }),
      ),
    ),
  beginExecution: (workflowId, inputDigest, startedAt) =>
    attempt("beginExecution", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${workflowId}, 0))`,
        );
        const [row] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(eq(researchReports.workflow_id, workflowId))
          .limit(1)
          .for("update");
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== inputDigest) return { _tag: "Conflict" as const };
        if (
          row.state === "running" ||
          row.state === "sources_committed" ||
          row.state === "artifact_stored" ||
          row.state === "success"
        ) {
          return row.startedAt === null
            ? { _tag: "Conflict" as const }
            : { _tag: "Found" as const, row };
        }
        if (row.state !== "admitted" && row.state !== "accepted") {
          return { _tag: "Conflict" as const };
        }
        const [updated] = await transaction
          .update(researchReports)
          .set({
            accepted_at: row.acceptedAt ?? startedAt,
            started_at: startedAt,
            state: "running",
            updated_at: startedAt,
          })
          .where(
            and(
              eq(researchReports.workflow_id, workflowId),
              eq(researchReports.input_digest, inputDigest),
              inArray(researchReports.state, ["admitted", "accepted"]),
              sql`${researchReports.started_at} is null`,
            ),
          )
          .returning(rowSelection);
        return updated === undefined
          ? { _tag: "Conflict" as const }
          : { _tag: "Found" as const, row: updated };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Missing") return yield* new ResearchReport.NotFound({ workflowId });
          if (outcome._tag === "Conflict") {
            return yield* new ResearchReport.Conflict({
              message: "Research Report execution could not claim the exact accepted identity",
              workflowId,
            });
          }
          return yield* decodeRow(outcome.row);
        }),
      ),
    ),
  markSourcesCommitted: (
    workflowId,
    inputDigest,
    sourceManifestKey,
    sourceManifestDigest,
    committedAt,
  ) =>
    attempt("markSourcesCommitted", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${workflowId}, 0))`,
        );
        const [row] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(eq(researchReports.workflow_id, workflowId))
          .limit(1)
          .for("update");
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== inputDigest) return { _tag: "Conflict" as const };
        if (row.sourceManifestKey !== null || row.sourceManifestDigest !== null) {
          return row.sourceManifestKey === sourceManifestKey &&
            row.sourceManifestDigest === sourceManifestDigest
            ? { _tag: "Found" as const, row }
            : { _tag: "Conflict" as const };
        }
        if (row.state !== "accepted" && row.state !== "running") {
          return { _tag: "Conflict" as const };
        }
        const [updated] = await transaction
          .update(researchReports)
          .set({
            source_manifest_key: sourceManifestKey,
            source_manifest_digest: sourceManifestDigest,
            sources_committed_at: committedAt,
            state: "sources_committed",
            updated_at: committedAt,
          })
          .where(
            and(
              eq(researchReports.workflow_id, workflowId),
              eq(researchReports.input_digest, inputDigest),
              inArray(researchReports.state, ["accepted", "running"]),
            ),
          )
          .returning(rowSelection);
        return updated === undefined
          ? { _tag: "Conflict" as const }
          : { _tag: "Found" as const, row: updated };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Missing") return yield* new ResearchReport.NotFound({ workflowId });
          if (outcome._tag === "Conflict") {
            return yield* new ResearchReport.Conflict({
              message: "The source manifest cannot replace or outlive current product authority",
              workflowId,
            });
          }
          return yield* decodeRow(outcome.row);
        }),
      ),
    ),
  claimArtifactPublication: (workflowId, inputDigest, contentId, claimedAt) =>
    transitionArtifact(database, {
      claimedAt,
      contentId,
      inputDigest,
      operation: "claimArtifactPublication",
      target: "artifact_stored",
      workflowId,
    }),
  completeSuccess: (workflowId, inputDigest, contentId, completedAt) =>
    transitionArtifact(database, {
      claimedAt: completedAt,
      contentId,
      inputDigest,
      operation: "completeSuccess",
      target: "success",
      workflowId,
    }),
  finishTerminal: (workflowId, inputDigest, state, safeFailureCode, terminalAt) =>
    attempt("finishTerminal", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${workflowId}, 0))`,
        );
        const [row] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(eq(researchReports.workflow_id, workflowId))
          .limit(1)
          .for("update");
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== inputDigest) return { _tag: "Conflict" as const };
        if (row.state === state) {
          return row.safeFailureCode === safeFailureCode
            ? { _tag: "Found" as const, row }
            : { _tag: "Conflict" as const };
        }
        if (
          row.state === "artifact_stored" ||
          row.state === "success" ||
          row.state === "failure" ||
          row.state === "canceled"
        ) {
          return { _tag: "Conflict" as const };
        }
        const [updated] = await transaction
          .update(researchReports)
          .set({
            safe_failure_code: safeFailureCode,
            state,
            terminal_at: terminalAt,
            updated_at: terminalAt,
          })
          .where(
            and(
              eq(researchReports.workflow_id, workflowId),
              eq(researchReports.input_digest, inputDigest),
              inArray(researchReports.state, [
                "admitted",
                "accepted",
                "running",
                "sources_committed",
                "cancel_requested",
              ]),
            ),
          )
          .returning(rowSelection);
        return updated === undefined
          ? { _tag: "Conflict" as const }
          : { _tag: "Found" as const, row: updated };
      }),
    ).pipe(
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Missing") return yield* new ResearchReport.NotFound({ workflowId });
          if (outcome._tag === "Conflict") {
            return yield* new ResearchReport.Conflict({
              message: "The terminal outcome lost to publication or another terminal claim",
              workflowId,
            });
          }
          return yield* decodeRow(outcome.row);
        }),
      ),
    ),
  requestCancel: (workflowId, userId, requestedAt) =>
    attempt("requestCancel", () =>
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${workflowId}, 0))`,
        );
        const [row] = await transaction
          .select(rowSelection)
          .from(researchReports)
          .where(
            and(eq(researchReports.workflow_id, workflowId), eq(researchReports.user_id, userId)),
          )
          .limit(1)
          .for("update");
        if (row === undefined) return null;
        if (
          row.state === "success" ||
          row.state === "failure" ||
          row.state === "canceled" ||
          row.state === "cancel_requested" ||
          row.state === "artifact_stored"
        ) {
          return row;
        }
        const [updated] = await transaction
          .update(researchReports)
          .set({
            cancel_requested_at: requestedAt,
            state: "cancel_requested",
            updated_at: requestedAt,
          })
          .where(
            and(eq(researchReports.workflow_id, workflowId), eq(researchReports.user_id, userId)),
          )
          .returning(rowSelection);
        return updated ?? null;
      }),
    ).pipe(
      Effect.flatMap((row) =>
        Effect.gen(function* () {
          if (row === null) return yield* new ResearchReport.NotFound({ workflowId });
          return yield* decodeRow(row);
        }),
      ),
    ),
});

const transitionArtifact = (
  database: Database,
  input: {
    readonly claimedAt: Date;
    readonly contentId: string;
    readonly inputDigest: ResearchReport.InputDigest;
    readonly operation: "claimArtifactPublication" | "completeSuccess";
    readonly target: "artifact_stored" | "success";
    readonly workflowId: ResearchReport.WorkflowId;
  },
) =>
  attempt(input.operation, () =>
    database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.workflowId}, 0))`,
      );
      const [row] = await transaction
        .select(rowSelection)
        .from(researchReports)
        .where(eq(researchReports.workflow_id, input.workflowId))
        .limit(1)
        .for("update");
      if (row === undefined) return { _tag: "Missing" as const };
      if (
        row.inputDigest !== input.inputDigest ||
        (row.artifactContentId !== null && row.artifactContentId !== input.contentId)
      ) {
        return { _tag: "Conflict" as const };
      }
      if (input.target === "artifact_stored") {
        if (row.state === "artifact_stored" || row.state === "success") {
          return { _tag: "Found" as const, row };
        }
        if (row.state !== "sources_committed" || row.sourceManifestKey === null) {
          return { _tag: "Conflict" as const };
        }
        const [updated] = await transaction
          .update(researchReports)
          .set({
            artifact_content_id: input.contentId,
            artifact_stored_at: input.claimedAt,
            state: "artifact_stored",
            updated_at: input.claimedAt,
          })
          .where(
            and(
              eq(researchReports.workflow_id, input.workflowId),
              eq(researchReports.input_digest, input.inputDigest),
              eq(researchReports.state, "sources_committed"),
            ),
          )
          .returning(rowSelection);
        return updated === undefined
          ? { _tag: "Conflict" as const }
          : { _tag: "Found" as const, row: updated };
      }
      if (row.state === "success") return { _tag: "Found" as const, row };
      if (row.state !== "artifact_stored" || row.artifactContentId !== input.contentId) {
        return { _tag: "Conflict" as const };
      }
      const [updated] = await transaction
        .update(researchReports)
        .set({ state: "success", terminal_at: input.claimedAt, updated_at: input.claimedAt })
        .where(
          and(
            eq(researchReports.workflow_id, input.workflowId),
            eq(researchReports.input_digest, input.inputDigest),
            eq(researchReports.artifact_content_id, input.contentId),
            eq(researchReports.state, "artifact_stored"),
          ),
        )
        .returning(rowSelection);
      return updated === undefined
        ? { _tag: "Conflict" as const }
        : { _tag: "Found" as const, row: updated };
    }),
  ).pipe(
    Effect.flatMap((outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Missing") {
          return yield* new ResearchReport.NotFound({ workflowId: input.workflowId });
        }
        if (outcome._tag === "Conflict") {
          return yield* new ResearchReport.Conflict({
            message:
              input.target === "artifact_stored"
                ? "Artifact publication lost to cancellation or changed immutable facts"
                : "Research Report success requires the exact published artifact",
            workflowId: input.workflowId,
          });
        }
        return yield* decodeRow(outcome.row);
      }),
    ),
  );

/** Rebuild current mutable authority facts before resumed Workflow work. */
export const makeCurrentAuthorization = (
  database: Database,
): ResearchReport.PortInterface["currentAuthorization"] =>
  Effect.fn("ResearchReportPostgres.currentAuthorization")(function* (report) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const [ownerRows, subscriptionRows, suspensionRows, deletionRows, activeRows, authority] =
      yield* Effect.all([
        attempt("currentAuthorization.owner", () =>
          database
            .select({ userId: agents.user_id })
            .from(agents)
            .where(eq(agents.agent_id, report.agentId))
            .limit(1),
        ),
        attempt("currentAuthorization.subscription", () =>
          database
            .select({
              plan: billingSubscriptions.plan,
              planPolicyVersion: billingSubscriptions.plan_policy_version,
            })
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.user_id, report.userId))
            .limit(1),
        ),
        attempt("currentAuthorization.suspension", () =>
          database
            .select({ action: userSuspensionEvents.action })
            .from(userSuspensionEvents)
            .where(eq(userSuspensionEvents.user_id, report.userId))
            .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
            .limit(1),
        ),
        attempt("currentAuthorization.deletion", () =>
          database
            .select({ deletionCaseId: deletionCases.deletion_case_id })
            .from(deletionCases)
            .where(
              and(
                eq(deletionCases.user_id, report.userId),
                isNotNull(deletionCases.access_fenced_at),
              ),
            )
            .limit(1),
        ),
        attempt("currentAuthorization.capacity", () =>
          database
            .select({ workflowId: researchReports.workflow_id })
            .from(researchReports)
            .where(
              and(
                eq(researchReports.user_id, report.userId),
                ne(researchReports.workflow_id, report.workflowId),
                inArray(researchReports.state, [
                  "admitted",
                  "accepted",
                  "running",
                  "sources_committed",
                  "artifact_stored",
                ]),
              ),
            ),
        ),
        inspectAuthority(database, report, now),
      ]);
    const subscription = subscriptionRows[0];
    if (subscription === undefined) {
      return yield* unavailable(
        "currentAuthorization.subscription",
        "The Research Report User has no current Subscription facts",
      );
    }
    const activeWorkflows = BigInt(activeRows.length);
    return yield* Schema.decodeEffect(AuthorizationContext)({
      allowance: { _tag: "Unavailable" },
      approval: report.approval,
      authority,
      deletionAccess:
        deletionRows[0] === undefined
          ? { _tag: "DeletionAccessAvailable" }
          : { _tag: "DeletionAccessRevoked" },
      gmailConnection: null,
      integrationConnections: [],
      liveFacts: {
        ...emptyLiveResourceFacts,
        concurrentCostlyJobs: activeWorkflows,
        concurrentWorkflows: activeWorkflows,
      },
      now,
      originatingAuthority: report.originatingAuthority,
      requestVendorUsdMicros: 0n,
      resourceOwnerUserId: ownerRows[0]?.userId ?? null,
      subscription,
      user:
        suspensionRows[0]?.action === "suspended"
          ? { _tag: "SuspendedUser", userId: report.userId }
          : { _tag: "ActiveUser", userId: report.userId },
    }).pipe(
      Effect.mapError((cause) =>
        unavailable(
          "currentAuthorization.decode",
          "PostgreSQL returned invalid current Research Report authority facts",
          cause,
        ),
      ),
    );
  });

const inspectAuthority = (database: Database, report: ResearchReport.Record, now: Date) => {
  const origin = report.originatingAuthority;
  if (Predicate.isTagged(origin, "AuthSession")) {
    return attempt("currentAuthorization.authSession", () =>
      database
        .select({ expiresAt: sessions.expiresAt, userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.id, origin.authSessionId), eq(sessions.userId, report.userId)))
        .limit(1),
    ).pipe(
      Effect.map(([row]) =>
        row === undefined || row.expiresAt.getTime() <= now.getTime()
          ? ({
              _tag: "RevokedAuthSession",
              authSessionId: origin.authSessionId,
              userId: report.userId,
            } as const)
          : ({
              _tag: "AuthSession",
              authSessionId: origin.authSessionId,
              expiresAt: row.expiresAt,
              userId: report.userId,
            } as const),
      ),
    );
  }
  if (Predicate.isTagged(origin, "ChannelLink")) {
    return attempt("currentAuthorization.channelLink", () =>
      database
        .select({
          authorId: channelLinks.author_id,
          channelId: channelLinks.channel_id,
          revokedAt: channelLinks.revoked_at,
          userId: channelLinks.user_id,
        })
        .from(channelLinks)
        .where(eq(channelLinks.channel_link_id, origin.channelLinkId))
        .limit(1),
    ).pipe(
      Effect.map(([row]) => ({
        _tag:
          row !== undefined && row.userId === report.userId && row.revokedAt === null
            ? ("ChannelLink" as const)
            : ("RevokedChannelLink" as const),
        address: {
          authorId: ChannelAuthorId.make(row?.authorId ?? "revoked"),
          channelId: ChannelId.make(row?.channelId ?? "revoked"),
        },
        channelLinkId: origin.channelLinkId,
        userId: report.userId,
      })),
    );
  }
  return Effect.succeed({
    _tag: "DurableTrigger" as const,
    triggerId: origin.triggerId,
    triggerType: origin.triggerType,
    userId: report.userId,
  });
};

const decodeRow = (row: Row): Effect.Effect<ResearchReport.Record, ResearchReport.Unavailable> =>
  Effect.gen(function* () {
    const authority = yield* Schema.decodeEffect(Schema.fromJsonString(OriginatingAuthority))(
      row.originatingAuthorityJson,
    ).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored authority facts are invalid", cause),
      ),
    );
    const request = yield* Schema.decodeEffect(Schema.fromJsonString(ResearchReport.Request))(
      row.requestJson,
    ).pipe(
      Effect.mapError((cause) => unavailable("decode", "Stored request facts are invalid", cause)),
    );
    const approval = yield* row.approvalJson === null
      ? Effect.succeed(null)
      : Schema.decodeEffect(Schema.fromJsonString(Approval))(row.approvalJson).pipe(
          Effect.mapError((cause) =>
            unavailable("decode", "Stored Research Report Approval is invalid", cause),
          ),
        );
    return yield* Schema.decodeUnknownEffect(EncodedRecord)({
      ...row,
      approval,
      originatingAuthority: authority,
      request,
    }).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored Research Report facts are invalid", cause),
      ),
    );
  });

const encodeAuthority = (authority: typeof OriginatingAuthority.Type) => {
  return Schema.encodeSync(Schema.fromJsonString(OriginatingAuthority))(authority);
};

const encodeApproval = (approval: typeof Approval.Type | null) =>
  approval === null ? null : Schema.encodeSync(Schema.fromJsonString(Approval))(approval);

const encodeRequest = (request: ResearchReport.Request) => {
  return Schema.encodeSync(Schema.fromJsonString(ResearchReport.Request))(request);
};

const attempt = <Value>(operation: string, query: () => Promise<Value>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      unavailable(operation, "PostgreSQL could not persist Research Report state", cause),
  });

const unavailable = (operation: string, message: string, cause: unknown = operation) =>
  new ResearchReport.Unavailable({ cause, message, operation });

export * as ResearchReportPostgres from "./research-report";
