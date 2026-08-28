import { Api, CurrentUser, DocumentBuildNotificationsUnavailable } from "@osfo/api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import { DocumentBuildFollowUp } from "../services/document-build-follow-up";

/** Project one delivered row without turning a preview milestone into an export grant. */
export const projectNotification = (
  notification: Pick<
    DocumentBuildFollowUp.Notification,
    | "acceptedAt"
    | "artifactContentId"
    | "buildState"
    | "claimedAt"
    | "format"
    | "kind"
    | "safeFailureCode"
    | "workflowId"
  >,
) => ({
  artifactContentId:
    notification.kind === "terminal" && notification.buildState === "success"
      ? notification.artifactContentId
      : null,
  deliveredAt: notification.acceptedAt ?? notification.claimedAt,
  format: notification.format,
  kind: notification.kind,
  safeFailureCode: notification.safeFailureCode,
  state: notification.buildState,
  workflowId: notification.workflowId,
});

/** Expose only delivered, privacy-safe Document Build lifecycle facts. */
export const layer = Layer.unwrap(
  DocumentBuildFollowUp.Service.pipe(
    Effect.map((followUps) =>
      HttpApiBuilder.group(Api, "documentBuilds", (handlers) =>
        handlers.handle("notifications", () =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            const notifications = yield* followUps.deliveredForUser(
              UserId.make(currentUser.userId),
            );
            return {
              items: notifications.map(projectNotification),
            };
          }).pipe(
            Effect.mapError(
              () =>
                new DocumentBuildNotificationsUnavailable({
                  message: "Document Build notifications are temporarily unavailable",
                }),
            ),
          ),
        ),
      ),
    ),
  ),
);

export * as DocumentBuildHandlers from "./document-builds";
