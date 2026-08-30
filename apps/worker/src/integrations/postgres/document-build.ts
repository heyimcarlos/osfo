import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { sessions } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { documentBuilds } from "@osfo/db/schema/document-builds";
import { researchReports } from "@osfo/db/schema/research-reports";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
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
import { RecordedAllowanceUse } from "../../domain/allowance";
import { ChannelAuthorId, ChannelId } from "../../domain/channel-link";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { QualificationContext } from "../../domain/qualification-context";
import { DocumentBuild } from "../../services/document-build";
import {
  AuthorizationContext,
  emptyLiveResourceFacts,
  OriginatingAuthority,
} from "../../services/authorization";
import type { Denied } from "../../services/authorization";
import type { CostEvidence } from "../../services/document-generation";
import { countActiveWorkflows, lockWorkflowUser } from "./workflow-serialization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions serialize Document Build truth. */
/* oxlint-disable eslint/no-underscore-dangle -- Persistence outcomes use the standard Effect discriminator. */

const rowSelection = {
  acceptedAt: documentBuilds.accepted_at,
  accountingCommittedAt: documentBuilds.accounting_committed_at,
  actionId: documentBuilds.action_id,
  admittedAt: documentBuilds.admitted_at,
  agentId: documentBuilds.agent_id,
  allowancePeriodId: documentBuilds.allowance_period_id,
  artifactAccountedAt: documentBuilds.artifact_accounted_at,
  artifactContentId: documentBuilds.artifact_content_id,
  cancelRequestedAt: documentBuilds.cancel_requested_at,
  capabilityCatalogVersion: documentBuilds.capability_catalog_version,
  cloudflareInstanceId: documentBuilds.cloudflare_instance_id,
  cloudflareTimerInstanceId: documentBuilds.cloudflare_timer_instance_id,
  costEvidenceJson: documentBuilds.cost_evidence_json,
  deadlineAt: documentBuilds.deadline_at,
  inputDigest: documentBuilds.input_digest,
  manifestVersion: documentBuilds.manifest_version,
  modelAccessPolicyVersion: documentBuilds.model_access_policy_version,
  modelRoute: documentBuilds.model_route,
  originatingAuthorityJson: documentBuilds.originating_authority_json,
  planPolicyVersion: documentBuilds.plan_policy_version,
  qualificationContextJson: documentBuilds.qualification_context_json,
  previewStoredAt: documentBuilds.preview_stored_at,
  providerCostRecordedAt: documentBuilds.provider_cost_recorded_at,
  publicationCommittedAt: documentBuilds.publication_committed_at,
  requestJson: documentBuilds.request_json,
  resourcePriceVersion: documentBuilds.resource_price_version,
  routeId: documentBuilds.route_id,
  safeFailureCode: documentBuilds.safe_failure_code,
  sessionId: documentBuilds.session_id,
  startedAt: documentBuilds.started_at,
  state: documentBuilds.state,
  terminalAt: documentBuilds.terminal_at,
  userId: documentBuilds.user_id,
  workflowId: documentBuilds.workflow_id,
};

interface Row {
  readonly acceptedAt: Date | null;
  readonly accountingCommittedAt: Date | null;
  readonly actionId: string;
  readonly admittedAt: Date;
  readonly agentId: string;
  readonly allowancePeriodId: string;
  readonly artifactAccountedAt: Date | null;
  readonly artifactContentId: string | null;
  readonly cancelRequestedAt: Date | null;
  readonly capabilityCatalogVersion: string;
  readonly cloudflareInstanceId: string;
  readonly cloudflareTimerInstanceId: string;
  readonly costEvidenceJson: string | null;
  readonly deadlineAt: Date;
  readonly inputDigest: string;
  readonly manifestVersion: string | null;
  readonly modelAccessPolicyVersion: string;
  readonly modelRoute: string;
  readonly originatingAuthorityJson: string;
  readonly planPolicyVersion: string;
  readonly qualificationContextJson: string | null;
  readonly previewStoredAt: Date | null;
  readonly providerCostRecordedAt: Date | null;
  readonly publicationCommittedAt: Date | null;
  readonly requestJson: string;
  readonly resourcePriceVersion: string;
  readonly routeId: string;
  readonly safeFailureCode: string | null;
  readonly sessionId: string;
  readonly startedAt: Date | null;
  readonly state: DocumentBuild.State;
  readonly terminalAt: Date | null;
  readonly userId: string;
  readonly workflowId: string;
}

const CostEvidenceSchema = Schema.Union([
  Schema.TaggedStruct("ProvenNoUse", {}),
  Schema.TaggedStruct("Incurred", {
    allowancePeriodId: AllowancePeriodId,
    basis: Schema.Literals(["conservative", "observed"]),
    providerOperationId: Schema.String.check(Schema.isMinLength(1)),
    usdMicros: Schema.BigIntFromString,
  }),
]);

