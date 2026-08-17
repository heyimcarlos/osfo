import { createHash, verify as verifySignature } from "node:crypto";

import type { EvidenceVerdict } from "./statistics";

/** Canonical SHA-256 digest string used for immutable evidence identities. */
export type Sha256Digest = `sha256:${string}`;

declare const digestRole: unique symbol;

/** Roles assigned to digested Model Quality evidence. */
export type DigestRole =
  | "artifact-checksums"
  | "configuration"
  | "context"
  | "corpus"
  | "cost"
  | "dependency"
  | "fixture"
  | "grader"
  | "inference-settings"
  | "latency"
  | "manifest"
  | "memory"
  | "policies"
  | "power-calculation"
  | "prompts"
  | "raw-outputs"
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
    readonly corpusDigest: EvidenceDigest<"corpus">;
    readonly graderDigest: EvidenceDigest<"grader">;
    readonly rubricDigest: EvidenceDigest<"rubric">;
    readonly signature: string;
  };
  readonly configuration: BehaviorConfiguration;
  readonly corpusDigest: EvidenceDigest<"corpus">;
  readonly corpusVersion: string;
  readonly createdAt: string;
  readonly dependencyDigest: EvidenceDigest<"dependency">;
  readonly fixtureDigest: EvidenceDigest<"fixture">;
  readonly graderDigest: EvidenceDigest<"grader">;
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
  readonly powerCalculationDigest: EvidenceDigest<"power-calculation">;
  readonly providerModelId: string;
  readonly rubricDigest: EvidenceDigest<"rubric">;
  readonly sourceCommit: string;
};

/** Immutable manifest that binds evaluation output to all behavior-producing inputs. */
export type EvaluationManifest = EvaluationManifestInput & {
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
  if (!evaluationManifestInputIsValid(input)) {
    return {
      error: {
        _tag: "InvalidBaselineApproval",
        message: "The baseline approval is unauthorized or does not match evaluated evidence.",
      },
      kind: "error",
    };
  }
  const approvedBaseline = Object.freeze({ ...input.approvedBaseline });
  const configuration = Object.freeze({ ...input.configuration });
  const outputEvidence = Object.freeze({
    ...input.outputEvidence,
    utcWindow: Object.freeze({ ...input.outputEvidence.utcWindow }),
  });
  const unsigned = Object.freeze({
    ...input,
    approvedBaseline,
    configuration,
    outputEvidence,
    configurationDigest: configurationDigest(configuration),
  });
  return {
    kind: "success",
    value: Object.freeze({ ...unsigned, contentDigest: digestValue("manifest", unsigned) }),
  };
};

const baselineApproverIds = new Set(["quality-owner-1"]);

const baselineApprovalPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6dh33JcphwgRxlTk88OXpQ4Hkt3hrTWfsRTeDEp3gTE=
-----END PUBLIC KEY-----`;

const verifyBaselineApproval = (approval: EvaluationManifestInput["approvedBaseline"]): boolean =>
  verifySignature(
    null,
    Buffer.from(
      [
        approval.approverId,
        approval.approvedAt,
        approval.corpusDigest,
        approval.graderDigest,
        approval.rubricDigest,
      ].join("|"),
    ),
    baselineApprovalPublicKey,
    Buffer.from(approval.signature, "base64"),
  );

const evaluationManifestInputIsValid = (input: EvaluationManifestInput): boolean => {
  const approvedAt = Date.parse(input.approvedBaseline.approvedAt);
  const createdAt = Date.parse(input.createdAt);
  const startedAt = Date.parse(input.outputEvidence.utcWindow.startedAt);
  const endedAt = Date.parse(input.outputEvidence.utcWindow.endedAt);
  return (
    baselineApproverIds.has(input.approvedBaseline.approverId) &&
    input.approvedBaseline.corpusDigest === input.corpusDigest &&
    input.approvedBaseline.graderDigest === input.graderDigest &&
    input.approvedBaseline.rubricDigest === input.rubricDigest &&
    verifyBaselineApproval(input.approvedBaseline) &&
    Number.isFinite(approvedAt) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) &&
    startedAt <= endedAt &&
    approvedAt <= startedAt
  );
};

/** Verify content integrity and the exact approved corpus, rubric, and grader baseline. */
export const verifyEvaluationManifest = (manifest: EvaluationManifest): boolean => {
  const { contentDigest, ...unsigned } = manifest;
  return (
    contentDigest === digestValue("manifest", unsigned) && evaluationManifestInputIsValid(manifest)
  );
};

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
