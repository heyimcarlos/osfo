import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const ReminderApproval = Schema.Struct({
  actionId: bounded(200),
  consequences: Schema.Array(bounded(500)),
  description: bounded(1_000),
  fields: Schema.Array(
    Schema.Struct({ label: bounded(80), name: bounded(80), value: bounded(64_000) }),
  ),
  presentationId: bounded(200),
  title: bounded(120),
});
export type ReminderApproval = typeof ReminderApproval.Type;

export const ReminderApprovals = Schema.Struct({
  items: Schema.Array(ReminderApproval),
});
export type ReminderApprovals = typeof ReminderApprovals.Type;

export const ReminderApprovalDecision = Schema.Struct({
  decision: Schema.Literals(["approve", "reject"]),
  presentationId: bounded(200),
  reason: Schema.optional(bounded(500)),
});
export type ReminderApprovalDecision = typeof ReminderApprovalDecision.Type;

export const ReminderApprovalDecisionAccepted = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  presentationId: bounded(200),
});

export class RemindersUnavailable extends Schema.TaggedError<RemindersUnavailable>()(
  "RemindersUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated control-plane projection of exact pending Reminders. */
export const RemindersGroup = HttpApiGroup.make("reminders")
  .add(
    HttpApiEndpoint.get("approvals", "/v1/reminders/approvals", {
      error: RemindersUnavailable,
      success: ReminderApprovals,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect Reminder Approvals" })),
  )
  .add(
    HttpApiEndpoint.post("decideApproval", "/v1/reminders/approvals/decision", {
      error: RemindersUnavailable,
      payload: ReminderApprovalDecision,
      success: ReminderApprovalDecisionAccepted,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Decide one Reminder Approval" })),
  );
