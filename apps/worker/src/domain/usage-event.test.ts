import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
} from "../domain";
import { parseUsageEvent } from "./usage-event";

/* oxlint-disable effecttsgo/global-date -- Fixed completion evidence proves original-period facts. */

const baseEvent = {
  allowancePeriodId: AllowancePeriodId.make("usage-period"),
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  evidenceReferences: [
    { kind: "gatewayLog" as const, reference: "opaque-gateway-log-id" },
    { kind: "companyCost" as const, reference: "company-cost:model-attempt-1" },
  ],
  manifestVersion: null,
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("managed-routing-v1"),
  occurredAt: new Date("2026-08-23T12:00:00.000Z"),
  rootOperationId: "root-operation-1",
  source: { sourceId: "model-call-attempt-1", sourceType: "ModelCallAttempt" },
  usagePolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
};

describe("Usage Event", () => {
  it("accepts a completed charge with only opaque external evidence references", () => {
    const result = parseUsageEvent({
      ...baseEvent,
      outcome: {
        _tag: "Completed",
        charge: {
          components: [
            {
              activity: "conversationsAndMemory",
              evidence: {
                cachedInputTokens: 0n,
                inputTokens: 1_000n,
                outputTokens: 200n,
                priceEntryId: "managed-model-routine",
              },
              ratedCostUsdMicros: 800n,
              resourcePriceVersion: ResourcePriceVersion.make("resource-prices-2026-08-22"),
            },
          ],
          planUsageMicros: 800n,
          ratedCostUsdMicros: 800n,
          usagePolicyVersion: PlanPolicyVersion.make("shared-usage-v1"),
        },
      },
    });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success.evidenceReferences).toEqual(baseEvent.evidenceReferences);
    expect(result.success).not.toHaveProperty("companyCostUsdMicros");
  });

  it("retains failed and cancelled outcomes without a Plan Usage charge", () => {
    const failed = parseUsageEvent({
      ...baseEvent,
      outcome: { _tag: "Failed" },
      source: { sourceId: "failed-operation", sourceType: "providerOperation" },
    });
    const cancelled = parseUsageEvent({
      ...baseEvent,
      outcome: { _tag: "Cancelled" },
      source: { sourceId: "cancelled-operation", sourceType: "providerOperation" },
    });

    expect(Result.isSuccess(failed)).toBe(true);
    expect(Result.isSuccess(cancelled)).toBe(true);
  });

  it("rejects hidden provider payload fields", () => {
    const result = parseUsageEvent({
      ...baseEvent,
      evidenceReferences: [
        {
          kind: "providerLog",
          providerPayload: { secret: "must-not-persist" },
          reference: "provider-log-1",
        },
      ],
      outcome: { _tag: "Failed" },
    });

    expect(Result.isFailure(result)).toBe(true);
  });
});
