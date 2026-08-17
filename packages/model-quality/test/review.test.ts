import { describe, expect, it } from "@effect/vitest";

import { assessHumanReview } from "../src/review";
import { initialCorpusManifest } from "../src/corpus";

describe("Model Quality human review", () => {
  it("requires every safety case, 20% and at least 20 per journey, double labels, and independent safety approval", () => {
    expect(
      assessHumanReview(
        {
          adjudicatedDisagreements: 0,
          assessedAt: "2026-08-16T12:00:00.000Z",
          assessmentId: "human-assessment-1",
          authoredSafetyCases: Array.from({ length: 160 }, (_, index) => ({
            authorId: `author-${index}`,
            caseId: `safety-${(index + 1).toString().padStart(3, "0")}`,
            finalApproverId: index === 0 ? "author-0" : `approver-${index}`,
          })),
          blinded: true,
          corpusDigest: initialCorpusManifest.contentDigest,
          disagreements: 0,
          journeyReviews: (
            [
              { doubleLabeledCases: 19, journey: "ordinary", reviewedCases: 20, totalCases: 100 },
              { doubleLabeledCases: 20, journey: "memory", reviewedCases: 20, totalCases: 100 },
              {
                doubleLabeledCases: 20,
                journey: "file-analysis",
                reviewedCases: 20,
                totalCases: 60,
              },
              { doubleLabeledCases: 20, journey: "gmail", reviewedCases: 20, totalCases: 60 },
              {
                doubleLabeledCases: 20,
                journey: "research-report",
                reviewedCases: 20,
                totalCases: 40,
              },
              {
                doubleLabeledCases: 20,
                journey: "document-build",
                reviewedCases: 20,
                totalCases: 40,
              },
              {
                doubleLabeledCases: 20,
                journey: "scheduled-email",
                reviewedCases: 20,
                totalCases: 40,
              },
            ] as const
          ).map((review) => {
            const reviewedCaseIds = initialCorpusManifest.cases
              .filter((item) => item.journey === review.journey)
              .slice(0, review.reviewedCases)
              .map((item) => item.id);
            return {
              doubleLabeledCaseIds: reviewedCaseIds.slice(0, review.doubleLabeledCases),
              doubleLabeledCases: review.doubleLabeledCases,
              journey: review.journey,
              reviewedCaseIds,
              reviewedCases: review.reviewedCases,
              totalCases: review.totalCases,
            };
          }),
          reviewedSafetyCases: 159,
          reviewedSafetyCaseIds: initialCorpusManifest.cases
            .filter((item) => item.journey === "safety")
            .slice(0, 159)
            .map((item) => item.id),
          reviewAuthorityId: "human-review-owner-1",
          signature: "invalid-signature",
          totalSafetyCases: 160,
        },
        initialCorpusManifest,
      ),
    ).toMatchObject({
      reasons: [
        "Every safety case requires human review.",
        "ordinary requires at least 20 double-labeled cases.",
        "A safety-case author cannot give final approval.",
      ],
      verdict: "MISSING",
    });
  });
});
