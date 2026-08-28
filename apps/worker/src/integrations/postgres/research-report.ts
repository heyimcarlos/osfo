import { researchReports } from "@osfo/db/schema/research-reports";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

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
import { ManagedModelRoute } from "../../domain/model-access-policy";
import { ResearchReport } from "../../services/research-report";
import { OriginatingAuthority } from "../../services/authorization";

/* oxlint-disable effecttsgo/async-function -- Drizzle transactions are the PostgreSQL serialization boundary. */
/* oxlint-disable eslint/no-underscore-dangle -- Persistence outcomes use the standard Effect _tag discriminator. */

const rowSelection = {
  acceptedAt: researchReports.accepted_at,
  admittedAt: researchReports.admitted_at,
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
  sessionId: researchReports.session_id,
  state: researchReports.state,
  terminalAt: researchReports.terminal_at,
  userId: researchReports.user_id,
  workflowId: researchReports.workflow_id,
};

type Row = {
  readonly acceptedAt: Date | null;
  readonly admittedAt: Date;
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
  readonly sessionId: string;
  readonly state: string;
  readonly terminalAt: Date | null;
  readonly userId: string;
  readonly workflowId: string;
};

const EncodedRecord = Schema.Struct({
  acceptedAt: Schema.NullOr(Schema.Date),
  admittedAt: Schema.Date,
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
  sessionId: SessionId,
  state: ResearchReport.State,
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
          admitted_at: record.admittedAt,
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
          session_id: record.sessionId,
          state: record.state,
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
          row.state === "cancel_requested"
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
    return yield* Schema.decodeUnknownEffect(EncodedRecord)({
      ...row,
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
