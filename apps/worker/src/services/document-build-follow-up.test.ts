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
    agentId,
    deliverySessionId: null,
    routeId,
    sessionId: origin,
  };

  it("retargets a deleted origin to the owning route's current Session", () => {
    expect(
      DocumentBuildFollowUp.deliverySessionFor(notification, agentId, {
        currentSessionId: current,
        historicalSessionIds: [],
        routeId,
      }),
    ).toBe(current);
  });

  it("keeps a retained delivery Session stable and rejects another Agent or route", () => {
    const selected = { ...notification, deliverySessionId: current };
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
});
