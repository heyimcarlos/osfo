import { Context, DateTime, Effect, Layer, Schema } from "effect";

import {
  AgentId,
  ConversationRouteId,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  UserId,
} from "../domain";
import { ManagedModelRoute } from "../domain/model-access-policy";
import type { ScheduledEmail } from "./scheduled-email";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const NotificationId = identity.pipe(Schema.brand("ScheduledEmailNotificationId"));
export type NotificationId = typeof NotificationId.Type;
export const SubmissionId = identity.pipe(Schema.brand("ScheduledEmailSubmissionId"));
export type SubmissionId = typeof SubmissionId.Type;

export const Notification = Schema.Struct({
  acceptedAt: Schema.NullOr(Schema.Date),
  agentId: AgentId,
  claimedAt: Schema.Date,
  deliverySessionId: Schema.NullOr(SessionId),
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  modelRoute: ManagedModelRoute,
  notificationId: NotificationId,
  originSessionId: SessionId,
  planPolicyVersion: PlanPolicyVersion,
  resourcePriceVersion: ResourcePriceVersion,
  routeId: ConversationRouteId,
  state: Schema.Literals(["success", "failure", "canceled"]),
  submissionId: Schema.NullOr(SubmissionId),
  userId: UserId,
  workflowId: Schema.String,
});
export type Notification = typeof Notification.Type;

export type Claim =
  | { readonly _tag: "Claimed"; readonly notification: Notification }
  | { readonly _tag: "NotTerminal" }
  | { readonly _tag: "Suppressed" };

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "ScheduledEmailFollowUpUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export interface PortInterface {
  readonly claimTerminal: (
    email: ScheduledEmail.Record,
    notificationId: NotificationId,
    claimedAt: Date,
  ) => Effect.Effect<Claim, Unavailable>;
  readonly inspect: (
    notificationId: NotificationId,
  ) => Effect.Effect<Notification | null, Unavailable>;
  readonly markAccepted: (
    notificationId: NotificationId,
    submissionId: SubmissionId,
    acceptedAt: Date,
  ) => Effect.Effect<Notification, Unavailable>;
  readonly selectDeliverySession: (
    notificationId: NotificationId,
    sessionId: SessionId,
  ) => Effect.Effect<Notification, Unavailable>;
}

export class Port extends Context.Service<Port, PortInterface>()(
  "@osfo/ScheduledEmailFollowUp/Port",
) {}

export class Service extends Context.Service<
  Service,
  {
    readonly claimTerminal: (email: ScheduledEmail.Record) => Effect.Effect<Claim, Unavailable>;
    readonly inspect: PortInterface["inspect"];
    readonly markAccepted: (
      notificationId: NotificationId,
      submissionId: SubmissionId,
    ) => Effect.Effect<Notification, Unavailable>;
    readonly selectDeliverySession: PortInterface["selectDeliverySession"];
  }
>()("@osfo/ScheduledEmailFollowUp") {}

export const make = Effect.gen(function* () {
  const port = yield* Port;
  return Service.of({
    claimTerminal: (email) =>
      DateTime.now.pipe(
        Effect.map(DateTime.toDateUtc),
        Effect.flatMap((claimedAt) =>
          port.claimTerminal(email, NotificationId.make(`${email.workflowId}-terminal`), claimedAt),
        ),
      ),
    inspect: port.inspect,
    markAccepted: (notificationId, submissionId) =>
      DateTime.now.pipe(
        Effect.map(DateTime.toDateUtc),
        Effect.flatMap((acceptedAt) => port.markAccepted(notificationId, submissionId, acceptedAt)),
      ),
    selectDeliverySession: port.selectDeliverySession,
  });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

export const submissionIdFor = (notificationId: NotificationId) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(notificationId)),
  ).pipe(
    Effect.map((bytes) =>
      SubmissionId.make(
        `scheduled-email-${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ),
    ),
  );

export const deliverySessionFor = (
  notification: Notification,
  agentId: AgentId,
  route: { readonly currentSessionId: SessionId; readonly routeId: ConversationRouteId },
) => {
  if (notification.agentId !== agentId || notification.routeId !== route.routeId) return null;
  if (notification.acceptedAt !== null) return notification.deliverySessionId;
  return route.currentSessionId;
};

export const message = (notification: Notification) =>
  notification.state === "success"
    ? "The scheduled email was sent. Confirm the completed delivery concisely."
    : notification.state === "canceled"
      ? "The scheduled email was canceled before provider use. Confirm that no email was sent."
      : "The scheduled email could not be sent. Explain the safe outcome without claiming delivery.";

export * as ScheduledEmailFollowUp from "./scheduled-email-follow-up";
