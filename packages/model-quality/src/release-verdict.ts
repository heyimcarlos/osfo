import {
  assessPassCurrentness,
  digestValue,
  verifyEvaluationManifest,
  type EvaluationManifest,
  type EvidenceDigest,
} from "./manifest";
import {
  parseEvidenceInstant,
  parseReleaseId,
  type EvidenceInstant,
  type ReleaseId,
} from "./identity";

/** Current product evidence used to decide whether one release PASS remains usable. */
export type CurrentReleaseEvidence = {
  readonly configurationDigest: EvidenceDigest<"configuration">;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly dependencyDigest: EvidenceDigest<"dependency">;
  readonly graderDigest: EvidenceDigest<"grader">;
  readonly now: string;
  readonly rubricDigest: EvidenceDigest<"rubric">;
};

/** Verified PASS bound to signed candidate and production output manifests. */
export type ReleasePass = {
  readonly candidateManifest: EvaluationManifest;
  readonly contentDigest: EvidenceDigest<"release-pass">;
  readonly passedAt: EvidenceInstant;
  readonly productionManifest: EvaluationManifest;
  readonly releaseId: ReleaseId;
  readonly verdict: "PASS";
};

/** Expected failure when signed release evidence is missing, invalid, or stale. */
export type InvalidReleasePass = {
  readonly error: { readonly _tag: "InvalidReleasePass"; readonly message: string };
  readonly kind: "error";
};

/** Release-PASS construction result. */
export type ReleasePassResult =
  | { readonly kind: "success"; readonly value: ReleasePass }
  | InvalidReleasePass;

/** Create a current PASS from two verified signed evaluation manifests. */
export const createReleasePass = (
  releaseIdInput: string,
  candidateManifest: EvaluationManifest,
  productionManifest: EvaluationManifest,
  current: CurrentReleaseEvidence,
): ReleasePassResult => {
  const releaseId = parseReleaseId(releaseIdInput);
  const currentInstant = parseEvidenceInstant(current.now);
  if (
    releaseId.kind === "error" ||
    currentInstant.kind === "error" ||
    !releaseManifestsAreValid(candidateManifest, productionManifest, current)
  ) {
    return invalidReleasePass("Signed release output evidence is invalid or stale.");
  }
  if (
    candidateManifest.releaseId !== releaseId.value ||
    productionManifest.releaseId !== releaseId.value
  ) {
    return invalidReleasePass("Signed release output evidence has another release identity.");
  }
  const passedAt = parseEvidenceInstant(candidateManifest.outputEvidence.utcWindow.endedAt);
  if (passedAt.kind === "error") return invalidReleasePass("Release PASS time is invalid.");
  const unsigned = Object.freeze({
    candidateManifest,
    passedAt: passedAt.value,
    productionManifest,
    releaseId: releaseId.value,
    verdict: "PASS" as const,
  });
  return {
    kind: "success",
    value: Object.freeze({
      ...unsigned,
      contentDigest: digestValue("release-pass", unsigned),
    }),
  };
};

/** Verify a persisted PASS and its current signed evaluation evidence. */
export const verifyReleasePass = (
  releasePass: ReleasePass,
  current: CurrentReleaseEvidence,
): boolean => {
  const { contentDigest, ...unsigned } = releasePass;
  const releaseId = parseReleaseId(releasePass.releaseId);
  const currentInstant = parseEvidenceInstant(current.now);
  return (
    releaseId.kind === "success" &&
    currentInstant.kind === "success" &&
    contentDigest === digestValue("release-pass", unsigned) &&
    releasePass.verdict === "PASS" &&
    releasePass.passedAt === releasePass.candidateManifest.outputEvidence.utcWindow.endedAt &&
    releasePass.candidateManifest.releaseId === releasePass.releaseId &&
    releasePass.productionManifest.releaseId === releasePass.releaseId &&
    releaseManifestsAreValid(releasePass.candidateManifest, releasePass.productionManifest, current)
  );
};

const releaseManifestsAreValid = (
  candidate: EvaluationManifest,
  production: EvaluationManifest,
  current: CurrentReleaseEvidence,
): boolean => {
  const currentInstant = parseEvidenceInstant(current.now);
  return (
    currentInstant.kind === "success" &&
    verifyEvaluationManifest(candidate) &&
    verifyEvaluationManifest(production) &&
    candidate.arm === "candidate" &&
    production.arm === "production" &&
    candidate.approvedBaseline.configurationDigest ===
      production.approvedBaseline.configurationDigest &&
    candidate.approvedBaseline.corpusDigest === production.approvedBaseline.corpusDigest &&
    candidate.approvedBaseline.dependencyDigest === production.approvedBaseline.dependencyDigest &&
    candidate.approvedBaseline.graderDigest === production.approvedBaseline.graderDigest &&
    candidate.approvedBaseline.humanLabelSetVersion ===
      production.approvedBaseline.humanLabelSetVersion &&
    candidate.approvedBaseline.inferenceSettingsDigest ===
      production.approvedBaseline.inferenceSettingsDigest &&
    candidate.approvedBaseline.providerModelId === production.approvedBaseline.providerModelId &&
    candidate.approvedBaseline.rubricDigest === production.approvedBaseline.rubricDigest &&
    candidate.approvedBaseline.sourceCommit === production.approvedBaseline.sourceCommit &&
    production.approvedBaseline.configurationDigest === production.configurationDigest &&
    production.approvedBaseline.corpusDigest === production.corpusDigest &&
    production.approvedBaseline.dependencyDigest === production.dependencyDigest &&
    production.approvedBaseline.graderDigest === production.graderDigest &&
    production.approvedBaseline.humanLabelSetVersion === production.humanLabelSetVersion &&
    production.approvedBaseline.inferenceSettingsDigest === production.inferenceSettingsDigest &&
    production.approvedBaseline.providerModelId === production.providerModelId &&
    production.approvedBaseline.rubricDigest === production.rubricDigest &&
    production.approvedBaseline.sourceCommit === production.sourceCommit &&
    candidate.corpusDigest === production.corpusDigest &&
    candidate.corpusVersion === production.corpusVersion &&
    candidate.fixtureDigest === production.fixtureDigest &&
    candidate.graderDigest === production.graderDigest &&
    candidate.rubricDigest === production.rubricDigest &&
    assessPassCurrentness({
      currentConfigurationDigest: current.configurationDigest,
      currentCorpusDigest: current.corpusDigest,
      currentDependencyDigest: current.dependencyDigest,
      currentGraderDigest: current.graderDigest,
      currentRubricDigest: current.rubricDigest,
      now: current.now,
      passConfigurationDigest: candidate.configurationDigest,
      passCorpusDigest: candidate.corpusDigest,
      passDependencyDigest: candidate.dependencyDigest,
      passGraderDigest: candidate.graderDigest,
      passRubricDigest: candidate.rubricDigest,
      passedAt: candidate.outputEvidence.utcWindow.endedAt,
    }) === "PASS"
  );
};

const invalidReleasePass = (message: string): InvalidReleasePass => ({
  error: { _tag: "InvalidReleasePass", message },
  kind: "error",
});
