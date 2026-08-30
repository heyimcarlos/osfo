import { describe, expect, it } from "vitest";

import {
  qualificationAgentPostgresAuthoritySources,
  qualificationArrivalReadbackAuthoritySources,
  qualificationAuthorityAdapterRegistry,
  qualificationAuthorityCoverageGaps,
  qualificationAuthoritySources,
  qualificationAuthoritySourcesRequiring,
} from "./authority-sources";
import { createBoundedBetaManifest } from "./qualification-manifest";

const manifest = createBoundedBetaManifest({
  dependencyVersions: {
    "@cloudflare/think": "0.15.1",
    agents: "0.20.1",
    effect: "4.0.0-rc.111",
  },
  hardLimits: [
    { maximum: 128, name: "workerMemory", unit: "MiB" },
    { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
    { maximum: 250_000, name: "qualificationWorkflowSubrequests", unit: "requests" },
  ],
  sourceVersion: "coverage-test-sha",
  topologyVersion: "cloudflare-v1",
  workloadSeed: 17,
});

describe("qualification authority adapter coverage", () => {
  it("has one source identity per installed adapter and preserves the collector split", () => {
    expect(new Set(qualificationAuthorityAdapterRegistry.map(({ source }) => source)).size).toBe(
      qualificationAuthorityAdapterRegistry.length,
    );
    expect(qualificationAgentPostgresAuthoritySources).toEqual([
      "allowance_and_billing_ledger",
      "gmail_provider_receipts",
      "memory_commit_receipts",
      "model_access_receipts",
      "osfo_agent_activation_log",
      "osfo_committed_turns",
      "provider_delivery_receipts",
      "task_compute_receipts",
      "workflow_instance_receipts",
    ]);
    expect(qualificationArrivalReadbackAuthoritySources).toEqual([
      "think_submission_receipts",
      "worker_admission_receipts",
    ]);
    expect(
      qualificationAuthorityAdapterRegistry.every(({ source }) =>
        qualificationAuthoritySources.includes(source),
      ),
    ).toBe(true);
    expect(qualificationAuthoritySourcesRequiring("directoryBinding")).toEqual([
      "allowance_and_billing_ledger",
      "memory_commit_receipts",
      "model_access_receipts",
      "osfo_agent_activation_log",
      "qualification_fault_controller_receipts",
      "osfo_committed_turns",
    ]);
    expect(qualificationAuthoritySourcesRequiring("scheduledEmailTable")).toEqual([
      "gmail_provider_receipts",
      "provider_delivery_receipts",
      "task_compute_receipts",
      "workflow_instance_receipts",
    ]);
  });

  it("reports unsupported source and journey pairs without erasing installed coverage", () => {
    const gaps = qualificationAuthorityCoverageGaps(manifest);
    expect(gaps).toContainEqual({
      component: "Gmail",
      journey: "gmail",
      source: "gmail_provider_receipts",
    });
    expect(gaps).toContainEqual({
      component: "TaskCompute",
      journey: "documentBuild",
      source: "task_compute_receipts",
    });
    expect(gaps).toContainEqual({
      component: "Workflow",
      journey: "reminder",
      source: "workflow_instance_receipts",
    });
    expect(gaps).toContainEqual({
      activationCause: "idleEviction",
      component: "AgentActivation",
      journey: null,
      source: "osfo_agent_activation_log",
    });
    expect(gaps).toContainEqual({
      component: "FaultController",
      faultKind: "dependencyOutage",
      journey: null,
      source: "qualification_fault_controller_receipts",
    });
    expect(gaps).toContainEqual({
      component: "FaultController",
      faultKind: "coldActivation",
      faultScope: "allCold",
      journey: null,
      source: "qualification_fault_controller_receipts",
    });
    expect(
      gaps.some(
        ({ activationCause, source }) =>
          source === "osfo_agent_activation_log" && activationCause === "faultRecovery",
      ),
    ).toBe(false);
    expect(
      gaps.some(
        ({ journey, source }) => source === "r2_object_metadata" && journey === "documentBuild",
      ),
    ).toBe(false);
    expect(gaps).toContainEqual({
      component: "R2",
      journey: "fileAnalysis",
      source: "r2_object_metadata",
    });
    expect(gaps).toContainEqual({
      component: "R2",
      journey: "researchReport",
      source: "r2_object_metadata",
    });
    expect(
      gaps.some(
        ({ source }) =>
          source === "worker_admission_receipts" || source === "think_submission_receipts",
      ),
    ).toBe(false);
    expect(
      gaps.some(
        ({ journey, source }) =>
          source === "gmail_provider_receipts" && journey === "scheduledEmail",
      ),
    ).toBe(false);
  });
});
