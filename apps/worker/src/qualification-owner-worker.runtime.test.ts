/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import owner from "./qualification-owner-worker";

it.effect("rejects a valid retained request replayed under another execution identity", () =>
  Effect.gen(function* () {
    const content = {
      authoritySources: ["worker_admission_receipts"],
      executionId: "execution-a",
      manifest: { acceptanceLevel: "BoundedBeta" },
      manifestChecksum: "sha256:manifest-a",
      plan: { executionId: "execution-a" },
      planChecksum: "sha256:plan-a",
      protocolVersion: "qualification-owner-v1" as const,
      shardRecordLimit: 256 as const,
    };
    const retainedRequest = canonicalQualificationJson({
      ...content,
      artifactChecksum: qualificationChecksum(content),
    });
    let workflowCalls = 0;
    const response = yield* Effect.promise(() =>
      owner.fetch(
        new Request("https://qualification-owner.internal/v1/executions", {
          body: canonicalQualificationJson({
            executionId: "execution-b",
            manifestChecksum: content.manifestChecksum,
            planChecksum: content.planChecksum,
            requestArtifactChecksum: qualificationChecksum(content),
            requestArtifactId: "qualification/executions/execution-a/owner-request.json",
          }),
          method: "POST",
        }),
        {
          ARTIFACTS: {
            get: (key) =>
              Promise.resolve(
                key === "qualification/executions/execution-a/owner-request.json"
                  ? { text: () => Promise.resolve(retainedRequest) }
                  : null,
              ),
          },
          QUALIFICATION_OWNER_WORKFLOW: {
            create: () => {
              workflowCalls += 1;
              return Promise.resolve({ status: () => Promise.resolve({ status: "running" }) });
            },
            get: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
          },
        },
      ),
    );

    expect(response.status).toBe(409);
    expect(workflowCalls).toBe(0);
  }),
);
