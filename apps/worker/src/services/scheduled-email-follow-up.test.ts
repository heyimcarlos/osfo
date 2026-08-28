import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AgentId, ConversationRouteId, SessionId } from "../domain";
import { ScheduledEmailFollowUp } from "./scheduled-email-follow-up";
import { makeRecord } from "./scheduled-email-test-fixture";

describe("ScheduledEmailFollowUp delivery Session selection", () => {
  const terminalAt = new Date("2026-08-28T12:06:00.000Z");
  const email = makeRecord({ state: "success", terminalAt });
  const currentSessionId = SessionId.make("current-delivery-session");
  const historicalSessionId = SessionId.make("historical-session");
  const notification: ScheduledEmailFollowUp.Notification = {
    acceptedAt: null,
    agentId: email.agentId,
    claimedAt: terminalAt,
    deliverySessionId: historicalSessionId,
    modelAccessPolicyVersion: email.modelAccessPolicyVersion,
    modelRoute: email.modelRoute,
    notificationId: ScheduledEmailFollowUp.NotificationId.make(`${email.workflowId}-terminal`),
    originSessionId: email.sessionId,
    planPolicyVersion: email.planPolicyVersion,
    resourcePriceVersion: email.resourcePriceVersion,
    routeId: email.routeId,
    state: "success",
    submissionId: null,
    userId: email.userId,
    workflowId: email.workflowId,
  };

  it("retargets an unaccepted notification to the route's current Session", () => {
    expect(
      ScheduledEmailFollowUp.deliverySessionFor(notification, email.agentId, {
        currentSessionId,
        routeId: email.routeId,
      }),
    ).toBe(currentSessionId);
  });

  it("rejects another Agent or route", () => {
    expect(
      ScheduledEmailFollowUp.deliverySessionFor(notification, AgentId.make("another-agent"), {
        currentSessionId,
        routeId: email.routeId,
      }),
    ).toBeNull();
    expect(
      ScheduledEmailFollowUp.deliverySessionFor(notification, email.agentId, {
        currentSessionId,
        routeId: ConversationRouteId.make("another-route"),
      }),
    ).toBeNull();
  });

  it("keeps the final delivery Session immutable after acceptance", () => {
    expect(
      ScheduledEmailFollowUp.deliverySessionFor(
        { ...notification, acceptedAt: new Date("2026-08-28T12:06:10.000Z") },
        email.agentId,
        { currentSessionId, routeId: email.routeId },
      ),
    ).toBe(historicalSessionId);
  });

  it.effect("derives a deterministic submission id from only the notification id", () =>
    Effect.gen(function* () {
      const first = yield* ScheduledEmailFollowUp.submissionIdFor(notification.notificationId);
      const replay = yield* ScheduledEmailFollowUp.submissionIdFor(notification.notificationId);
      expect(replay).toBe(first);
    }),
  );
});
