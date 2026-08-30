import { expect, it } from "vitest";

import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import {
  decodeQualificationCohortManifest,
  decodeQualificationParticipantGrant,
  qualificationDocumentBuildFixture,
  qualificationDocumentBuildFixtureBytes,
  qualificationDocumentBuildFixturePolicy,
  qualificationDocumentBuildMessage,
  qualificationParticipantGrantArtifactId,
} from "./qualification-cohort";
import { qualificationCohortArtifactProtocol } from "./cohort-artifact-authority-contract";

const manifestContent = {
  artifactAuthorityProtocol: qualificationCohortArtifactProtocol,
  cohortId: "cohort-1",
  createdAtUtc: "2026-08-29T16:59:00.000Z",
  executionId: "execution-1",
  expiresAtUtc: "2026-08-30T17:00:00.000Z",
  grantPrefix: "qualification/executions/execution-1/cohort/grants",
  documentBuildFixturePolicy: qualificationDocumentBuildFixturePolicy,
  manifestChecksum: "manifest-1",
  notBeforeUtc: "2026-08-29T17:00:00.000Z",
  participantCounts: { adventurer: 100, free: 900 },
  planChecksum: "plan-1",
  sourceVersion: "source-1",
  teardownPolicy: "permanentAccountDeletion" as const,
};
const manifest = {
  ...manifestContent,
  artifactChecksum: qualificationChecksum(manifestContent),
};
const grantContent = {
  agentId: "agent-1",
  cohortChecksum: manifest.artifactChecksum,
  cohortId: manifest.cohortId,
  createdAtUtc: manifest.createdAtUtc,
  executionId: manifest.executionId,
  expiresAtUtc: manifest.expiresAtUtc,
  index: 0,
  isolation: "disposableQualificationUser" as const,
  notBeforeUtc: manifest.notBeforeUtc,
  plan: "free" as const,
  provisionChecksum: "provision-checksum-1",
  provisionId: "provision-1",
  routeId: "route-1",
  documentBuildFixture: qualificationDocumentBuildFixture(
    "execution-1",
    "free",
    0,
    qualificationDocumentBuildFixturePolicy,
  ),
  sessionId: "session-1",
  status: "ACTIVE" as const,
  userId: "user-1",
};
const grant = { ...grantContent, artifactChecksum: qualificationChecksum(grantContent) };

it("accepts only checksummed disposable cohort grants", () => {
  const decodedManifest = decodeQualificationCohortManifest(canonicalQualificationJson(manifest));
  const decodedGrant = decodeQualificationParticipantGrant(canonicalQualificationJson(grant));

  expect(decodedManifest).toEqual(manifest);
  expect(decodedGrant).toEqual(grant);
  expect(qualificationParticipantGrantArtifactId(manifest, "free", 0)).toBe(
    "qualification/executions/execution-1/cohort/grants/free/00000000.json",
  );
});

it("freezes one deterministic real File fixture identity per disposable participant", () => {
  const fixture = qualificationDocumentBuildFixture(
    manifest.executionId,
    "free",
    0,
    manifest.documentBuildFixturePolicy,
  );

  expect(fixture).toEqual(grant.documentBuildFixture);
  expect(fixture.fileId).toMatch(/^web:[0-9a-f-]{36}$/u);
  expect(fixture.byteLength).toBe("108");
  expect(fixture.mediaType).toBe("text/plain");
  expect(fixture.sha256).toBe(
    "sha256:d7a6eeb9ea1e679086bf7290262c26a4e1f5ca95d6f90f02c2e3abe659367b2c",
  );
  expect(qualificationDocumentBuildMessage(fixture)).toContain(fixture.fileId);
  expect(
    qualificationDocumentBuildFixture(
      manifest.executionId,
      "free",
      1,
      manifest.documentBuildFixturePolicy,
    ).fileId,
  ).not.toBe(fixture.fileId);
  return crypto.subtle
    .digest("SHA-256", Uint8Array.from(qualificationDocumentBuildFixtureBytes).buffer)
    .then((digest) => {
      expect(
        `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ).toBe(fixture.sha256);
    });
});

it("rejects an ordinary User-shaped record without a disposable participant grant", () => {
  expect(
    decodeQualificationParticipantGrant(
      canonicalQualificationJson({
        agentId: "agent-ordinary",
        plan: "free",
        registrationCompletedAt: "2026-08-29T17:00:00.000Z",
        userId: "user-ordinary",
      }),
    ),
  ).toBeNull();
  expect(
    decodeQualificationParticipantGrant(
      canonicalQualificationJson({ ...grant, isolation: "ordinaryRegisteredUser" }),
    ),
  ).toBeNull();
});

it("rejects invalid and reversed qualification lifetimes", () => {
  const invalidExpiry = { ...grant, expiresAtUtc: "not-a-date" };
  const reversed = {
    ...grantContent,
    expiresAtUtc: "2026-08-29T16:58:00.000Z",
  };

  expect(
    decodeQualificationParticipantGrant(
      canonicalQualificationJson({
        ...invalidExpiry,
        artifactChecksum: qualificationChecksum({
          ...grantContent,
          expiresAtUtc: "not-a-date",
        }),
      }),
    ),
  ).toBeNull();
  expect(
    decodeQualificationParticipantGrant(
      canonicalQualificationJson({
        ...reversed,
        artifactChecksum: qualificationChecksum(reversed),
      }),
    ),
  ).toBeNull();
});
