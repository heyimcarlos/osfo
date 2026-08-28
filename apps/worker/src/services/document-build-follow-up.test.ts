import { describe, expect, it } from "@effect/vitest";

import { AgentId, ConversationRouteId, SessionId } from "../domain";
import { DocumentBuildFollowUp } from "./document-build-follow-up";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- The Promise queue models Agent serialization and uses one fixed product timestamp. */

describe("DocumentBuildFollowUp submission disposition", () => {
  it("derives concurrent replay truth from each refreshed serialized notification", async () => {
    let acceptedAt: Date | null = null;
    let serialized = Promise.resolve();
    const submit = () => {
      const outcome = serialized.then(() => {
        const disposition = DocumentBuildFollowUp.submissionDisposition({ acceptedAt });
        acceptedAt ??= new Date("2026-08-28T12:00:00.000Z");
        return disposition;
      });
      serialized = outcome.then(() => undefined);
      return outcome;
    };

    await expect(Promise.all([submit(), submit()])).resolves.toEqual(["Accepted", "Replayed"]);
  });
});

describe("DocumentBuildFollowUp delivery Session selection", () => {
  const agentId = AgentId.make("document-build-agent");
  const routeId = ConversationRouteId.make("document-build-route");
  const origin = SessionId.make("deleted-origin-session");
  const current = SessionId.make("current-delivery-session");
  const notification = {
    acceptedAt: null,
    agentId,
    deliverySessionId: null,
    routeId,
    sessionId: origin,
  };

  it("retargets a deleted origin to the owning route's current Session", () => {
    expect(
      DocumentBuildFollowUp.deliverySessionFor(notification, agentId, {
        currentSessionId: current,
        routeId,
      }),
    ).toBe(current);
  });

  it("retargets an unaccepted historical selection and rejects another Agent or route", () => {
    const selected = { ...notification, deliverySessionId: origin };
    const route = { currentSessionId: current, historicalSessionIds: [], routeId };
    expect(DocumentBuildFollowUp.deliverySessionFor(selected, agentId, route)).toBe(current);
    expect(
      DocumentBuildFollowUp.deliverySessionFor(selected, AgentId.make("another-agent"), route),
    ).toBeNull();
    expect(
      DocumentBuildFollowUp.deliverySessionFor(selected, agentId, {
        ...route,
        routeId: ConversationRouteId.make("another-route"),
      }),
    ).toBeNull();
  });

  it("keeps an accepted delivery identity stable without selecting a historical target", () => {
    expect(
      DocumentBuildFollowUp.deliverySessionFor(
        { ...notification, acceptedAt: new Date(0), deliverySessionId: origin },
        agentId,
        { currentSessionId: current, routeId },
      ),
    ).toBe(origin);
  });
});
