import { Context, DateTime, Effect, Layer, Schema } from "effect";

import type {
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
  ThinkSubmissionId,
  UserId,
} from "../domain";
import type { ManagedModelRoute } from "../domain/model-access-policy";
import { ResearchReport } from "./research-report";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** Opaque PostgreSQL authority for one milestone or terminal Agent follow-up. */
export const NotificationId = boundedIdentity.pipe(Schema.brand("ResearchReportNotificationId"));
export type NotificationId = typeof NotificationId.Type;

export const NotificationKind = Schema.Literals(["sourcesCollected", "terminal"]);
export type NotificationKind = typeof NotificationKind.Type;

/** Committed source facts re-read by the publicly callable Agent RPC. */
export interface Notification {
  readonly notificationId: NotificationId;
  readonly workflowId: ResearchReport.WorkflowId;
  readonly inputDigest: ResearchReport.InputDigest;
  readonly userId: UserId;
  readonly agentId: AgentId;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly capabilityCatalogVersion: CapabilityCatalogVersion;
  readonly modelAccessPolicyVersion: ModelAccessPolicyVersion;
  readonly modelRoute: ManagedModelRoute;
  readonly plan: Plan;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly resourcePriceVersion: ResourcePriceVersion;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
  readonly kind: NotificationKind;
  readonly reportState: ResearchReport.State;
  readonly safeFailureCode: string | null;
  readonly artifactContentId: string | null;
  readonly claimedAt: Date;
  readonly acceptedAt: Date | null;
  readonly sourceExposedAt: Date | null;
  readonly whatsAppChannelLinkId: ChannelLinkId | null;
}

/** Durable timer facts pinned by Research Report admission. */
export interface Schedule {
  readonly admittedAt: Date;
  readonly deadlineAt: Date;
  readonly state: ResearchReport.State;
}

export type MilestoneResult =
  | { readonly _tag: "Claimed"; readonly notification: Notification }
  | { readonly _tag: "AlreadyClaimed"; readonly notification: Notification | null }
  | { readonly _tag: "AwaitingSources" }
  | { readonly _tag: "NotDue" }
  | { readonly _tag: "Terminal" }
  | { readonly _tag: "Suppressed" };

export type TerminalResult =
  | { readonly _tag: "Claimed"; readonly notification: Notification }
  | { readonly _tag: "AlreadyClaimed"; readonly notification: Notification }
  | { readonly _tag: "NotTerminal" };

export type DeadlineResult =
  | { readonly _tag: "Canceled"; readonly report: ResearchReport.Record }
  | { readonly _tag: "NotDue"; readonly report: ResearchReport.Record }
  | { readonly _tag: "PublicationPending"; readonly report: ResearchReport.Record }
  | { readonly _tag: "Terminal"; readonly report: ResearchReport.Record };

export class Conflict extends Schema.TaggedError<Conflict>()("ResearchReportFollowUpConflict", {
  message: Schema.String,
  notificationId: Schema.NullOr(NotificationId),
  workflowId: ResearchReport.WorkflowId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ResearchReportFollowUpUnavailable",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}

export interface PortInterface {
  readonly claimMilestone: (
    payload: ResearchReport.WorkflowPayload,
    now: Date,
  ) => Effect.Effect<MilestoneResult, Conflict | Unavailable>;
  readonly claimTerminal: (
    payload: ResearchReport.WorkflowPayload,
    now: Date,
  ) => Effect.Effect<TerminalResult, Conflict | Unavailable>;
  readonly enforceDeadline: (
    payload: ResearchReport.WorkflowPayload,
    now: Date,
  ) => Effect.Effect<DeadlineResult, Conflict | Unavailable>;
  readonly inspect: (
    notificationId: NotificationId,
  ) => Effect.Effect<Notification | null, Unavailable>;
  readonly inspectSchedule: (
    payload: ResearchReport.WorkflowPayload,
  ) => Effect.Effect<Schedule, Conflict | Unavailable>;
  readonly markAccepted: (
    notificationId: NotificationId,
    submissionId: ThinkSubmissionId,
    acceptedAt: Date,
  ) => Effect.Effect<Notification, Conflict | Unavailable>;
  readonly exposeSources: (
    userId: UserId,
    notificationIds: ReadonlyArray<NotificationId>,
    exposedAt: Date,
  ) => Effect.Effect<void, Unavailable>;
  readonly pendingSources: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<Notification>, Unavailable>;
}

export class Port extends Context.Service<Port, PortInterface>()(
  "@osfo/ResearchReportFollowUp/Port",
) {}

export interface Interface {
  readonly claimMilestone: (
    payload: ResearchReport.WorkflowPayload,
  ) => Effect.Effect<MilestoneResult, Conflict | Unavailable>;
  readonly claimTerminal: (
    payload: ResearchReport.WorkflowPayload,
  ) => Effect.Effect<TerminalResult, Conflict | Unavailable>;
  readonly enforceDeadline: (
    payload: ResearchReport.WorkflowPayload,
  ) => Effect.Effect<DeadlineResult, Conflict | Unavailable>;
  readonly inspect: PortInterface["inspect"];
  readonly inspectSchedule: PortInterface["inspectSchedule"];
  readonly markAccepted: (
    notificationId: NotificationId,
    submissionId: ThinkSubmissionId,
  ) => Effect.Effect<Notification, Conflict | Unavailable>;
  readonly exposeSources: (
    userId: UserId,
    notificationIds: ReadonlyArray<NotificationId>,
  ) => Effect.Effect<void, Unavailable>;
  readonly pendingSources: PortInterface["pendingSources"];
}

export class Service extends Context.Service<Service, Interface>()(
  "@osfo/ResearchReportFollowUp",
) {}

export const make = Effect.gen(function* () {
  const port = yield* Port;
  const now = DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
  return Service.of({
    claimMilestone: (payload) =>
      now.pipe(Effect.flatMap((time) => port.claimMilestone(payload, time))),
    claimTerminal: (payload) =>
      now.pipe(Effect.flatMap((time) => port.claimTerminal(payload, time))),
    enforceDeadline: (payload) =>
      now.pipe(Effect.flatMap((time) => port.enforceDeadline(payload, time))),
    exposeSources: (userId, notificationIds) =>
      now.pipe(Effect.flatMap((time) => port.exposeSources(userId, notificationIds, time))),
    inspect: port.inspect,
    inspectSchedule: port.inspectSchedule,
    markAccepted: (notificationId, submissionId) =>
      now.pipe(Effect.flatMap((time) => port.markAccepted(notificationId, submissionId, time))),
    pendingSources: port.pendingSources,
  });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

export const notificationIdFor = (workflowId: ResearchReport.WorkflowId, kind: NotificationKind) =>
  NotificationId.make(`${workflowId}-${kind === "sourcesCollected" ? "sources" : "terminal"}`);

export * as ResearchReportFollowUp from "./research-report-follow-up";
