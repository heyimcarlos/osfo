import type { Journey } from "./corpus";
import type { EvidenceVerdict } from "./statistics";
import { isEvidenceCount, isEvidenceSubset } from "./evidence-count";

/** Review counts for one non-safety journey. */
export type JourneyReview = {
  readonly doubleLabeledCases: number;
  readonly journey: Exclude<Journey, "safety">;
  readonly reviewedCases: number;
  readonly totalCases: number;
};

/** Authorship and final approval for one safety case. */
export type SafetyCaseApproval = {
  readonly authorId: string;
  readonly caseId: string;
  readonly finalApproverId: string;
};

/** Human-review evidence for one complete gate. */
export type HumanReviewInput = {
  readonly adjudicatedDisagreements: number;
  readonly authoredSafetyCases: ReadonlyArray<SafetyCaseApproval>;
  readonly blinded: boolean;
  readonly disagreements: number;
  readonly journeyReviews: ReadonlyArray<JourneyReview>;
  readonly reviewedSafetyCases: number;
  readonly totalSafetyCases: number;
};

/** Human-review verdict and incomplete governance reasons. */
export type HumanReviewAssessment = {
  readonly reasons: ReadonlyArray<string>;
  readonly verdict: EvidenceVerdict;
};

/** Assess complete-gate human coverage and independent safety approval. */
export const assessHumanReview = (input: HumanReviewInput): HumanReviewAssessment => {
  const reasons: Array<string> = [];
  if (
    !isEvidenceSubset(input.reviewedSafetyCases, input.totalSafetyCases) ||
    input.journeyReviews.some(
      (review) =>
        !isEvidenceSubset(review.reviewedCases, review.totalCases) ||
        !isEvidenceSubset(review.doubleLabeledCases, review.reviewedCases),
    ) ||
    !isEvidenceCount(input.disagreements) ||
    !isEvidenceCount(input.adjudicatedDisagreements) ||
    input.adjudicatedDisagreements > input.disagreements
  ) {
    reasons.push("Review counts must be valid non-negative integer subsets.");
  }
  if (!input.blinded) reasons.push("Open-ended human review must be blinded.");
  if (input.totalSafetyCases === 0 || input.reviewedSafetyCases !== input.totalSafetyCases) {
    reasons.push("Every safety case requires human review.");
  }
  const requiredJourneys: ReadonlyArray<JourneyReview["journey"]> = [
    "ordinary",
    "memory",
    "file-analysis",
    "gmail",
    "research-report",
    "document-build",
    "scheduled-email",
  ];
  for (const journey of requiredJourneys) {
    if (input.journeyReviews.filter((review) => review.journey === journey).length !== 1) {
      reasons.push(`${journey} requires exactly one human-review coverage record.`);
    }
  }
  for (const review of input.journeyReviews) {
    const required = Math.max(20, Math.ceil(review.totalCases * 0.2));
    if (review.reviewedCases < required) {
      reasons.push(`${review.journey} requires at least ${required} reviewed cases.`);
    }
    if (review.doubleLabeledCases < required) {
      reasons.push(`${review.journey} requires at least ${required} double-labeled cases.`);
    }
  }
  if (input.authoredSafetyCases.some((item) => item.authorId === item.finalApproverId)) {
    reasons.push("A safety-case author cannot give final approval.");
  }
  if (input.authoredSafetyCases.length !== input.totalSafetyCases) {
    reasons.push("Every safety case requires recorded authorship and final approval.");
  }
  if (
    new Set(input.authoredSafetyCases.map((item) => item.caseId)).size !== input.totalSafetyCases
  ) {
    reasons.push("Safety-case approval records require unique case identities.");
  }
  if (input.adjudicatedDisagreements !== input.disagreements) {
    reasons.push("Every reviewer disagreement requires third-reviewer adjudication.");
  }
  return { reasons, verdict: reasons.length === 0 ? "PASS" : "MISSING" };
};