const EncodedRecord = Schema.Struct({
  acceptedAt: Schema.NullOr(Schema.Date),
  accountingCommittedAt: Schema.NullOr(Schema.Date),
  actionId: ActionId,
  admittedAt: Schema.Date,
  agentId: AgentId,
  allowancePeriodId: AllowancePeriodId,
  artifactAccountedAt: Schema.NullOr(Schema.Date),
  artifactContentId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  cancelRequestedAt: Schema.NullOr(Schema.Date),
  capabilityCatalogVersion: CapabilityCatalogVersion,
  cloudflareInstanceId: DocumentBuild.CloudflareInstanceId,
  cloudflareTimerInstanceId: DocumentBuild.CloudflareInstanceId,
  costEvidence: Schema.NullOr(Schema.toType(CostEvidenceSchema)),
  deadlineAt: Schema.Date,
  inputDigest: DocumentBuild.InputDigest,
  manifestVersion: Schema.NullOr(Schema.String),
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  originatingAuthority: OriginatingAuthority,
  planPolicyVersion: PlanPolicyVersion,
  qualificationContext: Schema.optionalKey(QualificationContext),
  previewStoredAt: Schema.NullOr(Schema.Date),
  providerCostRecordedAt: Schema.NullOr(Schema.Date),
  publicationCommittedAt: Schema.NullOr(Schema.Date),
  request: Schema.toType(DocumentBuild.StoredRequest),
  resourcePriceVersion: ResourcePriceVersion,
  routeId: ConversationRouteId,
  safeFailureCode: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  ),
  sessionId: SessionId,
  startedAt: Schema.NullOr(Schema.Date),
  state: DocumentBuild.State,
  terminalAt: Schema.NullOr(Schema.Date),
  userId: UserId,
  workflowId: DocumentBuild.WorkflowId,
});

const activeStates = [
  "admitted",
  "accepted",
  "running",
  "preview_stored",
  "publication_committed",
  "cancel_requested",
] as const;
const activeStateSet = new Set<string>(activeStates);

