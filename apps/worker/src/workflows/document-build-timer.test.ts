/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed timestamps make timer behavior deterministic and host stubs assert at their invocation boundary. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ThinkSubmissionId } from "../domain";
import { DocumentBuild } from "../services/document-build";
import { deadlineDisposition } from "../integrations/postgres/document-build-follow-up";
import { DocumentBuildFollowUp } from "../services/document-build-follow-up";
import { matchesInstanceIdentity } from "./document-build-host-outcome";
import {
  postPreviewDisposition,
  previewFollowUpDisposition,
  terminalFollowUpAccepted,
} from "./document-build-timer-outcome";

describe("DocumentBuildTimerWorkflow deadline", () => {
  const deadline = new Date("2026-08-28T13:00:00.000Z");
  const after = new Date("2026-08-28T13:00:01.000Z");

  it("cannot cancel after publication has committed", () => {
    expect(
      deadlineDisposition(DocumentBuild.State.make("publication_committed"), after, deadline),
    ).toBe("Terminal");
  });

  it("cancels still-executable work at the hard deadline", () => {
    expect(deadlineDisposition(DocumentBuild.State.make("preview_stored"), after, deadline)).toBe(
      "Canceled",
    );
  });

  it("continues polling when publication commits just after the first post-preview inspection", () => {
    expect(postPreviewDisposition(DocumentBuild.State.make("preview_stored"))).toBe("continue");
    expect(postPreviewDisposition(DocumentBuild.State.make("publication_committed"))).toBe(
      "recover",
    );
    expect(postPreviewDisposition(DocumentBuild.State.make("success"))).toBe("terminal");
  });

  it("promotes a superseded PreviewReady submission into terminal recovery", () => {
    const superseded = DocumentBuildFollowUp.SubmissionSuccess.make({
      _tag: "TerminalSuperseded",
      notificationId: DocumentBuildFollowUp.NotificationId.make("preview-notification"),
      submissionId: ThinkSubmissionId.make("preview-submission"),
    });

    expect(previewFollowUpDisposition(superseded)).toBe("terminal");
    expect(terminalFollowUpAccepted(superseded)).toBe(false);
  });

  it("accepts only accepted or replayed terminal submissions", () => {
    const notificationId = DocumentBuildFollowUp.NotificationId.make("terminal-notification");
    expect(
      terminalFollowUpAccepted(
        DocumentBuildFollowUp.SubmissionSuccess.make({
          _tag: "Accepted",
          notificationId,
          submissionId: ThinkSubmissionId.make("terminal-submission"),
        }),
      ),
    ).toBe(true);
    expect(
      terminalFollowUpAccepted(
        DocumentBuildFollowUp.SubmissionSuccess.make({
          _tag: "Replayed",
          notificationId,
          submissionId: ThinkSubmissionId.make("terminal-submission"),
        }),
      ),
    ).toBe(true);
  });

  it.effect("rejects a payload delivered to a different timer identity", () =>
    Effect.gen(function* () {
      const payload = DocumentBuild.WorkflowPayload.make({
        inputDigest: DocumentBuild.InputDigest.make("b".repeat(64)),
        workflowId: DocumentBuild.WorkflowId.make("document-build:timer-identity"),
      });
      const identities = yield* DocumentBuild.cloudflareInstanceIdsFor(payload.workflowId);
      expect(yield* matchesInstanceIdentity("timer", identities.timer, payload)).toBe(true);
      expect(yield* matchesInstanceIdentity("timer", identities.main, payload)).toBe(false);
    }),
  );
});
