/* oxlint-disable effecttsgo/global-date -- Fixed product timestamps prove the deadline boundary. */
import { expect, it } from "vitest";

import { deadlineDisposition } from "./research-report-follow-up";

const deadline = new Date("2026-08-28T13:00:00.000Z");

it("cancels retained bytes until publication commits, then resumes finalization", () => {
  expect(deadlineDisposition("artifact_stored", deadline, deadline)).toBe("Canceled");
  expect(deadlineDisposition("publication_committed", deadline, deadline)).toBe(
    "PublicationPending",
  );
  expect(
    deadlineDisposition("artifact_stored", new Date("2026-08-28T12:59:59.999Z"), deadline),
  ).toBe("NotDue");
  expect(
    deadlineDisposition("publication_committed", new Date("2026-08-28T12:59:59.999Z"), deadline),
  ).toBe("NotDue");
});

it("never rewrites an already committed terminal outcome at the deadline", () => {
  expect(deadlineDisposition("success", deadline, deadline)).toBe("Terminal");
  expect(deadlineDisposition("failure", deadline, deadline)).toBe("Terminal");
  expect(deadlineDisposition("canceled", deadline, deadline)).toBe("Terminal");
});
