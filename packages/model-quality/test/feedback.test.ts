import { describe, expect, it } from "@effect/vitest";

import {
  assessCorpusRebalancing,
  createEvaluationCopyRegistry,
  evaluationExpiry,
  minimizeReviewedFailure,
  planWeeklySampling,
  propagateSourceDeletion,
  reviewPrivateContent,
  triageFeedbackSignal,
} from "../src/feedback";

describe("privacy-safe production feedback", () => {
  it("caps stratified automatic sampling at one percent and 200 per journey each week", () => {
    expect(planWeeklySampling(120)).toBe(2);
    expect(planWeeklySampling(50_000)).toBe(200);
  });

  it("enforces retention limits", () => {
    const createdAt = Date.parse("2026-08-17T00:00:00.000Z");
    expect(evaluationExpiry("temporary-content", createdAt)).toBe(
      Date.parse("2026-08-18T00:00:00.000Z"),
    );
    expect(evaluationExpiry("content-free-metadata", createdAt)).toBe(
      Date.parse("2026-09-16T00:00:00.000Z"),
    );
    expect(evaluationExpiry("consented-real-trace", createdAt)).toBe(
      Date.parse("2026-11-15T00:00:00.000Z"),
    );
  });

  it("prohibits random private reading and starts deletion across every evaluation copy", () => {
    expect(reviewPrivateContent({ basis: "random-sample" })).toEqual({ verdict: "PROHIBITED" });
    expect(
      propagateSourceDeletion(
        createEvaluationCopyRegistry("thread-1", [
          { copyId: "raw-output", location: "live" },
          { copyId: "review-bundle", location: "live" },
          {
            copyId: "hosted-grader-copy",
            location: "provider-recovery",
            recoveryExpiresAt: "2026-09-16T12:00:00.000Z",
          },
        ]),
        "2026-08-17T12:00:00.000Z",
      ),
    ).toEqual({
      liveDeletions: [
        { copyId: "raw-output", requestedAt: "2026-08-17T12:00:00.000Z", sourceId: "thread-1" },
        { copyId: "review-bundle", requestedAt: "2026-08-17T12:00:00.000Z", sourceId: "thread-1" },
      ],
      providerRecoveryExpiries: [
        {
          copyId: "hosted-grader-copy",
          recoveryExpiresAt: "2026-09-16T12:00:00.000Z",
          sourceId: "thread-1",
        },
      ],
    });
  });

  it("treats production signals as triage leads instead of gold labels or release evidence", () => {
    expect(triageFeedbackSignal("gm-summon")).toEqual({
      canChangeReleaseVerdict: false,
      classification: "triage-lead",
      requiresReview: true,
    });
  });

  it("rebalances only after accepted production evidence and keeps stratum minimums", () => {
    expect(assessCorpusRebalancing({ acceptedMessages: 24_999, productionDays: 30 })).toEqual({
      aggregateWeightsMayChange: false,
      criticalRiskMinimumsRemain: true,
      perJourneyMinimumsRemain: true,
      verdict: "MISSING",
    });
    expect(assessCorpusRebalancing({ acceptedMessages: 25_000, productionDays: 30 })).toMatchObject(
      {
        aggregateWeightsMayChange: true,
        verdict: "PASS",
      },
    );
  });

  it("turns an adjudicated failure into minimized synthetic content", () => {
    expect(
      minimizeReviewedFailure({
        expectedOutcome: "Ask for Approval before the external effect.",
        failureMode: "approval omitted",
        reviewState: "adjudicated",
      }),
    ).toEqual({
      expectedOutcome: "Ask for Approval before the external effect.",
      prompt: "Synthetic reproduction of failure mode: approval omitted",
      provenance: "synthetic",
    });
  });
});
