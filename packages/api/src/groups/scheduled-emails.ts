import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const ScheduledEmailApproval = Schema.Struct({
  actionId: bounded(200),
  consequences: Schema.Array(bounded(500)),
  description: bounded(1_000),
  fields: Schema.Array(
    Schema.Struct({ label: bounded(80), name: bounded(80), value: bounded(64_000) }),
  ),
  presentationId: bounded(200),
  title: bounded(120),
});
export type ScheduledEmailApproval = typeof ScheduledEmailApproval.Type;

export const ScheduledEmailApprovals = Schema.Struct({
  items: Schema.Array(ScheduledEmailApproval),
});
export type ScheduledEmailApprovals = typeof ScheduledEmailApprovals.Type;

export const ScheduledEmailApprovalDecision = Schema.Struct({
  decision: Schema.Literals(["approve", "reject"]),
  presentationId: bounded(200),
  reason: Schema.optional(bounded(500)),
});
export type ScheduledEmailApprovalDecision = typeof ScheduledEmailApprovalDecision.Type;

export const ScheduledEmailApprovalDecisionAccepted = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  presentationId: bounded(200),
});

export const ScheduledEmailNotificationSummary = Schema.Struct({
  deliveredAt: Schema.DateFromString,
  state: Schema.Literals(["success", "failure", "canceled"]),
  workflowId: bounded(300),
});
export type ScheduledEmailNotificationSummary = typeof ScheduledEmailNotificationSummary.Type;

export const ScheduledEmailNotifications = Schema.Struct({
  items: Schema.Array(ScheduledEmailNotificationSummary),
});

export class ScheduledEmailsUnavailable extends Schema.TaggedError<ScheduledEmailsUnavailable>()(
  "ScheduledEmailsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated control-plane projection of exact pending and terminal Scheduled Emails. */
export const ScheduledEmailsGroup = HttpApiGroup.make("scheduledEmails")
  .add(
    HttpApiEndpoint.get("approvals", "/v1/scheduled-emails/approvals", {
      error: ScheduledEmailsUnavailable,
      success: ScheduledEmailApprovals,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect Scheduled Email Approvals" })),
  )
  .add(
    HttpApiEndpoint.post("decideApproval", "/v1/scheduled-emails/approvals/decision", {
      error: ScheduledEmailsUnavailable,
      payload: ScheduledEmailApprovalDecision,
      success: ScheduledEmailApprovalDecisionAccepted,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Decide one Scheduled Email Approval" })),
  )
  .add(
    HttpApiEndpoint.get("notifications", "/v1/scheduled-emails/notifications", {
      error: ScheduledEmailsUnavailable,
      success: ScheduledEmailNotifications,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect Scheduled Email notifications" })),
  );
