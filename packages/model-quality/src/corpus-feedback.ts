/** Evidence threshold for rebalancing aggregate journey weights from observed production behavior. */
export type RebalancingEvidence = {
  readonly acceptedMessages: number;
  readonly productionDays: number;
};

/** Result that keeps per-journey and critical-risk minimums fixed during aggregate rebalancing. */
export type RebalancingAssessment = {
  readonly aggregateWeightsMayChange: boolean;
  readonly criticalRiskMinimumsRemain: true;
  readonly perJourneyMinimumsRemain: true;
  readonly verdict: "PASS" | "MISSING";
};

/** Permit aggregate rebalancing only after 30 days and 25,000 accepted messages. */
export const assessCorpusRebalancing = (evidence: RebalancingEvidence): RebalancingAssessment => {
  const complete =
    Number.isInteger(evidence.productionDays) &&
    Number.isInteger(evidence.acceptedMessages) &&
    evidence.productionDays >= 30 &&
    evidence.acceptedMessages >= 25_000;
  return {
    aggregateWeightsMayChange: complete,
    criticalRiskMinimumsRemain: true,
    perJourneyMinimumsRemain: true,
    verdict: complete ? "PASS" : "MISSING",
  };
};

/** Adjudicated production failure safe to convert into a permanent synthetic case. */
export type ReviewedFailure = {
  readonly expectedOutcome: string;
  readonly failureMode: string;
  readonly reviewState: "adjudicated";
};

/** Minimized synthetic content for the next immutable corpus version. */
export type SyntheticRegressionCase = {
  readonly expectedOutcome: string;
  readonly prompt: string;
  readonly provenance: "synthetic";
};

/** Minimize a reviewed failure without retaining raw private conversation content. */
export const minimizeReviewedFailure = (failure: ReviewedFailure): SyntheticRegressionCase => ({
  expectedOutcome: failure.expectedOutcome,
  prompt: `Synthetic reproduction of failure mode: ${failure.failureMode}`,
  provenance: "synthetic",
});
