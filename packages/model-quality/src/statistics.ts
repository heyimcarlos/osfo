import { verifyCorpusManifest, type CorpusManifest } from "./corpus";
import { parseCaseId, parseEvidenceInstant, type CaseId, type EvidenceInstant } from "./identity";
import { digestValue, type EvidenceDigest } from "./manifest";

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

declare const statisticalInput: unique symbol;

/** Parsed paired-power inputs that satisfy probability and discordance constraints. */
export type ParsedPairedPowerInput = PairedPowerInput & {
  readonly [statisticalInput]: "ParsedPairedPowerInput";
};

/** Parse paired-power inputs before any statistical calculation. */
export const parsePairedPowerInput = (
  input: PairedPowerInput,
): StatisticsResult<ParsedPairedPowerInput> => {
  const distanceFromMargin = input.margin + input.anticipatedDifference;
  if (
    !Number.isFinite(input.anticipatedDifference) ||
    !Number.isFinite(input.discordanceRate) ||
    !Number.isFinite(input.margin) ||
    !Number.isInteger(input.pilotIndependentCases) ||
    input.pilotIndependentCases <= 0 ||
    input.anticipatedDifference < -1 ||
    input.anticipatedDifference > 1 ||
    input.discordanceRate < 0 ||
    input.discordanceRate > 1 ||
    Math.abs(input.anticipatedDifference) > input.discordanceRate ||
    input.margin <= 0 ||
    input.margin > 1 ||
    distanceFromMargin <= 0
  ) {
    return invalidStatistics("Paired power inputs are outside their domains.");
  }
  // SAFETY: Every numeric and relational invariant for paired power was parsed above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: TypeScript cannot construct the private parsed-input brand.
  return success(input as ParsedPairedPowerInput);
};

/** Calculate required independent cases at 90% power and one-sided alpha 0.05. */
export const requiredPairedCaseCount = (input: PairedPowerInput): StatisticsResult<number> => {
  const parsed = parsePairedPowerInput(input);
  if (parsed.kind === "error") return parsed;
  const value = parsed.value;
  const distanceFromMargin = value.margin + value.anticipatedDifference;
  const estimatedDiscordance =
    value.discordanceRate === 0
      ? 1 - 0.05 ** (1 / value.pilotIndependentCases)
      : value.discordanceRate;
  const variance = Math.max(0, estimatedDiscordance - value.anticipatedDifference ** 2);
  const zAlpha = 1.6448536269514722;
  const zPower = 1.2815515655446004;
  return success(Math.ceil(((zAlpha + zPower) ** 2 * variance) / distanceFromMargin ** 2));
};

/** Repeated outputs clustered under one independent case identity. */
export type CaseRunScores = {
  readonly caseId: string;
  readonly fixtureDigest: EvidenceDigest<"fixture">;
  readonly runs: ReadonlyArray<number>;
};

/** Inputs fixed before candidate evaluation for final paired power. */
export type PairedPowerPlanInput = PairedPowerInput & {
  readonly candidateEvaluationStartedAt: string;
  readonly caseIds: ReadonlyArray<string>;
  readonly declaredAt: string;
};

/** Immutable final-power plan bound to sealed corpus cases. */
export type PairedPowerPlan = ParsedPairedPowerInput & {
  readonly candidateEvaluationStartedAt: EvidenceInstant;
  readonly caseIds: ReadonlyArray<CaseId>;
  readonly contentDigest: EvidenceDigest<"power-calculation">;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly declaredAt: EvidenceInstant;
  readonly requiredCases: number;
};

/** Create the sealed holdout power plan before candidate evaluation starts. */
export const createPairedPowerPlan = (
  input: PairedPowerPlanInput,
  corpusManifest: CorpusManifest,
): StatisticsResult<PairedPowerPlan> => {
  const powerInput = parsePairedPowerInput(input);
  if (powerInput.kind === "error") return powerInput;
  if (!verifyCorpusManifest(corpusManifest)) {
    return invalidStatistics("The corpus manifest content digest does not match.");
  }
  const declaredAt = parseEvidenceInstant(input.declaredAt);
  const candidateStartedAt = parseEvidenceInstant(input.candidateEvaluationStartedAt);
  if (
    declaredAt.kind === "error" ||
    candidateStartedAt.kind === "error" ||
    Date.parse(declaredAt.value) >= Date.parse(candidateStartedAt.value)
  ) {
    return invalidStatistics("Power must be declared before candidate evaluation starts.");
  }
  const uniqueIds = new Set(input.caseIds);
  const parsedCaseIds = input.caseIds.map(parseCaseId);
  const sealedIds = new Set<string>(
    corpusManifest.cases.filter((item) => item.split === "sealed-holdout").map((item) => item.id),
  );
  if (
    input.caseIds.length === 0 ||
    uniqueIds.size !== input.caseIds.length ||
    parsedCaseIds.some((result) => result.kind === "error") ||
    input.caseIds.some((caseId) => !sealedIds.has(caseId))
  ) {
    return invalidStatistics("Final power may use only unique sealed holdout cases.");
  }
  const requiredCases = requiredPairedCaseCount(powerInput.value);
  if (requiredCases.kind === "error") return requiredCases;
  const caseIds = parsedCaseIds.flatMap((result) =>
    result.kind === "success" ? [result.value] : [],
  );
  const unsigned = Object.freeze({
    ...powerInput.value,
    candidateEvaluationStartedAt: candidateStartedAt.value,
    caseIds: Object.freeze(caseIds),
    corpusDigest: corpusManifest.contentDigest,
    declaredAt: declaredAt.value,
    requiredCases: requiredCases.value,
  });
  return {
    kind: "success",
    value: Object.freeze({
      ...unsigned,
      contentDigest: digestValue("power-calculation", unsigned),
    }),
  };
};

