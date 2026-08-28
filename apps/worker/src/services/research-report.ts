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
import {
  launchModelAccessPolicy,
  selectManagedRoute,
  sharedUsageModelAccessPolicy,
} from "../domain/model-access-policy";
import {
  isLaunchPolicy,
  policyFor,
  policyForVersion,
  retainedCatalog,
} from "../domain/plan-policy";
import { currentResourcePriceVersion } from "../domain/usage";
import {
  type AuthorizationContext,
  type Denied,
  approvalFor,
  Authorization,
  type OriginatingAuthority,
} from "./authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Research Report outcomes use the standard Effect _tag discriminator. */

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Stable product identity for one Research Report Workflow. */
export const WorkflowId = boundedIdentity.pipe(Schema.brand("ResearchReportWorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;

/** Stable Cloudflare instance identity derived from one Research Report Workflow. */
export const CloudflareInstanceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u),
).pipe(Schema.brand("ResearchReportCloudflareInstanceId"));
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
  "publication_committed",
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
  readonly sourceManifestKey: string | null;
  readonly sourceManifestDigest: InputDigest | null;
  readonly artifactContentId: string | null;
  readonly safeFailureCode: string | null;
  readonly cloudflareInstanceId: CloudflareInstanceId;
  readonly admittedAt: Date;
  readonly deadlineAt: Date;
  readonly acceptedAt: Date | null;
  readonly startedAt: Date | null;
  readonly artifactStoredAt: Date | null;
  readonly publicationCommittedAt: Date | null;
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
  | { readonly _tag: "PublicationCommitted"; readonly report: Record }
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
  readonly discardPendingArtifact: (report: Record) => Effect.Effect<void, Unavailable>;
  readonly providerAvailable: Effect.Effect<boolean>;
  readonly recordWorkflowStart: (report: Record) => Effect.Effect<void, Unavailable>;
  readonly commitTerminalFollowUp: (report: Record) => Effect.Effect<void, Unavailable>;
  readonly persistence: {
    readonly admit: (
      record: Record,
      activeWorkflowLimit: bigint,
    ) => Effect.Effect<
      | { readonly _tag: "Created"; readonly report: Record }
      | {
          readonly _tag: "Existing";
          readonly report: Record;
        },
      Conflict | Denied | Unavailable
    >;
    readonly inspect: (workflowId: WorkflowId) => Effect.Effect<Record | null, Unavailable>;
    readonly markAccepted: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      acceptedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly beginExecution: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      startedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly markSourcesCommitted: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      sourceManifestKey: string,
      sourceManifestDigest: InputDigest,
      committedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly claimArtifactPublication: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      claimedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly commitArtifactPublication: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      committedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly completeSuccess: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      completedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly finishTerminal: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      state: "canceled" | "failure",
      safeFailureCode: string,
      terminalAt: Date,
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
  readonly beginExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly artifactAuthorization: (
    payload: WorkflowPayload,
    requestVendorUsdMicros: bigint,
  ) => Effect.Effect<
    { readonly authorization: AuthorizationContext; readonly report: Record },
    Conflict | Denied | NotFound | Unavailable
  >;
  readonly authorizeExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly claimArtifactPublication: (
    payload: WorkflowPayload,
    contentId: string,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly commitArtifactPublication: (
    payload: WorkflowPayload,
    contentId: string,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly completeSuccess: (
    payload: WorkflowPayload,
    contentId: string,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly finishCanceled: (
    payload: WorkflowPayload,
    safeFailureCode: string,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly finishFailure: (
    payload: WorkflowPayload,
    safeFailureCode: string,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly cancel: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<CancelResult, Conflict | Denied | NotFound | Unavailable>;
  readonly commitSources: (
    payload: WorkflowPayload,
    sourceManifestKey: string,
    sourceManifestDigest: InputDigest,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly inspect: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<Record, Denied | NotFound | Unavailable>;
  readonly reconcileAcceptance: (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly resumePublication: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<StartResult, Conflict | Denied | NotFound | Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/ResearchReport") {}

/** Build the Research Report service around durable PostgreSQL and Cloudflare ports. */
export const make = Effect.gen(function* () {
  const ports = yield* Port;
  const authorization = Authorization.make(retainedCatalog);

  const authorizeControl = Effect.fn("ResearchReport.authorizeControl")(function* (
    report: Record,
    kind: "workflow.cancel" | "workflow.inspect",
  ) {
    const current = yield* ports.currentAuthorization(report);
    const result = authorization.recheck(
      { ...current, approval: null },
      { actionId: report.actionId, kind },
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
    return report;
  });

  const inspect = Effect.fn("ResearchReport.inspect")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const report = yield* ports.persistence.inspect(workflowId);
    if (report === null || report.userId !== userId) return yield* new NotFound({ workflowId });
    return yield* authorizeControl(report, "workflow.inspect");
  });

  const accept = Effect.fn("ResearchReport.accept")(function* (report: Record) {
    if (report.state !== "admitted") {
      if (report.acceptedAt !== null) yield* ports.recordWorkflowStart(report);
      return report;
    }
    const payload = WorkflowPayload.make({
      inputDigest: report.inputDigest,
      workflowId: report.workflowId,
    });
    yield* ports.workflow.create(report.cloudflareInstanceId, payload);
    const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const accepted = yield* ports.persistence.markAccepted(
      report.workflowId,
      report.inputDigest,
      acceptedAt,
    );
    yield* ports.recordWorkflowStart(accepted);
    return accepted;
  });

  const authorizeContinuation = Effect.fn("ResearchReport.authorizeContinuation")(function* (
    report: Record,
    context: AuthorizationContext,
  ) {
    const result = authorization.recheck(
      {
        ...context,
        approval: null,
        subscription: {
          ...context.subscription,
          planPolicyVersion: report.planPolicyVersion,
        },
      },
      { actionId: report.actionId, kind: "workflow.cancel" },
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
    if (report.request.consequences.length > 0) {
      const retained = report.approval;
      if (retained === null) {
        return yield* Effect.fail({
          _tag: "Denied",
          reason: "approvalRequired",
          resetAt: null,
        } satisfies Denied);
      }
      const expected = approvalFor(
        report.userId,
        workflowOperation(report.actionId, report.request),
        retained.presentation,
      );
      if (
        retained.actionId !== expected.actionId ||
        retained.operation !== expected.operation ||
        retained.operationIdentity !== expected.operationIdentity ||
        retained.userId !== expected.userId
      ) {
        return yield* Effect.fail({
          _tag: "Denied",
          reason: "approvalRequired",
          resetAt: null,
        } satisfies Denied);
      }
    }
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
    yield* authorizeContinuation(report, context);
    return yield* accept(report);
  });

  const authorizeExecution = Effect.fn("ResearchReport.authorizeExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const report = yield* ports.persistence.inspect(payload.workflowId);
    if (report === null) return yield* new NotFound({ workflowId: payload.workflowId });
    const cloudflareInstanceId = yield* cloudflareInstanceIdFor(payload.workflowId);
    if (
      report.inputDigest !== payload.inputDigest ||
      report.cloudflareInstanceId !== cloudflareInstanceId
    ) {
      return yield* new Conflict({
        message: "Cloudflare execution does not match the admitted Research Report",
        workflowId: payload.workflowId,
      });
    }
    if (report.state === "cancel_requested") {
      const terminalAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      yield* ports.persistence.finishTerminal(
        report.workflowId,
        report.inputDigest,
        "canceled",
        "cancel-requested",
        terminalAt,
      );
      return yield* new Conflict({
        message: "The Research Report was canceled before further execution",
        workflowId: payload.workflowId,
      });
    }
    if (terminalStates.has(report.state)) {
      return yield* new Conflict({
        message: "The Research Report is no longer executable",
        workflowId: payload.workflowId,
      });
    }
    // Publication owns company-continuity finalization after this durable boundary.
    // Current User authority, cancellation, and the admission deadline no longer
    // revoke the already-useful artifact while its accounting converges.
    if (report.state === "publication_committed") return report;
    const context = yield* ports.currentAuthorization(report);
    if (context.now.getTime() >= report.deadlineAt.getTime()) {
      yield* ports.persistence.finishTerminal(
        report.workflowId,
        report.inputDigest,
        "canceled",
        "deadline-exceeded",
        context.now,
      );
      return yield* new Conflict({
        message: "The Research Report deadline ended execution",
        workflowId: payload.workflowId,
      });
    }
    yield* authorizeContinuation(report, context).pipe(
      Effect.catch((denied) =>
        ports.persistence
          .finishTerminal(
            report.workflowId,
            report.inputDigest,
            "canceled",
            "authority-ended",
            context.now,
          )
          .pipe(Effect.andThen(Effect.fail(denied))),
      ),
    );
    return report;
  });

  const beginExecution = Effect.fn("ResearchReport.beginExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const report = yield* authorizeExecution(payload);
    if (
      report.state === "running" ||
      report.state === "sources_committed" ||
      report.state === "artifact_stored" ||
      report.state === "publication_committed"
    ) {
      if (report.startedAt === null) {
        return yield* new Conflict({
          message: "Executable Research Report state is missing its durable start time",
          workflowId: report.workflowId,
        });
      }
      yield* ports.recordWorkflowStart(report);
      return report;
    }
    if (report.state !== "admitted" && report.state !== "accepted") {
      return yield* new Conflict({
        message: "The Research Report cannot begin execution from its current state",
        workflowId: report.workflowId,
      });
    }
    const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const running = yield* ports.persistence.beginExecution(
      report.workflowId,
      report.inputDigest,
      startedAt,
    );
    yield* ports.recordWorkflowStart(running);
    return running;
  });

  const commitSources = Effect.fn("ResearchReport.commitSources")(function* (
    payload: WorkflowPayload,
    sourceManifestKey: string,
    sourceManifestDigest: InputDigest,
  ) {
    const report = yield* authorizeExecution(payload);
    const committedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.markSourcesCommitted(
      report.workflowId,
      report.inputDigest,
      sourceManifestKey,
      sourceManifestDigest,
      committedAt,
    );
  });

  const artifactAuthorization = Effect.fn("ResearchReport.artifactAuthorization")(function* (
    payload: WorkflowPayload,
    requestVendorUsdMicros: bigint,
  ) {
    const report = yield* authorizeExecution(payload);
    const current = yield* ports.currentAuthorization(report);
    yield* authorizeContinuation(report, current);
    const authority = {
      _tag: "DurableTrigger" as const,
      triggerId: report.workflowId,
      triggerType: "workflow" as const,
      userId: report.userId,
    };
    return {
      authorization: {
        ...current,
        allowance:
          current.allowance._tag === "Metered"
            ? { ...current.allowance, allowancePeriodId: report.allowancePeriodId }
            : current.allowance,
        authority,
        originatingAuthority: {
          _tag: "DurableTrigger" as const,
          triggerId: report.workflowId,
          triggerType: "workflow" as const,
        },
        requestVendorUsdMicros,
        resourceOwnerUserId: report.userId,
      },
      report,
    };
  });

  const claimArtifactPublication = Effect.fn("ResearchReport.claimArtifactPublication")(function* (
    payload: WorkflowPayload,
    contentId: string,
  ) {
    const retained = yield* ports.persistence.inspect(payload.workflowId);
    if (retained === null) return yield* new NotFound({ workflowId: payload.workflowId });
    if (retained.inputDigest !== payload.inputDigest) {
      return yield* new Conflict({
        message: "Artifact publication named a changed Research Report input",
        workflowId: payload.workflowId,
      });
    }
    if (
      retained.state === "artifact_stored" ||
      retained.state === "publication_committed" ||
      retained.state === "success"
    ) {
      if (retained.artifactContentId !== contentId) {
        return yield* new Conflict({
          message: "The Research Report already published a different artifact identity",
          workflowId: payload.workflowId,
        });
      }
      return retained;
    }
    const report = yield* authorizeExecution(payload);
    const claimedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.claimArtifactPublication(
      report.workflowId,
      report.inputDigest,
      contentId,
      claimedAt,
    );
  });

  const commitArtifactPublication = Effect.fn("ResearchReport.commitArtifactPublication")(
    function* (payload: WorkflowPayload, contentId: string) {
      const retained = yield* authorizeExecution(payload);
      if (retained.state === "publication_committed" || retained.state === "success") {
        if (retained.artifactContentId !== contentId) {
          return yield* new Conflict({
            message: "The committed publication owns a different artifact identity",
            workflowId: payload.workflowId,
          });
        }
        return retained;
      }
      const committedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      return yield* ports.persistence.commitArtifactPublication(
        payload.workflowId,
        payload.inputDigest,
        contentId,
        committedAt,
      );
    },
  );

  const completeSuccess = Effect.fn("ResearchReport.completeSuccess")(function* (
    payload: WorkflowPayload,
    contentId: string,
  ) {
    const completedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.completeSuccess(
      payload.workflowId,
      payload.inputDigest,
      contentId,
      completedAt,
    );
  });

  const finishTerminal = (
    payload: WorkflowPayload,
    state: "canceled" | "failure",
    safeFailureCode: string,
  ) =>
    Effect.gen(function* () {
      const terminalAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      return yield* ports.persistence.finishTerminal(
        payload.workflowId,
        payload.inputDigest,
        state,
        safeFailureCode,
        terminalAt,
      );
    });

  const start = Effect.fn("ResearchReport.start")(function* (input: StartInput) {
    const workflowId = yield* workflowIdFor(input.authorization.user.userId, input.actionId);
    const cloudflareInstanceId = yield* cloudflareInstanceIdFor(workflowId);
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
      yield* authorizeContinuation(existing, input.authorization);
      const accepted = yield* accept(existing).pipe(
        Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
      );
      return accepted === null
        ? { _tag: "AcceptancePending" as const, report: existing }
        : { _tag: "Replayed" as const, report: accepted };
    }

    const providerAvailable = yield* ports.providerAvailable;
    if (!providerAvailable) {
      return yield* new Unavailable({
        cause: "unpriced public-web provider",
        message: "Research Report provider publication is unavailable",
        operation: "start.providerAvailability",
      });
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
    const admittedAt = input.authorization.now;
    const admittedPolicy = yield* policyForVersion(
      retainedCatalog,
      input.authorization.subscription.planPolicyVersion,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "The admitted Research Report Plan policy is unavailable",
            operation: "start.planPolicy",
          }),
      ),
    );
    const modelAccessPolicy = isLaunchPolicy(admittedPolicy)
      ? launchModelAccessPolicy
      : sharedUsageModelAccessPolicy;
    const route = yield* selectManagedRoute(
      modelAccessPolicy,
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
      modelAccessPolicyVersion: ModelAccessPolicyVersion.make(modelAccessPolicy.planPolicyVersion),
      modelRoute: route.route,
      resourcePriceVersion: currentResourcePriceVersion,
      manifestVersion: admission.manifestVersion,
      sourceManifestKey: null,
      sourceManifestDigest: null,
      artifactContentId: null,
      safeFailureCode: null,
      cloudflareInstanceId,
      admittedAt,
      deadlineAt: deadlineAfter(admittedAt),
      acceptedAt: null,
      startedAt: null,
      artifactStoredAt: null,
      publicationCommittedAt: null,
      cancelRequestedAt: null,
      terminalAt: null,
    };
    const activeWorkflowLimit = isLaunchPolicy(admittedPolicy)
      ? policyFor(admittedPolicy, input.authorization.subscription.plan).liveLimits
          .concurrentWorkflows
      : BigInt(
          currentCapabilityCatalog.planResourceLimits[input.authorization.subscription.plan]
            .activeWorkflows,
        );
    const persisted = yield* ports.persistence.admit(report, activeWorkflowLimit);
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
    const retained = yield* ports.persistence.inspect(workflowId);
    if (retained === null || retained.userId !== userId) {
      return yield* new NotFound({ workflowId });
    }
    yield* authorizeControl(retained, "workflow.cancel");
    const requestedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const requested = yield* ports.persistence.requestCancel(workflowId, userId, requestedAt);
    const settleCancellation = (report: Record) =>
      ports
        .discardPendingArtifact(report)
        .pipe(
          Effect.andThen(ports.commitTerminalFollowUp(report)),
          Effect.ensuring(
            ports.workflow.terminate(report.cloudflareInstanceId).pipe(Effect.ignore),
          ),
        );
    if (terminalStates.has(requested.state)) {
      if (requested.state === "canceled" && requested.safeFailureCode === "cancel-requested") {
        yield* settleCancellation(requested);
      }
      return { _tag: "Terminal" as const, report: requested };
    }
    if (requested.state === "publication_committed") {
      return { _tag: "PublicationCommitted" as const, report: requested };
    }
    const canceled = yield* ports.persistence.finishTerminal(
      requested.workflowId,
      requested.inputDigest,
      "canceled",
      "cancel-requested",
      requestedAt,
    );
    yield* settleCancellation(canceled);
    return { _tag: "CancelRequested" as const, report: canceled };
  });

  const resumePublication = Effect.fn("ResearchReport.resumePublication")(function* (
    payload: WorkflowPayload,
  ) {
    const report = yield* ports.persistence.inspect(payload.workflowId);
    if (report === null) return yield* new NotFound({ workflowId: payload.workflowId });
    if (report.inputDigest !== payload.inputDigest) {
      return yield* new Conflict({
        message: "Publication recovery named a changed Research Report input",
        workflowId: payload.workflowId,
      });
    }
    if (
      report.state !== "artifact_stored" &&
      report.state !== "publication_committed" &&
      report.state !== "success"
    ) {
      return yield* new Conflict({
        message: "Only a claimed publication can enter company-continuity recovery",
        workflowId: payload.workflowId,
      });
    }
    return report;
  });

  return Service.of({
    artifactAuthorization,
    authorizeExecution,
    beginExecution,
    cancel,
    claimArtifactPublication,
    commitArtifactPublication,
    commitSources,
    completeSuccess,
    inspect,
    finishCanceled: (payload, safeFailureCode) =>
      finishTerminal(payload, "canceled", safeFailureCode),
    finishFailure: (payload, safeFailureCode) =>
      finishTerminal(payload, "failure", safeFailureCode),
    reconcileAcceptance,
    resumePublication,
    start,
  });
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

/** Derive a collision-resistant host identity within Cloudflare's public instance-ID contract. */
export const cloudflareInstanceIdFor = (workflowId: WorkflowId) =>
  digest(workflowId).pipe(Effect.map((value) => CloudflareInstanceId.make(`research-${value}`)));

const deadlineAfter = (admittedAt: Date) =>
  DateTime.toDateUtc(
    DateTime.add(DateTime.makeUnsafe(admittedAt), {
      milliseconds: currentCapabilityCatalog.operationLimits.researchOperationMilliseconds,
    }),
  );

/** Exact Authorization operation for one immutable Research Report start. */
export const workflowOperation = (actionId: ActionId, request: Request) => ({
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
