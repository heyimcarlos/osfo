import { createHash, verify as verifySignature } from "node:crypto";

import type { EvidenceVerdict } from "./statistics";
import {
  parseApprovalId,
  parseEvaluationManifestId,
  parseEvidenceInstant,
  parseReleaseId,
  parseVersionId,
  type ApprovalId,
  type EvaluationManifestId,
  type EvidenceInstant,
  type ReleaseId,
  type VersionId,
} from "./identity";

/** Canonical SHA-256 digest string used for immutable evidence identities. */
export type Sha256Digest = `sha256:${string}`;

declare const digestRole: unique symbol;

/** Roles assigned to digested Model Quality evidence. */
export type DigestRole =
  | "artifact-checksums"
  | "configuration"
  | "cohort"
  | "context"
  | "corpus"
  | "cost"
  | "dependency"
  | "fixture"
  | "grader"
  | "gate-verdict"
  | "human-review"
  | "inference-settings"
  | "latency"
  | "manifest"
  | "memory"
  | "policies"
  | "power-calculation"
  | "prompts"
  | "raw-outputs"
  | "release-pass"
  | "rendering"
  | "routes"
  | "rubric"
  | "scores"
  | "skills"
  | "token-use"
  | "tools"
  | "traces"
  | "workflows";

/** Role-specific digest that cannot be cross-wired with another evidence role. */
export type EvidenceDigest<Role extends DigestRole> = Sha256Digest & {
  readonly [digestRole]: Role;
};

/** Result of parsing one externally persisted role-specific digest. */
export type EvidenceDigestParseResult<Role extends DigestRole> =
  | { readonly kind: "success"; readonly value: EvidenceDigest<Role> }
  | {
      readonly error: { readonly _tag: "InvalidEvidenceDigest"; readonly role: Role };
      readonly kind: "error";
    };

/** Parse one canonical SHA-256 digest for its explicit evidence role. */
export const parseEvidenceDigest = <Role extends DigestRole>(
  role: Role,
  input: string,
): EvidenceDigestParseResult<Role> => {
  if (!/^sha256:[a-f0-9]{64}$/.test(input)) {
    return { error: { _tag: "InvalidEvidenceDigest", role }, kind: "error" };
  }
  // SAFETY: The format was parsed and the caller supplied the only role that owns the result.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: TypeScript cannot construct the private digest role brand.
  return { kind: "success", value: input as EvidenceDigest<Role> };
};

/** Material behavior configuration evaluated as one inseparable release object. */
export type BehaviorConfiguration = {
  readonly context: EvidenceDigest<"context">;
  readonly memory: EvidenceDigest<"memory">;
  readonly policies: EvidenceDigest<"policies">;
  readonly prompts: EvidenceDigest<"prompts">;
  readonly rendering: EvidenceDigest<"rendering">;
  readonly routes: EvidenceDigest<"routes">;
  readonly skills: EvidenceDigest<"skills">;
  readonly tools: EvidenceDigest<"tools">;
  readonly workflows: EvidenceDigest<"workflows">;
};

