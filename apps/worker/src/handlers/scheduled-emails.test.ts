/* oxlint-disable effecttsgo/global-date -- Fixed transport timestamps make canonical status projection deterministic. */
import { describe, expect, it } from "vitest";

import { ScheduledEmail } from "../services/scheduled-email";
import { projectNotification } from "./scheduled-emails";

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
});
