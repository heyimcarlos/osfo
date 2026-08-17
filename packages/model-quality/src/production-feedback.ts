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

/** Weekly message population for both Plan routes of one journey. */
export type JourneySamplingPopulation = {
  readonly adventurerMessages: number;
  readonly freeMessages: number;
};

/** Stratified weekly allocation capped at 200 total samples for the journey. */
export type JourneySamplingPlan = {
  readonly adventurerSamples: number;
  readonly freeSamples: number;
  readonly totalSamples: number;
};

/** Expected invalid population failure from weekly sampling. */
export type InvalidSamplingPopulation = {
  readonly error: { readonly _tag: "InvalidSamplingPopulation" };
  readonly kind: "error";
};

/** Parsed weekly sampling outcome. */
export type JourneySamplingResult =
  | { readonly kind: "success"; readonly value: JourneySamplingPlan }
  | InvalidSamplingPopulation;

/** Select one percent per Plan route while enforcing one 200-sample journey cap. */
export const planWeeklySampling = (
  population: JourneySamplingPopulation,
): JourneySamplingResult => {
  if (
    !isEvidenceCount(population.freeMessages) ||
    !isEvidenceCount(population.adventurerMessages)
  ) {
    return { error: { _tag: "InvalidSamplingPopulation" }, kind: "error" };
  }
  const freeTarget = Math.ceil(Math.max(0, population.freeMessages) * 0.01);
  const adventurerTarget = Math.ceil(Math.max(0, population.adventurerMessages) * 0.01);
  const uncapped = freeTarget + adventurerTarget;
  const totalSamples = Math.min(200, uncapped);
  const freeSamples =
    uncapped <= 200 || uncapped === 0
      ? freeTarget
      : Math.floor((totalSamples * freeTarget) / uncapped);
  return {
    kind: "success",
    value: {
      adventurerSamples: totalSamples - freeSamples,
      freeSamples,
      totalSamples,
    },
  };
};
import { isEvidenceCount } from "./evidence-count";
