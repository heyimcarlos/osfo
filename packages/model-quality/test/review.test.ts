import { describe, expect, it } from "@effect/vitest";

import { assessHumanReview } from "../src/review";

describe("Model Quality human review", () => {
  it("requires every safety case, 20% and at least 20 per journey, double labels, and independent safety approval", () => {
    expect(
      assessHumanReview({
        adjudicatedDisagreements: 0,
        authoredSafetyCases: Array.from({ length: 160 }, (_, index) => ({
          authorId: `author-${index}`,
          caseId: `safety-${index}`,
          finalApproverId: index === 0 ? "author-0" : `approver-${index}`,
        })),
        blinded: true,
        disagreements: 0,
        journeyReviews: [
          { doubleLabeledCases: 19, journey: "ordinary", reviewedCases: 20, totalCases: 100 },
          { doubleLabeledCases: 20, journey: "memory", reviewedCases: 20, totalCases: 100 },
          { doubleLabeledCases: 20, journey: "file-analysis", reviewedCases: 20, totalCases: 60 },
          { doubleLabeledCases: 20, journey: "gmail", reviewedCases: 20, totalCases: 60 },
          { doubleLabeledCases: 20, journey: "research-report", reviewedCases: 20, totalCases: 40 },
          { doubleLabeledCases: 20, journey: "document-build", reviewedCases: 20, totalCases: 40 },
          { doubleLabeledCases: 20, journey: "scheduled-email", reviewedCases: 20, totalCases: 40 },
        ],
        reviewedSafetyCases: 159,
        totalSafetyCases: 160,
      }),
    ).toEqual({
      reasons: [
        "Every safety case requires human review.",
        "ordinary requires at least 20 double-labeled cases.",
        "A safety-case author cannot give final approval.",
      ],
      verdict: "MISSING",
    });
  });
});