export const make = (database: Database): DocumentBuild.PortInterface["persistence"] => ({
  admit: (record, activeWorkflowLimit) =>
    attempt("admit", () =>
      database.transaction(async (transaction) => {
        await lockWorkflowUser(transaction, record.userId);
        const [existing] = await transaction
          .select(rowSelection)
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, record.workflowId))
          .for("update")
          .limit(1);
        if (existing !== undefined) return { _tag: "Existing" as const, row: existing };
        const [deletion] = await transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(
              eq(deletionCases.user_id, record.userId),
              isNotNull(deletionCases.access_fenced_at),
            ),
          )
          .limit(1);
        if (deletion !== undefined) return { _tag: "AccessFenced" as const };
        if (BigInt(await countActiveWorkflows(transaction, record.userId)) >= activeWorkflowLimit) {
          return { _tag: "CapacityExceeded" as const };
        }
        await transaction.insert(documentBuilds).values({
          accepted_at: record.acceptedAt,
          accounting_committed_at: record.accountingCommittedAt,
          action_id: record.actionId,
          admitted_at: record.admittedAt,
          agent_id: record.agentId,
          allowance_period_id: record.allowancePeriodId,
          artifact_accounted_at: record.artifactAccountedAt,
          artifact_content_id: record.artifactContentId,
          cancel_requested_at: record.cancelRequestedAt,
          capability_catalog_version: record.capabilityCatalogVersion,
          cloudflare_instance_id: record.cloudflareInstanceId,
          cloudflare_timer_instance_id: record.cloudflareTimerInstanceId,
          cost_evidence_json: encodeCost(record.costEvidence),
          deadline_at: record.deadlineAt,
          input_digest: record.inputDigest,
          manifest_version: record.manifestVersion,
          model_access_policy_version: record.modelAccessPolicyVersion,
          model_route: record.modelRoute,
          originating_authority_json: encodeAuthority(record.originatingAuthority),
          plan_policy_version: record.planPolicyVersion,
          qualification_context_json: encodeQualificationContext(record.qualificationContext),
          preview_stored_at: record.previewStoredAt,
          provider_cost_recorded_at: record.providerCostRecordedAt,
          publication_committed_at: record.publicationCommittedAt,
          request_json: encodeRequest(record.request),
          resource_price_version: record.resourcePriceVersion,
          route_id: record.routeId,
          safe_failure_code: record.safeFailureCode,
          session_id: record.sessionId,
          started_at: record.startedAt,
          state: record.state,
          terminal_at: record.terminalAt,
          user_id: record.userId,
          workflow_id: record.workflowId,
        });
        const [created] = await transaction
          .select(rowSelection)
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, record.workflowId))
          .limit(1);
        return created === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "Created" as const, row: created };
      }),
    ).pipe(
      Effect.flatMap(
        (
          outcome,
        ): Effect.Effect<
          | { readonly _tag: "Created"; readonly build: DocumentBuild.Record }
          | { readonly _tag: "Existing"; readonly build: DocumentBuild.Record },
          DocumentBuild.Conflict | Denied | DocumentBuild.Unavailable
        > => {
          if (outcome._tag === "CapacityExceeded") {
            return Effect.fail({
              _tag: "Denied",
              reason: "liveResourceLimitReached",
              resetAt: null,
            } satisfies Denied);
          }
          if (outcome._tag === "AccessFenced") {
            return Effect.fail({
              _tag: "Denied",
              reason: "deletionAccessRevoked",
              resetAt: null,
            } satisfies Denied);
          }
          if (outcome._tag === "Missing")
            return Effect.fail(
              unavailable("admit", "PostgreSQL did not return the admitted Document Build"),
            );
          return decodeRow(outcome.row).pipe(
            Effect.flatMap((build) =>
              build.inputDigest === record.inputDigest &&
              build.userId === record.userId &&
              sameQualificationContext(build.qualificationContext, record.qualificationContext)
                ? Effect.succeed({ _tag: outcome._tag, build } as const)
                : Effect.fail(
                    conflict(
                      record.workflowId,
                      "The Document Build identity owns changed immutable facts",
                    ),
                  ),
            ),
          );
        },
      ),
    ),
  inspect: (workflowId) =>
    attempt("inspect", () =>
      database
        .select(rowSelection)
        .from(documentBuilds)
        .where(eq(documentBuilds.workflow_id, workflowId))
        .limit(1),
    ).pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeRow(row)))),
  markAccepted: (workflowId, inputDigest, acceptedAt) =>
    transition(database, workflowId, inputDigest, "markAccepted", async (transaction, row) => {
      if (row.state !== "admitted") return found(row);
      const [updated] = await transaction
        .update(documentBuilds)
        .set({ accepted_at: acceptedAt, state: "accepted", updated_at: acceptedAt })
        .where(
          and(
            eq(documentBuilds.workflow_id, workflowId),
            eq(documentBuilds.input_digest, inputDigest),
            eq(documentBuilds.state, "admitted"),
          ),
        )
        .returning(rowSelection);
      return updated === undefined ? changed() : found(updated);
    }),
  beginExecution: (workflowId, inputDigest, startedAt) =>
    transition(database, workflowId, inputDigest, "beginExecution", async (transaction, row) => {
      if (["running", "preview_stored", "publication_committed", "success"].includes(row.state)) {
        return row.startedAt === null ? changed() : found(row);
      }
      if (row.state !== "accepted" || row.acceptedAt === null) return changed();
      const [updated] = await transaction
        .update(documentBuilds)
        .set({
          started_at: startedAt,
          state: "running",
          updated_at: startedAt,
        })
        .where(
          and(
            eq(documentBuilds.workflow_id, workflowId),
            eq(documentBuilds.input_digest, inputDigest),
            eq(documentBuilds.state, "accepted"),
            isNotNull(documentBuilds.accepted_at),
          ),
        )
        .returning(rowSelection);
      return updated === undefined ? changed() : found(updated);
    }),
  markPreviewStored: (workflowId, inputDigest, contentId, storedAt) =>
    transition(database, workflowId, inputDigest, "markPreviewStored", async (transaction, row) => {
      if (row.artifactContentId !== null) {
        return row.artifactContentId === contentId && row.previewStoredAt !== null
          ? found(row)
          : changed();
      }
      if (row.state !== "running") return changed();
      const [updated] = await transaction
        .update(documentBuilds)
        .set({
          artifact_content_id: contentId,
          preview_stored_at: storedAt,
          state: "preview_stored",
          updated_at: storedAt,
        })
        .where(
          and(
            eq(documentBuilds.workflow_id, workflowId),
            eq(documentBuilds.input_digest, inputDigest),
            eq(documentBuilds.state, "running"),
          ),
        )
        .returning(rowSelection);
      return updated === undefined ? changed() : found(updated);
    }),
  recordProviderCost: (workflowId, inputDigest, contentId, cost, recordedAt) =>
    transition(
      database,
      workflowId,
      inputDigest,
      "recordProviderCost",
      async (transaction, row) => {
        const encoded = encodeCost(cost);
        if (row.providerCostRecordedAt !== null || row.costEvidenceJson !== null) {
          return (row.artifactContentId === null || row.artifactContentId === contentId) &&
            row.costEvidenceJson === encoded
            ? found(row)
            : changed();
        }
        if (
          row.state === "publication_committed" ||
          row.state === "success" ||
          (row.artifactContentId !== null && row.artifactContentId !== contentId)
        )
          return changed();
        const [updated] = await transaction
          .update(documentBuilds)
          .set({
            cost_evidence_json: encoded,
            provider_cost_recorded_at: recordedAt,
            updated_at: recordedAt,
          })
          .where(
            and(
              eq(documentBuilds.workflow_id, workflowId),
              eq(documentBuilds.input_digest, inputDigest),
              inArray(documentBuilds.state, [
                "running",
                "preview_stored",
                "cancel_requested",
                "failure",
                "canceled",
              ]),
            ),
          )
          .returning(rowSelection);
        return updated === undefined ? changed() : found(updated);
      },
    ),
  markAccountingCommitted: (workflowId, inputDigest, contentId, cost, committedAt) =>
    transition(
      database,
      workflowId,
      inputDigest,
      "markAccountingCommitted",
      async (transaction, row) => {
        const encoded = encodeCost(cost);
        if (row.accountingCommittedAt !== null) {
          return row.state !== "running" &&
            row.artifactContentId === contentId &&
            row.costEvidenceJson === encoded
            ? found(row)
            : changed();
        }
        if (
          row.state !== "preview_stored" ||
          row.artifactContentId !== contentId ||
          row.providerCostRecordedAt === null ||
          row.costEvidenceJson !== encoded
        )
          return changed();
        const [updated] = await transaction
          .update(documentBuilds)
          .set({ accounting_committed_at: committedAt, updated_at: committedAt })
          .where(
            and(
              eq(documentBuilds.workflow_id, workflowId),
              eq(documentBuilds.input_digest, inputDigest),
              eq(documentBuilds.artifact_content_id, contentId),
              eq(documentBuilds.state, "preview_stored"),
              isNotNull(documentBuilds.provider_cost_recorded_at),
              isNull(documentBuilds.accounting_committed_at),
            ),
          )
          .returning(rowSelection);
        return updated === undefined ? changed() : found(updated);
      },
    ),
  commitPublication: (workflowId, inputDigest, contentId, committedAt) =>
    attempt("commitPublication", () =>
      database.transaction(async (transaction) => {
        const [identity] = await transaction
          .select({ inputDigest: documentBuilds.input_digest, userId: documentBuilds.user_id })
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, workflowId))
          .limit(1);
        if (identity === undefined) return { _tag: "Missing" as const };
        if (identity.inputDigest !== inputDigest) return changed();
        await lockWorkflowUser(transaction, identity.userId);
        await lock(transaction, workflowId);
        const [row] = await transaction
          .select({
            ...rowSelection,
            deadlineExpired: sql<boolean>`clock_timestamp() >= ${documentBuilds.deadline_at}`,
          })
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, workflowId))
          .for("update")
          .limit(1);
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== inputDigest) return changed();
        if (row.state === "publication_committed" || row.state === "success") {
          return row.artifactContentId === contentId ? found(row) : changed();
        }
        if (
          row.state !== "preview_stored" ||
          row.artifactContentId !== contentId ||
          row.accountingCommittedAt === null ||
          row.costEvidenceJson === null
        )
          return changed();
        const [deletion] = await transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(eq(deletionCases.user_id, row.userId), isNotNull(deletionCases.access_fenced_at)),
          )
          .limit(1);
        const deadlineExpired =
          row.deadlineExpired || committedAt.getTime() >= row.deadlineAt.getTime();
        if (deletion !== undefined || deadlineExpired) {
          await transaction
            .update(documentBuilds)
            .set({
              safe_failure_code: deletion === undefined ? "deadline-exceeded" : "account-deletion",
              state: "canceled",
              terminal_at: deletion === undefined ? row.deadlineAt : committedAt,
              updated_at: committedAt,
            })
            .where(
              and(
                eq(documentBuilds.workflow_id, workflowId),
                eq(documentBuilds.input_digest, inputDigest),
                eq(documentBuilds.state, "preview_stored"),
              ),
            );
          return changed();
        }
        const [updated] = await transaction
          .update(documentBuilds)
          .set({
            publication_committed_at: committedAt,
            state: "publication_committed",
            updated_at: committedAt,
          })
          .where(
            and(
              eq(documentBuilds.workflow_id, workflowId),
              eq(documentBuilds.input_digest, inputDigest),
              eq(documentBuilds.artifact_content_id, contentId),
              eq(documentBuilds.state, "preview_stored"),
              isNotNull(documentBuilds.accounting_committed_at),
              sql`clock_timestamp() < ${documentBuilds.deadline_at}`,
            ),
          )
          .returning(rowSelection);
        return updated === undefined ? changed() : found(updated);
      }),
    ).pipe(Effect.flatMap((outcome) => decodeTransition(workflowId, "commitPublication", outcome))),
  finishSuccess: (workflowId, inputDigest, contentId, accountedAt) =>
    attempt("finishSuccess", () =>
      database.transaction(async (transaction) => {
        const [identity] = await transaction
          .select({ inputDigest: documentBuilds.input_digest, userId: documentBuilds.user_id })
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, workflowId))
          .limit(1);
        if (identity === undefined) return { _tag: "Missing" as const };
        if (identity.inputDigest !== inputDigest) return changed();
        if (!(await lockWorkflowUser(transaction, identity.userId))) {
          return { _tag: "Missing" as const };
        }
        await lock(transaction, workflowId);
        const [row] = await transaction
          .select(rowSelection)
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, workflowId))
          .for("update")
          .limit(1);
        if (row === undefined) return { _tag: "Missing" as const };
        if (row.inputDigest !== inputDigest) return changed();
        if (row.state === "success") {
          return row.artifactContentId === contentId ? found(row) : changed();
        }
        if (row.state !== "publication_committed" || row.artifactContentId !== contentId) {
          return changed();
        }
        const [updated] = await transaction
          .update(documentBuilds)
          .set({
            artifact_accounted_at: accountedAt,
            state: "success",
            terminal_at: accountedAt,
            updated_at: accountedAt,
          })
          .where(
            and(
              eq(documentBuilds.workflow_id, workflowId),
              eq(documentBuilds.input_digest, inputDigest),
              eq(documentBuilds.artifact_content_id, contentId),
              eq(documentBuilds.state, "publication_committed"),
            ),
          )
          .returning(rowSelection);
        return updated === undefined ? changed() : found(updated);
      }),
    ).pipe(Effect.flatMap((outcome) => decodeTransition(workflowId, "finishSuccess", outcome))),
  enforceDeadline: (workflowId, inputDigest, checkedAt) =>
    transition(database, workflowId, inputDigest, "enforceDeadline", async (transaction, row) => {
      if (
        DocumentBuild.terminalStates.has(DocumentBuild.State.make(row.state)) ||
        row.state === "publication_committed" ||
        checkedAt.getTime() < row.deadlineAt.getTime()
      )
        return found(row);
      const [updated] = await transaction
        .update(documentBuilds)
        .set({
          safe_failure_code: "deadline-exceeded",
          state: "canceled",
          terminal_at: row.deadlineAt,
          updated_at: checkedAt,
        })
        .where(
          and(
            eq(documentBuilds.workflow_id, workflowId),
            eq(documentBuilds.input_digest, inputDigest),
            inArray(documentBuilds.state, [
              "admitted",
              "accepted",
              "running",
              "preview_stored",
              "cancel_requested",
            ]),
          ),
        )
        .returning(rowSelection);
      return updated === undefined ? changed() : found(updated);
    }),
  finishTerminal: (workflowId, inputDigest, state, safeFailureCode, terminalAt) =>
    transition(database, workflowId, inputDigest, "finishTerminal", async (transaction, row) => {
      if (row.state === state)
        return row.safeFailureCode === safeFailureCode ? found(row) : changed();
      if (
        DocumentBuild.terminalStates.has(DocumentBuild.State.make(row.state)) ||
        row.state === "publication_committed"
      )
        return changed();
      const [updated] = await transaction
        .update(documentBuilds)
        .set({
          safe_failure_code: safeFailureCode,
          state,
          terminal_at: terminalAt,
          updated_at: terminalAt,
        })
        .where(
          and(
            eq(documentBuilds.workflow_id, workflowId),
            eq(documentBuilds.input_digest, inputDigest),
            inArray(documentBuilds.state, [
              "admitted",
              "accepted",
              "running",
              "preview_stored",
              "cancel_requested",
            ]),
          ),
        )
        .returning(rowSelection);
      return updated === undefined ? changed() : found(updated);
    }),
  requestCancel: (workflowId, userId, requestedAt) =>
    attempt("requestCancel", () =>
      database.transaction(async (transaction) => {
        if (!(await lockWorkflowUser(transaction, userId))) return null;
        await lock(transaction, workflowId);
        const [row] = await transaction
          .select(rowSelection)
          .from(documentBuilds)
          .where(
            and(eq(documentBuilds.workflow_id, workflowId), eq(documentBuilds.user_id, userId)),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return null;
        if (
          DocumentBuild.terminalStates.has(DocumentBuild.State.make(row.state)) ||
          row.state === "cancel_requested" ||
          row.state === "publication_committed"
        )
          return row;
        const [updated] = await transaction
          .update(documentBuilds)
          .set({
            cancel_requested_at: requestedAt,
            state: "cancel_requested",
            updated_at: requestedAt,
          })
          .where(
            and(
              eq(documentBuilds.workflow_id, workflowId),
              eq(documentBuilds.user_id, userId),
              inArray(documentBuilds.state, ["admitted", "accepted", "running", "preview_stored"]),
            ),
          )
          .returning(rowSelection);
        return updated ?? null;
      }),
    ).pipe(
      Effect.flatMap(
        (
          row,
        ): Effect.Effect<
          DocumentBuild.Record,
          DocumentBuild.NotFound | DocumentBuild.Unavailable
        > =>
          row === null ? Effect.fail(new DocumentBuild.NotFound({ workflowId })) : decodeRow(row),
      ),
    ),
});

