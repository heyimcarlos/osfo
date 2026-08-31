/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- Fixed transport timestamps and Effect assertions make the handler projection deterministic. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationsFound,
} from "../agents/osfo/think-action-approvals";
import { ActionId } from "../domain/action-execution";
import { ScheduledEmail } from "../services/scheduled-email";
import { listApprovals, projectNotification } from "./scheduled-emails";

describe("Scheduled Email notification projection", () => {
  it.each([
    { expectedOutcome: "applied", expectedState: "success" },
    { expectedOutcome: "notApplied", expectedState: "failure" },
  ] as const)(
    "returns late $expectedOutcome provider truth through the authenticated API",
    ({ expectedOutcome, expectedState }) => {
      const deliveredAt = new Date("2026-08-29T12:00:30.000Z");
      const workflowId = ScheduledEmail.WorkflowId.make(`scheduled-email:${expectedOutcome}`);

      expect(
        projectNotification({
          acceptedAt: deliveredAt,
          claimedAt: new Date("2026-08-29T12:00:00.000Z"),
          sendOutcome: expectedOutcome,
          state: expectedState,
          workflowId,
        }),
      ).toEqual({ deliveredAt, sendOutcome: expectedOutcome, state: expectedState, workflowId });
    },
  );

  it.effect("requests only Scheduled Email Action presentations from the Agent", () =>
    Effect.gen(function* () {
      const selections: Array<string | undefined> = [];
      const scheduled = ActionPresentation.make({
        actionDefinitionVersion: "osfo-scheduled-email-start-v1",
        actionId: ActionId.make("scheduled-action"),
        consequences: ["Schedule one email."],
        description: "Schedule the exact email shown here.",
        fields: [],
        operation: "integration.effect",
        presentationId: ActionPresentationId.make("scheduled-presentation"),
        title: "Schedule email",
      });
      const result = yield* listApprovals(
        {
          decideActionApproval: () => Promise.resolve(null),
          listActionPresentations: (_agentId, _actor, selection) => {
            selections.push(selection);
            return Promise.resolve(ActionPresentationsFound.make({ presentations: [scheduled] }));
          },
        },
        "agent-1",
        {
          authSessionExpiresAt: new Date("2026-08-30T00:00:00.000Z"),
          authSessionId: "session-1",
          userId: "user-1",
        },
      );

      expect(selections).toEqual(["scheduled-email"]);
      expect(result.items.map(({ presentationId }) => presentationId)).toEqual([
        "scheduled-presentation",
      ]);
    }),
  );
});
