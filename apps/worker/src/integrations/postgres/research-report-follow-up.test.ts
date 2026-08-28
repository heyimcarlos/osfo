/* oxlint-disable effecttsgo/global-date -- Fixed product timestamps prove the deadline boundary. */
import { expect, it } from "vitest";

import { deadlineDisposition } from "./research-report-follow-up";

const deadline = new Date("2026-08-28T13:00:00.000Z");

it("finishes a claimed publication instead of canceling its readable artifact", () => {
  expect(deadlineDisposition("artifact_stored", deadline, deadline)).toBe("PublicationPending");
  expect(
    deadlineDisposition("artifact_stored", new Date("2026-08-28T12:59:59.999Z"), deadline),
  ).toBe("NotDue");
});

it("never rewrites an already committed terminal outcome at the deadline", () => {
  expect(deadlineDisposition("success", deadline, deadline)).toBe("Terminal");
  expect(deadlineDisposition("failure", deadline, deadline)).toBe("Terminal");
  expect(deadlineDisposition("canceled", deadline, deadline)).toBe("Terminal");
});
