import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { CapabilityCatalogVersion } from "../domain";
import {
  currentCapabilityCatalog,
  resolveCapabilityCatalog,
  retainedCapabilityCatalogs,
} from "./capability-catalog";

/* oxlint-disable eslint/no-underscore-dangle -- The typed failure uses the standard Effect _tag discriminator. */

describe("Capability Catalog", () => {
  it("gives both Plans one self-serve operation catalog with only GM Summon gated", () => {
    expect(currentCapabilityCatalog.version).toBe("governed-capabilities-v1");
    expect(currentCapabilityCatalog.operations).toEqual(
      expect.arrayContaining([
        "conversation.run",
        "skill.inspect",
        "skill.manage",
        "integration.connection.manage",
        "integration.read",
        "integration.effect",
        "artifact.generate",
        "artifact.revise",
        "artifact.read",
        "artifact.delete",
        "reminder.manage",
        "workflow.manage",
      ]),
    );
    expect(currentCapabilityCatalog.operations).not.toEqual(
      expect.arrayContaining(["gmail.send", "document.generate"]),
    );
    expect(currentCapabilityCatalog.planExceptions).toEqual({
      adventurer: ["support.gmSummon"],
      free: [],
    });
  });

  it("freezes the shared operation, exhaustion, and Plan-specific resource bounds", () => {
    expect(currentCapabilityCatalog.operationLimits).toMatchObject({
      computeMilliseconds: 60_000,
      csvInputRows: 100_000,
      durableArtifactOperationMilliseconds: 3_600_000,
      generatedDocumentBytes: 5_000_000n,
      generatedDocumentPages: 20,
      generatedImageBytes: 10_000_000n,
      generatedImagePixelsPerEdge: 2_048,
      modelSteps: 12,
      researchRetrievedPages: 20,
      researchSearches: 20,
      uploadBytes: 25_000_000n,
      webRetrievedPages: 5,
      webSearches: 3,
    });
    expect(currentCapabilityCatalog.exhaustedConversation).toEqual({
      concurrentOperations: 1,
      inputTokens: 8_000,
      memoryDeadlineMilliseconds: 750,
      memoryProfileTokens: 200,
      memoryQueryTokens: 300,
      memoryRecalls: 1,
      modelSteps: 2,
      outputTokens: 1_024,
      retries: 0,
      skillInstructions: "locallyAvailableOnly",
    });
    expect(currentCapabilityCatalog.exhaustedConnectorRead).toMatchObject({
      callsPerRollingDay: 20,
      concurrentReads: 1,
      deadlineMilliseconds: 10_000,
      providerExecutions: 1,
      records: 10,
      responseBytes: 65_536n,
    });
    expect(currentCapabilityCatalog.planResourceLimits).toEqual({
      adventurer: {
        activeGmSummonsPerSession: 1,
        activeReminders: 25,
        activeWorkflows: 25,
        concurrentCostlyJobs: 3,
        concurrentIntegrationEffects: 1,
        connectedAccountsPerToolkit: 1,
        gmSummonsPerPeriod: 1,
        managedModelInputTokens: 128_000,
        managedModelOutputTokens: 8_192,
        retainedUserContentBytes: 2_000_000_000n,
      },
      free: {
        activeGmSummonsPerSession: 0,
        activeReminders: 5,
        activeWorkflows: 3,
        concurrentCostlyJobs: 1,
        concurrentIntegrationEffects: 1,
        connectedAccountsPerToolkit: 1,
        gmSummonsPerPeriod: 0,
        managedModelInputTokens: 32_000,
        managedModelOutputTokens: 4_096,
        retainedUserContentBytes: 100_000_000n,
      },
    });
  });

  it("denies an unknown catalog version", () => {
    const result = resolveCapabilityCatalog(
      retainedCapabilityCatalogs,
      CapabilityCatalogVersion.make("unknown-catalog"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure._tag).toBe("CapabilityCatalogNotFound");
  });
});