/** Inputs frozen into one evaluation evidence manifest. */
export type EvaluationManifestInput = {
  readonly approvedBaseline: {
    readonly approvedAt: string;
    readonly approverId: string;
    readonly configurationDigest: EvidenceDigest<"configuration">;
    readonly corpusDigest: EvidenceDigest<"corpus">;
    readonly dependencyDigest: EvidenceDigest<"dependency">;
    readonly graderDigest: EvidenceDigest<"grader">;
    readonly humanLabelSetVersion: string;
    readonly inferenceSettingsDigest: EvidenceDigest<"inference-settings">;
    readonly providerModelId: string;
    readonly rubricDigest: EvidenceDigest<"rubric">;
    readonly sourceCommit: string;
    readonly signature: string;
  };
  /** Explicit immutable role of this manifest in the candidate versus production comparison. */
  readonly arm: "candidate" | "production";
  readonly configuration: BehaviorConfiguration;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly corpusVersion: string;
  readonly createdAt: string;
  readonly dependencyDigest: EvidenceDigest<"dependency">;
  readonly fixtureDigest: EvidenceDigest<"fixture">;
  readonly graderDigest: EvidenceDigest<"grader">;
  readonly gateVerdictDigest: EvidenceDigest<"gate-verdict">;
  readonly humanReviewDigest: EvidenceDigest<"human-review">;
  readonly humanLabelSetVersion: string;
  readonly inferenceSettingsDigest: EvidenceDigest<"inference-settings">;
  readonly outputEvidence: {
    readonly artifactChecksumsDigest: EvidenceDigest<"artifact-checksums">;
    readonly costDigest: EvidenceDigest<"cost">;
    readonly latencyDigest: EvidenceDigest<"latency">;
    readonly rawOutputsDigest: EvidenceDigest<"raw-outputs">;
    readonly scoreDigest: EvidenceDigest<"scores">;
    readonly tokenUseDigest: EvidenceDigest<"token-use">;
    readonly traceDigest: EvidenceDigest<"traces">;
    readonly utcWindow: { readonly endedAt: string; readonly startedAt: string };
  };
  readonly outputSignature: string;
  readonly powerCalculationDigest: EvidenceDigest<"power-calculation">;
  readonly providerModelId: string;
  readonly rubricDigest: EvidenceDigest<"rubric">;
  readonly releaseId: string;
  readonly sourceCommit: string;
  readonly manifestId: string;
};

/** Immutable manifest that binds evaluation output to all behavior-producing inputs. */
export type EvaluationManifest = Omit<
  EvaluationManifestInput,
  | "approvedBaseline"
  | "corpusVersion"
  | "createdAt"
  | "humanLabelSetVersion"
  | "manifestId"
  | "outputEvidence"
  | "releaseId"
> & {
  readonly approvedBaseline: Omit<
    EvaluationManifestInput["approvedBaseline"],
    "approvedAt" | "approverId"
  > & {
    readonly approvedAt: EvidenceInstant;
    readonly approverId: ApprovalId;
  };
  readonly configurationDigest: EvidenceDigest<"configuration">;
  readonly contentDigest: EvidenceDigest<"manifest">;
  readonly corpusVersion: VersionId;
  readonly createdAt: EvidenceInstant;
  readonly humanLabelSetVersion: VersionId;
  readonly manifestId: EvaluationManifestId;
  readonly outputEvidence: Omit<EvaluationManifestInput["outputEvidence"], "utcWindow"> & {
    readonly utcWindow: {
      readonly endedAt: EvidenceInstant;
      readonly startedAt: EvidenceInstant;
    };
  };
  readonly releaseId: ReleaseId;
};

/** Less-trusted persisted evaluation-manifest shape accepted at the parsing boundary. */
export type PersistedEvaluationManifest = EvaluationManifestInput & {
  readonly configurationDigest: EvidenceDigest<"configuration">;
  readonly contentDigest: EvidenceDigest<"manifest">;
};

/** Expected failure when baseline evidence is not authorized or internally consistent. */
export type InvalidBaselineApproval = {
  readonly _tag: "InvalidBaselineApproval";
  readonly message: string;
};

/** Result of creating an immutable evaluation manifest. */
export type EvaluationManifestResult =
  | { readonly kind: "success"; readonly value: EvaluationManifest }
  | { readonly error: InvalidBaselineApproval; readonly kind: "error" };

/** JSON-compatible evidence value accepted by canonical manifest hashing. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalValue>
  | { readonly [key: string]: CanonicalValue };

/** Produce a canonical SHA-256 digest bound to one evidence role. */
export const digestValue = <Role extends DigestRole>(
  role: Role,
  value: CanonicalValue,
): EvidenceDigest<Role> => {
  const digest = `sha256:${createHash("sha256")
    .update(`${role}:${canonicalRepresentation(value)}`)
    .digest("hex")}`;
  // SAFETY: This function hashes the value for the explicit role. Callers cannot construct the brand.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: TypeScript cannot express this private role brand after hashing.
  return digest as EvidenceDigest<Role>;
};

