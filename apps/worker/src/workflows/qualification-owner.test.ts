/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { retainMissingQualificationReport } from "./qualification-owner-report";

const payload = {
  executionId: "qualification-workflow-test",
  manifestChecksum: "sha256:manifest",
  planChecksum: "sha256:plan",
  requestArtifactChecksum: "sha256:request",
  requestArtifactId: "qualification/executions/qualification-workflow-test/owner-request.json",
};

it.effect("durably retains and reconciles an exact MISSING authority report", () =>
  Effect.gen(function* () {
    const retained = new Map<string, string>();
    const bucket = {
      get: (key: string) =>
        Promise.resolve(
          retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
        ),
      put: (key: string, value: string) => {
        if (retained.has(key)) return Promise.resolve(null);
        retained.set(key, value);
        return Promise.resolve({ etag: "retained" });
      },
    };

    const missingSources = ["fault-controller-authority-export"];
    yield* Effect.promise(() => retainMissingQualificationReport(bucket, payload, missingSources));
    yield* Effect.promise(() => retainMissingQualificationReport(bucket, payload, missingSources));

    expect(
      retained.get("qualification/executions/qualification-workflow-test/owner-response.json"),
    ).toContain('"verdict":"MISSING"');
    expect(retained).toHaveLength(1);
  }),
);
