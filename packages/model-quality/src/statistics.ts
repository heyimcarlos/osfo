/** PASS, FAIL, and MISSING evidence states used by quality calculations. */
export type EvidenceVerdict = "PASS" | "FAIL" | "MISSING";

/** Expected failure returned for malformed statistical evidence. */
export type InvalidStatisticsInput = {
  readonly _tag: "InvalidStatisticsInput";
  readonly message: string;
};

/** Result of a statistical calculation with explicit invalid-input evidence. */
export type StatisticsResult<T> =
  | { readonly kind: "success"; readonly value: T }
  | StatisticsFailure;

/** Tagged invalid-input branch returned by statistical calculations. */
export type StatisticsFailure = {
  readonly error: InvalidStatisticsInput;
  readonly kind: "error";
};

/** Inputs for a one-sided Clopper-Pearson upper confidence bound. */
export type ExactBinomialInput = {
  readonly confidence: number;
  readonly failures: number;
  readonly total: number;
};

/** Calculate a one-sided exact-binomial upper confidence bound. */
export const exactBinomialUpperBound = (input: ExactBinomialInput): StatisticsResult<number> => {
  if (
    !Number.isInteger(input.failures) ||
    !Number.isInteger(input.total) ||
    !Number.isFinite(input.confidence) ||
    input.failures < 0 ||
    input.total <= 0 ||
    input.failures > input.total ||
    input.confidence <= 0 ||
    input.confidence >= 1
  ) {
    return invalidStatistics("Exact-binomial counts and confidence are outside their domains.");
  }
  if (input.failures === input.total) return success(1);

  const alpha = 1 - input.confidence;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (binomialCumulative(input.failures, input.total, midpoint) > alpha) lower = midpoint;
    else upper = midpoint;
  }
  return success((lower + upper) / 2);
};

/** Inputs for the predeclared 90%-power paired case calculation. */
export type PairedPowerInput = {
  readonly anticipatedDifference: number;
  readonly discordanceRate: number;
  readonly margin: number;
  readonly pilotIndependentCases: number;
};

/** Calculate required independent cases at 90% power and one-sided alpha 0.05. */
export const requiredPairedCaseCount = (input: PairedPowerInput): StatisticsResult<number> => {
  const distanceFromMargin = input.margin + input.anticipatedDifference;
  if (
    !Number.isFinite(input.anticipatedDifference) ||
    !Number.isFinite(input.discordanceRate) ||
    !Number.isFinite(input.margin) ||
    !Number.isInteger(input.pilotIndependentCases) ||
    input.pilotIndependentCases <= 0 ||
    input.discordanceRate < 0 ||
    input.discordanceRate > 1 ||
    input.margin <= 0 ||
    distanceFromMargin <= 0
  ) {
    return invalidStatistics("Paired power inputs are outside their domains.");
  }
  const estimatedDiscordance =
    input.discordanceRate === 0
      ? 1 - 0.05 ** (1 / input.pilotIndependentCases)
      : input.discordanceRate;
  const variance = Math.max(0, estimatedDiscordance - input.anticipatedDifference ** 2);
  const zAlpha = 1.6448536269514722;
  const zPower = 1.2815515655446004;
  return success(Math.ceil(((zAlpha + zPower) ** 2 * variance) / distanceFromMargin ** 2));
};

/** Repeated outputs clustered under one independent case identity. */
export type CaseRunScores = {
  readonly caseId: string;
  readonly runs: ReadonlyArray<number>;
};

/** Inputs for a paired, case-clustered non-inferiority comparison. */
export type PairedComparisonInput = PairedPowerInput & {
  readonly baselineByCase: ReadonlyArray<CaseRunScores>;
  readonly candidateByCase: ReadonlyArray<CaseRunScores>;
  readonly corpusCases: ReadonlyArray<{ readonly id: string; readonly repetitions: 3 | 5 }>;
};

/** Result of a paired, case-clustered non-inferiority comparison. */
export type PairedComparison = {
  readonly difference: number;
  readonly independentCases: number;
  readonly kind: "success";
  readonly lowerConfidenceBound: number;
  readonly requiredCases: number;
  readonly verdict: EvidenceVerdict;
};

