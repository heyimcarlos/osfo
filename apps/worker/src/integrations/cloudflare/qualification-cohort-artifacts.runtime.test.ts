/* oxlint-disable effecttsgo/async-function -- Runtime tests exercise the Promise-native Cloudflare RPC boundary. */
import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  qualificationCohortArtifactRetentionFailureResponse,
  retainExactQualificationArtifact,
} from "../../qualification-cohort-provisioner";
import {
  type QualificationCohortArtifactAuthorityNamespace,
  retainQualificationCohortArtifact,
} from "./qualification-cohort-artifacts";

/* oxlint-disable eslint/no-underscore-dangle -- Closed authority outcomes use the _tag discriminator. */

const input = {
  body: "{}",
  executionId: "transport-outcome-execution",
  family: "manifest" as const,
  key: "qualification/executions/transport-outcome-execution/cohort/manifest.json",
  metadata: {
    "osfo-execution-id": "transport-outcome-execution",
    "osfo-kind": "qualification-cohort-v1",
  },
};

const namespaceWith = (
  retain: ReturnType<QualificationCohortArtifactAuthorityNamespace["getByName"]>["retain"],
): QualificationCohortArtifactAuthorityNamespace => {
  const namespace: QualificationCohortArtifactAuthorityNamespace = {
    getByName: () => ({
      deletePage: () => Promise.resolve({ _tag: "Missing", code: "test" }),
      deleteRoot: () => Promise.resolve({ _tag: "Missing", code: "test" }),
      fence: () => Promise.resolve({ _tag: "Missing" }),
      inspect: () => Promise.resolve({ _tag: "Missing" }),
      retain,
      sealPage: () => Promise.resolve({ _tag: "Missing", code: "test" }),
      sealRoot: () => Promise.resolve({ _tag: "Missing", code: "test" }),
    }),
  };
  return namespace;
};

it("preserves transport unavailability separately from an authoritative busy outcome", async () => {
  const unavailable = namespaceWith(() => Promise.reject(new Error("rpc unavailable")));
  const unavailableExit = await Effect.runPromiseExit(
    retainQualificationCohortArtifact(unavailable, input),
  );
  expect(unavailableExit._tag).toBe("Failure");

  const busy = namespaceWith(() => Promise.resolve({ _tag: "Busy" }));
  expect(
    await retainExactQualificationArtifact(
      busy,
      input.executionId,
      input.family,
      input.key,
      input.body,
      input.metadata,
    ),
  ).toEqual({ _tag: "Busy" });
  expect(
    await retainExactQualificationArtifact(
      unavailable,
      input.executionId,
      input.family,
      input.key,
      input.body,
      input.metadata,
    ),
  ).toEqual({ _tag: "Unavailable" });
});

it("maps busy and unavailable provisioner outcomes to distinct retryable responses", async () => {
  const busy = qualificationCohortArtifactRetentionFailureResponse({ _tag: "Busy" }, "conflict");
  expect(busy?.status).toBe(503);
  expect(busy?.headers.get("Retry-After")).toBe("1");
  expect(await busy?.json()).toEqual({ error: "qualificationCohortArtifactAuthorityBusy" });

  const unavailable = qualificationCohortArtifactRetentionFailureResponse(
    { _tag: "Unavailable" },
    "conflict",
  );
  expect(unavailable?.status).toBe(503);
  expect(unavailable?.headers.has("Retry-After")).toBe(false);
  expect(await unavailable?.json()).toEqual({
    error: "qualificationCohortArtifactAuthorityUnavailable",
  });
});
