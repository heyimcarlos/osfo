import { Api, CurrentUser, ResearchReportNotificationsUnavailable } from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { Db } from "../db";
import { UserId } from "../domain";
import { ResearchReportFollowUpPostgres } from "../integrations/postgres/research-report-follow-up";

/** Expose the bounded safe projection of delivered Research Report follow-ups. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Db.database;
    const followUps = ResearchReportFollowUpPostgres.make(database);
    return HttpApiBuilder.group(Api, "researchReports", (handlers) =>
      handlers.handle("notifications", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const notifications = yield* followUps.deliveredForUser(UserId.make(currentUser.userId));
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
    );
  }),
);

export * as ResearchReportHandlers from "./research-reports";