/** Compare matching candidate and production cases with repeated runs kept in each case cluster. */
export const pairedNonInferiority = (
  input: PairedComparisonInput,
): PairedComparison | StatisticsFailure => {
  const power = requiredPairedCaseCount(input);
  if (power.kind === "error") return power;
  const repetitions = new Map(input.corpusCases.map((item) => [item.id, item.repetitions]));
  if (repetitions.size !== input.corpusCases.length) {
    return invalidStatistics("Corpus case identities must be unique.");
  }
  const baseline = parseCaseScores(input.baselineByCase, repetitions);
  if (baseline.kind === "error") return baseline;
  const candidate = parseCaseScores(input.candidateByCase, repetitions);
  if (candidate.kind === "error") return candidate;
  const baselineIds = [...baseline.value.keys()];
  const candidateIds = [...candidate.value.keys()];
  if (
    baselineIds.length !== candidateIds.length ||
    baselineIds.some((caseId) => !candidate.value.has(caseId))
  ) {
    return invalidStatistics("Paired case identities must match.");
  }
  const differences = baselineIds.map((caseId) => {
    const baselineScore = baseline.value.get(caseId) ?? 0;
    const candidateScore = candidate.value.get(caseId) ?? 0;
    return candidateScore - baselineScore;
  });
  const difference = mean(differences);
  const lowerConfidenceBound = pairedClusterBootstrapLowerBound(differences);
  const verdict: EvidenceVerdict =
    baselineIds.length < power.value
      ? "MISSING"
      : lowerConfidenceBound >= -input.margin
        ? "PASS"
        : "FAIL";
  return {
    difference,
    independentCases: baselineIds.length,
    kind: "success",
    lowerConfidenceBound,
    requiredCases: power.value,
    verdict,
  };
};

const parseCaseScores = (
  cases: ReadonlyArray<CaseRunScores>,
  repetitions: ReadonlyMap<string, 3 | 5>,
): StatisticsResult<ReadonlyMap<string, number>> => {
  const scores = new Map<string, number>();
  for (const item of cases) {
    const requiredRuns = repetitions.get(item.caseId);
    if (
      item.caseId.length === 0 ||
      scores.has(item.caseId) ||
      requiredRuns === undefined ||
      item.runs.length !== requiredRuns ||
      item.runs.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      return invalidStatistics("Case identities must be unique and every case needs bounded runs.");
    }
    scores.set(item.caseId, mean(item.runs));
  }
  if (scores.size === 0) return invalidStatistics("Paired analysis requires independent cases.");
  return success(scores);
};

const binomialCumulative = (maximumFailures: number, total: number, probability: number) => {
  if (probability === 0) return 1;
  if (probability === 1) return maximumFailures === total ? 1 : 0;
  const logProbability = Math.log(probability);
  const logOneMinusProbability = Math.log1p(-probability);
  let logTerm = total * logOneMinusProbability;
  let logSum = logTerm;
  for (let failures = 0; failures < maximumFailures; failures += 1) {
    logTerm +=
      Math.log(total - failures) - Math.log(failures + 1) + logProbability - logOneMinusProbability;
    logSum = logAdd(logSum, logTerm);
  }
  return Math.exp(logSum);
};

const logAdd = (left: number, right: number) => {
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
};

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const pairedClusterBootstrapLowerBound = (caseDifferences: ReadonlyArray<number>) => {
  if (caseDifferences.every((value) => value === caseDifferences[0]))
    return caseDifferences[0] ?? 0;
  let state = 0x6d2b79f5;
  const samples = Array.from({ length: 10_000 }, () => {
    let total = 0;
    for (let index = 0; index < caseDifferences.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      total += caseDifferences[(state >>> 0) % caseDifferences.length] ?? 0;
    }
    return total / caseDifferences.length;
  });
  // oxlint-disable-next-line unicorn/no-array-sort -- This private bootstrap array is sorted for its percentile.
  samples.sort((left, right) => left - right);
  return samples[Math.floor((samples.length - 1) * 0.05)] ?? 0;
};

const invalidStatistics = (message: string): StatisticsFailure => ({
  error: { _tag: "InvalidStatisticsInput", message },
  kind: "error",
});

const success = <T>(value: T): StatisticsResult<T> => ({ kind: "success", value });