export type QualificationDocumentBuildAuthority =
  | { readonly _tag: "Conflict" | "Missing"; readonly rootId: string }
  | { readonly _tag: "Ready"; readonly records: ReadonlyArray<DocumentBuild.Record> };

/** Read exact Document Build product rows by their transactionally retained qualification roots. */
export const readQualificationDocumentBuildAuthority = (
  database: Database,
  executionId: string,
  rootIds: ReadonlyArray<string>,
): Effect.Effect<QualificationDocumentBuildAuthority, DocumentBuild.Unavailable> => {
  if (rootIds.length === 0) return Effect.succeed({ _tag: "Ready", records: [] });
  const executionIdentity = sql<string>`${documentBuilds.qualification_context_json}::jsonb ->> 'executionId'`;
  const rootIdentity = sql<string>`${documentBuilds.qualification_context_json}::jsonb ->> 'rootId'`;
  return attempt("qualificationAuthority", () =>
    database
      .select(rowSelection)
      .from(documentBuilds)
      .where(and(eq(executionIdentity, executionId), inArray(rootIdentity, rootIds)))
      .limit(rootIds.length + 1),
  ).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
    Effect.map((records): QualificationDocumentBuildAuthority => {
      for (const rootId of rootIds) {
        const matches = records.filter((record) => record.qualificationContext?.rootId === rootId);
        if (matches.length === 0) return { _tag: "Missing", rootId };
        if (
          matches.length !== 1 ||
          matches[0]?.qualificationContext?.executionId !== executionId ||
          matches[0]?.qualificationContext?.journey !== "documentBuild"
        ) {
          return { _tag: "Conflict", rootId };
        }
      }
      return records.length === rootIds.length
        ? { _tag: "Ready", records }
        : { _tag: "Conflict", rootId: rootIds[0] ?? executionId };
    }),
  );
};

