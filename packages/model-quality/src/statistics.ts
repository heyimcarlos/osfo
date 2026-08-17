import { verify as verifySignature } from "node:crypto";

import { verifyCorpusManifest, type CorpusLineage, type CorpusManifest } from "./corpus";
import {
  parseApprovalId,
  parseCaseId,
  parseEvidenceInstant,
  type ApprovalId,
  type CaseId,
  type EvidenceInstant,
} from "./identity";
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
  readonly secondMoment: number;
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
    !Number.isFinite(input.secondMoment) ||
    !Number.isInteger(input.pilotIndependentCases) ||
    input.pilotIndependentCases <= 0 ||
    input.anticipatedDifference < -1 ||
    input.anticipatedDifference > 1 ||
    input.discordanceRate < 0 ||
    input.discordanceRate > 1 ||
    input.secondMoment < input.anticipatedDifference ** 2 ||
    input.secondMoment > input.discordanceRate ||
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
  const estimatedSecondMoment =
    value.secondMoment === 0 ? 1 - 0.05 ** (1 / value.pilotIndependentCases) : value.secondMoment;
  const observedVariance = Math.max(0, estimatedSecondMoment - value.anticipatedDifference ** 2);
  const variance =
    value.secondMoment > 0 && value.pilotIndependentCases > 1
      ? (observedVariance * value.pilotIndependentCases) / (value.pilotIndependentCases - 1)
      : observedVariance;
  const zAlpha = 1.6448536269514722;
  const zPower = 1.2815515655446004;
  return success(
    Math.max(2, Math.ceil(((zAlpha + zPower) ** 2 * variance) / distanceFromMargin ** 2)),
  );
};

/** Repeated outputs clustered under one independent case identity. */
export type CaseRunScores = {
  readonly caseId: string;
  readonly fixtureDigest: EvidenceDigest<"fixture">;
  readonly runs: ReadonlyArray<number>;
};

/** Verify exact repeated outputs for every case in one trusted corpus version. */
export const verifyCompleteCorpusRuns = (
  runs: ReadonlyArray<CaseRunScores>,
  corpusManifest: CorpusManifest,
  corpusLineage: CorpusLineage = [],
): boolean => {
  if (
    !verifyCorpusManifest(corpusManifest, corpusLineage) ||
    runs.length !== corpusManifest.cases.length
  )
    return false;
  const expected = new Map<
    string,
    {
      readonly fixtureDigest: EvidenceDigest<"fixture">;
      readonly repetitions: 3 | 5;
    }
  >(
    corpusManifest.cases.map((item) => [
      item.id,
      {
        fixtureDigest:
          item.split === "sealed-holdout"
            ? item.fixture.contentDigest
            : digestValue("fixture", item.fixture),
        repetitions: item.repetitions,
      },
    ]),
  );
  const seen = new Set<string>();
  return runs.every((item) => {
    const corpusCase = expected.get(item.caseId);
    if (corpusCase === undefined || seen.has(item.caseId)) return false;
    seen.add(item.caseId);
    return (
      item.fixtureDigest === corpusCase.fixtureDigest &&
      item.runs.length === corpusCase.repetitions &&
      item.runs.every((score) => Number.isFinite(score) && score >= 0 && score <= 1)
    );
  });
};

/** Parsed initial-run observation derived from signed paired development runs. */
export type PilotObservation = {
  readonly caseId: CaseId;
  readonly difference: number;
  readonly fixtureDigest: EvidenceDigest<"fixture">;
};

/** Inputs fixed before candidate evaluation for final paired power. */
export type PairedPowerPlanInput = {
  readonly authorityId: string;
  readonly candidateEvaluationStartedAt: string;
  readonly caseIds: ReadonlyArray<string>;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly declaredAt: string;
  readonly margin: number;
  readonly pilotBaselineByCase: ReadonlyArray<CaseRunScores>;
  readonly pilotCandidateByCase: ReadonlyArray<CaseRunScores>;
  readonly signature: string;
};

/** Immutable final-power plan bound to sealed corpus cases. */
export type PairedPowerPlan = ParsedPairedPowerInput & {
  readonly authorityId: ApprovalId;
  readonly candidateEvaluationStartedAt: EvidenceInstant;
  readonly caseIds: ReadonlyArray<CaseId>;
  readonly contentDigest: EvidenceDigest<"power-calculation">;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly declaredAt: EvidenceInstant;
  readonly pilotBaselineByCase: ReadonlyArray<CaseRunScores>;
  readonly pilotCandidateByCase: ReadonlyArray<CaseRunScores>;
  readonly pilotObservations: ReadonlyArray<PilotObservation>;
  readonly pilotRunEvidenceDigest: EvidenceDigest<"scores">;
  readonly requiredCases: number;
  readonly signature: string;
};

