import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";

import {
  AgentId,
  type AllowancePeriodId,
  type CapabilityCatalogVersion,
  type ConversationRouteId,
  ManifestVersion,
  ModelAccessPolicyVersion,
  type Plan,
  type PlanPolicyVersion,
  type ResourcePriceVersion,
  type SessionId,
  type UserId,
} from "../domain";
import type { ActionId } from "../domain/action-execution";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import { GmailMessageInput } from "../domain/integration-manifest";
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
  type OriginatingAuthority,
  type ApprovalPresentation,
  Authorization,
  approvalFor,
} from "./authorization";
import type { IntegrationEffectCompleted } from "./integrations";

/* oxlint-disable eslint/no-underscore-dangle -- Workflow and provider outcomes use Effect's standard discriminator. */

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const WorkflowId = boundedIdentity.pipe(Schema.brand("ScheduledEmailWorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;

export const InputDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("ScheduledEmailInputDigest"),
);
export type InputDigest = typeof InputDigest.Type;

export const CloudflareInstanceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u),
).pipe(Schema.brand("ScheduledEmailCloudflareInstanceId"));
export type CloudflareInstanceId = typeof CloudflareInstanceId.Type;

/** One exact future Gmail effect. V1 sends only from the connected primary mailbox. */
export const Request = Schema.Struct({
  ...GmailMessageInput.fields,
  gmailResource: Schema.Literal("primary"),
  scheduledAt: Schema.Date,
});
export type Request = typeof Request.Type;

export const WorkflowPayload = Schema.Struct({
  agentId: AgentId,
  dueAt: Schema.Date,
  inputDigest: InputDigest,
  workflowId: WorkflowId,
});
export type WorkflowPayload = typeof WorkflowPayload.Type;

export const ReconciliationCandidate = Schema.Struct({
  ...WorkflowPayload.fields,
  kind: Schema.Literals(["claimed", "due"]),
});
export type ReconciliationCandidate = typeof ReconciliationCandidate.Type;

export const State = Schema.Literals([
  "admitted",
  "accepted",
  "waiting",
  "sending",
  "send_pending_reconciliation",
  "success",
  "failure",
  "canceled",
]);
export type State = typeof State.Type;

export const terminalStates = new Set<State>(["success", "failure", "canceled"]);

export interface Record {
  readonly workflowId: WorkflowId;
  readonly actionId: ActionId;
  readonly userId: UserId;
  readonly agentId: AgentId;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
  readonly originatingAuthority: typeof OriginatingAuthority.Type;
  readonly approvalPresentation: ApprovalPresentation;
  readonly inputDigest: InputDigest;
  readonly request: Request;
  readonly dueAt: Date;
  readonly state: State;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly plan: Plan;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly capabilityCatalogVersion: CapabilityCatalogVersion;
  readonly modelAccessPolicyVersion: ModelAccessPolicyVersion;
  readonly modelRoute: ManagedModelRoute;
  readonly resourcePriceVersion: ResourcePriceVersion;
  readonly manifestVersion: ManifestVersion;
  readonly cloudflareInstanceId: CloudflareInstanceId;
  readonly providerLogId: string | null;
  readonly providerResourceId: string | null;
  readonly sendOutcome: "applied" | "ambiguous" | "notApplied" | null;
  readonly safeFailureCode: string | null;
  readonly admittedAt: Date;
  readonly acceptedAt: Date | null;
  readonly waitingAt: Date | null;
  readonly sendStartedAt: Date | null;
  readonly sendOutcomeAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly terminalAt: Date | null;
}

/** Observable SLO intervals; unresolved phases remain null instead of implying completion. */
export const sloEvidence = (email: Record, followUpAcceptedAt: Date | null) => ({
  dueToSendClaimMilliseconds:
    email.sendStartedAt === null ? null : email.sendStartedAt.getTime() - email.dueAt.getTime(),
  sendClaimToTerminalMilliseconds:
    email.sendStartedAt === null || email.terminalAt === null
      ? null
      : email.terminalAt.getTime() - email.sendStartedAt.getTime(),
  terminalToFollowUpAcceptedMilliseconds:
    email.terminalAt === null || followUpAcceptedAt === null
      ? null
      : followUpAcceptedAt.getTime() - email.terminalAt.getTime(),
});