/** Digest the complete behavior configuration independent of object key insertion order. */
export const configurationDigest = (
  configuration: BehaviorConfiguration,
): EvidenceDigest<"configuration"> => digestValue("configuration", configuration);

/** Create and freeze an immutable evaluation evidence manifest. */
export const createEvaluationManifest = (
  input: EvaluationManifestInput,
): EvaluationManifestResult => {
  if (!evaluationManifestInputIsValid(input)) return invalidEvaluationManifest();
  const createdAt = parseEvidenceInstant(input.createdAt);
  const approvedAt = parseEvidenceInstant(input.approvedBaseline.approvedAt);
  const approverId = parseApprovalId(input.approvedBaseline.approverId);
  const corpusVersion = parseVersionId(input.corpusVersion);
  const humanLabelSetVersion = parseVersionId(input.humanLabelSetVersion);
  const manifestId = parseEvaluationManifestId(input.manifestId);
  const releaseId = parseReleaseId(input.releaseId);
  const startedAt = parseEvidenceInstant(input.outputEvidence.utcWindow.startedAt);
  const endedAt = parseEvidenceInstant(input.outputEvidence.utcWindow.endedAt);
  if (
    approvedAt.kind === "error" ||
    approverId.kind === "error" ||
    createdAt.kind === "error" ||
    corpusVersion.kind === "error" ||
    humanLabelSetVersion.kind === "error" ||
    manifestId.kind === "error" ||
    releaseId.kind === "error" ||
    startedAt.kind === "error" ||
    endedAt.kind === "error"
  ) {
    return invalidEvaluationManifest();
  }
  const approvedBaseline = Object.freeze({
    ...input.approvedBaseline,
    approvedAt: approvedAt.value,
    approverId: approverId.value,
  });
  const configuration = Object.freeze({ ...input.configuration });
  const outputEvidence = Object.freeze({
    ...input.outputEvidence,
    utcWindow: Object.freeze({
      endedAt: endedAt.value,
      startedAt: startedAt.value,
    }),
  });
  const unsigned = Object.freeze({
    ...input,
    approvedBaseline,
    configuration,
    corpusVersion: corpusVersion.value,
    createdAt: createdAt.value,
    humanLabelSetVersion: humanLabelSetVersion.value,
    manifestId: manifestId.value,
    releaseId: releaseId.value,
    outputEvidence,
    configurationDigest: configurationDigest(configuration),
  });
  return parseEvaluationManifest(
    Object.freeze({ ...unsigned, contentDigest: digestValue("manifest", unsigned) }),
  );
};

const baselineApproverIds = new Set(["quality-owner-1"]);

const baselineApprovalPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxHWjDtUk10j4bylZrvhcB2FpnEBJ65GWCW+Etn6hOj8=
-----END PUBLIC KEY-----`;

const outputEvidencePublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEACRDA7XS9bYXe8nFwvAuCH5ny1bZ5LR0WkWMlylI6NjU=
-----END PUBLIC KEY-----`;

/** Produce the baseline authority payload that binds approved production identity. */
export const baselineApprovalSigningDigest = (
  approval: EvaluationManifestInput["approvedBaseline"],
): EvidenceDigest<"manifest"> =>
  digestValue("manifest", {
    approvedAt: approval.approvedAt,
    approverId: approval.approverId,
    configurationDigest: approval.configurationDigest,
    corpusDigest: approval.corpusDigest,
    dependencyDigest: approval.dependencyDigest,
    graderDigest: approval.graderDigest,
    humanLabelSetVersion: approval.humanLabelSetVersion,
    inferenceSettingsDigest: approval.inferenceSettingsDigest,
    providerModelId: approval.providerModelId,
    rubricDigest: approval.rubricDigest,
    sourceCommit: approval.sourceCommit,
  });

const verifyBaselineApproval = (approval: EvaluationManifestInput["approvedBaseline"]): boolean =>
  verifySignature(
    null,
    Buffer.from(baselineApprovalSigningDigest(approval)),
    baselineApprovalPublicKey,
    Buffer.from(approval.signature, "base64"),
  );

