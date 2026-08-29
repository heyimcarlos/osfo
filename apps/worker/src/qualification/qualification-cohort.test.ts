import { expect, it } from "vitest";

import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import {
  decodeQualificationCohortManifest,
  decodeQualificationParticipantGrant,
  qualificationParticipantGrantArtifactId,
} from "./qualification-cohort";

const manifestContent = {
  cohortId: "cohort-1",
  createdAtUtc: "2026-08-29T16:59:00.000Z",
  executionId: "execution-1",
  expiresAtUtc: "2026-08-30T17:00:00.000Z",
  grantPrefix: "qualification/executions/execution-1/cohort/grants",
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
