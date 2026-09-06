import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const BrowserApproval = Schema.Struct({
  actionId: bounded(200),
  consequences: Schema.Array(bounded(500)),
  description: bounded(1_000),
  fields: Schema.Array(
    Schema.Struct({ label: bounded(80), name: bounded(80), value: bounded(64_000) }),
  ),
  presentationId: bounded(200),
  title: bounded(120),
});
export type BrowserApproval = typeof BrowserApproval.Type;

export const BrowserApprovals = Schema.Struct({
  items: Schema.Array(BrowserApproval),
});
export type BrowserApprovals = typeof BrowserApprovals.Type;

export const BrowserApprovalDecision = Schema.Struct({
  decision: Schema.Literals(["approve", "reject"]),
  presentationId: bounded(200),
  reason: Schema.optional(bounded(500)),
});
export type BrowserApprovalDecision = typeof BrowserApprovalDecision.Type;

export const BrowserApprovalDecisionAccepted = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  presentationId: bounded(200),
});

export class BrowserApprovalsUnavailable extends Schema.TaggedError<BrowserApprovalsUnavailable>()(
  "BrowserApprovalsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated control-plane projection of exact pending browser interactions. */
export const BrowserApprovalsGroup = HttpApiGroup.make("browserApprovals")
  .add(
    HttpApiEndpoint.get("approvals", "/v1/browser/approvals", {
      error: BrowserApprovalsUnavailable,
      success: BrowserApprovals,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect browser interaction Approvals" })),
  )
  .add(
    HttpApiEndpoint.post("decideApproval", "/v1/browser/approvals/decision", {
      error: BrowserApprovalsUnavailable,
      payload: BrowserApprovalDecision,
      success: BrowserApprovalDecisionAccepted,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Decide one browser interaction Approval" })),
  );
