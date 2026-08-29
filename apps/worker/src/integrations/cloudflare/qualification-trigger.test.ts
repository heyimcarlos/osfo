/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import { createQualificationExecutionPlan } from "../../qualification/execution";
import { createBoundedBetaManifest } from "../../qualification/qualification-manifest";
import { qualificationCohortArtifactId } from "../../qualification/qualification-cohort";
import type { QualificationExecutionListingBucket } from "./qualification-execution-artifacts";
import { runQualificationTrigger } from "./qualification-trigger";

const invocation = {
  acceptanceLevel: "BoundedBeta",
  executionId: "qualification-trigger-test",
  startsAtEpochMs: 0,
} as const;

const artifacts = () => {
  const retained = new Map<string, string>();
  const bucket = {
    get: (key: string) =>
      Promise.resolve(
        retained.has(key) ? { text: () => Promise.resolve(retained.get(key) ?? "") } : null,
      ),
    list: () => Promise.resolve({ objects: [], truncated: false as const }),
    put: (key: string, value: string) => {
      retained.set(key, value);
      return Promise.resolve({ etag: "retained" });
    },
  } satisfies QualificationExecutionListingBucket;
  return { bucket, retained };
};

it.effect("rejects an unauthorized qualification invocation without calling the owner", () =>
  Effect.gen(function* () {
    let calls = 0;
    const { bucket } = artifacts();
    const response = yield* Effect.promise(() =>
      runQualificationTrigger(
        new Request("https://api.osfo.ai/internal/qualification-executions", {
          body: canonicalQualificationJson(invocation),
          method: "POST",
        }),
        {
          ARTIFACTS: bucket,
          CF_VERSION_METADATA: { id: "deployed-sha", tag: "", timestamp: "2026-08-29" },
          QUALIFICATION_OWNER: {
            fetch: () => {
              calls += 1;
              return Promise.resolve(new Response(null, { status: 202 }));
            },
          },
          QUALIFICATION_TRIGGER_TOKEN: "operator-secret",
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  }),
);

it.effect("forwards one authorized retained execution to the private owner", () =>
  Effect.gen(function* () {
    const { bucket, retained } = artifacts();
    const manifest = createBoundedBetaManifest({
      dependencyVersions: {
        "@cloudflare/think": "0.15.1",
        agents: "0.20.1",
        effect: "4.0.0-rc.111",
      },
      hardLimits: [
        { maximum: 128, name: "workerMemory", unit: "MiB" },
        { maximum: 1_000, name: "workerSubrequests", unit: "requests" },
        {
          maximum: 250_000,
          name: "qualificationWorkflowSubrequests",
          unit: "requests",
        },
      ],
      sourceVersion: "deployed-sha",
      topologyVersion: "cloudflare-v1",
      workloadSeed: 17,
    });
    const plan = createQualificationExecutionPlan(manifest, 0, invocation.executionId);
    const cohortContent = {
      cohortId: "qualification-trigger-cohort",
      createdAtUtc: "2026-08-29T16:59:00.000Z",
      executionId: invocation.executionId,
      expiresAtUtc: "2099-08-30T17:00:00.000Z",
      grantPrefix: `qualification/executions/${invocation.executionId}/cohort/grants`,
      manifestChecksum: manifest.manifestChecksum,
      notBeforeUtc: "2026-08-29T17:00:00.000Z",
      participantCounts: { adventurer: 100, free: 900 },
      planChecksum: plan.planChecksum,
      sourceVersion: manifest.sourceVersion,
      teardownPolicy: "permanentAccountDeletion" as const,
    };
    retained.set(
      qualificationCohortArtifactId(invocation.executionId),
      canonicalQualificationJson({
        ...cohortContent,
        artifactChecksum: qualificationChecksum(cohortContent),
      }),
    );
    let forwarded = Promise.resolve<string | null>(null);
    const response = yield* Effect.promise(() =>
      runQualificationTrigger(
        new Request("https://api.osfo.ai/internal/qualification-executions", {
          body: canonicalQualificationJson(invocation),
          headers: { authorization: "Bearer operator-secret" },
          method: "POST",
        }),
        {
          ARTIFACTS: bucket,
          CF_VERSION_METADATA: { id: "deployed-sha", tag: "", timestamp: "2026-08-29" },
          QUALIFICATION_OWNER: {
            fetch: (_input, init) => {
              forwarded = new Response(init?.body).text();
              return Promise.resolve(Response.json({ status: "running" }, { status: 202 }));
            },
          },
          QUALIFICATION_TRIGGER_TOKEN: "operator-secret",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toContain('"verdict":"MISSING"');
    expect(yield* Effect.promise(() => forwarded)).toContain(
      '"executionId":"qualification-trigger-test"',
    );
    expect([...retained.keys()]).toEqual(
      expect.arrayContaining([
        "qualification/executions/qualification-trigger-test/owner-request.json",
      ]),
    );
  }),
);
