import { Api, CurrentUser, ResearchReportNotificationsUnavailable } from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import { ResearchReportFollowUp } from "../services/research-report-follow-up";

/** Expose the bounded safe projection of delivered Research Report follow-ups. */
export const layer = Layer.unwrap(
  ResearchReportFollowUp.Service.pipe(
    Effect.map((followUps) =>
      HttpApiBuilder.group(Api, "researchReports", (handlers) =>
        handlers.handle("notifications", () =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            const notifications = yield* followUps.deliveredForUser(
              UserId.make(currentUser.userId),
            );
            return {
              items: notifications.map((notification) => ({
                artifactContentId: notification.artifactContentId,
                deliveredAt: notification.acceptedAt ?? notification.claimedAt,
                kind: notification.kind,
                safeFailureCode: notification.safeFailureCode,
                state: notification.reportState,
                workflowId: notification.workflowId,
              })),
            };
          }).pipe(
            Effect.mapError(
              () =>
                new ResearchReportNotificationsUnavailable({
                  message: "Research Report notifications are temporarily unavailable",
                }),
            ),
          ),
        ),
      ),
    ),
  ),
);

export * as ResearchReportHandlers from "./research-reports";
