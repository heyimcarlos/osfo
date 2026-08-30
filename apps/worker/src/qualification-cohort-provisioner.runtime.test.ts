/* oxlint-disable effecttsgo/async-function -- Runtime tests drive the Promise-native Worker HTTP boundary. */
import { Redacted } from "effect";
import { expect, it } from "vitest";

import { AgentId, UserId } from "./domain";
import { FileDigest } from "./domain/file-content";
import type { WebFileUpload } from "./agents/osfo/web-file-upload";
import { canonicalQualificationJson } from "./qualification/qualification-checksum";
import {
  qualificationDocumentBuildFixture,
  qualificationDocumentBuildFixturePolicy,
} from "./qualification/qualification-cohort";
import {
  prepareQualificationDocumentBuildFixture,
  retainExactQualificationArtifact,
  runQualificationCohortProvisioner,
} from "./qualification-cohort-provisioner";

/* oxlint-disable eslint/no-underscore-dangle -- Closed boundary outcomes use Effect-style _tag discriminators. */

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

it("provisions and authenticates the deterministic fixture through the normal File port", async () => {
  const uploads: Array<unknown> = [];
  let snapshotDigest = qualificationDocumentBuildFixturePolicy.sha256;
  const fixture = qualificationDocumentBuildFixture(
    "qualification-file-execution",
    "free",
    0,
    qualificationDocumentBuildFixturePolicy,
  );
  const port = {
    inspectDocumentBuildSourceSnapshot: () =>
      Promise.resolve({
        _tag: "Found" as const,
        byteLength: 108n,
        fileId: fixture.fileId,
        mediaType: "text/plain" as const,
        sha256: snapshotDigest,
        state: "ready" as const,
        userId: UserId.make("qualification-file-user"),
      }),
    uploadUserTextFile: (request: WebFileUpload.Request) => {
      uploads.push(request);
      return Promise.resolve({
        _tag: "Uploaded" as const,
        fileId: fixture.fileId,
        fileName: "qualification-document-source.txt",
        mediaType: "text/plain" as const,
        state: "ready" as const,
      });
    },
  };
  const input = {
    agentId: AgentId.make("qualification-file-agent"),
    authSessionId: "qualification-file-auth-session",
    executionId: "qualification-file-execution",
    index: 0,
    plan: "free" as const,
    policy: qualificationDocumentBuildFixturePolicy,
    userId: UserId.make("qualification-file-user"),
  };

  const first = await prepareQualificationDocumentBuildFixture(port, input);
  const replay = await prepareQualificationDocumentBuildFixture(port, input);
  expect(first._tag).toBe("Ready");
  expect(replay).toEqual(first);
  expect(uploads).toHaveLength(2);

  snapshotDigest = FileDigest.make(`sha256:${"a".repeat(64)}`);
  expect(await prepareQualificationDocumentBuildFixture(port, input)).toEqual({ _tag: "Conflict" });
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
