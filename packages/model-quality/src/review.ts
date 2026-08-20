import { verify } from "node:crypto";

import {
  verifyCorpusManifest,
  type CorpusLineage,
  type CorpusManifest,
  type Journey,
} from "./corpus";
import { digestValue, type EvidenceDigest } from "./manifest";
import type { EvidenceVerdict } from "./statistics";
import { isEvidenceCount, isEvidenceSubset } from "./evidence-count";
import { parseApprovalId, parseCaseId, parseEvidenceInstant } from "./identity";

/** Review counts for one non-safety journey. */
export type JourneyReview = {
  readonly doubleLabeledCaseIds: ReadonlyArray<string>;
  readonly doubleLabeledCases: number;
  readonly journey: Exclude<Journey, "safety">;
  readonly reviewedCaseIds: ReadonlyArray<string>;
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
  readonly assessedAt: string;
  readonly assessmentId: string;
  readonly authoredSafetyCases: ReadonlyArray<SafetyCaseApproval>;
  readonly blinded: boolean;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly disagreements: number;
  readonly journeyReviews: ReadonlyArray<JourneyReview>;
  readonly reviewedSafetyCases: number;
  readonly reviewedSafetyCaseIds: ReadonlyArray<string>;
  readonly reviewAuthorityId: string;
  readonly signature: string;
  readonly totalSafetyCases: number;
};

/** Human-review verdict and incomplete governance reasons. */
export type HumanReviewAssessment = {
  readonly affectedCases: number;
  readonly contentDigest: EvidenceDigest<"human-review">;
  readonly evidence: HumanReviewInput;
  readonly reasons: ReadonlyArray<string>;
  readonly reviewedCases: number;
  readonly verdict: EvidenceVerdict;
};

