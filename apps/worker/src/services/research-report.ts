import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";

import {
  type AgentId,
  type AllowancePeriodId,
  type CapabilityCatalogVersion,
  type ConversationRouteId,
  ModelAccessPolicyVersion,
  type PlanPolicyVersion,
  type ResourcePriceVersion,
  type SessionId,
  UserId,
} from "../domain";
import type { ActionId } from "../domain/action-execution";
import { ConsequenceClass, currentCapabilityCatalog } from "../domain/capability-catalog";
import type { ManagedModelRoute } from "../domain/model-access-policy";
import { launchModelAccessPolicy, selectManagedRoute } from "../domain/model-access-policy";
import { retainedCatalog } from "../domain/plan-policy";
import { currentResourcePriceVersion } from "../domain/usage";
import {
  type AuthorizationContext,
  type Denied,
  Authorization,
  type OriginatingAuthority,
} from "./authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Research Report outcomes use the standard Effect _tag discriminator. */

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Stable product identity for one Research Report Workflow. */
export const WorkflowId = boundedIdentity.pipe(Schema.brand("ResearchReportWorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;

/** Stable Cloudflare instance identity derived from one Research Report Workflow. */
export const CloudflareInstanceId = boundedIdentity.pipe(
  Schema.brand("ResearchReportCloudflareInstanceId"),
);
export type CloudflareInstanceId = typeof CloudflareInstanceId.Type;

/** Digest binding one Workflow identity to its immutable request. */
export const InputDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("ResearchReportInputDigest"),
);
export type InputDigest = typeof InputDigest.Type;

/** Bounded public-web plan supplied by the requesting Agent. */
export const Request = Schema.Struct({
  consequences: Schema.Array(ConsequenceClass).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  format: Schema.Literals(["pdf", "docx"]),
  queries: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  topic: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
});
export type Request = typeof Request.Type;

/** Cloudflare payload deliberately excludes private report input and provider state. */
export const WorkflowPayload = Schema.Struct({
  inputDigest: InputDigest,
  workflowId: WorkflowId,
});
export type WorkflowPayload = typeof WorkflowPayload.Type;

/** Product states retained independently of Cloudflare Workflow history. */
export const State = Schema.Literals([
  "admitted",
  "accepted",
  "running",
  "sources_committed",
  "artifact_stored",
  "cancel_requested",
  "success",
  "failure",
  "canceled",
]);
export type State = typeof State.Type;

export const terminalStates = new Set<State>(["success", "failure", "canceled"]);

/** Complete trusted product row needed to recover one Research Report. */
export interface Record {
  readonly workflowId: WorkflowId;
  readonly actionId: ActionId;
  readonly userId: UserId;
  readonly agentId: AgentId;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
  readonly originatingAuthority: typeof OriginatingAuthority.Type;
  readonly approval: AuthorizationContext["approval"];
  readonly inputDigest: InputDigest;
  readonly request: Request;
  readonly state: State;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly capabilityCatalogVersion: CapabilityCatalogVersion;
  readonly modelAccessPolicyVersion: ModelAccessPolicyVersion;
  readonly modelRoute: ManagedModelRoute;
  readonly resourcePriceVersion: ResourcePriceVersion;
  readonly manifestVersion: string | null;
  readonly cloudflareInstanceId: CloudflareInstanceId;
  readonly admittedAt: Date;
  readonly deadlineAt: Date;
  readonly acceptedAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly terminalAt: Date | null;
}

export interface StartInput {
  readonly actionId: ActionId;
  readonly agentId: AgentId;
  readonly authorization: AuthorizationContext;
  readonly request: Request;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
}

export type StartResult =
  | { readonly _tag: "Started"; readonly report: Record }
  | { readonly _tag: "Replayed"; readonly report: Record }
  | { readonly _tag: "AcceptancePending"; readonly report: Record };

export type CancelResult =
  | { readonly _tag: "CancelRequested"; readonly report: Record }
  | { readonly _tag: "Terminal"; readonly report: Record };

export class Conflict extends Schema.TaggedError<Conflict>()("ResearchReportConflict", {
  message: Schema.String,
  workflowId: WorkflowId,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("ResearchReportNotFound", {
  workflowId: WorkflowId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("ResearchReportUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
}) {}

export interface PortInterface {
  readonly currentAuthorization: (
    report: Record,
  ) => Effect.Effect<AuthorizationContext, Unavailable>;
  readonly persistence: {
    readonly admit: (record: Record) => Effect.Effect<
      | { readonly _tag: "Created"; readonly report: Record }
      | {
          readonly _tag: "Existing";
          readonly report: Record;
        },
      Conflict | Unavailable
    >;
    readonly inspect: (workflowId: WorkflowId) => Effect.Effect<Record | null, Unavailable>;
    readonly markAccepted: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      acceptedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly requestCancel: (
      workflowId: WorkflowId,
      userId: UserId,
      requestedAt: Date,
    ) => Effect.Effect<Record, NotFound | Unavailable>;
  };
  readonly workflow: {
    readonly create: (
      instanceId: CloudflareInstanceId,
      payload: WorkflowPayload,
    ) => Effect.Effect<void, Unavailable>;
    readonly terminate: (instanceId: CloudflareInstanceId) => Effect.Effect<void, Unavailable>;
  };
}

export class Port extends Context.Service<Port, PortInterface>()("@osfo/ResearchReport/Port") {}

export interface Interface {
  readonly authorizeExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly cancel: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<CancelResult, NotFound | Unavailable>;
  readonly inspect: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<Record, NotFound | Unavailable>;
  readonly reconcileAcceptance: (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<StartResult, Conflict | Denied | NotFound | Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/ResearchReport") {}

/** Build the Research Report service around durable PostgreSQL and Cloudflare ports. */
export const make = Effect.gen(function* () {
  const ports = yield* Port;
  const authorization = Authorization.make(retainedCatalog);

  const inspect = Effect.fn("ResearchReport.inspect")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const report = yield* ports.persistence.inspect(workflowId);
    if (report === null || report.userId !== userId) return yield* new NotFound({ workflowId });
    return report;
  });

  const accept = Effect.fn("ResearchReport.accept")(function* (report: Record) {
    if (report.state !== "admitted") return report;
    const payload = WorkflowPayload.make({
      inputDigest: report.inputDigest,
      workflowId: report.workflowId,
    });
    yield* ports.workflow.create(report.cloudflareInstanceId, payload);
    const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.markAccepted(report.workflowId, report.inputDigest, acceptedAt);
  });

  const recheck = Effect.fn("ResearchReport.recheck")(function* (
    report: Record,
    context: AuthorizationContext,
  ) {
    const result = authorization.recheck(
      context,
      workflowOperation(report.actionId, report.request),
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
    return undefined;
  });

  const reconcileAcceptance = Effect.fn("ResearchReport.reconcileAcceptance")(function* (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) {
    const report = yield* ports.persistence.inspect(workflowId);
    if (report === null) return yield* new NotFound({ workflowId });
    if (report.inputDigest !== inputDigest) {
      return yield* new Conflict({
        message: "The Workflow identity names a different immutable Research Report request",
        workflowId,
      });
    }
    const context = yield* ports.currentAuthorization(report);
    yield* recheck(report, context);
    return yield* accept(report);
  });

  const authorizeExecution = Effect.fn("ResearchReport.authorizeExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const report = yield* ports.persistence.inspect(payload.workflowId);
    if (report === null) return yield* new NotFound({ workflowId: payload.workflowId });
    if (
      report.inputDigest !== payload.inputDigest ||
      String(report.cloudflareInstanceId) !== String(payload.workflowId)
    ) {
      return yield* new Conflict({
        message: "Cloudflare execution does not match the admitted Research Report",
        workflowId: payload.workflowId,
      });
    }
    if (report.state === "cancel_requested" || terminalStates.has(report.state)) {
      return yield* new Conflict({
        message: "The Research Report is no longer executable",
        workflowId: payload.workflowId,
      });
    }
    const context = yield* ports.currentAuthorization(report);
    yield* recheck(report, context);
    return report;
  });

  const start = Effect.fn("ResearchReport.start")(function* (input: StartInput) {
    const workflowId = yield* workflowIdFor(input.authorization.user.userId, input.actionId);
    const cloudflareInstanceId = CloudflareInstanceId.make(workflowId);
    const inputDigest = yield* digestRequest(input.authorization.user.userId, input.request);
    const existing = yield* ports.persistence.inspect(workflowId);
    if (existing !== null) {
      if (
        existing.userId !== input.authorization.user.userId ||
        existing.inputDigest !== inputDigest
      ) {
        return yield* new Conflict({
          message: "The Workflow identity was replayed with changed User or request facts",
          workflowId,
        });
      }
      yield* recheck(existing, input.authorization);
      const accepted = yield* accept(existing).pipe(
        Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
      );
      return accepted === null
        ? { _tag: "AcceptancePending" as const, report: existing }
        : { _tag: "Replayed" as const, report: accepted };
    }

    const admission = authorization.admit(
      input.authorization,
      workflowOperation(input.actionId, input.request),
    );
    if (!Predicate.isTagged(admission, "Admitted")) {
      return yield* Effect.fail(
        Predicate.isTagged(admission, "Denied")
          ? admission
          : ({ _tag: "Denied", reason: "approvalRequired", resetAt: null } satisfies Denied),
      );
    }
    if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
      return yield* Effect.fail({
        _tag: "Denied",
        reason: "allowancePeriodUnavailable",
        resetAt: null,
      } satisfies Denied);
    }
    const route = yield* selectManagedRoute(
      launchModelAccessPolicy,
      input.authorization.subscription.plan,
      input.authorization.subscription.planPolicyVersion,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "The admitted Plan has no retained Research Report model route",
            operation: "start.selectRoute",
          }),
      ),
    );
    const admittedAt = input.authorization.now;
    const report: Record = {
      workflowId,
      actionId: input.actionId,
      userId: input.authorization.user.userId,
      agentId: input.agentId,
      routeId: input.routeId,
      sessionId: input.sessionId,
      originatingAuthority: input.authorization.originatingAuthority,
      approval: input.authorization.approval,
      inputDigest,
      request: input.request,
      state: "admitted",
      allowancePeriodId: admission.allowancePeriod.allowancePeriodId,
      planPolicyVersion: input.authorization.subscription.planPolicyVersion,
      capabilityCatalogVersion: admission.capabilityCatalogVersion,
      modelAccessPolicyVersion: ModelAccessPolicyVersion.make(
        launchModelAccessPolicy.planPolicyVersion,
      ),
      modelRoute: route.route,
      resourcePriceVersion: currentResourcePriceVersion,
      manifestVersion: admission.manifestVersion,
      cloudflareInstanceId,
      admittedAt,
      deadlineAt: deadlineAfter(admittedAt),
      acceptedAt: null,
      cancelRequestedAt: null,
      terminalAt: null,
    };
    const persisted = yield* ports.persistence.admit(report);
    const exact = persisted.report;
    if (exact.userId !== report.userId || exact.inputDigest !== report.inputDigest) {
      return yield* new Conflict({
        message: "Concurrent Research Report admission retained different immutable facts",
        workflowId,
      });
    }
    const accepted = yield* accept(exact).pipe(
      Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
    );
    if (accepted === null) {
      return { _tag: "AcceptancePending" as const, report: exact };
    }
    return {
      _tag: persisted._tag === "Created" ? ("Started" as const) : ("Replayed" as const),
      report: accepted,
    };
  });

  const cancel = Effect.fn("ResearchReport.cancel")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const requestedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const requested = yield* ports.persistence.requestCancel(workflowId, userId, requestedAt);
    if (terminalStates.has(requested.state)) {
      return { _tag: "Terminal" as const, report: requested };
    }
    yield* ports.workflow.terminate(requested.cloudflareInstanceId).pipe(Effect.ignore);
    return { _tag: "CancelRequested" as const, report: requested };
  });

  return Service.of({ authorizeExecution, cancel, inspect, reconcileAcceptance, start });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

const digestRequest = (userId: UserId, request: Request) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ request: Request, userId: UserId })))({
    request,
    userId,
  }).pipe(Effect.orDie, Effect.flatMap(digest));

const workflowIdFor = (userId: UserId, actionId: ActionId) =>
  digest(`${userId}\0${actionId}`).pipe(
    Effect.map((value) => WorkflowId.make(`research:${value}`)),
  );

const deadlineAfter = (admittedAt: Date) =>
  DateTime.toDateUtc(
    DateTime.add(DateTime.makeUnsafe(admittedAt), {
      milliseconds: currentCapabilityCatalog.operationLimits.researchOperationMilliseconds,
    }),
  );

const workflowOperation = (actionId: ActionId, request: Request) => ({
  actionId,
  change: "start" as const,
  consequences: request.consequences,
  kind: "workflow.manage" as const,
});

const isWorkflowAcknowledgementFailure = (failure: Conflict | NotFound | Unavailable) =>
  Predicate.isTagged(failure, "ResearchReportUnavailable") &&
  (failure.operation === "workflow.create" || failure.operation === "workflow.reconcileCreate");

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

export * as ResearchReport from "./research-report";