/** Rebuild mutable User and acting-authority facts before resumed work. */
export const makeCurrentAuthorization = (
  database: Database,
): DocumentBuild.PortInterface["currentAuthorization"] =>
  Effect.fn("DocumentBuildPostgres.currentAuthorization")(function* (build) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const [
      owners,
      subscriptions,
      suspensions,
      deletions,
      builds,
      reports,
      periods,
      usage,
      authority,
    ] = yield* Effect.all([
      attempt("currentAuthorization.owner", () =>
        database
          .select({ userId: agents.user_id })
          .from(agents)
          .where(eq(agents.agent_id, build.agentId))
          .limit(1),
      ),
      attempt("currentAuthorization.subscription", () =>
        database
          .select({
            plan: billingSubscriptions.plan,
            planPolicyVersion: billingSubscriptions.plan_policy_version,
          })
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.user_id, build.userId))
          .limit(1),
      ),
      attempt("currentAuthorization.suspension", () =>
        database
          .select({ action: userSuspensionEvents.action })
          .from(userSuspensionEvents)
          .where(eq(userSuspensionEvents.user_id, build.userId))
          .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
          .limit(1),
      ),
      attempt("currentAuthorization.deletion", () =>
        database
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(eq(deletionCases.user_id, build.userId), isNotNull(deletionCases.access_fenced_at)),
          )
          .limit(1),
      ),
      attempt("currentAuthorization.buildCapacity", () =>
        database
          .select({ id: documentBuilds.workflow_id })
          .from(documentBuilds)
          .where(
            and(
              eq(documentBuilds.user_id, build.userId),
              ne(documentBuilds.workflow_id, build.workflowId),
              inArray(documentBuilds.state, activeStates),
            ),
          ),
      ),
      attempt("currentAuthorization.reportCapacity", () =>
        database
          .select({ id: researchReports.workflow_id })
          .from(researchReports)
          .where(
            and(
              eq(researchReports.user_id, build.userId),
              inArray(researchReports.state, [
                "admitted",
                "accepted",
                "running",
                "sources_committed",
                "artifact_stored",
                "publication_committed",
              ]),
            ),
          ),
      ),
      attempt("currentAuthorization.allowancePeriod", () =>
        database
          .select({
            allowancePeriodId: allowancePeriods.allowance_period_id,
            endsAt: allowancePeriods.ends_at,
            plan: allowancePeriods.plan,
            planPolicyVersion: allowancePeriods.plan_policy_version,
            startsAt: allowancePeriods.starts_at,
          })
          .from(allowancePeriods)
          .where(
            and(
              eq(allowancePeriods.user_id, build.userId),
              eq(allowancePeriods.allowance_period_id, build.allowancePeriodId),
            ),
          )
          .limit(1),
      ),
      attempt("currentAuthorization.allowanceUsage", () =>
        database
          .select({
            allowanceKind: allowanceUsage.allowance_kind,
            quantity: sql<bigint>`sum(${allowanceUsage.quantity})`.mapWith(allowanceUsage.quantity),
          })
          .from(allowanceUsage)
          .where(eq(allowanceUsage.allowance_period_id, build.allowancePeriodId))
          .groupBy(allowanceUsage.allowance_kind),
      ),
      inspectAuthority(database, build, now),
    ]);
    const subscription = subscriptions[0];
    if (subscription === undefined)
      return yield* unavailable(
        "currentAuthorization.subscription",
        "The Document Build User has no Subscription facts",
      );
    const allowance = periods[0];
    if (allowance === undefined)
      return yield* unavailable(
        "currentAuthorization.allowancePeriod",
        "The admitted Document Build Allowance Period is unavailable",
      );
    const recordedUsage = yield* Schema.decodeUnknownEffect(Schema.Array(RecordedAllowanceUse))(
      usage,
    ).pipe(
      Effect.mapError((cause) =>
        unavailable(
          "currentAuthorization.allowanceUsage",
          "PostgreSQL returned invalid Document Build Allowance usage",
          cause,
        ),
      ),
    );
    const activeWorkflows = BigInt(builds.length + reports.length);
    return yield* Schema.decodeEffect(AuthorizationContext)({
      allowance: { _tag: "Metered", ...allowance, usage: recordedUsage },
      approval: null,
      authority,
      deletionAccess:
        deletions[0] === undefined
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
      originatingAuthority: build.originatingAuthority,
      requestVendorUsdMicros: 0n,
      resourceOwnerUserId: owners[0]?.userId ?? null,
      subscription,
      user:
        suspensions[0]?.action === "suspended"
          ? { _tag: "SuspendedUser", userId: build.userId }
          : { _tag: "ActiveUser", userId: build.userId },
    }).pipe(
      Effect.mapError((cause) =>
        unavailable(
          "currentAuthorization.decode",
          "PostgreSQL returned invalid Document Build authority facts",
          cause,
        ),
      ),
    );
  });