export interface StartInput {
  readonly actionId: ActionId;
  readonly agentId: AgentId;
  readonly authorization: AuthorizationContext;
  readonly request: Request;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
}

export type StartResult =
  | { readonly _tag: "Started"; readonly email: Record }
  | { readonly _tag: "Replayed"; readonly email: Record }
  | { readonly _tag: "AcceptancePending"; readonly email: Record };

export type CancelResult =
  | { readonly _tag: "CancelRequested"; readonly email: Record }
  | { readonly _tag: "ReconciliationRequired"; readonly email: Record }
  | { readonly _tag: "Terminal"; readonly email: Record };

export type SendReconciliation =
  | { readonly _tag: "Applied"; readonly result: IntegrationEffectCompleted }
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "NotApplied"; readonly providerLogId: string | null }
  | { readonly _tag: "Pending" };

export class Conflict extends Schema.TaggedError<Conflict>()("ScheduledEmailConflict", {
  message: Schema.String,
  workflowId: WorkflowId,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("ScheduledEmailNotFound", {
  workflowId: WorkflowId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("ScheduledEmailUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
}) {}

export class SendAuthorityEnded extends Schema.TaggedError<SendAuthorityEnded>()(
  "ScheduledEmailSendAuthorityEnded",
  { message: Schema.String },
) {}

export class SendAmbiguous extends Schema.TaggedError<SendAmbiguous>()(
  "ScheduledEmailSendAmbiguous",
  { message: Schema.String },
) {}

export class SendNotApplied extends Schema.TaggedError<SendNotApplied>()(
  "ScheduledEmailSendNotApplied",
  { message: Schema.String, providerLogId: Schema.NullOr(Schema.String) },
) {}

type Persisted =
  | { readonly _tag: "Created"; readonly email: Record }
  | { readonly _tag: "Existing"; readonly email: Record };

export interface PortInterface {
  readonly currentAuthorization: (
    email: Record,
  ) => Effect.Effect<AuthorizationContext, Unavailable>;
  readonly send: (
    email: Record,
    authorization: Effect.Effect<void, SendAuthorityEnded | Unavailable>,
  ) => Effect.Effect<
    IntegrationEffectCompleted,
    SendAmbiguous | SendAuthorityEnded | SendNotApplied | Unavailable
  >;
  readonly recordWorkflowStart: (email: Record) => Effect.Effect<void, Unavailable>;
  readonly recordSendOutcome: (email: Record) => Effect.Effect<void, Unavailable>;
  readonly commitTerminalFollowUp: (email: Record) => Effect.Effect<void, Unavailable>;
  readonly reconcileSend: (email: Record) => Effect.Effect<SendReconciliation, Unavailable>;
  readonly persistence: {
    readonly admit: (
      record: Record,
      activeWorkflowLimit: bigint,
    ) => Effect.Effect<Persisted, Conflict | Denied | Unavailable>;
    readonly inspect: (workflowId: WorkflowId) => Effect.Effect<Record | null, Unavailable>;
    readonly markAccepted: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      acceptedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly markWaiting: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      waitingAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly beginSend: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      startedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly finishApplied: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      result: IntegrationEffectCompleted,
      outcomeAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly markAmbiguous: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      outcomeAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly finishTerminal: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      state: "canceled" | "failure",
      sendOutcome: "ambiguous" | "notApplied" | null,
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

export class Port extends Context.Service<Port, PortInterface>()("@osfo/ScheduledEmail/Port") {}

export interface Interface {
  readonly beginWaiting: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly cancel: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<CancelResult, Conflict | Denied | NotFound | Unavailable>;
  readonly inspect: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<Record, Denied | NotFound | Unavailable>;
  readonly inspectExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly reconcileAcceptance: (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly recoverClaimed: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly sendDue: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly settleTerminal: (email: Record) => Effect.Effect<Record, Conflict | Unavailable>;
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<StartResult, Conflict | Denied | NotFound | Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/ScheduledEmail") {}

export const make = Effect.gen(function* () {
  const ports = yield* Port;
  const authorization = Authorization.make(retainedCatalog);

  const settleTerminal = Effect.fn("ScheduledEmail.settleTerminal")(function* (email: Record) {
    if (!terminalStates.has(email.state)) {
      return yield* new Conflict({
        message: "Only terminal Scheduled Email truth can be settled",
        workflowId: email.workflowId,
      });
    }
    yield* ports.recordSendOutcome(email);
    yield* ports.commitTerminalFollowUp(email);
    return email;
  });

  const inspectExecution = Effect.fn("ScheduledEmail.inspectExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const email = yield* ports.persistence.inspect(payload.workflowId);
    if (email === null) return yield* new NotFound({ workflowId: payload.workflowId });
    const instanceId = yield* cloudflareInstanceIdFor(payload.workflowId);
    if (
      email.inputDigest !== payload.inputDigest ||
      email.agentId !== payload.agentId ||
      email.dueAt.getTime() !== payload.dueAt.getTime() ||
      email.cloudflareInstanceId !== instanceId
    ) {
      return yield* new Conflict({
        message: "Cloudflare execution does not match the admitted Scheduled Email",
        workflowId: payload.workflowId,
      });
    }
    return email;
  });

  const authorizeControl = Effect.fn("ScheduledEmail.authorizeControl")(function* (
    email: Record,
    kind: "workflow.cancel" | "workflow.inspect",
  ) {
    const current = yield* ports.currentAuthorization(email);
    const result = authorization.recheck(
      { ...current, approval: null },
      { actionId: email.actionId, kind },
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
    return email;
  });

  const inspect = Effect.fn("ScheduledEmail.inspect")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const email = yield* ports.persistence.inspect(workflowId);
    if (email === null || email.userId !== userId) return yield* new NotFound({ workflowId });
    return yield* authorizeControl(email, "workflow.inspect");
  });

  const authorizeContinuation = Effect.fn("ScheduledEmail.authorizeContinuation")(function* (
    email: Record,
    current: AuthorizationContext,
  ) {
    const operation = workflowOperation(email.actionId);
    const result = authorization.recheck(
      {
        ...current,
        approval: null,
        subscription: { ...current.subscription, planPolicyVersion: email.planPolicyVersion },
      },
      operation,
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
    return undefined;
  });

  const authorizeProtectedSend = Effect.fn("ScheduledEmail.authorizeProtectedSend")(function* (
    email: Record,
  ) {
    const current = yield* ports.currentAuthorization(email);
    const operation = integrationOperation(email.actionId);
    const result = authorization.recheck(
      {
        ...current,
        approval: approvalFor(email.userId, operation, email.approvalPresentation),
        subscription: { ...current.subscription, planPolicyVersion: email.planPolicyVersion },
      },
      operation,
    );
    if (Predicate.isTagged(result, "Denied")) {
      return yield* new SendAuthorityEnded({
        message: `Current Gmail send authority ended: ${result.reason}`,
      });
    }
    return undefined;
  });

  const accept = Effect.fn("ScheduledEmail.accept")(function* (email: Record) {
    if (email.state !== "admitted") {
      if (email.acceptedAt !== null) yield* ports.recordWorkflowStart(email);
      return email;
    }
    const payload = payloadFor(email);
    yield* ports.workflow.create(email.cloudflareInstanceId, payload);
    const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const accepted = yield* ports.persistence.markAccepted(
      email.workflowId,
      email.inputDigest,
      acceptedAt,
    );
    yield* ports.recordWorkflowStart(accepted);
    return accepted;
  });

  const reconcileAcceptance = Effect.fn("ScheduledEmail.reconcileAcceptance")(function* (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) {
    const email = yield* ports.persistence.inspect(workflowId);
    if (email === null) return yield* new NotFound({ workflowId });
    if (email.inputDigest !== inputDigest) {
      return yield* new Conflict({
        message: "The Workflow identity names changed Scheduled Email input",
        workflowId,
      });
    }
    const current = yield* ports.currentAuthorization(email);
    yield* authorizeContinuation(email, current);
    return yield* accept(email);
  });

  const beginWaiting = Effect.fn("ScheduledEmail.beginWaiting")(function* (
    payload: WorkflowPayload,
  ) {
    const retained = yield* inspectExecution(payload);
    const email =
      retained.state === "admitted"
        ? yield* reconcileAcceptance(retained.workflowId, retained.inputDigest)
        : retained;
    if (
      [
        "waiting",
        "sending",
        "send_pending_reconciliation",
        "success",
        "failure",
        "canceled",
      ].includes(email.state)
    ) {
      return email;
    }
    if (email.state !== "accepted") {
      return yield* new Conflict({
        message: "The Scheduled Email cannot begin waiting from its current state",
        workflowId: email.workflowId,
      });
    }
    const waitingAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.markWaiting(email.workflowId, email.inputDigest, waitingAt);
  });

  const finishCanceled = (email: Record, safeFailureCode: string, terminalAt: Date) =>
    ports.persistence
      .finishTerminal(
        email.workflowId,
        email.inputDigest,
        "canceled",
        null,
        safeFailureCode,
        terminalAt,
      )
      .pipe(Effect.flatMap(settleTerminal));

  const finishAfterClaim = (
    email: Record,
    sendOutcome: "notApplied" | null,
    safeFailureCode: string,
    terminalAt: Date,
  ) =>
    ports.persistence
      .finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        sendOutcome,
        safeFailureCode,
        terminalAt,
      )
      .pipe(Effect.flatMap(settleTerminal));

  const executeClaimedSend = Effect.fn("ScheduledEmail.executeClaimedSend")(function* (
    email: Record,
  ) {
    const outcome = yield* ports.send(email, authorizeProtectedSend(email)).pipe(
      Effect.map((result) => ({ _tag: "Applied" as const, result })),
      Effect.catchTags({
        ScheduledEmailSendAmbiguous: (failure) =>
          Effect.succeed({ _tag: "Ambiguous" as const, failure }),
        ScheduledEmailSendAuthorityEnded: (failure) =>
          Effect.succeed({ _tag: "AuthorityEnded" as const, failure }),
        ScheduledEmailSendNotApplied: (failure) =>
          Effect.succeed({ _tag: "NotApplied" as const, failure }),
      }),
    );
    const outcomeAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    if (outcome._tag === "Applied") {
      const completed = yield* ports.persistence.finishApplied(
        email.workflowId,
        email.inputDigest,
        outcome.result,
        outcomeAt,
      );
      return yield* settleTerminal(completed);
    }
    if (outcome._tag === "AuthorityEnded") {
      return yield* finishCanceled(email, "authority-ended", outcomeAt);
    }
    if (outcome._tag === "NotApplied") {
      return yield* finishAfterClaim(email, "notApplied", "send-not-applied", outcomeAt);
    }
    const pending = yield* ports.persistence.markAmbiguous(
      email.workflowId,
      email.inputDigest,
      outcomeAt,
    );
    yield* ports.recordSendOutcome(pending);
    return pending;
  });

  const reconcileClaimedSend = Effect.fn("ScheduledEmail.reconcileClaimedSend")(function* (
    email: Record,
  ) {
    const reconciliation = yield* ports.reconcileSend(email);
    if (reconciliation._tag === "NotStarted") return yield* executeClaimedSend(email);
    if (reconciliation._tag === "Pending") return email;
    const outcomeAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    if (reconciliation._tag === "Applied") {
      const completed = yield* ports.persistence.finishApplied(
        email.workflowId,
        email.inputDigest,
        reconciliation.result,
        outcomeAt,
      );
      return yield* settleTerminal(completed);
    }
    return yield* finishAfterClaim(email, "notApplied", "send-not-applied", outcomeAt);
  });

  const sendDue = Effect.fn("ScheduledEmail.sendDue")(function* (payload: WorkflowPayload) {
    const email = yield* inspectExecution(payload);
    if (terminalStates.has(email.state)) return yield* settleTerminal(email);
    if (email.state === "sending" || email.state === "send_pending_reconciliation") {
      return yield* reconcileClaimedSend(email);
    }
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    if (email.cancelRequestedAt !== null)
      return yield* finishCanceled(email, "cancel-requested", now);
    if (email.state !== "waiting") {
      return yield* new Conflict({
        message: "The Scheduled Email is not ready to send",
        workflowId: email.workflowId,
      });
    }
    if (now.getTime() < email.dueAt.getTime()) {
      return yield* new Conflict({
        message: "The Scheduled Email send was invoked before its exact schedule",
        workflowId: email.workflowId,
      });
    }
    const begun = yield* ports.persistence.beginSend(email.workflowId, email.inputDigest, now);
    return yield* executeClaimedSend(begun);
  });

  const recoverClaimed = Effect.fn("ScheduledEmail.recoverClaimed")(function* (
    payload: WorkflowPayload,
  ) {
    const email = yield* inspectExecution(payload);
    if (terminalStates.has(email.state)) return yield* settleTerminal(email);
    if (email.state !== "sending" && email.state !== "send_pending_reconciliation") {
      return yield* new Conflict({
        message: "Only an already-claimed Scheduled Email can use deletion-safe recovery",
        workflowId: email.workflowId,
      });
    }
    return yield* reconcileClaimedSend(email);
  });

  const start = Effect.fn("ScheduledEmail.start")(function* (input: StartInput) {
    const userId = input.authorization.user.userId;
    const workflowId = yield* workflowIdFor(userId, input.actionId);
    const inputDigest = yield* digestRequest(userId, input.request);
    const existing = yield* ports.persistence.inspect(workflowId);
    if (existing !== null) {
      if (existing.userId !== userId || existing.inputDigest !== inputDigest) {
        return yield* new Conflict({
          message:
            "The Workflow identity was replayed with changed User, content, schedule, or Gmail resource",
          workflowId,
        });
      }
      const current = yield* ports.currentAuthorization(existing);
      yield* authorizeContinuation(existing, current);
      const accepted = yield* accept(existing).pipe(
        Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
      );
      return accepted === null
        ? { _tag: "AcceptancePending" as const, email: existing }
        : { _tag: "Replayed" as const, email: accepted };
    }
    if (input.request.scheduledAt.getTime() <= input.authorization.now.getTime()) {
      return yield* new Conflict({
        message: "A Scheduled Email requires a future absolute send instant",
        workflowId,
      });
    }
    const workflowAdmission = authorization.admit(
      input.authorization,
      workflowOperation(input.actionId),
    );
    if (!Predicate.isTagged(workflowAdmission, "Admitted")) {
      return yield* Effect.fail(
        Predicate.isTagged(workflowAdmission, "Denied")
          ? workflowAdmission
          : ({ _tag: "Denied", reason: "approvalRequired", resetAt: null } satisfies Denied),
      );
    }
    if (!Predicate.isTagged(workflowAdmission.allowancePeriod, "Metered")) {
      return yield* Effect.fail({
        _tag: "Denied",
        reason: "allowancePeriodUnavailable",
        resetAt: null,
      } satisfies Denied);
    }
    if (input.authorization.approval === null) {
      return yield* Effect.fail({
        _tag: "Denied",
        reason: "approvalRequired",
        resetAt: null,
      } satisfies Denied);
    }
    const sendAdmission = authorization.admit(
      input.authorization,
      integrationOperation(input.actionId),
    );
    if (!Predicate.isTagged(sendAdmission, "Admitted")) {
      return yield* Effect.fail(
        Predicate.isTagged(sendAdmission, "Denied")
          ? sendAdmission
          : ({ _tag: "Denied", reason: "approvalRequired", resetAt: null } satisfies Denied),
      );
    }
    const admittedPolicy = yield* policyForVersion(
      retainedCatalog,
      input.authorization.subscription.planPolicyVersion,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "The admitted Scheduled Email Plan policy is unavailable",
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
            message: "The admitted Plan has no retained Scheduled Email follow-up route",
            operation: "start.selectRoute",
          }),
      ),
    );
    const cloudflareInstanceId = yield* cloudflareInstanceIdFor(workflowId);
    const email: Record = {
      workflowId,
      actionId: input.actionId,
      userId,
      agentId: input.agentId,
      routeId: input.routeId,
      sessionId: input.sessionId,
      originatingAuthority: input.authorization.originatingAuthority,
      approvalPresentation: input.authorization.approval.presentation,
      inputDigest,
      request: input.request,
      dueAt: input.request.scheduledAt,
      state: "admitted",
      allowancePeriodId: workflowAdmission.allowancePeriod.allowancePeriodId,
      plan: input.authorization.subscription.plan,
      planPolicyVersion: input.authorization.subscription.planPolicyVersion,
      capabilityCatalogVersion: workflowAdmission.capabilityCatalogVersion,
      modelAccessPolicyVersion: ModelAccessPolicyVersion.make(modelAccessPolicy.planPolicyVersion),
      modelRoute: route.route,
      resourcePriceVersion: currentResourcePriceVersion,
      manifestVersion: ManifestVersion.make("gmail-v1"),
      cloudflareInstanceId,
      providerLogId: null,
      providerResourceId: null,
      sendOutcome: null,
      safeFailureCode: null,
      admittedAt: input.authorization.now,
      acceptedAt: null,
      waitingAt: null,
      sendStartedAt: null,
      sendOutcomeAt: null,
      cancelRequestedAt: null,
      terminalAt: null,
    };
    const limits =
      currentCapabilityCatalog.planResourceLimits[input.authorization.subscription.plan];
    const activeWorkflowLimit = isLaunchPolicy(admittedPolicy)
      ? policyFor(admittedPolicy, input.authorization.subscription.plan).liveLimits
          .concurrentWorkflows
      : BigInt(limits.activeWorkflows);
    const persisted = yield* ports.persistence.admit(email, activeWorkflowLimit);
    if (
      persisted.email.userId !== email.userId ||
      persisted.email.inputDigest !== email.inputDigest
    ) {
      return yield* new Conflict({
        message: "Concurrent admission retained different immutable Scheduled Email facts",
        workflowId,
      });
    }
    const accepted = yield* accept(persisted.email).pipe(
      Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
    );
    if (accepted === null) return { _tag: "AcceptancePending" as const, email: persisted.email };
    return {
      _tag: persisted._tag === "Created" ? ("Started" as const) : ("Replayed" as const),
      email: accepted,
    };
  });

  const cancel = Effect.fn("ScheduledEmail.cancel")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const email = yield* ports.persistence.inspect(workflowId);
    if (email === null || email.userId !== userId) return yield* new NotFound({ workflowId });
    yield* authorizeControl(email, "workflow.cancel");
    const requestedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const requested = yield* ports.persistence.requestCancel(workflowId, userId, requestedAt);
    if (terminalStates.has(requested.state)) {
      yield* settleTerminal(requested);
      return { _tag: "Terminal" as const, email: requested };
    }
    if (requested.state === "sending" || requested.state === "send_pending_reconciliation") {
      return { _tag: "ReconciliationRequired" as const, email: requested };
    }
    const canceled = yield* finishCanceled(requested, "cancel-requested", requestedAt);
    yield* ports.workflow.terminate(email.cloudflareInstanceId).pipe(Effect.ignore);
    return { _tag: "CancelRequested" as const, email: canceled };
  });

  return Service.of({
    beginWaiting,
    cancel,
    inspect,
    inspectExecution,
    reconcileAcceptance,
    recoverClaimed,
    sendDue,
    settleTerminal,
    start,
  });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

export const workflowIdFor = (userId: UserId, actionId: ActionId) =>
  digest(`${userId}\0${actionId}`).pipe(
    Effect.map((value) => WorkflowId.make(`scheduled-email:${value}`)),
  );

export const digestRequest = (userId: UserId, request: Request) =>
  Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ request: Request, userId: Schema.String })),
  )({ request, userId }).pipe(Effect.orDie, Effect.flatMap(digest));

export const cloudflareInstanceIdFor = (workflowId: WorkflowId) =>
  digest(workflowId).pipe(
    Effect.map((value) => CloudflareInstanceId.make(`scheduled-email-${value}`)),
  );

export const workflowOperation = (actionId: ActionId) => ({
  actionId,
  change: "start" as const,
  consequences: [],
  kind: "workflow.manage" as const,
});

export const integrationOperation = (actionId: ActionId) => ({
  actionId,
  kind: "integration.effect" as const,
  manifestVersion: ManifestVersion.make("gmail-v1"),
  providerOperation: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
});

const payloadFor = (email: Record) =>
  WorkflowPayload.make({
    agentId: email.agentId,
    dueAt: email.dueAt,
    inputDigest: email.inputDigest,
    workflowId: email.workflowId,
  });

const isWorkflowAcknowledgementFailure = (failure: Conflict | Denied | NotFound | Unavailable) =>
  Schema.is(Unavailable)(failure) &&
  (failure.operation === "workflow.create" || failure.operation === "workflow.reconcileCreate");

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

export * as ScheduledEmail from "./scheduled-email";
