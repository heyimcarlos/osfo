import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Safe delivered Research Report follow-up shown in the authenticated dashboard. */
export const ResearchReportNotificationSummary = Schema.Struct({
  artifactContentId: Schema.NullOr(Schema.String),
  deliveredAt: Schema.DateFromString,
  kind: Schema.Literals(["sourcesCollected", "terminal"]),
  safeFailureCode: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "admitted",
    "accepted",
    "running",
    "sources_committed",
    "artifact_stored",
    "cancel_requested",
    "success",
    "failure",
    "canceled",
  ]),
  workflowId: Schema.String,
});

export type ResearchReportNotificationSummary = typeof ResearchReportNotificationSummary.Type;

/** Bounded delivered Research Report follow-ups for the authenticated User. */
export const ResearchReportNotifications = Schema.Struct({
  items: Schema.Array(ResearchReportNotificationSummary),
});

export type ResearchReportNotifications = typeof ResearchReportNotifications.Type;

/** Safe response when the Research Report notification projection is unavailable. */
export class ResearchReportNotificationsUnavailable extends Schema.TaggedError<ResearchReportNotificationsUnavailable>()(
  "ResearchReportNotificationsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Authenticated safe Research Report notification projection. */
export const ResearchReportsGroup = HttpApiGroup.make("researchReports").add(
  HttpApiEndpoint.get("notifications", "/v1/research-reports/notifications", {
    error: ResearchReportNotificationsUnavailable,
    success: ResearchReportNotifications,
  })
    .middleware(Auth)
    .annotateMerge(
      OpenApi.annotations({
        description: "Show delivered safe Research Report follow-ups for the current User.",
        identifier: "researchReports.notifications",
        summary: "Inspect Research Report notifications",
      }),
    ),
);