export const quiesceForAccountDeletion = (database: Database, userId: UserId, terminalAt: Date) =>
  attempt("quiesceForAccountDeletion", () =>
    database.transaction(async (transaction) => {
      await lockWorkflowUser(transaction, userId);
      const rows = await transaction
        .select({
          main: documentBuilds.cloudflare_instance_id,
          state: documentBuilds.state,
          timer: documentBuilds.cloudflare_timer_instance_id,
          workflowId: documentBuilds.workflow_id,
        })
        .from(documentBuilds)
        .where(eq(documentBuilds.user_id, userId))
        .for("update");
      const recoveryPending = rows.filter((row) => row.state === "publication_committed");
      if (recoveryPending.length > 0) {
        return {
          _tag: "RecoveryPending" as const,
          workflowIds: recoveryPending.map(({ workflowId }) => workflowId),
        };
      }
      await transaction
        .update(documentBuilds)
        .set({
          safe_failure_code: "account-deletion",
          state: "canceled",
          terminal_at: terminalAt,
          updated_at: terminalAt,
        })
        .where(
          and(
            eq(documentBuilds.user_id, userId),
            inArray(documentBuilds.state, [
              "admitted",
              "accepted",
              "running",
              "preview_stored",
              "cancel_requested",
            ]),
          ),
        );
      return {
        _tag: "Ready" as const,
        instances: rows.map(({ main, timer }) => ({ main, timer })),
      };
    }),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Union([
          Schema.TaggedStruct("Ready", {
            instances: Schema.Array(
              Schema.Struct({
                main: DocumentBuild.CloudflareInstanceId,
                timer: DocumentBuild.CloudflareInstanceId,
              }),
            ),
          }),
          Schema.TaggedStruct("RecoveryPending", {
            workflowIds: Schema.Array(DocumentBuild.WorkflowId),
          }),
        ]),
      ),
    ),
    Effect.mapError((cause) =>
      Schema.is(DocumentBuild.Unavailable)(cause)
        ? cause
        : unavailable(
            "quiesceForAccountDeletion",
            "PostgreSQL returned invalid Document Build instance identities",
            cause,
          ),
    ),
  );

export const countActiveForUser = (database: Database, userId: UserId) =>
  attempt("countActiveForUser", () =>
    Promise.all([
      database
        .select({ id: documentBuilds.workflow_id })
        .from(documentBuilds)
        .where(
          and(eq(documentBuilds.user_id, userId), inArray(documentBuilds.state, activeStates)),
        ),
      database
        .select({ id: researchReports.workflow_id })
        .from(researchReports)
        .where(
          and(
            eq(researchReports.user_id, userId),
            inArray(researchReports.state, [
              "admitted",
              "accepted",
              "running",
              "sources_committed",
              "artifact_stored",
              "publication_committed",
            ]),
          ),
        ),
    ]),
  ).pipe(Effect.map(([builds, reports]) => BigInt(builds.length + reports.length)));

const HostRecoveryCandidate = Schema.Struct({
  inputDigest: DocumentBuild.InputDigest,
  mainInstanceId: DocumentBuild.CloudflareInstanceId,
  timerInstanceId: DocumentBuild.CloudflareInstanceId,
  workflowId: DocumentBuild.WorkflowId,
});

