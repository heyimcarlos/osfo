import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Safe delivered Document Build follow-up shown in the authenticated dashboard. */
export const DocumentBuildNotificationSummary = Schema.Struct({
  artifactContentId: Schema.NullOr(Schema.String),
  deliveredAt: Schema.DateFromString,
  format: Schema.Literals(["pdf", "docx"]),
  kind: Schema.Literals(["previewReady", "terminal"]),
  safeFailureCode: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "admitted",
    "accepted",
    "running",
    "preview_stored",
    "publication_committed",
    "cancel_requested",
    "success",
    "failure",
    "canceled",
  ]),
  workflowId: Schema.String,
});
export type DocumentBuildNotificationSummary = typeof DocumentBuildNotificationSummary.Type;

export const DocumentBuildNotifications = Schema.Struct({
  items: Schema.Array(DocumentBuildNotificationSummary),
});
export type DocumentBuildNotifications = typeof DocumentBuildNotifications.Type;

export class DocumentBuildNotificationsUnavailable extends Schema.TaggedError<DocumentBuildNotificationsUnavailable>()(
  "DocumentBuildNotificationsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const DocumentBuildsGroup = HttpApiGroup.make("documentBuilds").add(
  HttpApiEndpoint.get("notifications", "/v1/document-builds/notifications", {
    error: DocumentBuildNotificationsUnavailable,
    success: DocumentBuildNotifications,
  })
    .middleware(Auth)
    .annotateMerge(
      OpenApi.annotations({
        description: "Show delivered safe Document Build follow-ups for the current User.",
        identifier: "documentBuilds.notifications",
        summary: "Inspect Document Build notifications",
      }),
    ),
);
