import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const IntegrationToolkit = Schema.Literals(["gmail", "googlecalendar", "googledrive"]);
export type IntegrationToolkit = typeof IntegrationToolkit.Type;

export const IntegrationConnectionSummary = Schema.Struct({
  connections: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      label: Schema.String,
      status: Schema.Literals(["connected", "missing", "stale", "unavailable"]),
      toolkit: IntegrationToolkit,
    }),
  ),
});
export type IntegrationConnectionSummary = typeof IntegrationConnectionSummary.Type;

export const IntegrationConnectRedirect = Schema.Struct({ url: Schema.URLFromString });
export const IntegrationConnectionChanged = Schema.Struct({
  status: Schema.Literal("missing"),
  toolkit: IntegrationToolkit,
});

export const GmailSendApproval = Schema.Struct({
  actionId: bounded(200),
  consequences: Schema.Array(bounded(500)),
  description: bounded(1_000),
  fields: Schema.Array(
    Schema.Struct({ label: bounded(80), name: bounded(80), value: bounded(64_000) }),
  ),
  presentationId: bounded(200),
  title: bounded(120),
});
export type GmailSendApproval = typeof GmailSendApproval.Type;

export const GmailSendStatus = Schema.Struct({
  actionId: bounded(200),
  presentationId: bounded(200),
  status: Schema.Literals([
    "pending",
    "applied",
    "notApplied",
    "ambiguous",
    "rejected",
    "invalidated",
  ]),
});
export type GmailSendStatus = typeof GmailSendStatus.Type;

export const GmailSends = Schema.Struct({
  approvals: Schema.Array(GmailSendApproval),
  statuses: Schema.Array(GmailSendStatus),
});

export const GmailSendApprovalDecision = Schema.Struct({
  decision: Schema.Literals(["approve", "reject"]),
  presentationId: bounded(200),
  reason: Schema.optional(bounded(500)),
});
export type GmailSendApprovalDecision = typeof GmailSendApprovalDecision.Type;

export const GmailSendApprovalDecisionAccepted = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  presentationId: bounded(200),
});

export class IntegrationsUnavailable extends Schema.TaggedError<IntegrationsUnavailable>()(
  "IntegrationsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const IntegrationsGroup = HttpApiGroup.make("integrations")
  .add(
    HttpApiEndpoint.get("inspect", "/v1/integrations", {
      error: IntegrationsUnavailable,
      success: IntegrationConnectionSummary,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect integration connections" })),
  )
  .add(
    HttpApiEndpoint.get("gmailSends", "/v1/integrations/gmail-sends", {
      error: IntegrationsUnavailable,
      success: GmailSends,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Inspect immediate Gmail sends" })),
  )
  .add(
    HttpApiEndpoint.post("decideGmailSend", "/v1/integrations/gmail-sends/approval", {
      error: IntegrationsUnavailable,
      payload: GmailSendApprovalDecision,
      success: GmailSendApprovalDecisionAccepted,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Decide one immediate Gmail send" })),
  )
  .add(
    HttpApiEndpoint.post("connect", "/v1/integrations/connect", {
      error: IntegrationsUnavailable,
      payload: Schema.Struct({ toolkit: IntegrationToolkit }),
      success: IntegrationConnectRedirect,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Connect one integration" })),
  )
  .add(
    HttpApiEndpoint.post("disconnect", "/v1/integrations/disconnect", {
      error: IntegrationsUnavailable,
      payload: Schema.Struct({ toolkit: IntegrationToolkit }),
      success: IntegrationConnectionChanged,
    })
      .middleware(Auth)
      .annotateMerge(OpenApi.annotations({ summary: "Disconnect one integration" })),
  );
