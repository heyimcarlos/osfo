import { expect, it } from "vitest";

import { AgentId, ConversationRouteId, ThinkSubmissionId, UserId } from "../domain";
import { canonicalQualificationJson, qualificationChecksum } from "./qualification-checksum";
import {
  qualificationAttemptArtifactId,
  qualificationAdmissionReceipt,
  verifyQualificationConversationAttempt,
} from "./qualification-attempt";

const context = {
  attemptId: "attempt-1",
  executionId: "execution-1",
  journey: "ordinaryConversation" as const,
  offeredAtEpochMs: 1_787_500_000_000,
  planChecksum: "sha256:plan-1",
  region: "americas" as const,
  rootId: "root-1",
  runId: "run-1",
};
const input = {
  authorization: { user: { _tag: "ActiveUser" as const, userId: UserId.make("user-1") } },
  message: "Run the ordinary conversation journey",
  proofArtifactChecksum: "",
  proofArtifactId: qualificationAttemptArtifactId(context),
  qualificationContext: context,
  routeId: ConversationRouteId.make("route-1"),
  submissionId: ThinkSubmissionId.make("submission-1"),
};
const content = {
  agentId: AgentId.make("agent-1"),
  authSessionExpiresAtUtc: "2026-08-30T17:00:00.000Z",
  authSessionId: "auth-session-1",
  context,
  messageChecksum: qualificationChecksum({ message: input.message }),
  participantGrantChecksum: "sha256:participant-grant-1",
  routeId: input.routeId,
  submissionId: input.submissionId,
  userId: input.authorization.user.userId,
};
const artifactChecksum = qualificationChecksum(content);
const encoded = canonicalQualificationJson({ ...content, artifactChecksum });

it("accepts only the exact retained server qualification attempt", () => {
  expect(
    verifyQualificationConversationAttempt(
      encoded,
      { ...input, proofArtifactChecksum: artifactChecksum },
      AgentId.make("agent-1"),
    ),
  ).toBe(true);
});

it("rejects cross-root and cross-Agent proof replay", () => {
  expect(
    verifyQualificationConversationAttempt(
      encoded,
      {
        ...input,
        proofArtifactChecksum: artifactChecksum,
        qualificationContext: { ...context, rootId: "root-2" },
      },
      AgentId.make("agent-1"),
    ),
  ).toBe(false);
  expect(
    verifyQualificationConversationAttempt(
      encoded,
      { ...input, proofArtifactChecksum: artifactChecksum },
      AgentId.make("agent-2"),
    ),
  ).toBe(false);
});

it("derives accepted and rejected Worker facts from the Agent outcome", () => {
  const accepted = qualificationAdmissionReceipt(
    { ...input, proofArtifactChecksum: artifactChecksum },
    AgentId.make("agent-1"),
    {
      decision: "accepted",
      occurredAt: "2026-08-29T17:00:00.000Z",
      thinkSubmissionId: "submission-1",
    },
  );
  const rejected = qualificationAdmissionReceipt(
    { ...input, proofArtifactChecksum: artifactChecksum },
    AgentId.make("agent-1"),
    { decision: "capacityRejected", occurredAt: "2026-08-29T17:00:00.000Z" },
  );

  expect(accepted).toMatchObject({
    admissionDecision: "accepted",
    rootId: "root-1",
    thinkSubmissionId: "submission-1",
  });
  expect(rejected).toMatchObject({
    admissionDecision: "capacityRejected",
    rootId: "root-1",
    thinkSubmissionId: null,
  });
});
