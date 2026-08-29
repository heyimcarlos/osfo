import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { agents } from "@osfo/db/schema/agents";
import { sessions } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { scheduledEmailNotifications, scheduledEmails } from "@osfo/db/schema/scheduled-emails";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { DateTime, Effect, Predicate, Result, Schema } from "effect";

import type { Database } from "@osfo/db";
import {
  AgentId,
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ConversationRouteId,
  ManifestVersion,
  ModelAccessPolicyVersion,
  Plan,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../../domain";
import { ActionId } from "../../domain/action-execution";
import { RecordedAllowanceUse } from "../../domain/allowance";
import { ChannelAuthorId, ChannelId } from "../../domain/channel-link";
import { ManagedModelRoute } from "../../domain/model-access-policy";
import {
  ApprovalPresentation,
  AuthorizationContext,
  emptyLiveResourceFacts,
  OriginatingAuthority,
} from "../../services/authorization";
import type { Denied } from "../../services/authorization";
import { ScheduledEmail } from "../../services/scheduled-email";
import { countActiveWorkflows, lockWorkflowUser } from "./workflow-serialization";

/* oxlint-disable effecttsgo/async-function, eslint/no-underscore-dangle -- Drizzle transactions serialize irreversible send claims, and outcomes use the canonical tagged discriminator. */

type Row = typeof scheduledEmails.$inferSelect;

type AdmissionOutcome =
  | { readonly _tag: "AccessFenced" }
  | { readonly _tag: "CapacityExceeded" }
  | { readonly _tag: "Created"; readonly row: Row }
  | { readonly _tag: "Existing"; readonly row: Row }
  | { readonly _tag: "Missing" };

type Persisted =
  | { readonly _tag: "Created"; readonly email: ScheduledEmail.Record }
  | { readonly _tag: "Existing"; readonly email: ScheduledEmail.Record };

type SendClaimOutcome =
  | { readonly _tag: "Acquired"; readonly row: Row }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Existing"; readonly row: Row }
  | { readonly _tag: "Missing" };

type RetrySendClaimOutcome =
  | { readonly _tag: "Acquired"; readonly row: Row }
  | { readonly _tag: "Canceled"; readonly row: Row }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Existing"; readonly row: Row }
  | { readonly _tag: "Missing" };

const EncodedRecord = Schema.Struct({
  acceptedAt: Schema.NullOr(Schema.Date),
  actionId: ActionId,
  admittedAt: Schema.Date,
  agentId: AgentId,
  allowancePeriodId: AllowancePeriodId,
  approvalPresentation: ApprovalPresentation,
  cancelRequestedAt: Schema.NullOr(Schema.Date),
  capabilityCatalogVersion: CapabilityCatalogVersion,
  cloudflareInstanceId: ScheduledEmail.CloudflareInstanceId,
  dueAt: Schema.Date,
  inputDigest: ScheduledEmail.InputDigest,
  manifestVersion: ManifestVersion,
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  originatingAuthority: OriginatingAuthority,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  providerLogId: Schema.NullOr(Schema.String),
  providerResourceId: Schema.NullOr(Schema.String),
  request: ScheduledEmail.Request,
  resourcePriceVersion: ResourcePriceVersion,
  routeId: ConversationRouteId,
  safeFailureCode: Schema.NullOr(Schema.String),
  sendOutcome: Schema.NullOr(Schema.Literals(["applied", "ambiguous", "notApplied"])),
  sendAccountingBasis: Schema.NullOr(Schema.Literals(["conservative", "observed"])),
  sendOutcomeAt: Schema.NullOr(Schema.Date),
  sendAccountedAt: Schema.NullOr(Schema.Date),
  sendClaimGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sendStartedAt: Schema.NullOr(Schema.Date),
  sessionId: SessionId,
  state: ScheduledEmail.State,
  terminalAt: Schema.NullOr(Schema.Date),
  workflowStartAccountedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
  waitingAt: Schema.NullOr(Schema.Date),
  workflowId: ScheduledEmail.WorkflowId,
});
const StoredRequest = Schema.Struct({
  ...ScheduledEmail.Request.fields,
  scheduledAt: Schema.DateFromString,
});

export const make = (database: Database): ScheduledEmail.PortInterface["persistence"] => ({
  admit: (record, activeWorkflowLimit) =>
    attempt("admit", () =>
      database.transaction(async (transaction) => {
        if (!(await lockWorkflowUser(transaction, record.userId))) {
          return { _tag: "AccessFenced" as const };
        }
        const [existing] = await transaction
          .select()
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, record.workflowId))
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
        await transaction.insert(scheduledEmails).values(encodeInsert(record));
        const [created] = await transaction
          .select()
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, record.workflowId))
          .limit(1);
        return created === undefined
          ? { _tag: "Missing" as const }
          : { _tag: "Created" as const, row: created };
      }),
    ).pipe(Effect.flatMap((outcome) => decodeAdmission(record.workflowId, outcome))),
  beginSend: (workflowId, inputDigest, startedAt) =>
    attempt("beginSend", () =>
      database.transaction(async (transaction): Promise<SendClaimOutcome> => {
        const [row] = await transaction
          .select()
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .for("update")
          .limit(1);
        if (row === undefined) return { _tag: "Missing" };
        if (row.input_digest !== inputDigest) return { _tag: "Conflict" };
        if (row.state === "sending" || row.state === "send_pending_reconciliation") {
          return { _tag: "Existing", row };
        }
        if (
          row.state !== "waiting" ||
          row.cancel_requested_at !== null ||
          startedAt.getTime() < row.due_at.getTime()
        ) {
          return { _tag: "Conflict" };
        }
        const [updated] = await transaction
          .update(scheduledEmails)
          .set({
            send_claim_generation: row.send_claim_generation + 1,
            send_started_at: startedAt,
            state: "sending",
            updated_at: sql`clock_timestamp()`,
          })
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .returning();
        return updated === undefined ? { _tag: "Conflict" } : { _tag: "Acquired", row: updated };
      }),
    ).pipe(Effect.flatMap((outcome) => decodeSendClaim(workflowId, outcome))),
  retrySend: (workflowId, inputDigest, expectedClaimGeneration, claimedAt) =>
    attempt("retrySend", () =>
      database.transaction(async (transaction): Promise<RetrySendClaimOutcome> => {
        const [identity] = await transaction
          .select({ userId: scheduledEmails.user_id })
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .limit(1);
        if (identity === undefined) return { _tag: "Missing" };
        if (!(await lockWorkflowUser(transaction, UserId.make(identity.userId)))) {
          return { _tag: "Missing" };
        }
        const [row] = await transaction
          .select()
          .from(scheduledEmails)
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .for("update")
          .limit(1);
        if (row === undefined) return { _tag: "Missing" };
        if (row.input_digest !== inputDigest) return { _tag: "Conflict" };
        if (row.state !== "sending" || row.send_claim_generation !== expectedClaimGeneration) {
          return { _tag: "Existing", row };
        }
        if (row.cancel_requested_at !== null) {
          const [canceled] = await transaction
            .update(scheduledEmails)
            .set({
              safe_failure_code: "cancel-requested",
              state: "canceled",
              terminal_at: claimedAt,
              updated_at: sql`clock_timestamp()`,
            })
            .where(eq(scheduledEmails.workflow_id, workflowId))
            .returning();
          return canceled === undefined
            ? { _tag: "Conflict" }
            : { _tag: "Canceled", row: canceled };
        }
        const [updated] = await transaction
          .update(scheduledEmails)
          .set({
            send_claim_generation: row.send_claim_generation + 1,
            send_started_at: claimedAt,
            updated_at: sql`clock_timestamp()`,
          })
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .returning();
        return updated === undefined ? { _tag: "Conflict" } : { _tag: "Acquired", row: updated };
      }),
    ).pipe(Effect.flatMap((outcome) => decodeRetrySendClaim(workflowId, outcome))),
  finishApplied: (workflowId, inputDigest, result, outcomeAt) =>
    transition(database, workflowId, inputDigest, "finishApplied", async (transaction, row) => {
      if (row.state === "success") return found(row);
      const canRefineUnaccountedAmbiguity =
        row.state === "failure" &&
        row.send_outcome === "ambiguous" &&
        row.send_accounting_basis === "conservative";
      if (
        row.state !== "sending" &&
        row.state !== "send_pending_reconciliation" &&
        !canRefineUnaccountedAmbiguity
      ) {
        return changed();
      }
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({
          provider_log_id: result.evidence.providerLogId,
          provider_resource_id: result.evidence.providerResourceId,
          safe_failure_code: null,
          send_accounting_basis: row.send_accounting_basis ?? "observed",
          send_outcome: "applied",
          send_outcome_at: outcomeAt,
          state: "success",
          terminal_at: outcomeAt,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  finishTerminal: (
    workflowId,
    inputDigest,
    state,
    sendOutcome,
    providerLogId,
    safeFailureCode,
    terminalAt,
  ) =>
    transition(database, workflowId, inputDigest, "finishTerminal", async (transaction, row) => {
      if (ScheduledEmail.terminalStates.has(row.state)) {
        return row.state === state && row.safe_failure_code === safeFailureCode
          ? found(row)
          : changed();
      }
      if (row.state === "send_pending_reconciliation" && state === "canceled") return changed();
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({
          safe_failure_code: safeFailureCode,
          send_accounting_basis:
            row.send_accounting_basis ?? (sendOutcome === "ambiguous" ? "conservative" : null),
          send_outcome: sendOutcome,
          send_outcome_at: sendOutcome === null ? row.send_outcome_at : terminalAt,
          provider_log_id: providerLogId ?? row.provider_log_id,
          state,
          terminal_at: terminalAt,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  refineNotApplied: (workflowId, inputDigest, providerLogId, preserveAccounting, outcomeAt) =>
    transition(database, workflowId, inputDigest, "refineNotApplied", async (transaction, row) => {
      if (
        row.state === "failure" &&
        row.send_outcome === "notApplied" &&
        row.send_accounting_basis === (preserveAccounting ? "conservative" : null) &&
        row.safe_failure_code === "send-not-applied"
      ) {
        return found(row);
      }
      if (
        row.state !== "failure" ||
        row.send_outcome !== "ambiguous" ||
        row.send_accounting_basis !== "conservative"
      ) {
        return changed();
      }
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({
          provider_log_id: providerLogId,
          safe_failure_code: "send-not-applied",
          send_accounting_basis: preserveAccounting ? "conservative" : null,
          send_outcome: "notApplied",
          send_outcome_at: outcomeAt,
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  inspect: (workflowId) =>
    attempt("inspect", () =>
      database
        .select()
        .from(scheduledEmails)
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .limit(1),
    ).pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : decodeRow(row)))),
  markAccepted: (workflowId, inputDigest, acceptedAt) =>
    transition(database, workflowId, inputDigest, "markAccepted", async (transaction, row) => {
      if (row.state === "accepted" || row.state === "waiting") return found(row);
      if (row.state !== "admitted") return changed();
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({ accepted_at: acceptedAt, state: "accepted", updated_at: sql`clock_timestamp()` })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  markAmbiguous: (workflowId, inputDigest, outcomeAt) =>
    transition(database, workflowId, inputDigest, "markAmbiguous", async (transaction, row) => {
      if (row.state === "send_pending_reconciliation") return found(row);
      if (row.state !== "sending") return changed();
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({
          send_outcome: "ambiguous",
          send_accounting_basis: "conservative",
          send_outcome_at: outcomeAt,
          state: "send_pending_reconciliation",
          updated_at: sql`clock_timestamp()`,
        })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  markWaiting: (workflowId, inputDigest, waitingAt) =>
    transition(database, workflowId, inputDigest, "markWaiting", async (transaction, row) => {
      if (row.state === "waiting") return found(row);
      if (row.state !== "accepted") return changed();
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({ state: "waiting", updated_at: sql`clock_timestamp()`, waiting_at: waitingAt })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  markSendAccounted: (workflowId, inputDigest, accountedAt) =>
    transition(database, workflowId, inputDigest, "markSendAccounted", async (transaction, row) => {
      if (row.send_accounted_at !== null) return found(row);
      if (row.send_outcome === null) return changed();
      const [updated] = await transaction
        .update(scheduledEmails)
        .set({ send_accounted_at: accountedAt, updated_at: sql`clock_timestamp()` })
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .returning();
      return updated === undefined ? changed() : found(updated);
    }),
  markWorkflowStartAccounted: (workflowId, inputDigest, accountedAt) =>
    transition(
      database,
      workflowId,
      inputDigest,
      "markWorkflowStartAccounted",
      async (transaction, row) => {
        if (row.workflow_start_accounted_at !== null) return found(row);
        if (row.accepted_at === null) return changed();
        const [updated] = await transaction
          .update(scheduledEmails)
          .set({ workflow_start_accounted_at: accountedAt, updated_at: sql`clock_timestamp()` })
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .returning();
        return updated === undefined ? changed() : found(updated);
      },
    ),
  requestCancel: (workflowId, userId, requestedAt) =>
    attempt("requestCancel", () =>
      database.transaction(async (transaction) => {
        if (!(await lockWorkflowUser(transaction, userId))) return null;
        const [row] = await transaction
          .select()
          .from(scheduledEmails)
          .where(
            and(eq(scheduledEmails.workflow_id, workflowId), eq(scheduledEmails.user_id, userId)),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return null;
        if (ScheduledEmail.terminalStates.has(row.state) || row.cancel_requested_at !== null) {
          return row;
        }
        const [updated] = await transaction
          .update(scheduledEmails)
          .set({ cancel_requested_at: requestedAt, updated_at: sql`clock_timestamp()` })
          .where(eq(scheduledEmails.workflow_id, workflowId))
          .returning();
        return updated ?? null;
      }),
    ).pipe(Effect.flatMap((row) => decodeCancel(workflowId, row))),
});

/** Check the immutable launch allowance key before refining terminal provider truth. */
export const sendAccountingRecorded = (database: Database, email: ScheduledEmail.Record) =>
  attempt("sendAccountingRecorded", () =>
    database
      .select({ allowanceKind: allowanceUsage.allowance_kind })
      .from(allowanceUsage)
      .where(
        and(
          eq(allowanceUsage.allowance_period_id, email.allowancePeriodId),
          eq(allowanceUsage.allowance_kind, "gmailSends"),
          eq(allowanceUsage.source_type, "integrationAction"),
          eq(allowanceUsage.source_id, email.actionId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));

/** Rebuild mutable User, Subscription, allowance, and originating-authority facts. */
export const makeCurrentAuthorization = (
  database: Database,
): ScheduledEmail.PortInterface["currentAuthorization"] =>
  Effect.fn("ScheduledEmailPostgres.currentAuthorization")(function* (email) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const [owners, subscriptions, suspensions, deletions, periods, usage, authority] =
      yield* Effect.all([
        attempt("currentAuthorization.owner", () =>
          database
            .select({ userId: agents.user_id })
            .from(agents)
            .where(eq(agents.agent_id, email.agentId))
            .limit(1),
        ),
        attempt("currentAuthorization.subscription", () =>
          database
            .select({
              plan: billingSubscriptions.plan,
              planPolicyVersion: billingSubscriptions.plan_policy_version,
            })
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.user_id, email.userId))
            .limit(1),
        ),
        attempt("currentAuthorization.suspension", () =>
          database
            .select({ action: userSuspensionEvents.action })
            .from(userSuspensionEvents)
            .where(eq(userSuspensionEvents.user_id, email.userId))
            .orderBy(desc(userSuspensionEvents.occurred_at), desc(userSuspensionEvents.event_id))
            .limit(1),
        ),
        attempt("currentAuthorization.deletion", () =>
          database
            .select({ id: deletionCases.deletion_case_id })
            .from(deletionCases)
            .where(
              and(
                eq(deletionCases.user_id, email.userId),
                isNotNull(deletionCases.access_fenced_at),
              ),
            )
            .limit(1),
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
                eq(allowancePeriods.user_id, email.userId),
                eq(allowancePeriods.allowance_period_id, email.allowancePeriodId),
              ),
            )
            .limit(1),
        ),
        attempt("currentAuthorization.allowanceUsage", () =>
          database
            .select({
              allowanceKind: allowanceUsage.allowance_kind,
              quantity: sql<bigint>`sum(${allowanceUsage.quantity})`.mapWith(
                allowanceUsage.quantity,
              ),
            })
            .from(allowanceUsage)
            .where(eq(allowanceUsage.allowance_period_id, email.allowancePeriodId))
            .groupBy(allowanceUsage.allowance_kind),
        ),
        inspectAuthority(database, email, now),
      ]);
    const subscription = subscriptions[0];
    const period = periods[0];
    if (subscription === undefined || period === undefined) {
      return yield* unavailable(
        "currentAuthorization",
        "Scheduled Email authority facts are missing",
      );
    }
    const recordedUsage = yield* Schema.decodeUnknownEffect(Schema.Array(RecordedAllowanceUse))(
      usage,
    ).pipe(
      Effect.mapError((cause) =>
        unavailable(
          "currentAuthorization.usage",
          "Scheduled Email allowance usage is invalid",
          cause,
        ),
      ),
    );
    return yield* Schema.decodeEffect(AuthorizationContext)({
      allowance: { _tag: "Metered", ...period, usage: recordedUsage },
      approval: null,
      authority,
      deletionAccess:
        deletions[0] === undefined
          ? { _tag: "DeletionAccessAvailable" }
          : { _tag: "DeletionAccessRevoked" },
      gmailConnection: null,
      integrationConnections: [],
      liveFacts: emptyLiveResourceFacts,
      now,
      originatingAuthority: email.originatingAuthority,
      requestVendorUsdMicros: 0n,
      resourceOwnerUserId: owners[0]?.userId ?? null,
      subscription,
      user:
        suspensions[0]?.action === "suspended"
          ? { _tag: "SuspendedUser", userId: email.userId }
          : { _tag: "ActiveUser", userId: email.userId },
    }).pipe(
      Effect.mapError((cause) =>
        unavailable(
          "currentAuthorization.decode",
          "Scheduled Email authority facts are invalid",
          cause,
        ),
      ),
    );
  });

/** Cancel every pre-effect email while retaining claimed provider truth for reconciliation. */
export const quiesceForAccountDeletion = (database: Database, userId: UserId, terminalAt: Date) =>
  attempt("quiesceForAccountDeletion", () =>
    database.transaction(async (transaction) => {
      await lockWorkflowUser(transaction, userId);
      const rows = await transaction
        .select({
          instanceId: scheduledEmails.cloudflare_instance_id,
          state: scheduledEmails.state,
          workflowId: scheduledEmails.workflow_id,
        })
        .from(scheduledEmails)
        .where(eq(scheduledEmails.user_id, userId))
        .for("update");
      const preEffect = rows.filter((row) =>
        ["admitted", "accepted", "waiting"].includes(row.state),
      );
      if (preEffect.length > 0) {
        await transaction
          .update(scheduledEmails)
          .set({
            cancel_requested_at: terminalAt,
            safe_failure_code: "account-deletion",
            state: "canceled",
            terminal_at: terminalAt,
            updated_at: terminalAt,
          })
          .where(
            and(
              eq(scheduledEmails.user_id, userId),
              inArray(scheduledEmails.state, ["admitted", "accepted", "waiting"]),
            ),
          );
      }
      const workflowIds = rows
        .filter((row) => row.state === "sending" || row.state === "send_pending_reconciliation")
        .map(({ workflowId }) => workflowId);
      const instances = preEffect.map(({ instanceId }) => instanceId);
      return workflowIds.length === 0
        ? { _tag: "Ready" as const, instances }
        : { _tag: "RecoveryPending" as const, instances, workflowIds };
    }),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Union([
          Schema.TaggedStruct("Ready", {
            instances: Schema.Array(ScheduledEmail.CloudflareInstanceId),
          }),
          Schema.TaggedStruct("RecoveryPending", {
            instances: Schema.Array(ScheduledEmail.CloudflareInstanceId),
            workflowIds: Schema.Array(ScheduledEmail.WorkflowId),
          }),
        ]),
      ),
    ),
    Effect.mapError((cause) =>
      Schema.is(ScheduledEmail.Unavailable)(cause)
        ? cause
        : unavailable(
            "quiesceForAccountDeletion",
            "PostgreSQL returned invalid Scheduled Email instance identities",
            cause,
          ),
    ),
  );

export const countActiveForUser = (database: Database, userId: UserId) =>
  attempt("countActiveForUser", () =>
    database.transaction((transaction) => countActiveWorkflows(transaction, userId)),
  ).pipe(Effect.map(BigInt));

/** Read a fair bounded batch whose host, effect, or post-commit obligations need repair. */
export const reconciliationBatch = (database: Database, now: Date, limit: number) =>
  attempt("reconciliationBatch", () =>
    database.transaction(async (transaction) => {
      const accessIsAvailable = notExists(
        transaction
          .select({ id: deletionCases.deletion_case_id })
          .from(deletionCases)
          .where(
            and(
              eq(deletionCases.user_id, scheduledEmails.user_id),
              isNotNull(deletionCases.access_fenced_at),
            ),
          ),
      );
      const rows = await transaction
        .select({
          agentId: scheduledEmails.agent_id,
          dueAt: scheduledEmails.due_at,
          inputDigest: scheduledEmails.input_digest,
          kind: sql<"claimed" | "due" | "host" | "settlement">`case
            when ${scheduledEmails.cancel_requested_at} is not null and ${scheduledEmails.state} not in ('success', 'failure', 'canceled') then 'claimed'
            when ${scheduledEmails.state} in ('admitted', 'accepted') then 'host'
            when ${scheduledEmails.state} = 'waiting' and ${scheduledEmails.workflow_start_accounted_at} is null then 'settlement'
            when ${scheduledEmails.state} = 'waiting' then 'due'
            when ${scheduledEmails.state} in ('sending', 'send_pending_reconciliation') then 'claimed'
            else 'settlement'
          end`,
          workflowId: scheduledEmails.workflow_id,
        })
        .from(scheduledEmails)
        .leftJoin(
          scheduledEmailNotifications,
          eq(scheduledEmailNotifications.workflow_id, scheduledEmails.workflow_id),
        )
        .where(
          or(
            and(inArray(scheduledEmails.state, ["admitted", "accepted"]), accessIsAvailable),
            and(
              eq(scheduledEmails.state, "waiting"),
              or(
                lte(scheduledEmails.due_at, now),
                isNull(scheduledEmails.workflow_start_accounted_at),
              ),
              accessIsAvailable,
            ),
            inArray(scheduledEmails.state, ["sending", "send_pending_reconciliation"]),
            and(
              isNotNull(scheduledEmails.cancel_requested_at),
              inArray(scheduledEmails.state, ["admitted", "accepted", "waiting"]),
              accessIsAvailable,
            ),
            and(
              eq(scheduledEmails.state, "failure"),
              eq(scheduledEmails.send_outcome, "ambiguous"),
              isNotNull(scheduledEmails.send_started_at),
              sql`${scheduledEmails.send_started_at} + interval '5 minutes' >= ${now.toISOString()}::timestamptz`,
              accessIsAvailable,
            ),
            and(
              inArray(scheduledEmails.state, ["success", "failure", "canceled"]),
              or(
                and(
                  isNotNull(scheduledEmails.accepted_at),
                  isNull(scheduledEmails.workflow_start_accounted_at),
                ),
                and(
                  isNotNull(scheduledEmails.send_outcome),
                  isNull(scheduledEmails.send_accounted_at),
                ),
                isNull(scheduledEmailNotifications.accepted_at),
                isNull(scheduledEmailNotifications.wake_requested_at),
              ),
              accessIsAvailable,
            ),
          ),
        )
        .orderBy(asc(scheduledEmails.updated_at), asc(scheduledEmails.due_at))
        .limit(limit)
        .for("update", { of: scheduledEmails, skipLocked: true });
      if (rows.length > 0) {
        await transaction
          .update(scheduledEmails)
          .set({ updated_at: now })
          .where(
            inArray(
              scheduledEmails.workflow_id,
              rows.map(({ workflowId }) => workflowId),
            ),
          );
      }
      return rows;
    }),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Array(ScheduledEmail.ReconciliationCandidate)),
    ),
    Effect.mapError((cause) =>
      Schema.is(ScheduledEmail.Unavailable)(cause)
        ? cause
        : unavailable(
            "reconciliationBatch",
            "PostgreSQL returned invalid Scheduled Email recovery identities",
            cause,
          ),
    ),
  );

const transition = (
  database: Database,
  workflowId: ScheduledEmail.WorkflowId,
  inputDigest: ScheduledEmail.InputDigest,
  operation: string,
  apply: (
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    row: Row,
  ) => Promise<Transition>,
) =>
  attempt(operation, () =>
    database.transaction(async (transaction) => {
      const [identity] = await transaction
        .select({ inputDigest: scheduledEmails.input_digest, userId: scheduledEmails.user_id })
        .from(scheduledEmails)
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .limit(1);
      if (identity === undefined || !(await lockWorkflowUser(transaction, identity.userId))) {
        return missing();
      }
      if (identity.inputDigest !== inputDigest) return changed();
      const [row] = await transaction
        .select()
        .from(scheduledEmails)
        .where(eq(scheduledEmails.workflow_id, workflowId))
        .for("update")
        .limit(1);
      if (row === undefined) return missing();
      if (row.input_digest !== inputDigest) return changed();
      return apply(transaction, row);
    }),
  ).pipe(Effect.flatMap((outcome) => decodeTransition(workflowId, operation, outcome)));

type Transition =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Found"; readonly row: Row }
  | { readonly _tag: "Missing" };

const changed = (): Transition => ({ _tag: "Conflict" });
const found = (row: Row): Transition => ({ _tag: "Found", row });
const missing = (): Transition => ({ _tag: "Missing" });

const decodeAdmission = (
  workflowId: ScheduledEmail.WorkflowId,
  outcome: AdmissionOutcome,
): Effect.Effect<Persisted, ScheduledEmail.Conflict | Denied | ScheduledEmail.Unavailable> => {
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
  if (outcome._tag === "Missing") {
    return Effect.fail(conflict(workflowId, "Scheduled Email admission vanished"));
  }
  return decodeRow(outcome.row).pipe(
    Effect.map((email): Persisted =>
      outcome._tag === "Created" ? { _tag: "Created", email } : { _tag: "Existing", email },
    ),
  );
};

const decodeCancel = (
  workflowId: ScheduledEmail.WorkflowId,
  row: Row | null,
): Effect.Effect<ScheduledEmail.Record, ScheduledEmail.NotFound | ScheduledEmail.Unavailable> =>
  row === null ? Effect.fail(new ScheduledEmail.NotFound({ workflowId })) : decodeRow(row);

const decodeSendClaim = (
  workflowId: ScheduledEmail.WorkflowId,
  outcome: SendClaimOutcome,
): Effect.Effect<
  ScheduledEmail.SendClaim,
  ScheduledEmail.Conflict | ScheduledEmail.NotFound | ScheduledEmail.Unavailable
> => {
  if (outcome._tag === "Missing") {
    return Effect.fail(new ScheduledEmail.NotFound({ workflowId }));
  }
  if (outcome._tag === "Conflict") {
    return Effect.fail(conflict(workflowId, "beginSend lost to changed lifecycle truth"));
  }
  return decodeRow(outcome.row).pipe(
    Effect.map((email): ScheduledEmail.SendClaim => ({ _tag: outcome._tag, email })),
  );
};

const decodeRetrySendClaim = (
  workflowId: ScheduledEmail.WorkflowId,
  outcome: RetrySendClaimOutcome,
): Effect.Effect<
  ScheduledEmail.RetrySendClaim,
  ScheduledEmail.Conflict | ScheduledEmail.NotFound | ScheduledEmail.Unavailable
> => {
  if (outcome._tag === "Missing") {
    return Effect.fail(new ScheduledEmail.NotFound({ workflowId }));
  }
  if (outcome._tag === "Conflict") {
    return Effect.fail(conflict(workflowId, "retrySend lost to changed lifecycle truth"));
  }
  return decodeRow(outcome.row).pipe(
    Effect.map((email): ScheduledEmail.RetrySendClaim => ({ _tag: outcome._tag, email })),
  );
};

const decodeTransition = (
  workflowId: ScheduledEmail.WorkflowId,
  operation: string,
  outcome: Transition,
): Effect.Effect<
  ScheduledEmail.Record,
  ScheduledEmail.Conflict | ScheduledEmail.NotFound | ScheduledEmail.Unavailable
> => {
  if (outcome._tag === "Missing") {
    return Effect.fail(new ScheduledEmail.NotFound({ workflowId }));
  }
  if (outcome._tag === "Conflict") {
    return Effect.fail(conflict(workflowId, `${operation} lost to changed lifecycle truth`));
  }
  return decodeRow(outcome.row);
};

const decodeRow = (row: Row): Effect.Effect<ScheduledEmail.Record, ScheduledEmail.Unavailable> => {
  const authority = Schema.decodeResult(Schema.fromJsonString(OriginatingAuthority))(
    row.originating_authority_json,
  );
  const request = Schema.decodeResult(Schema.fromJsonString(StoredRequest))(row.request_json);
  if (Result.isFailure(authority) || Result.isFailure(request)) {
    return Effect.fail(
      unavailable("decode", "PostgreSQL returned invalid Scheduled Email JSON", {
        authority: Result.isFailure(authority),
        request: Result.isFailure(request),
      }),
    );
  }
  return Schema.decodeEffect(EncodedRecord)({
    acceptedAt: row.accepted_at,
    actionId: row.action_id,
    admittedAt: row.admitted_at,
    agentId: row.agent_id,
    allowancePeriodId: row.allowance_period_id,
    approvalPresentation: row.approval_presentation,
    cancelRequestedAt: row.cancel_requested_at,
    capabilityCatalogVersion: row.capability_catalog_version,
    cloudflareInstanceId: row.cloudflare_instance_id,
    dueAt: row.due_at,
    inputDigest: row.input_digest,
    manifestVersion: row.manifest_version,
    modelAccessPolicyVersion: row.model_access_policy_version,
    modelRoute: row.model_route,
    originatingAuthority: authority.success,
    plan: row.plan,
    planPolicyVersion: row.plan_policy_version,
    providerLogId: row.provider_log_id,
    providerResourceId: row.provider_resource_id,
    request: request.success,
    resourcePriceVersion: row.resource_price_version,
    routeId: row.route_id,
    safeFailureCode: row.safe_failure_code,
    sendOutcome: row.send_outcome,
    sendAccountingBasis: row.send_accounting_basis,
    sendOutcomeAt: row.send_outcome_at,
    sendAccountedAt: row.send_accounted_at,
    sendClaimGeneration: row.send_claim_generation,
    sendStartedAt: row.send_started_at,
    sessionId: row.session_id,
    state: row.state,
    terminalAt: row.terminal_at,
    workflowStartAccountedAt: row.workflow_start_accounted_at,
    userId: row.user_id,
    waitingAt: row.waiting_at,
    workflowId: row.workflow_id,
  }).pipe(
    Effect.mapError((cause) =>
      unavailable("decode", "PostgreSQL returned invalid Scheduled Email truth", cause),
    ),
  );
};

const encodeInsert = (record: ScheduledEmail.Record): typeof scheduledEmails.$inferInsert => ({
  accepted_at: record.acceptedAt,
  action_id: record.actionId,
  admitted_at: record.admittedAt,
  agent_id: record.agentId,
  allowance_period_id: record.allowancePeriodId,
  approval_presentation: record.approvalPresentation,
  cancel_requested_at: record.cancelRequestedAt,
  capability_catalog_version: record.capabilityCatalogVersion,
  cloudflare_instance_id: record.cloudflareInstanceId,
  due_at: record.dueAt,
  input_digest: record.inputDigest,
  manifest_version: record.manifestVersion,
  model_access_policy_version: record.modelAccessPolicyVersion,
  model_route: record.modelRoute,
  originating_authority_json: Schema.encodeSync(Schema.fromJsonString(OriginatingAuthority))(
    record.originatingAuthority,
  ),
  plan: record.plan,
  plan_policy_version: record.planPolicyVersion,
  provider_log_id: record.providerLogId,
  provider_resource_id: record.providerResourceId,
  request_json: Schema.encodeSync(Schema.fromJsonString(StoredRequest))(record.request),
  resource_price_version: record.resourcePriceVersion,
  route_id: record.routeId,
  safe_failure_code: record.safeFailureCode,
  send_outcome: record.sendOutcome,
  send_accounting_basis: record.sendAccountingBasis,
  send_outcome_at: record.sendOutcomeAt,
  send_accounted_at: record.sendAccountedAt,
  send_claim_generation: record.sendClaimGeneration,
  send_started_at: record.sendStartedAt,
  session_id: record.sessionId,
  state: record.state,
  terminal_at: record.terminalAt,
  workflow_start_accounted_at: record.workflowStartAccountedAt,
  user_id: record.userId,
  waiting_at: record.waitingAt,
  workflow_id: record.workflowId,
});

const inspectAuthority = (database: Database, email: ScheduledEmail.Record, now: Date) => {
  const origin = email.originatingAuthority;
  if (Predicate.isTagged(origin, "AuthSession")) {
    return attempt("currentAuthorization.authSession", () =>
      database
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(and(eq(sessions.id, origin.authSessionId), eq(sessions.userId, email.userId)))
        .limit(1),
    ).pipe(
      Effect.map(([row]) =>
        row === undefined || row.expiresAt.getTime() <= now.getTime()
          ? {
              _tag: "RevokedAuthSession" as const,
              authSessionId: origin.authSessionId,
              userId: email.userId,
            }
          : {
              _tag: "AuthSession" as const,
              authSessionId: origin.authSessionId,
              expiresAt: row.expiresAt,
              userId: email.userId,
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
          row !== undefined && row.userId === email.userId && row.revokedAt === null
            ? ("ChannelLink" as const)
            : ("RevokedChannelLink" as const),
        address: {
          authorId: ChannelAuthorId.make(row?.authorId ?? "revoked"),
          channelId: ChannelId.make(row?.channelId ?? "revoked"),
        },
        channelLinkId: origin.channelLinkId,
        userId: email.userId,
      })),
    );
  }
  return Effect.succeed({
    _tag: "DurableTrigger" as const,
    triggerId: origin.triggerId,
    triggerType: origin.triggerType,
    userId: email.userId,
  });
};

const attempt = <Value>(operation: string, run: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => unavailable(operation, "Scheduled Email PostgreSQL is unavailable", cause),
  });

const unavailable = (operation: string, message: string, cause: unknown = operation) =>
  new ScheduledEmail.Unavailable({ cause, message, operation });

const conflict = (workflowId: ScheduledEmail.WorkflowId, message: string) =>
  new ScheduledEmail.Conflict({ message, workflowId });

export * as ScheduledEmailPostgres from "./scheduled-email";
