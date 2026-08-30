/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise fakes model Worker boundaries; Effect Vitest assertions execute inside generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "./qualification/qualification-checksum";
import {
  qualificationDistributedEvaluationReportArtifactId,
  qualificationDistributedEvaluationReportCompletionArtifactId,
} from "./qualification/distributed-evaluation-report";
import owner from "./qualification-owner-worker";
import { qualificationDistributedEvaluationConflictArtifactId } from "./workflows/qualification-owner-report";

const sha256Hex = async (encoded: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const completedResponseFixture = async (
  tamper:
    | "bodyHash"
    | "bytes"
    | "completionKey"
    | "contentType"
    | "manifest"
    | "metadata"
    | "plan"
    | "reportKey"
    | null,
) => {
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
    completionArtifactId:
      tamper === "completionKey"
        ? "substituted-completion.json"
        : qualificationDistributedEvaluationReportCompletionArtifactId(executionId),
    completionChecksum: "completion-checksum",
    error: "qualificationAuthorityMaterialMissing" as const,
    executionId,
    failingFamilies: [],
    manifestChecksum:
      tamper === "manifest" ? "sha256:substituted-manifest" : requestContent.manifestChecksum,
    missingFamilies: ["cohort_teardown"],
    phase: "PRE_TEARDOWN" as const,
    planChecksum: tamper === "plan" ? "sha256:substituted-plan" : requestContent.planChecksum,
    reportArtifactId:
      tamper === "reportKey"
        ? "substituted-report.json"
        : qualificationDistributedEvaluationReportArtifactId(executionId),
    reportChecksum: "report-checksum",
    verdict: "MISSING" as const,
    version: "qualification-owner-response-v2" as const,
  };
  const canonicalResponse = canonicalQualificationJson({ body, status: 424 });
  const response =
    tamper === "bytes" ? JSON.stringify({ status: 424, body }, null, 2) : canonicalResponse;
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
        "osfo-body-sha256":
          tamper === "bodyHash" ? "tampered-body-hash" : await sha256Hex(canonicalResponse),
        "osfo-execution-id": executionId,
        "osfo-kind": "qualification-owner-response-v2",
        "osfo-manifest-checksum": body.manifestChecksum,
        "osfo-plan-checksum": body.planChecksum,
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

const rejectsV2ResponseTamper = (
  tamper:
    | "bodyHash"
    | "bytes"
    | "completionKey"
    | "contentType"
    | "manifest"
    | "metadata"
    | "plan"
    | "reportKey",
) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => completedResponseFixture(tamper));
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

it.effect("rejects a retained v2 response with a conflicting body hash", () =>
  rejectsV2ResponseTamper("bodyHash"),
);

it.effect("rejects noncanonical v2 response bytes with copied metadata", () =>
  rejectsV2ResponseTamper("bytes"),
);

// oxlint-disable-next-line vitest/expect-expect -- The shared Effect assertion executes through Effect.runPromise.
it.each(["manifest", "plan", "reportKey", "completionKey"] as const)(
  "rejects a v2 response with substituted invocation identity: %s",
  async (tamper) => Effect.runPromise(rejectsV2ResponseTamper(tamper)),
);

it.each([null, 2, { injected: true }, "qualification-owner-response-v3"])(
  "rejects a legacy-shaped retained response with a declared version: %j",
  async (version) => {
    const fixture = await completedResponseFixture(null);
    const encoded = canonicalQualificationJson({
      body: {
        error: "qualificationAuthorityMaterialMissing",
        executionId: fixture.executionId,
        manifestChecksum: "sha256:manifest",
        missingSources: ["provider_delivery_receipts"],
        planChecksum: "sha256:plan",
        verdict: "MISSING",
        version,
      },
      status: 424,
    });
    const response = await owner.fetch(
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
                  ? { text: () => Promise.resolve(encoded) }
                  : null,
            ),
        },
        QUALIFICATION_OWNER_WORKFLOW: {
          create: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
          get: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }) }),
        },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "qualificationOwnerResponseConflict" });
  },
);

it.each([
  ["present", "errored", false, 409, "qualificationOwnerWorkflowConflict"],
  ["present", "running", false, 409, "qualificationOwnerWorkflowConflict"],
  ["present", "running", true, 409, "qualificationOwnerWorkflowConflict"],
  ["afterStatus", "running", false, 409, "qualificationOwnerWorkflowConflict"],
  ["afterStatus", "complete", false, 409, "qualificationOwnerWorkflowConflict"],
  ["absent", "errored", false, 500, "qualificationOwnerWorkflowFailed"],
] as const)(
  "gives an authenticated collision marker precedence: marker=%s status=%s response=%s",
  async (markerMode, workflowStatus, withResponse, expectedStatus, expectedError) => {
    const fixture = await completedResponseFixture(null);
    const markerArtifactId = qualificationDistributedEvaluationConflictArtifactId(
      fixture.executionId,
    );
    const markerContent = {
      artifactId: markerArtifactId,
      conflictingArtifactId: `qualification/executions/${fixture.executionId}/owner-response.json`,
      executionId: fixture.executionId,
      manifestChecksum: "sha256:manifest",
      planChecksum: "sha256:plan",
      version: "qualification-distributed-evaluation-conflict-v1" as const,
    };
    const marker = { ...markerContent, checksum: qualificationChecksum(markerContent) };
    const encodedMarker = canonicalQualificationJson(marker);
    let markerReads = 0;
    const response = await owner.fetch(
      new Request("https://qualification-owner.internal/v1/executions", {
        body: fixture.invocation,
        method: "POST",
      }),
      {
        ARTIFACTS: {
          get: async (key) =>
            key.endsWith("owner-request.json")
              ? { text: () => Promise.resolve(fixture.request) }
              : key === markerArtifactId
                ? ((markerReads += 1),
                  markerMode === "present" || (markerMode === "afterStatus" && markerReads > 1))
                  ? {
                      customMetadata: {
                        "osfo-artifact-checksum": marker.checksum,
                        "osfo-body-sha256": await sha256Hex(encodedMarker),
                        "osfo-conflicting-artifact-id": marker.conflictingArtifactId,
                        "osfo-execution-id": marker.executionId,
                        "osfo-kind": marker.version,
                        "osfo-manifest-checksum": marker.manifestChecksum,
                        "osfo-plan-checksum": marker.planChecksum,
                      },
                      httpMetadata: { contentType: "application/json" },
                      text: () => Promise.resolve(encodedMarker),
                    }
                  : null
                : withResponse && key.endsWith("owner-response.json")
                  ? {
                      ...fixture.responseMetadata,
                      text: () => Promise.resolve(fixture.response),
                    }
                  : null,
        },
        QUALIFICATION_OWNER_WORKFLOW: {
          create: () =>
            Promise.resolve({ status: () => Promise.resolve({ status: workflowStatus }) }),
          get: () => Promise.resolve({ status: () => Promise.resolve({ status: workflowStatus }) }),
        },
      },
    );

    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ error: expectedError });
  },
);

it.effect("serves an exact canonical v2 response", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => completedResponseFixture(null));
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

    expect(response.status).toBe(424);
    expect(yield* Effect.promise(() => response.json())).toEqual(fixture.body);
  }),
);

it.effect("continues to serve an exact legacy v1 terminal response", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => completedResponseFixture(null));
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