const powerPlanAuthorityIds = new Set(["quality-power-owner-1"]);

const powerPlanAuthorityPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYmDUW0aBFMQmi3lGHgfcyNy2B3p1eXmZb3B41/HtDss=
-----END PUBLIC KEY-----`;

/** Produce the canonical digest signed by the independent power-plan authority. */
export const pairedPowerPlanSigningDigest = (
  input: PairedPowerPlanInput | Omit<PairedPowerPlanInput, "signature">,
): EvidenceDigest<"power-calculation"> => {
  if ("signature" in input) {
    const { signature: ignoredSignature, ...unsigned } = input;
    void ignoredSignature;
    return digestValue("power-calculation", unsigned);
  }
  return digestValue("power-calculation", input);
};

/** Create the sealed holdout power plan before candidate evaluation starts. */
export const createPairedPowerPlan = (
  input: PairedPowerPlanInput,
  corpusManifest: CorpusManifest,
  corpusLineage: CorpusLineage = [],
): StatisticsResult<PairedPowerPlan> => {
  if (!verifyCorpusManifest(corpusManifest, corpusLineage)) {
    return invalidStatistics("The corpus manifest content digest does not match.");
  }
  const pilotEvidence = parsePilotRunEvidence(
    input.pilotBaselineByCase,
    input.pilotCandidateByCase,
    corpusManifest,
  );
  if (pilotEvidence.kind === "error") return pilotEvidence;
  const powerInput = parsePilotPowerInput(pilotEvidence.value, input.margin);
  if (powerInput.kind === "error") return powerInput;
  const declaredAt = parseEvidenceInstant(input.declaredAt);
  const candidateStartedAt = parseEvidenceInstant(input.candidateEvaluationStartedAt);
  const authorityId = parseApprovalId(input.authorityId);
  if (
    declaredAt.kind === "error" ||
    candidateStartedAt.kind === "error" ||
    authorityId.kind === "error" ||
    input.corpusDigest !== corpusManifest.contentDigest ||
    Date.parse(declaredAt.value) >= Date.parse(candidateStartedAt.value) ||
    !powerPlanAuthorityIds.has(input.authorityId) ||
    !verifySignature(
      null,
      Buffer.from(pairedPowerPlanSigningDigest(input)),
      powerPlanAuthorityPublicKey,
      Buffer.from(input.signature, "base64"),
    )
  ) {
    return invalidStatistics("Power evidence must be signed and declared before evaluation.");
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
  const pilotObservations = pilotEvidence.value;
  const pilotBaselineByCase = freezeCaseRuns(input.pilotBaselineByCase);
  const pilotCandidateByCase = freezeCaseRuns(input.pilotCandidateByCase);
  const pilotRunEvidenceDigest = digestValue("scores", {
    baselineByCase: pilotBaselineByCase,
    candidateByCase: pilotCandidateByCase,
  });
  const unsigned = Object.freeze({
    ...powerInput.value,
    authorityId: authorityId.value,
    candidateEvaluationStartedAt: candidateStartedAt.value,
    caseIds: Object.freeze(caseIds),
    corpusDigest: corpusManifest.contentDigest,
    declaredAt: declaredAt.value,
    pilotBaselineByCase,
    pilotCandidateByCase,
    pilotObservations: Object.freeze(pilotObservations),
    pilotRunEvidenceDigest,
    requiredCases: requiredCases.value,
    signature: input.signature,
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
  readonly corpusLineage?: CorpusLineage;
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
  if (!verifyCorpusManifest(input.corpusManifest, input.corpusLineage ?? [])) {
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
        {
          fixtureDigest: item.fixture.contentDigest,
          repetitions: item.repetitions,
        },
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
    {
      readonly fixtureDigest: EvidenceDigest<"fixture">;
      readonly repetitions: 3 | 5;
    }
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
  const pilotInput = parsePilotPowerInput(plan.pilotObservations, plan.margin);
  const pilotEvidence = parsePilotRunEvidence(
    plan.pilotBaselineByCase,
    plan.pilotCandidateByCase,
    corpusManifest,
  );
  const declaredAt = parseEvidenceInstant(plan.declaredAt);
  const candidateStartedAt = parseEvidenceInstant(plan.candidateEvaluationStartedAt);
  const parsedCaseIds = plan.caseIds.map(parseCaseId);
  const sealedIds = new Set<string>(
    corpusManifest.cases.filter((item) => item.split === "sealed-holdout").map((item) => item.id),
  );
  const requiredCases = requiredPairedCaseCount(plan);
  return (
    parsed.kind === "success" &&
    pilotInput.kind === "success" &&
    pilotEvidence.kind === "success" &&
    digestValue("scores", {
      baselineByCase: plan.pilotBaselineByCase,
      candidateByCase: plan.pilotCandidateByCase,
    }) === plan.pilotRunEvidenceDigest &&
    digestValue("power-calculation", plan.pilotObservations) ===
      digestValue(
        "power-calculation",
        pilotEvidence.kind === "success" ? pilotEvidence.value : [],
      ) &&
    pilotInput.value.anticipatedDifference === plan.anticipatedDifference &&
    pilotInput.value.discordanceRate === plan.discordanceRate &&
    pilotInput.value.pilotIndependentCases === plan.pilotIndependentCases &&
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
    powerPlanAuthorityIds.has(plan.authorityId) &&
    verifySignature(
      null,
      Buffer.from(
        pairedPowerPlanSigningDigest({
          authorityId: plan.authorityId,
          candidateEvaluationStartedAt: plan.candidateEvaluationStartedAt,
          caseIds: plan.caseIds,
          corpusDigest: plan.corpusDigest,
          declaredAt: plan.declaredAt,
          margin: plan.margin,
          pilotBaselineByCase: plan.pilotBaselineByCase,
          pilotCandidateByCase: plan.pilotCandidateByCase,
        }),
      ),
      powerPlanAuthorityPublicKey,
      Buffer.from(plan.signature, "base64"),
    ) &&
    contentDigest === digestValue("power-calculation", unsigned)
  );
};

const parsePilotPowerInput = (
  observations: ReadonlyArray<PilotObservation>,
  margin: number,
): StatisticsResult<ParsedPairedPowerInput> => {
  if (
    observations.length === 0 ||
    new Set(observations.map((item) => item.caseId)).size !== observations.length ||
    observations.some(
      (item) =>
        parseCaseId(item.caseId).kind === "error" ||
        !Number.isFinite(item.difference) ||
        item.difference < -1 ||
        item.difference > 1,
    )
  ) {
    return invalidStatistics("Paired power requires unique product-owned pilot observations.");
  }
  return parsePairedPowerInput({
    anticipatedDifference: mean(observations.map((item) => item.difference)),
    discordanceRate:
      observations.filter((item) => item.difference !== 0).length / observations.length,
    margin,
    pilotIndependentCases: observations.length,
    secondMoment: mean(observations.map((item) => item.difference ** 2)),
  });
};

const parsePilotRunEvidence = (
  baselineByCase: ReadonlyArray<CaseRunScores>,
  candidateByCase: ReadonlyArray<CaseRunScores>,
  corpusManifest: CorpusManifest,
): StatisticsResult<ReadonlyArray<PilotObservation>> => {
  const developmentCases = new Map<
    string,
    {
      readonly fixtureDigest: EvidenceDigest<"fixture">;
      readonly repetitions: 3 | 5;
    }
  >(
    corpusManifest.cases.flatMap((item) =>
      item.split === "development"
        ? [
            [
              item.id,
              {
                fixtureDigest: digestValue("fixture", item.fixture),
                repetitions: item.repetitions,
              },
            ],
          ]
        : [],
    ),
  );
  const baseline = parseCaseScores(baselineByCase, developmentCases);
  if (baseline.kind === "error") return baseline;
  const candidate = parseCaseScores(candidateByCase, developmentCases);
  if (candidate.kind === "error") return candidate;
  const caseIds = [...baseline.value.keys()];
  if (!sameCaseIdentities(caseIds, [...candidate.value.keys()])) {
    return invalidStatistics("Signed pilot arms must contain identical development cases.");
  }
  const observations = caseIds.flatMap((caseId) => {
    const parsedCaseId = parseCaseId(caseId);
    const fixtureDigest = developmentCases.get(caseId)?.fixtureDigest;
    const baselineScore = baseline.value.get(caseId);
    const candidateScore = candidate.value.get(caseId);
    if (
      parsedCaseId.kind === "error" ||
      fixtureDigest === undefined ||
      baselineScore === undefined ||
      candidateScore === undefined
    ) {
      return [];
    }
    return [
      Object.freeze({
        caseId: parsedCaseId.value,
        difference: candidateScore - baselineScore,
        fixtureDigest,
      }),
    ];
  });
  return observations.length === caseIds.length
    ? success(Object.freeze(observations))
    : invalidStatistics("Parsed pilot evidence became incomplete.");
};

const freezeCaseRuns = (runs: ReadonlyArray<CaseRunScores>): ReadonlyArray<CaseRunScores> =>
  Object.freeze(
    runs.map((item) => Object.freeze({ ...item, runs: Object.freeze([...item.runs]) })),
  );

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

const success = <T>(value: T): StatisticsResult<T> => ({
  kind: "success",
  value,
});
