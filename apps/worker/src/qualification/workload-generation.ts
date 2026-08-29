import type {
  JourneyRequirement,
  ReferenceJourney,
  WorkloadWindow,
} from "./qualification-manifest";

/** One identity offered at a fixed time without waiting for a previous completion. */
export interface OpenWorkloadArrival {
  readonly journey: ReferenceJourney;
  readonly offeredAtEpochMs: number;
  readonly plan: "adventurer" | "free";
  readonly rootId: string;
}

/** Inputs for deterministic open-arrival generation. */
export interface OpenArrivalInput {
  readonly identityPrefix: string;
  readonly journeyMix: ReadonlyArray<Pick<JourneyRequirement, "journey" | "percentage">>;
  readonly planMixBasisPoints: { readonly adventurer: number; readonly free: number };
  readonly seed: number;
  readonly startsAtEpochMs: number;
  readonly window: WorkloadWindow;
}

const bucket = (index: number, seed: number): number => (((index + seed) % 100) + 100) % 100;

const journeyForBucket = (
  value: number,
  journeyMix: OpenArrivalInput["journeyMix"],
): ReferenceJourney => {
  let upperBound = 0;
  for (const entry of journeyMix) {
    upperBound += entry.percentage;
    if (value < upperBound) return entry.journey;
  }
  return journeyMix.at(-1)?.journey ?? "ordinaryConversation";
};

const arrivalOffsetSeconds = (index: number, windowValue: WorkloadWindow): number => {
  const targetCount = index + 0.5;
  const rateChangePerSecond =
    (windowValue.endRatePerSecond - windowValue.startRatePerSecond) / windowValue.durationSeconds;
  if (rateChangePerSecond === 0) return targetCount / windowValue.startRatePerSecond;
  return (
    (-windowValue.startRatePerSecond +
      Math.sqrt(windowValue.startRatePerSecond ** 2 + 2 * rateChangePerSecond * targetCount)) /
    rateChangePerSecond
  );
};

/** Generate the Plan and journey mix on a clock-driven open-arrival schedule. */
export const generateOpenArrivals = (
  input: OpenArrivalInput,
): ReadonlyArray<OpenWorkloadArrival> => {
  const averageRate = (input.window.startRatePerSecond + input.window.endRatePerSecond) / 2;
  const arrivalCount = Math.floor(averageRate * input.window.durationSeconds);
  return Array.from({ length: arrivalCount }, (_, index) => ({
    journey: journeyForBucket(bucket(index, input.seed), input.journeyMix),
    offeredAtEpochMs:
      input.startsAtEpochMs + Math.round(arrivalOffsetSeconds(index, input.window) * 1_000),
    plan:
      bucket(index, input.seed * 31) * 100 < input.planMixBasisPoints.free ? "free" : "adventurer",
    rootId: `${input.identityPrefix}:${index}`,
  }));
};
