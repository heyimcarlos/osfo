/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest assertions execute inside generators. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { canonicalQualificationJson } from "../../qualification/qualification-checksum";
import type { QualificationExecutionListingBucket } from "./qualification-execution-artifacts";
import { runQualificationTrigger } from "./qualification-trigger";

const invocation = {
  acceptanceLevel: "BoundedBeta",
  executionId: "qualification-trigger-test",
  startsAtEpochMs: 0,
  versions: {
    dependencyVersions: { effect: "4.0.0-rc.111" },
    hardLimits: [{ maximum: 1_000, name: "sqlQueries", unit: "queries" }],
    sourceVersion: "qualification-trigger-sha",
    topologyVersion: "cloudflare-v1",
    workloadSeed: 17,
  },
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
