import { verify as verifySignature } from "node:crypto";

import {
  parseApprovalId,
  parseCaseId,
  parseEvidenceInstant,
  type ApprovalId,
  type CaseId,
  type EvidenceInstant,
} from "./identity";
import { digestValue, type EvidenceDigest } from "./manifest";
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
  readonly caseId: CaseId;
  readonly failed: boolean;
};

/** Less-trusted calibration observation accepted only at the signature boundary. */
export type PersistedCalibrationObservation = {
  readonly caseId: string;
  readonly failed: boolean;
};

/** Adjudicated confusion-matrix observations for a model grader. */
export type ModelGraderCalibration = {
  readonly criticalFalsePasses: ReadonlyArray<CalibrationObservation>;
  readonly falseFailures: ReadonlyArray<CalibrationObservation>;
  readonly otherFalsePasses: ReadonlyArray<CalibrationObservation>;
};

/** Less-trusted calibration records accepted before case identities are parsed. */
export type PersistedModelGraderCalibration = {
  readonly criticalFalsePasses: ReadonlyArray<PersistedCalibrationObservation>;
  readonly falseFailures: ReadonlyArray<PersistedCalibrationObservation>;
  readonly otherFalsePasses: ReadonlyArray<PersistedCalibrationObservation>;
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

/** Signed calibration observations that can authorize a model grader for release use. */
export type ModelGraderQualificationInput = {
  readonly assessedAt: string;
  readonly authorityId: string;
  readonly calibration: PersistedModelGraderCalibration;
  readonly graderDigest: EvidenceDigest<"grader">;
  readonly signature: string;
};

/** Immutable verified model-grader qualification evidence. */
export type VerifiedModelGraderQualification = {
  readonly assessedAt: EvidenceInstant;
  readonly authorityId: ApprovalId;
  readonly calibration: ModelGraderCalibration;
  readonly contentDigest: EvidenceDigest<"grader">;
  readonly graderDigest: EvidenceDigest<"grader">;
  readonly signature: string;
  readonly qualification: ModelGraderQualification;
};

/** Expected failure returned for invalid signed model-grader qualification evidence. */
export type InvalidModelGraderQualification = {
  readonly error: {
    readonly _tag: "InvalidModelGraderQualification";
    readonly message: string;
  };
  readonly kind: "error";
};

/** Result of parsing signed model-grader qualification evidence. */
export type ModelGraderQualificationResult =
  | { readonly kind: "success"; readonly value: VerifiedModelGraderQualification }
  | InvalidModelGraderQualification;

/** Result of parsing calibration identities at the signed evidence boundary. */
export type ModelGraderCalibrationResult =
  | { readonly kind: "success"; readonly value: ModelGraderCalibration }
  | InvalidModelGraderQualification;

/** Produce the payload signed by the independent model-grader calibration authority. */
export const modelGraderQualificationSigningDigest = (
  input: ModelGraderQualificationInput,
): EvidenceDigest<"grader"> => {
  const { signature: ignoredSignature, ...unsigned } = input;
  void ignoredSignature;
  return digestValue("grader", unsigned);
};

/** Parse, calculate, and freeze signed calibration evidence for one exact grader. */
export const createModelGraderQualification = (
  input: ModelGraderQualificationInput,
): ModelGraderQualificationResult => {
  const authorityId = parseApprovalId(input.authorityId);
  const assessedAt = parseEvidenceInstant(input.assessedAt);
  if (
    authorityId.kind === "error" ||
    assessedAt.kind === "error" ||
    !modelGraderAuthorityIds.has(input.authorityId) ||
    !verifySignature(
      null,
      Buffer.from(modelGraderQualificationSigningDigest(input)),
      modelGraderQualificationPublicKey,
      Buffer.from(input.signature, "base64"),
    )
  ) {
    return invalidQualification("The model-grader authority signature or identity is invalid.");
  }
  const calibration = parseModelGraderCalibration(input.calibration);
  if (calibration.kind === "error") return calibration;
  const qualification = qualifyModelGrader(calibration.value);
  const unsigned = Object.freeze({
    assessedAt: assessedAt.value,
    authorityId: authorityId.value,
    calibration: calibration.value,
    graderDigest: input.graderDigest,
    signature: input.signature,
    qualification: Object.freeze({ ...qualification }),
  });
  return {
    kind: "success",
    value: Object.freeze({ ...unsigned, contentDigest: digestValue("grader", unsigned) }),
  };
};

/** Verify signed qualification and recompute exact-binomial release authority. */
export const verifyModelGraderQualification = (
  qualification: VerifiedModelGraderQualification,
): boolean => {
  const recomputed = createModelGraderQualification({
    assessedAt: qualification.assessedAt,
    authorityId: qualification.authorityId,
    calibration: qualification.calibration,
    graderDigest: qualification.graderDigest,
    signature: qualification.signature,
  });
  return (
    recomputed.kind === "success" &&
    qualification.contentDigest === recomputed.value.contentDigest &&
    qualification.qualification.verdict === recomputed.value.qualification.verdict &&
    qualification.qualification.releaseAuthority === recomputed.value.qualification.releaseAuthority
  );
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

const modelGraderAuthorityIds = new Set(["model-grader-owner-1"]);

const modelGraderQualificationPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA4kqomQaJ+eIIsBYagDRrhme3zNYi1/hJoDGEteGhYuI=
-----END PUBLIC KEY-----`;

/** Parse and freeze all signed calibration case identities. */
export const parseModelGraderCalibration = (
  calibration: PersistedModelGraderCalibration,
): ModelGraderCalibrationResult => {
  const criticalFalsePasses = parseObservations(calibration.criticalFalsePasses);
  const falseFailures = parseObservations(calibration.falseFailures);
  const otherFalsePasses = parseObservations(calibration.otherFalsePasses);
  if (criticalFalsePasses.kind === "error") return criticalFalsePasses;
  if (falseFailures.kind === "error") return falseFailures;
  if (otherFalsePasses.kind === "error") return otherFalsePasses;
  return {
    kind: "success",
    value: Object.freeze({
      criticalFalsePasses: criticalFalsePasses.value,
      falseFailures: falseFailures.value,
      otherFalsePasses: otherFalsePasses.value,
    }),
  };
};

const parseObservations = (
  observations: ReadonlyArray<PersistedCalibrationObservation>,
):
  | { readonly kind: "success"; readonly value: ReadonlyArray<CalibrationObservation> }
  | InvalidModelGraderQualification => {
  const parsed = observations.map((item) => ({ ...item, caseId: parseCaseId(item.caseId) }));
  if (parsed.some((item) => item.caseId.kind === "error")) {
    return invalidQualification("Calibration case identities are invalid.");
  }
  return {
    kind: "success",
    value: Object.freeze(
      parsed.flatMap((item) =>
        item.caseId.kind === "success"
          ? [Object.freeze({ caseId: item.caseId.value, failed: item.failed })]
          : [],
      ),
    ),
  };
};

const invalidQualification = (message: string): InvalidModelGraderQualification => ({
  error: { _tag: "InvalidModelGraderQualification", message },
  kind: "error",
});
