/* oxlint-disable effecttsgo/global-date -- Fixed notification timestamps make projection evidence deterministic. */
import { describe, expect, it } from "@effect/vitest";

import { DocumentBuild } from "../services/document-build";
import { projectNotification } from "./document-builds";

describe("Document Build notification projection", () => {
  it("never grants preview export even when the joined build later succeeds", () => {
    const workflowId = DocumentBuild.WorkflowId.make("document-build:notification-preview");
    expect(
      projectNotification({
        acceptedAt: new Date("2026-08-28T12:01:00.000Z"),
        artifactContentId: `document:workflow:${workflowId}`,
        buildState: DocumentBuild.State.make("success"),
        claimedAt: new Date("2026-08-28T12:00:00.000Z"),
        format: "pdf",
        kind: "previewReady",
        safeFailureCode: null,
        workflowId,
      }).artifactContentId,
    ).toBeNull();
  });
});
