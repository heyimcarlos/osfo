/* oxlint-disable osfo/no-unknown-parameters -- These functions are the owning schema parsers for untrusted Durable Object RPC input. */
import { Option, Schema } from "effect";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const boundedKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const boundedBody = Schema.String.check(Schema.isMaxLength(131_072));

export const qualificationCohortArtifactProtocol = "qualification-cohort-artifacts-v1" as const;

export const QualificationCohortArtifactFamily = Schema.Literals([
  "manifest",
  "provisionPage",
  "participantGrant",
  "finalizePage",
  "inventoryReceipt",
]);
export type QualificationCohortArtifactFamily = typeof QualificationCohortArtifactFamily.Type;

export const QualificationCohortArtifactRetainInput = Schema.Struct({
  body: boundedBody,
  executionId: boundedIdentity,
  family: QualificationCohortArtifactFamily,
  key: boundedKey,
  metadata: Schema.Record(Schema.String, Schema.String),
  operationToken: boundedIdentity,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
});
export type QualificationCohortArtifactRetainInput =
  typeof QualificationCohortArtifactRetainInput.Type;

export const QualificationCohortArtifactFenceInput = Schema.Struct({
  executionId: boundedIdentity,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
});
export type QualificationCohortArtifactFenceInput =
  typeof QualificationCohortArtifactFenceInput.Type;

const decodeRetain = Schema.decodeUnknownOption(QualificationCohortArtifactRetainInput);
const decodeFence = Schema.decodeUnknownOption(QualificationCohortArtifactFenceInput);

export const decodeQualificationCohortArtifactRetainInput = (
  input: unknown,
): QualificationCohortArtifactRetainInput | null => {
  const decoded = decodeRetain(input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const decodeQualificationCohortArtifactFenceInput = (
  input: unknown,
): QualificationCohortArtifactFenceInput | null => {
  const decoded = decodeFence(input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export type QualificationCohortArtifactRetainOutcome =
  | {
      readonly _tag: "Complete";
      readonly bodySha256: string;
      readonly key: string;
      readonly metadataDigest: string;
      readonly protocolVersion: typeof qualificationCohortArtifactProtocol;
    }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Conflict"; readonly code: string }
  | { readonly _tag: "Fenced" };

export type QualificationCohortArtifactFenceOutcome =
  | {
      readonly _tag: "Fenced";
      readonly protocolVersion: typeof qualificationCohortArtifactProtocol;
    }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Conflict"; readonly code: string }
  | { readonly _tag: "Missing" };
