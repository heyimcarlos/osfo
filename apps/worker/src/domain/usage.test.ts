import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { PlanPolicyVersion, ResourcePriceVersion } from "../domain";
import { retainedCatalog } from "./plan-policy";
import { explainActivityShares, rate } from "./usage";

describe("Plan Usage rating", () => {
  it("rates completed model work and generic non-model cost with integer USD micros", () => {
    const result = rate(
      [
        {
          activity: "webAndResearch",
          cachedInputTokens: 500_000n,
          inputTokens: 1_000_000n,
          outputTokens: 250_000n,
          price: {
            cachedInputUsdMicrosPerMillionTokens: 1_000_000n,
            inputUsdMicrosPerMillionTokens: 2_000_000n,
            outputUsdMicrosPerMillionTokens: 4_000_000n,
            priceEntryId: "managed-model-routine",
            resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
          },
        },
      ],
      [
        {
          activity: "filesAndArtifacts",
          ratedCostUsdMicros: 1_500n,
          resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
        },
      ],
      retainedCatalog,
      PlanPolicyVersion.make("shared-usage-v1"),
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success).toEqual({
      components: [
        {
          activity: "webAndResearch",
          evidence: {
            cachedInputTokens: 500_000n,
            inputTokens: 1_000_000n,
            outputTokens: 250_000n,
            priceEntryId: "managed-model-routine",
          },
          ratedCostUsdMicros: 2_500_000n,
          resourcePriceVersion: "resource-prices-2026-08-22",
        },
        {
          activity: "filesAndArtifacts",
          ratedCostUsdMicros: 1_500n,
          resourcePriceVersion: "resource-prices-2026-08-22",
        },
      ],
      planUsageMicros: 2_501_500n,
      ratedCostUsdMicros: 2_501_500n,
      usagePolicyVersion: "shared-usage-v1",
    });
  });

  it("rounds each positive token component up to one USD micro", () => {
    const result = rate(
      [
        {
          activity: "conversationsAndMemory",
          cachedInputTokens: 0n,
          inputTokens: 1n,
          outputTokens: 1n,
          price: {
            cachedInputUsdMicrosPerMillionTokens: 0n,
            inputUsdMicrosPerMillionTokens: 1n,
            outputUsdMicrosPerMillionTokens: 1n,
            priceEntryId: "tiny-model",
            resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
          },
        },
      ],
      [],
      retainedCatalog,
      PlanPolicyVersion.make("shared-usage-v1"),
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success.ratedCostUsdMicros).toBe(2n);
    expect(result.success.planUsageMicros).toBe(2n);
  });

  it("fails closed for an unknown Usage Policy version", () => {
    const result = rate([], [], retainedCatalog, PlanPolicyVersion.make("unknown-policy"));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toMatchObject({
      _tag: "UsageRatingFailed",
      reason: "policyUnavailable",
    });
  });

  it("fails closed for an unrecognized immutable Resource Price entry", () => {
    const result = rate(
      [
        {
          activity: "integrations",
          cachedInputTokens: 0n,
          inputTokens: 1n,
          outputTokens: 0n,
          price: {
            cachedInputUsdMicrosPerMillionTokens: 0n,
            inputUsdMicrosPerMillionTokens: 1n,
            outputUsdMicrosPerMillionTokens: 0n,
            priceEntryId: "caller-invented-price",
            resourcePriceVersion: ResourcePriceVersion.make("caller-invented-version"),
          },
        },
      ],
      [],
      retainedCatalog,
      PlanPolicyVersion.make("shared-usage-v1"),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure.reason).toBe("unrecognizedPriceEntry");
  });

  it("projects only broad plain-language activity shares", () => {
    expect(
      explainActivityShares([
        { activity: "conversationsAndMemory", ratedCostUsdMicros: 3n },
        { activity: "webAndResearch", ratedCostUsdMicros: 1n },
      ]),
    ).toEqual([
      { activity: "conversationsAndMemory", label: "conversations and memory", percentage: 75 },
      { activity: "webAndResearch", label: "web and research", percentage: 25 },
    ]);
  });

  it("pins replacement prices to new work without rewriting the old charge", () => {
    const work = {
      activity: "automations" as const,
      cachedInputTokens: 0n,
      inputTokens: 1_000_000n,
      outputTokens: 0n,
    };
    const oldCharge = rate(
      [
        {
          ...work,
          price: {
            cachedInputUsdMicrosPerMillionTokens: 0n,
            inputUsdMicrosPerMillionTokens: 1_000_000n,
            outputUsdMicrosPerMillionTokens: 0n,
            priceEntryId: "old-provider",
            resourcePriceVersion: ResourcePriceVersion.make("prices-v1"),
          },
        },
      ],
      [],
      retainedCatalog,
      PlanPolicyVersion.make("shared-usage-v1"),
    );
    const newCharge = rate(
      [
        {
          ...work,
          price: {
            cachedInputUsdMicrosPerMillionTokens: 0n,
            inputUsdMicrosPerMillionTokens: 2_000_000n,
            outputUsdMicrosPerMillionTokens: 0n,
            priceEntryId: "replacement-provider",
            resourcePriceVersion: ResourcePriceVersion.make("prices-v2"),
          },
        },
      ],
      [],
      retainedCatalog,
      PlanPolicyVersion.make("shared-usage-v1"),
    );

    expect(Result.getOrThrow(oldCharge).planUsageMicros).toBe(1_000_000n);
    expect(Result.getOrThrow(newCharge).planUsageMicros).toBe(2_000_000n);
    expect(Result.getOrThrow(oldCharge).components[0]?.resourcePriceVersion).toBe("prices-v1");
  });
});
