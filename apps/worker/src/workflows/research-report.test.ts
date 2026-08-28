import { describe, expect, it } from "@effect/vitest";

import { ResearchReport } from "../services/research-report";
import { requireRetryForRecoverableResult } from "./research-report-host-outcome";

describe("ResearchReportWorkflow host outcomes", () => {
  it("throws recoverable storage and provider reconciliation failures so the step retries", () => {
    expect(() => requireRetryForRecoverableResult({ failure: "unavailable" })).toThrow(
      "temporarily unavailable",
    );
    expect(() => requireRetryForRecoverableResult({ failure: "recovery" })).toThrow(
      "reconciliation is pending",
    );
  });

  it("returns deterministic terminal and invalid host outcomes", () => {
    expect(requireRetryForRecoverableResult({ failure: "unauthorized" })).toEqual({
      failure: "unauthorized",
    });
    expect(
      requireRetryForRecoverableResult({
        artifactContentId: null,
        sourceCount: 0,
        sourceManifestKey: null,
        state: "canceled",
        workflowId: ResearchReport.WorkflowId.make("report-terminal"),
      }),
    ).toMatchObject({ state: "canceled" });
  });
});
