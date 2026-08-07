import { describe, expect, it } from "@effect/vitest";
import { assessDevelopmentAgentRunEvidence } from "@osfo/db";

const completeEvidence = {
  agentRunId: "96ae49eb-b1ab-41cb-a468-b68893ec82c3",
  assistantOutputCount: "1",
  claimEpoch: "2",
  completedAssistantOutputCount: "1",
  confirmedProviderRequestCount: "1",
  deliveryId: "b1dfd21a-7526-4e52-a732-8e01debd1d52",
  distinctProviderRequestCount: "1",
  executionProfileRef: "oz.openrouter.minimax.minimax-m3.chat-completions.v1",
  fragmentCount: "2",
  modelBinding: "openrouter.chat-completions.minimax.minimax-m3.v1",
  modelCallCount: "1",
  modelCallAttemptCount: "1",
  openModelCallAttemptCount: "0",
  positiveReasoningUsageAttemptCount: "1",
  receiptCount: "1",
  relayConfirmedAttemptCount: "1",
  relayOpenAttemptCount: "0",
  relayTaskCount: "0",
  reservationCount: "1",
  releasedReservationCount: "1",
  reportedUsageAttemptCount: "1",
  runState: "succeeded",
  succeededModelCallCount: "1",
  terminalModelCallAttemptCount: "1",
  threadEventCount: "5",
  threadId: "512e5093-0051-4f82-b452-78d907ead08c",
  unpublishedOutboxCount: "0",
  userMessageCount: "1",
} as const;

describe("development AgentRun reconciliation", () => {
  it("accepts one complete durable identity graph", () => {
    expect(assessDevelopmentAgentRunEvidence(completeEvidence)).toEqual({
      ...completeEvidence,
      verdict: "PASS",
    });
  });

  it("rejects unfinished or duplicate authority", () => {
    expect(
      assessDevelopmentAgentRunEvidence({
        ...completeEvidence,
        distinctProviderRequestCount: "2",
        executionProfileRef: "oz.deterministic.v1",
        receiptCount: "2",
        openModelCallAttemptCount: "1",
        positiveReasoningUsageAttemptCount: "0",
        relayOpenAttemptCount: "1",
      }).verdict,
    ).toBe("FAIL");
  });

  it("rejects a non-Oz execution profile", () => {
    expect(
      assessDevelopmentAgentRunEvidence({
        ...completeEvidence,
        executionProfileRef: "oz.deterministic.v1",
      }).verdict,
    ).toBe("FAIL");
  });

  it("requires one confirmed provider request with reported reasoning usage", () => {
    for (const evidence of [
      { ...completeEvidence, confirmedProviderRequestCount: "0" },
      { ...completeEvidence, distinctProviderRequestCount: "2" },
      { ...completeEvidence, reportedUsageAttemptCount: "0" },
      { ...completeEvidence, positiveReasoningUsageAttemptCount: "0" },
    ]) {
      expect(assessDevelopmentAgentRunEvidence(evidence).verdict).toBe("FAIL");
    }
  });
});
