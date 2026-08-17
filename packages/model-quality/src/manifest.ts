import { createHash } from "node:crypto";

import type { EvidenceVerdict } from "./statistics";

/** Canonical SHA-256 digest string used for immutable evidence identities. */
export type Sha256Digest = `sha256:${string}`;

/** Material behavior configuration evaluated as one inseparable release object. */
export type BehaviorConfiguration = {
  readonly context: Sha256Digest;
  readonly memory: Sha256Digest;
  readonly policies: Sha256Digest;
  readonly prompts: Sha256Digest;
  readonly rendering: Sha256Digest;
  readonly routes: Sha256Digest;
  readonly skills: Sha256Digest;
  readonly tools: Sha256Digest;
  readonly workflows: Sha256Digest;
};

/** Inputs frozen into one evaluation evidence manifest. */
export type EvaluationManifestInput = {
  readonly configuration: BehaviorConfiguration;
  readonly corpusDigest: Sha256Digest;
  readonly corpusVersion: string;
  readonly createdAt: string;
  readonly dependencyDigest: Sha256Digest;
  readonly fixtureDigest: Sha256Digest;
  readonly graderDigest: Sha256Digest;
  readonly humanLabelSetVersion: string;
  readonly inferenceSettingsDigest: Sha256Digest;
  readonly outputEvidence: {
    readonly artifactChecksumsDigest: Sha256Digest;
    readonly costDigest: Sha256Digest;
    readonly latencyDigest: Sha256Digest;
    readonly rawOutputsDigest: Sha256Digest;
    readonly scoreDigest: Sha256Digest;
    readonly tokenUseDigest: Sha256Digest;
    readonly traceDigest: Sha256Digest;
    readonly utcWindow: { readonly endedAt: string; readonly startedAt: string };
  };
  readonly powerCalculationDigest: Sha256Digest;
  readonly providerModelId: string;
  readonly sourceCommit: string;
};

/** Immutable manifest that binds evaluation output to all behavior-producing inputs. */
export type EvaluationManifest = EvaluationManifestInput & {
  readonly configurationDigest: Sha256Digest;
  readonly contentDigest: Sha256Digest;
};

/** JSON-compatible evidence value accepted by canonical manifest hashing. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalValue>
  | { readonly [key: string]: CanonicalValue };

/** Produce a canonical SHA-256 digest for JSON-compatible product evidence. */
export const digestValue = (value: CanonicalValue): Sha256Digest =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/** Digest the complete behavior configuration independent of object key insertion order. */
export const configurationDigest = (configuration: BehaviorConfiguration): Sha256Digest =>
  digestValue(configuration);

/** Create and freeze an immutable evaluation evidence manifest. */
export const createEvaluationManifest = (input: EvaluationManifestInput): EvaluationManifest => {
  const configuration = Object.freeze({ ...input.configuration });
  const outputEvidence = Object.freeze({
    ...input.outputEvidence,
    utcWindow: Object.freeze({ ...input.outputEvidence.utcWindow }),
  });
  const unsigned = Object.freeze({
    ...input,
    configuration,
    outputEvidence,
    configurationDigest: configurationDigest(configuration),
  });
  return Object.freeze({ ...unsigned, contentDigest: digestValue(unsigned) });
};

/** Verify that an evaluation manifest still matches its immutable content digest. */
export const verifyEvaluationManifest = (manifest: EvaluationManifest): boolean => {
  const { contentDigest, ...unsigned } = manifest;
  return contentDigest === digestValue(unsigned);
};

/** Inputs needed to decide whether an earlier PASS remains current for promotion. */
export type PassCurrentnessInput = {
  readonly currentConfigurationDigest: Sha256Digest;
  readonly currentCorpusDigest: Sha256Digest;
  readonly currentDependencyDigest: Sha256Digest;
  readonly currentGraderDigest: Sha256Digest;
  readonly now: string;
  readonly passConfigurationDigest: Sha256Digest;
  readonly passCorpusDigest: Sha256Digest;
  readonly passDependencyDigest: Sha256Digest;
  readonly passGraderDigest: Sha256Digest;
  readonly passedAt: string;
};

/** Require matching material digests and a PASS no more than seven days old. */
export const assessPassCurrentness = (input: PassCurrentnessInput): EvidenceVerdict => {
  const elapsed = Date.parse(input.now) - Date.parse(input.passedAt);
  const exactDigests =
    input.currentConfigurationDigest === input.passConfigurationDigest &&
    input.currentCorpusDigest === input.passCorpusDigest &&
    input.currentDependencyDigest === input.passDependencyDigest &&
    input.currentGraderDigest === input.passGraderDigest;
  return Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    elapsed <= 7 * 24 * 60 * 60 * 1_000 &&
    exactDigests
    ? "PASS"
    : "MISSING";
};

const canonicalJson = (value: CanonicalValue): string => JSON.stringify(normalize(value));

const normalize = (value: CanonicalValue): CanonicalValue => {
  if (Array.isArray(value)) return value.map(normalize);
  // oxlint-disable-next-line osfo/no-runtime-typeof -- CanonicalValue is already parsed; this distinguishes its object variant for stable key ordering.
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        // oxlint-disable-next-line unicorn/no-array-sort -- Object.entries returns a fresh array used only for canonical ordering.
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
};
