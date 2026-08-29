/* oxlint-disable effecttsgo/async-function -- Runtime tests drive the Promise-native Worker HTTP boundary. */
import { Redacted } from "effect";
import { expect, it } from "vitest";

import { canonicalQualificationJson } from "./qualification/qualification-checksum";
import {
  retainExactQualificationArtifact,
  runQualificationCohortProvisioner,
} from "./qualification-cohort-provisioner";

it("rejects unbounded provisioning pages before touching product authority", async () => {
  let authorityTouched = false;
  const response = await runQualificationCohortProvisioner(
    new Request("https://api.osfo.test/internal/qualification-cohorts", {
      body: canonicalQualificationJson({
        action: "provisionPage",
        executionId: "bounded-provisioning-test",
        pageIndex: 0,
        participants: Array.from({ length: 51 }, (_, index) => ({
          index,
          plan: "free",
          verifiedPhoneNumber: `+1555555${index.toString().padStart(4, "0")}`,
        })),
      }),
      method: "POST",
    }),
    "bounded-provisioning-source",
    Redacted.make("qualification-enrollment-secret"),
    {
      ARTIFACTS: {
        get: () => {
          authorityTouched = true;
          return Promise.resolve(null);
        },
        put: () => {
          authorityTouched = true;
          return Promise.resolve(null);
        },
      },
      DB: {
        get connectionString() {
          authorityTouched = true;
          return "postgres://unbounded-page-must-not-connect.invalid/osfo";
        },
      },
    },
  );

  expect(response.status).toBe(400);
  expect(authorityTouched).toBe(false);
});

it("reconciles an ambiguous immutable artifact write by exact readback", async () => {
  const retained = new Map<string, string>();
  const bucket = {
    get: (key: string) =>
      Promise.resolve(
        retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
      ),
    put: (key: string, value: string) => {
      if (!retained.has(key)) retained.set(key, value);
      return Promise.resolve(null);
    },
  };

  expect(
    await retainExactQualificationArtifact(bucket, "qualification/page-0", "exact-page", {
      "osfo-kind": "qualification-test",
    }),
  ).toBe(true);
  retained.set("qualification/page-1", "conflicting-page");
  expect(
    await retainExactQualificationArtifact(bucket, "qualification/page-1", "expected-page", {
      "osfo-kind": "qualification-test",
    }),
  ).toBe(false);
});