const evaluationManifestInputIsValid = (input: EvaluationManifestInput): boolean => {
  const approvedAt = parseEvidenceInstant(input.approvedBaseline.approvedAt);
  const createdAt = parseEvidenceInstant(input.createdAt);
  const startedAt = parseEvidenceInstant(input.outputEvidence.utcWindow.startedAt);
  const endedAt = parseEvidenceInstant(input.outputEvidence.utcWindow.endedAt);
  return (
    baselineApproverIds.has(input.approvedBaseline.approverId) &&
    verifyBaselineApproval(input.approvedBaseline) &&
    verifyOutputEvidenceSignature(input) &&
    approvedAt.kind === "success" &&
    createdAt.kind === "success" &&
    startedAt.kind === "success" &&
    endedAt.kind === "success" &&
    Date.parse(startedAt.value) <= Date.parse(endedAt.value) &&
    Date.parse(approvedAt.value) <= Date.parse(startedAt.value) &&
    parseApprovalId(input.approvedBaseline.approverId).kind === "success" &&
    parseVersionId(input.approvedBaseline.humanLabelSetVersion).kind === "success" &&
    parseVersionId(input.corpusVersion).kind === "success" &&
    parseVersionId(input.humanLabelSetVersion).kind === "success" &&
    parseEvaluationManifestId(input.manifestId).kind === "success" &&
    parseReleaseId(input.releaseId).kind === "success" &&
    (input.arm === "candidate" || input.arm === "production") &&
    input.providerModelId.length > 0 &&
    input.sourceCommit.length > 0
  );
};

const verifyOutputEvidenceSignature = (input: EvaluationManifestInput): boolean => {
  return verifySignature(
    null,
    Buffer.from(evaluationOutputSigningDigest(input)),
    outputEvidencePublicKey,
    Buffer.from(input.outputSignature, "base64"),
  );
};

/** Produce the canonical digest signed by the evaluation execution authority. */
export const evaluationOutputSigningDigest = (
  input: EvaluationManifestInput,
): EvidenceDigest<"manifest"> => {
  const { outputSignature: ignoredSignature, ...signed } = input;
  void ignoredSignature;
  return digestValue("manifest", signed);
};

/** Parse persisted evidence with the same invariants used by creation. */
export const parseEvaluationManifest = (
  manifest: PersistedEvaluationManifest,
): EvaluationManifestResult => {
  const { contentDigest, ...unsigned } = manifest;
  const { configurationDigest: ignoredConfigurationDigest, ...input } = unsigned;
  void ignoredConfigurationDigest;
  if (
    contentDigest !== digestValue("manifest", unsigned) ||
    ignoredConfigurationDigest !== configurationDigest(input.configuration) ||
    !evaluationManifestInputIsValid(input)
  ) {
    return invalidEvaluationManifest();
  }
  return { kind: "success", value: freezeEvaluationManifest(manifest) };
};

/** Verify content integrity and the exact approved corpus, rubric, and grader baseline. */
export const verifyEvaluationManifest = (manifest: PersistedEvaluationManifest): boolean => {
  return parseEvaluationManifest(manifest).kind === "success";
};