/** Assess complete-gate human coverage and independent safety approval. */
export const assessHumanReview = (
  input: HumanReviewInput,
  corpusManifest: CorpusManifest,
  corpusLineage: CorpusLineage = [],
): HumanReviewAssessment => {
  const reasons: Array<string> = [];
  const corpusJourneyCounts = new Map<Journey, number>();
  for (const item of corpusManifest.cases) {
    corpusJourneyCounts.set(item.journey, (corpusJourneyCounts.get(item.journey) ?? 0) + 1);
  }
  if (
    !verifyCorpusManifest(corpusManifest, corpusLineage) ||
    input.corpusDigest !== corpusManifest.contentDigest
  ) {
    reasons.push("Human review must identify one verified corpus manifest.");
  }
  if (
    !isEvidenceSubset(input.reviewedSafetyCases, input.totalSafetyCases) ||
    input.journeyReviews.some(
      (review) =>
        !isEvidenceSubset(review.reviewedCases, review.totalCases) ||
        !isEvidenceSubset(review.doubleLabeledCases, review.reviewedCases) ||
        review.reviewedCases !== review.reviewedCaseIds.length ||
        review.doubleLabeledCases !== review.doubleLabeledCaseIds.length,
    ) ||
    !isEvidenceCount(input.disagreements) ||
    !isEvidenceCount(input.adjudicatedDisagreements) ||
    input.adjudicatedDisagreements > input.disagreements
  ) {
    reasons.push("Review counts must be valid non-negative integer subsets.");
  }
  if (
    parseEvidenceInstant(input.assessedAt).kind === "error" ||
    parseApprovalId(input.reviewAuthorityId).kind === "error" ||
    parseCaseId(input.assessmentId).kind === "error" ||
    input.authoredSafetyCases.some(
      (item) =>
        parseApprovalId(item.authorId).kind === "error" ||
        parseApprovalId(item.finalApproverId).kind === "error" ||
        parseCaseId(item.caseId).kind === "error",
    )
  ) {
    reasons.push("Human-review identities and assessment time must be parsed.");
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
    const journeyCaseIds = new Set<string>(
      corpusManifest.cases.filter((item) => item.journey === review.journey).map((item) => item.id),
    );
    const reviewedIds = new Set(review.reviewedCaseIds);
    if (
      reviewedIds.size !== review.reviewedCaseIds.length ||
      new Set(review.doubleLabeledCaseIds).size !== review.doubleLabeledCaseIds.length ||
      review.reviewedCaseIds.some((id) => !journeyCaseIds.has(id)) ||
      review.doubleLabeledCaseIds.some((id) => !reviewedIds.has(id))
    ) {
      reasons.push(`${review.journey} review case evidence is invalid.`);
    }
    if (review.totalCases !== corpusJourneyCounts.get(review.journey)) {
      reasons.push(`${review.journey} review totals must match the corpus.`);
    }
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
  const corpusSafetyCaseIds = new Set<string>(
    corpusManifest.cases.filter((item) => item.journey === "safety").map((item) => item.id),
  );
  const corpusSafetyCases = new Map<string, CorpusManifest["cases"][number]>(
    corpusManifest.cases.filter((item) => item.journey === "safety").map((item) => [item.id, item]),
  );
  if (
    input.totalSafetyCases !== corpusSafetyCaseIds.size ||
    input.authoredSafetyCases.some((item) => !corpusSafetyCaseIds.has(item.caseId)) ||
    input.reviewedSafetyCases !== input.reviewedSafetyCaseIds.length ||
    new Set(input.reviewedSafetyCaseIds).size !== input.reviewedSafetyCaseIds.length ||
    input.reviewedSafetyCaseIds.some((id) => !corpusSafetyCaseIds.has(id))
  ) {
    reasons.push("Safety-case review identities and totals must match the corpus.");
  }
  if (
    input.authoredSafetyCases.some((item) => {
      const corpusCase = corpusSafetyCases.get(item.caseId);
      return (
        corpusCase === undefined ||
        item.authorId !== corpusCase.authorId ||
        item.finalApproverId !== corpusCase.finalApproverId
      );
    })
  ) {
    reasons.push("Safety-case authors and final approvers must match corpus approval metadata.");
  }
  if (
    new Set(input.authoredSafetyCases.map((item) => item.caseId)).size !== input.totalSafetyCases
  ) {
    reasons.push("Safety-case approval records require unique case identities.");
  }
  if (input.adjudicatedDisagreements !== input.disagreements) {
    reasons.push("Every reviewer disagreement requires third-reviewer adjudication.");
  }
  const evidence = freezeHumanReviewInput(input);
  const affectedCases =
    input.totalSafetyCases + input.journeyReviews.reduce((sum, item) => sum + item.totalCases, 0);
  const reviewedCases =
    input.reviewedSafetyCaseIds.length +
    input.journeyReviews.reduce((sum, item) => sum + item.reviewedCaseIds.length, 0);
  const unsigned = Object.freeze({
    affectedCases,
    evidence,
    reasons: Object.freeze(reasons),
    reviewedCases,
    verdict: reasons.length === 0 ? ("PASS" as const) : ("MISSING" as const),
  });
  return Object.freeze({
    ...unsigned,
    contentDigest: digestValue("human-review", unsigned),
  });
};

/** Verify a persisted human assessment by recomputing its evidence and digest. */
export const verifyHumanReviewAssessment = (
  assessment: HumanReviewAssessment,
  corpusManifest: CorpusManifest,
  corpusLineage: CorpusLineage = [],
): boolean => {
  const recomputed = assessHumanReview(assessment.evidence, corpusManifest, corpusLineage);
  return (
    reviewAuthorityIds.has(assessment.evidence.reviewAuthorityId) &&
    verifyHumanReviewSignature(assessment.evidence) &&
    assessment.contentDigest === recomputed.contentDigest &&
    assessment.verdict === recomputed.verdict &&
    assessment.affectedCases === recomputed.affectedCases &&
    assessment.reviewedCases === recomputed.reviewedCases &&
    assessment.reasons.length === recomputed.reasons.length &&
    assessment.reasons.every((reason, index) => reason === recomputed.reasons[index])
  );
};

const reviewAuthorityIds = new Set(["human-review-owner-1"]);

const reviewEvidencePublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABbq+Me0sknTj7rdmH1i0M3brIf1l4JuDuEK+GFFhC+E=
-----END PUBLIC KEY-----`;

/** Produce the digest signed by the independent human-review authority. */
export const humanReviewSigningDigest = (
  input: HumanReviewInput,
): EvidenceDigest<"human-review"> => {
  const { signature: ignoredSignature, ...signed } = input;
  void ignoredSignature;
  return digestValue("human-review", signed);
};

const verifyHumanReviewSignature = (input: HumanReviewInput): boolean =>
  verify(
    null,
    Buffer.from(humanReviewSigningDigest(input)),
    reviewEvidencePublicKey,
    Buffer.from(input.signature, "base64"),
  );

const freezeHumanReviewInput = (input: HumanReviewInput): HumanReviewInput =>
  Object.freeze({
    ...input,
    authoredSafetyCases: Object.freeze(
      input.authoredSafetyCases.map((item) => Object.freeze({ ...item })),
    ),
    journeyReviews: Object.freeze(
      input.journeyReviews.map((item) =>
        Object.freeze({
          ...item,
          doubleLabeledCaseIds: Object.freeze([...item.doubleLabeledCaseIds]),
          reviewedCaseIds: Object.freeze([...item.reviewedCaseIds]),
        }),
      ),
    ),
    reviewedSafetyCaseIds: Object.freeze([...input.reviewedSafetyCaseIds]),
  });
