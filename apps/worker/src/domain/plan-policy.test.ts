import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { PlanPolicyVersion } from "../domain";
import { parseCatalog, policyForVersion, retainedCatalog } from "./plan-policy";

/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Assertions execute inside @effect/vitest Effect callbacks and inspect tagged failures. */

describe("Plan policy catalog", () => {
  it.effect("retains launch-v1 as current until the shared Usage activation gates pass", () =>
    Effect.gen(function* () {
      expect(retainedCatalog.currentVersion).toBe("launch-v1");

      const launch = yield* policyForVersion(retainedCatalog, PlanPolicyVersion.make("launch-v1"));
      expect(launch).toMatchObject({
        plans: {
          adventurer: {
            allowanceLimits: {
              generatedDocuments: 10n,
              vendorUsdMicros: 7_500_000n,
            },
          },
          free: {
            allowanceLimits: {
              generatedDocuments: 0n,
              vendorUsdMicros: 250_000n,
            },
          },
        },
        version: "launch-v1",
      });

      const shared = yield* policyForVersion(
        retainedCatalog,
        PlanPolicyVersion.make("shared-usage-v1"),
      );
      expect(shared).toEqual({
        plans: {
          adventurer: { includedPlanUsageMicros: 6_000_000n },
          free: { includedPlanUsageMicros: 2_000_000n },
        },
        ratedCostUsdMicroToPlanUsageMicro: 1n,
        version: "shared-usage-v1",
      });
    }),
  );

  it.effect("fails closed when a shared Usage policy carries capability counters", () =>
    parseCatalog({
      currentVersion: "shared-usage-v1",
      policies: [
        {
          plans: {
            adventurer: {
              includedPlanUsageMicros: 6_000_000n,
              researchReports: 5n,
            },
            free: { includedPlanUsageMicros: 2_000_000n },
          },
          ratedCostUsdMicroToPlanUsageMicro: 1n,
          version: "shared-usage-v1",
        },
      ],
    }).pipe(
      Effect.flip,
      Effect.map((failure) => expect(failure._tag).toBe("InvalidPlanPolicyCatalog")),
    ),
  );
});
