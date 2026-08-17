import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { currentPolicy, parseCatalog, policyFor, retainedCatalog } from "../src/domain/plan-policy";

describe("Plan policy", () => {
  it("retains the launch policy and selects it explicitly", () => {
    expect(currentPolicy.version).toBe("launch-v1");
    expect(policyFor(currentPolicy, "free")).toMatchObject({
      allowanceLimits: {
        acceptedMessages: 30n,
        vendorUsdMicros: 250_000n,
      },
      operationLimits: {
        modelStepsPerRequest: 6n,
        uploadBytes: 10_000_000n,
        vendorUsdMicrosPerRequest: 30_000n,
      },
    });
    expect(policyFor(currentPolicy, "adventurer")).toMatchObject({
      allowanceLimits: {
        acceptedMessages: 300n,
        vendorUsdMicros: 7_500_000n,
      },
      operationLimits: {
        modelStepsPerRequest: 12n,
        uploadBytes: 25_000_000n,
        vendorUsdMicrosPerRequest: 750_000n,
      },
    });
  });

  it("defines every v1 allowance and operation limit in named base units", () => {
    expect(policyFor(currentPolicy, "free")).toEqual({
      allowanceLimits: {
        acceptedMessages: 30n,
        fileUploads: 10n,
        generatedDocuments: 0n,
        gmailMessagesExamined: 0n,
        gmailSearches: 0n,
        gmailSends: 0n,
        gmSummons: 0n,
        reminderDeliveries: 3n,
        researchReports: 0n,
        supermemoryIngestionTokens: 10_000n,
        supermemoryRetrievals: 100n,
        vendorUsdMicros: 250_000n,
        workflowStarts: 0n,
      },
      entitlements: ["conversation", "session", "memory", "files", "oneTimeReminders"],
      liveLimits: {
        activeGmSummonsPerSession: 0n,
        activeReminders: 1n,
        concurrentWorkflows: 0n,
        retainedFileBytes: 100_000_000n,
      },
      operationLimits: {
        documentBytes: 0n,
        documentPages: 0n,
        modelStepsPerRequest: 6n,
        researchSearches: 0n,
        uploadBytes: 10_000_000n,
        vendorUsdMicrosPerRequest: 30_000n,
      },
    });
    expect(policyFor(currentPolicy, "adventurer")).toEqual({
      allowanceLimits: {
        acceptedMessages: 300n,
        fileUploads: 100n,
        generatedDocuments: 10n,
        gmailMessagesExamined: 500n,
        gmailSearches: 50n,
        gmailSends: 20n,
        gmSummons: 1n,
        reminderDeliveries: 100n,
        researchReports: 5n,
        supermemoryIngestionTokens: 250_000n,
        supermemoryRetrievals: 2_000n,
        vendorUsdMicros: 7_500_000n,
        workflowStarts: 40n,
      },
      entitlements: [
        "conversation",
        "session",
        "memory",
        "files",
        "oneTimeReminders",
        "documents",
        "researchReports",
        "recurringReminders",
        "workflows",
        "gmail",
        "gmSummon",
      ],
      liveLimits: {
        activeGmSummonsPerSession: 1n,
        activeReminders: 25n,
        concurrentWorkflows: 3n,
        retainedFileBytes: 2_000_000_000n,
      },
      operationLimits: {
        documentBytes: 5_000_000n,
        documentPages: 20n,
        modelStepsPerRequest: 12n,
        researchSearches: 20n,
        uploadBytes: 25_000_000n,
        vendorUsdMicrosPerRequest: 750_000n,
      },
    });
  });

  it.effect("rejects a catalog with a missing Plan entry at startup", () =>
    Effect.gen(function* () {
      const result = yield* parseCatalog({
        currentVersion: "launch-v1",
        policies: [
          {
            plans: { free: policyFor(currentPolicy, "free") },
            version: "launch-v1",
          },
        ],
      }).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects negative launch limits at startup", () =>
    Effect.gen(function* () {
      const policy = retainedCatalog.policies[0];
      const result = yield* parseCatalog({
        currentVersion: "launch-v1",
        policies: [
          {
            plans: {
              adventurer: policy.plans.adventurer,
              free: {
                ...policy.plans.free,
                allowanceLimits: {
                  ...policy.plans.free.allowanceLimits,
                  acceptedMessages: -1n,
                },
              },
            },
            version: "launch-v1",
          },
        ],
      }).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("rejects duplicate retained policy versions at startup", () =>
    Effect.gen(function* () {
      const policy = retainedCatalog.policies[0];
      const result = yield* parseCatalog({
        currentVersion: "launch-v1",
        policies: [policy, policy],
      }).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
