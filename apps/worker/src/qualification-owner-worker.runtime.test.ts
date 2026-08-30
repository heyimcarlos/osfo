/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import owner from "./qualification-owner-worker";

const completedResponseFixture = (tamper: "contentType" | "metadata" | null) => {
  const executionId = "completed-response-execution";
  const requestContent = {
    authoritySources: ["worker_admission_receipts"],
    cohortArtifactChecksum: "cohort-checksum",
    cohortArtifactId: "cohort.json",
    executionId,
    manifest: { acceptanceLevel: "BoundedBeta" },
    manifestChecksum: "sha256:manifest",
    plan: { executionId },
    planChecksum: "sha256:plan",
    protocolVersion: "qualification-owner-v1" as const,
    shardRecordLimit: 256 as const,
  };
  const requestChecksum = qualificationChecksum(requestContent);
  const request = canonicalQualificationJson({
    ...requestContent,
    artifactChecksum: requestChecksum,
  });
  const body = {
    completionArtifactId: "completion.json",
    completionChecksum: "completion-checksum",
    error: "qualificationAuthorityMaterialMissing" as const,
    executionId,
    failingFamilies: [],
    manifestChecksum: requestContent.manifestChecksum,
    missingFamilies: ["cohort_teardown"],
    phase: "PRE_TEARDOWN" as const,
    planChecksum: requestContent.planChecksum,
    reportArtifactId: "report.json",
    reportChecksum: "report-checksum",
    verdict: "MISSING" as const,
    version: "qualification-owner-response-v2" as const,
  };
  const response = canonicalQualificationJson({ body, status: 424 });
  const invocation = canonicalQualificationJson({
    executionId,
    manifestChecksum: requestContent.manifestChecksum,
    planChecksum: requestContent.planChecksum,
    requestArtifactChecksum: requestChecksum,
    requestArtifactId: `qualification/executions/${executionId}/owner-request.json`,
  });
  return {
    body,
    executionId,
    invocation,
    request,
    response,
    responseMetadata: {
      customMetadata: {
        "osfo-execution-id": executionId,
        "osfo-kind": "qualification-owner-response-v2",
        "osfo-report-checksum":
          tamper === "metadata" ? "other-report-checksum" : body.reportChecksum,
        "osfo-verdict": body.verdict,
      },
      httpMetadata: {
        contentType: tamper === "contentType" ? "text/plain" : "application/json",
      },
    },
  };
};

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

const rejectsV2ResponseTamper = (tamper: "contentType" | "metadata") =>
  Effect.gen(function* () {
    const fixture = completedResponseFixture(tamper);
    const response = yield* Effect.promise(() =>
      owner.fetch(
        new Request("https://qualification-owner.internal/v1/executions", {
          body: fixture.invocation,
          method: "POST",
        }),
        {
          ARTIFACTS: {
            get: (key) =>
              Promise.resolve(
                key.endsWith("owner-request.json")
                  ? { text: () => Promise.resolve(fixture.request) }
                  : key.endsWith("owner-response.json")
                    ? {
                        ...fixture.responseMetadata,
                        text: () => Promise.resolve(fixture.response),
                      }
                    : null,
              ),
          },
          QUALIFICATION_OWNER_WORKFLOW: {
            create: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
            get: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
          },
        },
      ),
    );

    expect(response.status).toBe(409);
    expect(yield* Effect.promise(() => response.json())).toEqual({
      error: "qualificationOwnerResponseConflict",
    });
  });

it.effect("rejects a retained v2 response with conflicting metadata", () =>
  rejectsV2ResponseTamper("metadata"),
);

it.effect("rejects a retained v2 response with conflicting content type", () =>
  rejectsV2ResponseTamper("contentType"),
);

it.effect("continues to serve an exact legacy v1 terminal response", () =>
  Effect.gen(function* () {
    const fixture = completedResponseFixture(null);
    const legacy = canonicalQualificationJson({
      body: {
        error: "qualificationAuthorityMaterialMissing",
        executionId: fixture.executionId,
        manifestChecksum: "sha256:manifest",
        missingSources: ["provider_delivery_receipts"],
        planChecksum: "sha256:plan",
        verdict: "MISSING",
      },
      status: 424,
    });
    const response = yield* Effect.promise(() =>
      owner.fetch(
        new Request("https://qualification-owner.internal/v1/executions", {
          body: fixture.invocation,
          method: "POST",
        }),
        {
          ARTIFACTS: {
            get: (key) =>
              Promise.resolve(
                key.endsWith("owner-request.json")
                  ? { text: () => Promise.resolve(fixture.request) }
                  : key.endsWith("owner-response.json")
                    ? { text: () => Promise.resolve(legacy) }
                    : null,
              ),
          },
          QUALIFICATION_OWNER_WORKFLOW: {
            create: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
            get: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
          },
        },
      ),
    );

    expect(response.status).toBe(424);
  }),
);
