/** Retention class for evaluation records. */
export type EvaluationRecordClass =
  | "temporary-content"
  | "content-free-metadata"
  | "flagged-review-bundle"
  | "consented-real-trace";

/** Select one percent of a journey and Plan route stratum, capped at 200 each week. */
export const planWeeklySampling = (stratumMessages: number): number =>
  Math.min(200, Math.ceil(Math.max(0, stratumMessages) * 0.01));

/** Production signals that must enter privacy-safe triage. */
export type FeedbackSignal =
  | "negative-feedback"
  | "user-correction"
  | "repeated-failed-attempt"
  | "gm-summon"
  | "support-incident"
  | "hard-invariant-alert";

/** Privacy-safe classification of one production feedback signal. */
export type FeedbackTriage = {
  readonly canChangeReleaseVerdict: false;
  readonly classification: "triage-lead";
  readonly requiresReview: true;
};

/** Classify a production signal without turning it into a gold label or release verdict. */
export const triageFeedbackSignal = (_signal: FeedbackSignal): FeedbackTriage => ({
  canChangeReleaseVerdict: false,
  classification: "triage-lead",
  requiresReview: true,
});

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
  const complete = evidence.productionDays >= 30 && evidence.acceptedMessages >= 25_000;
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

/** Calculate the maximum retained-until epoch millisecond for an evaluation record. */
export const evaluationExpiry = (
  recordClass: EvaluationRecordClass,
  createdAtEpochMs: number,
): number => {
  const hours =
    recordClass === "temporary-content"
      ? 24
      : recordClass === "consented-real-trace"
        ? 24 * 90
        : 24 * 30;
  return createdAtEpochMs + hours * 60 * 60 * 1_000;
};

/** Basis under which private content was selected for human review. */
export type PrivateReviewRequest = {
  readonly basis:
    | "user-feedback-consent"
    | "documented-security-need"
    | "documented-support-need"
    | "random-sample";
};

/** Decision on whether a human may read selected private content. */
export type PrivateReviewDecision = { readonly verdict: "ALLOWED" | "PROHIBITED" };

/** Decide whether private content may be read by a human. */
export const reviewPrivateContent = (request: PrivateReviewRequest): PrivateReviewDecision => ({
  verdict: request.basis === "random-sample" ? "PROHIBITED" : "ALLOWED",
});

/** One registered live or provider-recovery evaluation copy. */
export type EvaluationCopy =
  | { readonly copyId: string; readonly location: "live" }
  | {
      readonly copyId: string;
      readonly location: "provider-recovery";
      readonly recoveryExpiresAt: string;
    };

/** Product-owned complete registry of evaluation copies for one source. */
export type EvaluationCopyRegistry = {
  readonly copies: ReadonlyArray<EvaluationCopy>;
  readonly sourceId: string;
};

/** Create the complete immutable registry when evaluation copies are created. */
export const createEvaluationCopyRegistry = (
  sourceId: string,
  copies: ReadonlyArray<EvaluationCopy>,
): EvaluationCopyRegistry =>
  Object.freeze({
    copies: Object.freeze(copies.map((copy) => Object.freeze({ ...copy }))),
    sourceId,
  });

/** One immediate deletion request propagated to an evaluation copy. */
export type EvaluationCopyDeletion = {
  readonly copyId: string;
  readonly requestedAt: string;
  readonly sourceId: string;
};

/** Provider-recovery expiry kept separate from live deletion completion. */
export type ProviderRecoveryExpiry = {
  readonly copyId: string;
  readonly recoveryExpiresAt: string;
  readonly sourceId: string;
};

/** Separate live deletion and provider-recovery results for one source lineage. */
export type SourceDeletionPlan = {
  readonly liveDeletions: ReadonlyArray<EvaluationCopyDeletion>;
  readonly providerRecoveryExpiries: ReadonlyArray<ProviderRecoveryExpiry>;
};

/** Start deletion from every declared evaluation copy when its source is deleted or redacted. */
export const propagateSourceDeletion = (
  registry: EvaluationCopyRegistry,
  requestedAt: string,
): SourceDeletionPlan => ({
  liveDeletions: registry.copies
    .filter((copy) => copy.location === "live")
    .map((copy) => ({ copyId: copy.copyId, requestedAt, sourceId: registry.sourceId })),
  providerRecoveryExpiries: registry.copies
    .filter((copy) => copy.location === "provider-recovery")
    .map((copy) => ({
      copyId: copy.copyId,
      recoveryExpiresAt: copy.recoveryExpiresAt,
      sourceId: registry.sourceId,
    })),
});
