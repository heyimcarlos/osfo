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
import { DocumentBuild } from "./document-build";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const NotificationId = boundedIdentity.pipe(Schema.brand("DocumentBuildNotificationId"));
export type NotificationId = typeof NotificationId.Type;

export const NotificationKind = Schema.Literals(["previewReady", "terminal"]);
export type NotificationKind = typeof NotificationKind.Type;

/** Safe product facts re-read by the publicly callable Agent RPC. */
export interface Notification {
  readonly notificationId: NotificationId;
  readonly workflowId: DocumentBuild.WorkflowId;
  readonly inputDigest: DocumentBuild.InputDigest;
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
  readonly buildState: DocumentBuild.State;
  readonly safeFailureCode: string | null;
  readonly artifactContentId: string | null;
  readonly claimedAt: Date;
  readonly acceptedAt: Date | null;
  readonly format: "pdf" | "docx";
  readonly whatsAppChannelLinkId: ChannelLinkId | null;
}

export interface Schedule {
  readonly admittedAt: Date;
  readonly deadlineAt: Date;
  readonly state: DocumentBuild.State;
}

export type PreviewResult =
  | { readonly _tag: "Claimed"; readonly notification: Notification }
  | { readonly _tag: "AlreadyClaimed"; readonly notification: Notification | null }
  | { readonly _tag: "AwaitingPreview" }
  | { readonly _tag: "NotDue" }
  | { readonly _tag: "Terminal" }
  | { readonly _tag: "Suppressed" };

export type TerminalResult =
  | { readonly _tag: "Claimed"; readonly notification: Notification }
  | { readonly _tag: "AlreadyClaimed"; readonly notification: Notification }
  | { readonly _tag: "NotTerminal" }
  | { readonly _tag: "Suppressed" };

export type DeadlineResult =
  | { readonly _tag: "Canceled"; readonly build: DocumentBuild.Record }
  | { readonly _tag: "NotDue"; readonly build: DocumentBuild.Record }
  | { readonly _tag: "Terminal"; readonly build: DocumentBuild.Record };

export class Conflict extends Schema.TaggedError<Conflict>()("DocumentBuildFollowUpConflict", {
  message: Schema.String,
  notificationId: Schema.NullOr(NotificationId),
  workflowId: DocumentBuild.WorkflowId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "DocumentBuildFollowUpUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

export interface PortInterface {
  readonly deliveredForUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<Notification>, Unavailable>;
  readonly claimPreview: (
    payload: DocumentBuild.WorkflowPayload,
    now: Date,
  ) => Effect.Effect<PreviewResult, Conflict | Unavailable>;
  readonly claimTerminal: (
    payload: DocumentBuild.WorkflowPayload,
    now: Date,
  ) => Effect.Effect<TerminalResult, Conflict | Unavailable>;
  readonly enforceDeadline: (
    payload: DocumentBuild.WorkflowPayload,
    now: Date,
  ) => Effect.Effect<DeadlineResult, Conflict | Unavailable>;
  readonly inspect: (
    notificationId: NotificationId,
  ) => Effect.Effect<Notification | null, Unavailable>;
  readonly inspectSchedule: (
    payload: DocumentBuild.WorkflowPayload,
  ) => Effect.Effect<Schedule, Conflict | Unavailable>;
  readonly markAccepted: (
    notificationId: NotificationId,
    submissionId: ThinkSubmissionId,
    acceptedAt: Date,
  ) => Effect.Effect<Notification, Conflict | Unavailable>;
}

export class Port extends Context.Service<Port, PortInterface>()(
  "@osfo/DocumentBuildFollowUp/Port",
) {}

export interface Interface {
  readonly deliveredForUser: PortInterface["deliveredForUser"];
  readonly claimPreview: (
    payload: DocumentBuild.WorkflowPayload,
  ) => Effect.Effect<PreviewResult, Conflict | Unavailable>;
  readonly claimTerminal: (
    payload: DocumentBuild.WorkflowPayload,
  ) => Effect.Effect<TerminalResult, Conflict | Unavailable>;
  readonly enforceDeadline: (
    payload: DocumentBuild.WorkflowPayload,
  ) => Effect.Effect<DeadlineResult, Conflict | Unavailable>;
  readonly inspect: PortInterface["inspect"];
  readonly inspectSchedule: PortInterface["inspectSchedule"];
  readonly markAccepted: (
    notificationId: NotificationId,
    submissionId: ThinkSubmissionId,
  ) => Effect.Effect<Notification, Conflict | Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/DocumentBuildFollowUp") {}

export const make = Effect.gen(function* () {
  const port = yield* Port;
  const now = DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
  return Service.of({
    claimPreview: (payload) => now.pipe(Effect.flatMap((time) => port.claimPreview(payload, time))),
    claimTerminal: (payload) =>
      now.pipe(Effect.flatMap((time) => port.claimTerminal(payload, time))),
    deliveredForUser: port.deliveredForUser,
    enforceDeadline: (payload) =>
      now.pipe(Effect.flatMap((time) => port.enforceDeadline(payload, time))),
    inspect: port.inspect,
    inspectSchedule: port.inspectSchedule,
    markAccepted: (notificationId, submissionId) =>
      now.pipe(Effect.flatMap((time) => port.markAccepted(notificationId, submissionId, time))),
  });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

export const notificationIdFor = (workflowId: DocumentBuild.WorkflowId, kind: NotificationKind) =>
  NotificationId.make(`${workflowId}-${kind === "previewReady" ? "preview" : "terminal"}`);

export * as DocumentBuildFollowUp from "./document-build-follow-up";