const freezeEvaluationManifest = (manifest: PersistedEvaluationManifest): EvaluationManifest => {
  const approvedAt = parseEvidenceInstant(manifest.approvedBaseline.approvedAt);
  const approverId = parseApprovalId(manifest.approvedBaseline.approverId);
  const corpusVersion = parseVersionId(manifest.corpusVersion);
  const createdAt = parseEvidenceInstant(manifest.createdAt);
  const humanLabelSetVersion = parseVersionId(manifest.humanLabelSetVersion);
  const manifestId = parseEvaluationManifestId(manifest.manifestId);
  const releaseId = parseReleaseId(manifest.releaseId);
  const startedAt = parseEvidenceInstant(manifest.outputEvidence.utcWindow.startedAt);
  const endedAt = parseEvidenceInstant(manifest.outputEvidence.utcWindow.endedAt);
  if (
    approvedAt.kind === "error" ||
    approverId.kind === "error" ||
    corpusVersion.kind === "error" ||
    createdAt.kind === "error" ||
    humanLabelSetVersion.kind === "error" ||
    manifestId.kind === "error" ||
    releaseId.kind === "error" ||
    startedAt.kind === "error" ||
    endedAt.kind === "error"
  ) {
    throw new Error("Validated evaluation manifest could not be normalized.");
  }
  return Object.freeze({
    ...manifest,
    approvedBaseline: Object.freeze({
      ...manifest.approvedBaseline,
      approvedAt: approvedAt.value,
      approverId: approverId.value,
    }),
    configuration: Object.freeze({ ...manifest.configuration }),
    corpusVersion: corpusVersion.value,
    createdAt: createdAt.value,
    humanLabelSetVersion: humanLabelSetVersion.value,
    manifestId: manifestId.value,
    releaseId: releaseId.value,
    outputEvidence: Object.freeze({
      ...manifest.outputEvidence,
      utcWindow: Object.freeze({ endedAt: endedAt.value, startedAt: startedAt.value }),
    }),
  });
};

const invalidEvaluationManifest = (): EvaluationManifestResult => ({
  error: {
    _tag: "InvalidBaselineApproval",
    message: "The evaluation manifest or its signed evidence is invalid.",
  },
  kind: "error",
});

/** Inputs needed to decide whether an earlier PASS remains current for promotion. */
export type PassCurrentnessInput = {
  readonly currentConfigurationDigest: EvidenceDigest<"configuration">;
  readonly currentCorpusDigest: EvidenceDigest<"corpus">;
  readonly currentDependencyDigest: EvidenceDigest<"dependency">;
  readonly currentGraderDigest: EvidenceDigest<"grader">;
  readonly currentRubricDigest: EvidenceDigest<"rubric">;
  readonly now: string;
  readonly passConfigurationDigest: EvidenceDigest<"configuration">;
  readonly passCorpusDigest: EvidenceDigest<"corpus">;
  readonly passDependencyDigest: EvidenceDigest<"dependency">;
  readonly passGraderDigest: EvidenceDigest<"grader">;
  readonly passRubricDigest: EvidenceDigest<"rubric">;
  readonly passedAt: string;
};

/** Require matching material digests and a PASS no more than seven days old. */
export const assessPassCurrentness = (input: PassCurrentnessInput): EvidenceVerdict => {
  if (
    parseEvidenceInstant(input.now).kind === "error" ||
    parseEvidenceInstant(input.passedAt).kind === "error"
  ) {
    return "MISSING";
  }
  const elapsed = Date.parse(input.now) - Date.parse(input.passedAt);
  const exactDigests =
    input.currentConfigurationDigest === input.passConfigurationDigest &&
    input.currentCorpusDigest === input.passCorpusDigest &&
    input.currentDependencyDigest === input.passDependencyDigest &&
    input.currentGraderDigest === input.passGraderDigest &&
    input.currentRubricDigest === input.passRubricDigest;
  return Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    elapsed <= 7 * 24 * 60 * 60 * 1_000 &&
    exactDigests
    ? "PASS"
    : "MISSING";
};

const canonicalRepresentation = (value: CanonicalValue): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array:[${value.map(canonicalRepresentation).join(",")}]`;
  // oxlint-disable-next-line osfo/no-runtime-typeof -- CanonicalValue is parsed; each variant gets a collision-safe tag.
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  // oxlint-disable-next-line osfo/no-runtime-typeof -- CanonicalValue is parsed; each variant gets a collision-safe tag.
  if (typeof value === "boolean") return `boolean:${value ? "true" : "false"}`;
  // oxlint-disable-next-line osfo/no-runtime-typeof -- Non-finite and negative-zero tokens remain distinct.
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  return `object:{${Object.entries(value)
    // oxlint-disable-next-line unicorn/no-array-sort -- Object.entries returns a new array for canonical ordering.
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalRepresentation(child)}`)
    .join(",")}}`;
};
