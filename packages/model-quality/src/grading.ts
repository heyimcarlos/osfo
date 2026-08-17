import { exactBinomialUpperBound, type EvidenceVerdict } from "./statistics";

/** One already-computed grader result. */
export type GraderResult = {
  readonly graderId: string;
  readonly verdict: EvidenceVerdict;
};

/** Ordered grader inputs for one model sample. */
export type SampleGradingInput = {
  readonly deterministic: ReadonlyArray<GraderResult>;
  readonly human: GraderResult;
  readonly model: GraderResult;
};

/** Observable grading result with the order of executed graders. */
export type SampleGradingResult = {
  readonly executed: ReadonlyArray<string>;
  readonly verdict: EvidenceVerdict;
};

/** Apply deterministic graders before any subjective grader. */
export const gradeSample = (input: SampleGradingInput): SampleGradingResult => {
  const executed: Array<string> = [];
  for (const result of input.deterministic) {
    executed.push(result.graderId);
    if (result.verdict === "FAIL") return { executed: Object.freeze(executed), verdict: "FAIL" };
    if (result.verdict === "MISSING")
      return { executed: Object.freeze(executed), verdict: "MISSING" };
  }

  executed.push(input.model.graderId, input.human.graderId);
  return {
    executed: Object.freeze(executed),
    verdict: combineVerdicts([input.model.verdict, input.human.verdict]),
  };
};

/** One calibration observation, keyed by its independent corpus case. */
export type CalibrationObservation = {
  readonly caseId: string;
  readonly failed: boolean;
};

/** Adjudicated confusion-matrix observations for a model grader. */
export type ModelGraderCalibration = {
  readonly criticalFalsePasses: ReadonlyArray<CalibrationObservation>;
  readonly falseFailures: ReadonlyArray<CalibrationObservation>;
  readonly otherFalsePasses: ReadonlyArray<CalibrationObservation>;
};

/** Model-grader qualification evidence. */
export type ModelGraderQualification = {
  readonly criticalFalsePassUpperBound: number | null;
  readonly criticalIndependentCases: number;
  readonly falseFailureUpperBound: number | null;
  readonly otherFalsePassUpperBound: number | null;
  readonly releaseAuthority: boolean;
  readonly verdict: EvidenceVerdict;
};

/** Qualify model-grader release authority from independent adjudicated labels. */
export const qualifyModelGrader = (input: ModelGraderCalibration): ModelGraderQualification => {
  const critical = independentObservations(input.criticalFalsePasses);
  const other = independentObservations(input.otherFalsePasses);
  const falseFailures = independentObservations(input.falseFailures);
  const criticalFailures = countFailures(critical);
  const criticalBound = upperBound(criticalFailures, critical.length);
  const otherBound = upperBound(countFailures(other), other.length);
  const falseFailureBound = upperBound(countFailures(falseFailures), falseFailures.length);
  const complete =
    critical.length >= 299 &&
    other.length > 0 &&
    falseFailures.length > 0 &&
    criticalBound !== null &&
    otherBound !== null &&
    falseFailureBound !== null;
  const releaseAuthority =
    complete &&
    criticalFailures === 0 &&
    criticalBound !== null &&
    criticalBound < 0.01 &&
    otherBound !== null &&
    otherBound < 0.05 &&
    falseFailureBound !== null &&
    falseFailureBound < 0.1;
  return {
    criticalFalsePassUpperBound: criticalBound,
    criticalIndependentCases: critical.length,
    falseFailureUpperBound: falseFailureBound,
    otherFalsePassUpperBound: otherBound,
    releaseAuthority,
    verdict: complete ? (releaseAuthority ? "PASS" : "FAIL") : "MISSING",
  };
};

const independentObservations = (observations: ReadonlyArray<CalibrationObservation>) => {
  const byCase = new Map<string, CalibrationObservation>();
  for (const observation of observations) {
    const current = byCase.get(observation.caseId);
    byCase.set(observation.caseId, {
      caseId: observation.caseId,
      failed: observation.failed || current?.failed === true,
    });
  }
  return [...byCase.values()];
};

const countFailures = (observations: ReadonlyArray<CalibrationObservation>) =>
  observations.filter((observation) => observation.failed).length;

const upperBound = (failures: number, total: number) =>
  total === 0 ? null : resultValue(exactBinomialUpperBound({ confidence: 0.95, failures, total }));

const resultValue = (result: ReturnType<typeof exactBinomialUpperBound>) =>
  result.kind === "success" ? result.value : null;

const combineVerdicts = (verdicts: ReadonlyArray<EvidenceVerdict>): EvidenceVerdict =>
  verdicts.includes("FAIL") ? "FAIL" : verdicts.includes("MISSING") ? "MISSING" : "PASS";