/** Inputs for a paired, case-clustered non-inferiority comparison. */
export type PairedComparisonInput = {
  readonly baselineByCase: ReadonlyArray<CaseRunScores>;
  readonly candidateByCase: ReadonlyArray<CaseRunScores>;
  readonly corpusManifest: CorpusManifest;
  readonly powerPlan: PairedPowerPlan;
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
  if (!verifyCorpusManifest(input.corpusManifest)) {
    return invalidStatistics("The corpus manifest content digest does not match.");
  }
  if (!powerPlanIsValid(input.powerPlan, input.corpusManifest)) {
    return invalidStatistics("The predeclared paired power plan is invalid.");
  }
  const sealedCases = new Map(
    input.corpusManifest.cases
      .filter((item) => item.split === "sealed-holdout")
      .map((item) => [
        item.id,
        { fixtureDigest: item.fixture.contentDigest, repetitions: item.repetitions },
      ]),
  );
  const baseline = parseCaseScores(input.baselineByCase, sealedCases);
  if (baseline.kind === "error") return baseline;
  const candidate = parseCaseScores(input.candidateByCase, sealedCases);
  if (candidate.kind === "error") return candidate;
  const baselineIds = [...baseline.value.keys()];
  const candidateIds = [...candidate.value.keys()];
  if (
    baselineIds.length !== candidateIds.length ||
    baselineIds.some((caseId) => !candidate.value.has(caseId))
  ) {
    return invalidStatistics("Paired case identities must match.");
  }
  if (
    !sameCaseIdentities(baselineIds, input.powerPlan.caseIds) ||
    baselineIds.some(
      (caseId) =>
        input.baselineByCase.find((item) => item.caseId === caseId)?.fixtureDigest !==
        input.candidateByCase.find((item) => item.caseId === caseId)?.fixtureDigest,
    )
  ) {
    return invalidStatistics("Both arms must use the identical predeclared sealed fixtures.");
  }
  const differences = baselineIds.map((caseId) => {
    const baselineScore = baseline.value.get(caseId) ?? 0;
    const candidateScore = candidate.value.get(caseId) ?? 0;
    return candidateScore - baselineScore;
  });
  const difference = mean(differences);
  const lowerConfidenceBound = pairedClusterBootstrapLowerBound(differences);
  const verdict: EvidenceVerdict =
    baselineIds.length < input.powerPlan.requiredCases
      ? "MISSING"
      : lowerConfidenceBound >= -input.powerPlan.margin
        ? "PASS"
        : "FAIL";
  return {
    difference,
    independentCases: baselineIds.length,
    kind: "success",
    lowerConfidenceBound,
    requiredCases: input.powerPlan.requiredCases,
    verdict,
  };
};

const parseCaseScores = (
  cases: ReadonlyArray<CaseRunScores>,
  sealedCases: ReadonlyMap<
    string,
    { readonly fixtureDigest: EvidenceDigest<"fixture">; readonly repetitions: 3 | 5 }
  >,
): StatisticsResult<ReadonlyMap<string, number>> => {
  const scores = new Map<string, number>();
  for (const item of cases) {
    const sealedCase = sealedCases.get(item.caseId);
    if (
      item.caseId.length === 0 ||
      scores.has(item.caseId) ||
      sealedCase === undefined ||
      item.fixtureDigest !== sealedCase.fixtureDigest ||
      item.runs.length !== sealedCase.repetitions ||
      item.runs.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      return invalidStatistics("Case identities must be unique and every case needs bounded runs.");
    }
    scores.set(item.caseId, mean(item.runs));
  }
  if (scores.size === 0) return invalidStatistics("Paired analysis requires independent cases.");
  return success(scores);
};

const powerPlanIsValid = (plan: PairedPowerPlan, corpusManifest: CorpusManifest): boolean => {
  const { contentDigest, ...unsigned } = plan;
  const parsed = parsePairedPowerInput(plan);
  const declaredAt = parseEvidenceInstant(plan.declaredAt);
  const candidateStartedAt = parseEvidenceInstant(plan.candidateEvaluationStartedAt);
  const parsedCaseIds = plan.caseIds.map(parseCaseId);
  const sealedIds = new Set<string>(
    corpusManifest.cases.filter((item) => item.split === "sealed-holdout").map((item) => item.id),
  );
  const requiredCases = requiredPairedCaseCount(plan);
  return (
    parsed.kind === "success" &&
    declaredAt.kind === "success" &&
    candidateStartedAt.kind === "success" &&
    requiredCases.kind === "success" &&
    requiredCases.value === plan.requiredCases &&
    Date.parse(plan.declaredAt) < Date.parse(plan.candidateEvaluationStartedAt) &&
    plan.caseIds.length > 0 &&
    new Set(plan.caseIds).size === plan.caseIds.length &&
    parsedCaseIds.every((result) => result.kind === "success") &&
    plan.caseIds.every((caseId) => sealedIds.has(caseId)) &&
    plan.corpusDigest === corpusManifest.contentDigest &&
    contentDigest === digestValue("power-calculation", unsigned)
  );
};

const sameCaseIdentities = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return rightIds.size === right.length && left.every((caseId) => rightIds.has(caseId));
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