/** Read a bounded, serialized batch whose durable nonterminal truth still needs host ownership. */
export const hostRecoveryBatch = (database: Database, limit: number) =>
  attempt("hostRecoveryBatch", async () => {
    const candidates = await database
      .select({ userId: documentBuilds.user_id, workflowId: documentBuilds.workflow_id })
      .from(documentBuilds)
      .where(
        and(
          inArray(documentBuilds.state, activeStates),
          or(
            eq(documentBuilds.state, "publication_committed"),
            notExists(
              database
                .select({ id: deletionCases.deletion_case_id })
                .from(deletionCases)
                .where(
                  and(
                    eq(deletionCases.user_id, documentBuilds.user_id),
                    isNotNull(deletionCases.access_fenced_at),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(
        sql`${documentBuilds.host_recovery_checked_at} asc nulls first`,
        asc(documentBuilds.deadline_at),
        asc(documentBuilds.workflow_id),
      )
      .limit(limit);
    const recovered = new Array<typeof HostRecoveryCandidate.Type>();
    for (const candidate of candidates) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each bounded candidate owns one independent User-ordered transaction.
      const row = await database.transaction(async (transaction) => {
        if (!(await lockWorkflowUser(transaction, candidate.userId))) return null;
        const [current] = await transaction
          .select({
            inputDigest: documentBuilds.input_digest,
            mainInstanceId: documentBuilds.cloudflare_instance_id,
            state: documentBuilds.state,
            timerInstanceId: documentBuilds.cloudflare_timer_instance_id,
            userId: documentBuilds.user_id,
            workflowId: documentBuilds.workflow_id,
          })
          .from(documentBuilds)
          .where(eq(documentBuilds.workflow_id, candidate.workflowId))
          .for("update")
          .limit(1);
        if (current === undefined || !activeStateSet.has(current.state)) return null;
        const [deletion] = await transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(
              eq(deletionCases.user_id, current.userId),
              isNotNull(deletionCases.access_fenced_at),
            ),
          )
          .limit(1);
        if (deletion !== undefined && current.state !== "publication_committed") return null;
        await transaction
          .update(documentBuilds)
          .set({ host_recovery_checked_at: sql`clock_timestamp()` })
          .where(eq(documentBuilds.workflow_id, current.workflowId));
        return current;
      });
      if (row !== null) recovered.push(Schema.decodeSync(HostRecoveryCandidate)(row));
    }
    return recovered;
  });

const HostRecoveryDisposition = Schema.Literals(["Keep", "Terminate"]);

/** Recheck host eligibility after a repair under the same User-first serialization as deletion. */
export const hostRecoveryDisposition = (
  database: Database,
  workflowId: DocumentBuild.WorkflowId,
  inputDigest: DocumentBuild.InputDigest,
) =>
  attempt("hostRecoveryDisposition", async () => {
    return database.transaction(async (transaction) => {
      const [identity] = await transaction
        .select({ inputDigest: documentBuilds.input_digest, userId: documentBuilds.user_id })
        .from(documentBuilds)
        .where(eq(documentBuilds.workflow_id, workflowId))
        .limit(1);
      if (identity === undefined || identity.inputDigest !== inputDigest) return "Terminate";
      if (!(await lockWorkflowUser(transaction, identity.userId))) return "Terminate";
      const [current] = await transaction
        .select({ state: documentBuilds.state, userId: documentBuilds.user_id })
        .from(documentBuilds)
        .where(
          and(
            eq(documentBuilds.workflow_id, workflowId),
            eq(documentBuilds.input_digest, inputDigest),
          ),
        )
        .for("update")
        .limit(1);
      if (current === undefined || !activeStateSet.has(current.state)) return "Terminate";
      const [deletion] = await transaction
        .select({ id: deletionCases.deletion_case_id })
        .from(deletionCases)
        .where(
          and(eq(deletionCases.user_id, current.userId), isNotNull(deletionCases.access_fenced_at)),
        )
        .limit(1);
      return deletion === undefined || current.state === "publication_committed"
        ? "Keep"
        : "Terminate";
    });
  }).pipe(
    Effect.flatMap((outcome) =>
      Schema.decodeEffect(HostRecoveryDisposition)(outcome).pipe(
        Effect.mapError((cause) =>
          unavailable(
            "hostRecoveryDisposition.decode",
            "PostgreSQL returned invalid Document Build host eligibility",
            cause,
          ),
        ),
      ),
    ),
  );

const transition = (
  database: Database,
  workflowId: DocumentBuild.WorkflowId,
  inputDigest: DocumentBuild.InputDigest,
  operation: string,
  apply: (
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    row: Row,
  ) => Promise<Transition>,
) =>
  attempt(operation, () =>
    database.transaction(async (transaction) => {
      const [identity] = await transaction
        .select({ inputDigest: documentBuilds.input_digest, userId: documentBuilds.user_id })
        .from(documentBuilds)
        .where(eq(documentBuilds.workflow_id, workflowId))
        .limit(1);
      if (identity === undefined) return { _tag: "Missing" as const };
      if (identity.inputDigest !== inputDigest) return changed();
      if (!(await lockWorkflowUser(transaction, identity.userId))) {
        return { _tag: "Missing" as const };
      }
      await lock(transaction, workflowId);
      const [row] = await transaction
        .select(rowSelection)
        .from(documentBuilds)
        .where(eq(documentBuilds.workflow_id, workflowId))
        .for("update")
        .limit(1);
      if (row === undefined) return { _tag: "Missing" as const };
      if (row.inputDigest !== inputDigest) return changed();
      return apply(transaction, row);
    }),
  ).pipe(Effect.flatMap((outcome) => decodeTransition(workflowId, operation, outcome)));

type Transition =
  | { readonly _tag: "Found"; readonly row: Row }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Missing" };

const found = (row: Row): Transition => ({ _tag: "Found", row });
const changed = (): Transition => ({ _tag: "Conflict" });

const decodeTransition = (
  workflowId: DocumentBuild.WorkflowId,
  operation: string,
  outcome: Transition,
): Effect.Effect<
  DocumentBuild.Record,
  DocumentBuild.Conflict | DocumentBuild.NotFound | DocumentBuild.Unavailable
> => {
  if (outcome._tag === "Missing") return Effect.fail(new DocumentBuild.NotFound({ workflowId }));
  if (outcome._tag === "Conflict") {
    return Effect.fail(
      conflict(workflowId, `${operation} lost to cancellation, terminal state, or changed facts`),
    );
  }
  return decodeRow(outcome.row);
};

const inspectAuthority = (database: Database, build: DocumentBuild.Record, now: Date) => {
  const origin = build.originatingAuthority;
  if (Predicate.isTagged(origin, "AuthSession")) {
    return attempt("currentAuthorization.authSession", () =>
      database
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(and(eq(sessions.id, origin.authSessionId), eq(sessions.userId, build.userId)))
        .limit(1),
    ).pipe(
      Effect.map(([row]) =>
        row === undefined || row.expiresAt.getTime() <= now.getTime()
          ? {
              _tag: "RevokedAuthSession" as const,
              authSessionId: origin.authSessionId,
              userId: build.userId,
            }
          : {
              _tag: "AuthSession" as const,
              authSessionId: origin.authSessionId,
              expiresAt: row.expiresAt,
              userId: build.userId,
            },
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
          row !== undefined && row.userId === build.userId && row.revokedAt === null
            ? ("ChannelLink" as const)
            : ("RevokedChannelLink" as const),
        address: {
          authorId: ChannelAuthorId.make(row?.authorId ?? "revoked"),
          channelId: ChannelId.make(row?.channelId ?? "revoked"),
        },
        channelLinkId: origin.channelLinkId,
        userId: build.userId,
      })),
    );
  }
  return Effect.succeed({
    _tag: "DurableTrigger" as const,
    triggerId: origin.triggerId,
    triggerType: origin.triggerType,
    userId: build.userId,
  });
};

const decodeRow = (row: Row): Effect.Effect<DocumentBuild.Record, DocumentBuild.Unavailable> =>
  Effect.gen(function* () {
    const originatingAuthority = yield* Schema.decodeEffect(
      Schema.fromJsonString(OriginatingAuthority),
    )(row.originatingAuthorityJson).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored Document Build authority is invalid", cause),
      ),
    );
    const request = yield* Schema.decodeEffect(Schema.fromJsonString(DocumentBuild.StoredRequest))(
      row.requestJson,
    ).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored Document Build request is invalid", cause),
      ),
    );
    const costEvidence = yield* row.costEvidenceJson === null
      ? Effect.succeed(null)
      : Schema.decodeEffect(Schema.fromJsonString(CostEvidenceSchema))(row.costEvidenceJson).pipe(
          Effect.mapError((cause) =>
            unavailable("decode", "Stored Document Build cost evidence is invalid", cause),
          ),
        );
    const qualificationContext = yield* row.qualificationContextJson === null
      ? Effect.succeed(null)
      : Schema.decodeEffect(Schema.fromJsonString(QualificationContext))(
          row.qualificationContextJson,
        ).pipe(
          Effect.mapError((cause) =>
            unavailable("decode", "Stored Document Build qualification identity is invalid", cause),
          ),
        );
    return yield* Schema.decodeEffect(EncodedRecord)({
      ...row,
      costEvidence,
      originatingAuthority,
      ...qualificationContextFields(qualificationContext),
      request,
    }).pipe(
      Effect.mapError((cause) =>
        unavailable("decode", "Stored Document Build facts are invalid", cause),
      ),
    );
  });

const encodeAuthority = (authority: typeof OriginatingAuthority.Type) =>
  Schema.encodeSync(Schema.fromJsonString(OriginatingAuthority))(authority);

const encodeRequest = (request: DocumentBuild.StoredRequest) =>
  Schema.encodeSync(Schema.fromJsonString(DocumentBuild.StoredRequest))(request);

const encodeCost = (cost: CostEvidence | null) =>
  cost === null ? null : Schema.encodeSync(Schema.fromJsonString(CostEvidenceSchema))(cost);

const encodeQualificationContext = (context: QualificationContext | undefined) =>
  context === undefined
    ? null
    : Schema.encodeSync(Schema.fromJsonString(QualificationContext))(context);

const sameQualificationContext = (
  left: QualificationContext | undefined,
  right: QualificationContext | undefined,
) =>
  left === undefined || right === undefined
    ? left === right
    : left.attemptId === right.attemptId &&
      left.executionId === right.executionId &&
      left.journey === right.journey &&
      left.offeredAtEpochMs === right.offeredAtEpochMs &&
      left.planChecksum === right.planChecksum &&
      left.region === right.region &&
      left.rootId === right.rootId &&
      left.runId === right.runId;

const qualificationContextFields = (qualificationContext: QualificationContext | null) =>
  qualificationContext === null ? {} : { qualificationContext };

const lock = (
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  identity: string,
) => transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);

const attempt = <Value>(operation: string, query: () => Promise<Value>) =>
  Effect.tryPromise({
    try: query,
    catch: (cause) =>
      unavailable(operation, "PostgreSQL could not persist Document Build state", cause),
  });

const conflict = (workflowId: DocumentBuild.WorkflowId, message: string) =>
  new DocumentBuild.Conflict({ message, workflowId });

const unavailable = (operation: string, message: string, cause: unknown = operation) =>
  new DocumentBuild.Unavailable({ cause, message, operation });

export * as DocumentBuildPostgres from "./document-build";
