/* oxlint-disable osfo/no-unknown-parameters -- These functions are the owning schema parsers for untrusted Durable Object RPC input. */
import { Option, Schema } from "effect";

import { qualificationChecksum } from "./qualification-checksum";

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const boundedKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const boundedBody = Schema.String.check(Schema.isMaxLength(131_072));
const boundedChecksum = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const boundedArtifactKeys = Schema.Array(boundedKey).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(27),
);

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

export const QualificationCohortArtifactDeletePageInput = Schema.Struct({
  executionId: boundedIdentity,
  expectedArtifactKeys: boundedArtifactKeys,
  expectedArtifactsChecksum: boundedChecksum,
  pageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  plan: Schema.Literals(["adventurer", "free"]),
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  previousPageChecksum: boundedChecksum,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
});
export type QualificationCohortArtifactDeletePageInput =
  typeof QualificationCohortArtifactDeletePageInput.Type;

export const QualificationCohortArtifactSealPageInput = Schema.Struct({
  executionId: boundedIdentity,
  expectedArtifactKeys: boundedArtifactKeys,
  expectedArtifactsChecksum: boundedChecksum,
  pageChecksum: boundedChecksum,
  pageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  plan: Schema.Literals(["adventurer", "free"]),
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  previousPageChecksum: boundedChecksum,
  proofChecksum: boundedChecksum,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
});
export type QualificationCohortArtifactSealPageInput =
  typeof QualificationCohortArtifactSealPageInput.Type;

export const QualificationCohortArtifactDeleteRootInput = Schema.Struct({
  executionId: boundedIdentity,
  expectedArtifactKeys: Schema.Array(boundedKey).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(2),
  ),
  expectedArtifactsChecksum: boundedChecksum,
  expectedPageCount: Schema.Int.check(Schema.isGreaterThan(0)),
  finalPageChecksum: boundedChecksum,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
});
export type QualificationCohortArtifactDeleteRootInput =
  typeof QualificationCohortArtifactDeleteRootInput.Type;

export const QualificationCohortArtifactSealRootInput = Schema.Struct({
  executionId: boundedIdentity,
  proofChecksum: boundedChecksum,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
  rootChecksum: boundedChecksum,
});
export type QualificationCohortArtifactSealRootInput =
  typeof QualificationCohortArtifactSealRootInput.Type;

export const QualificationCohortArtifactInspectInput = Schema.Struct({
  executionId: boundedIdentity,
  protocolVersion: Schema.Literal(qualificationCohortArtifactProtocol),
});
export type QualificationCohortArtifactInspectInput =
  typeof QualificationCohortArtifactInspectInput.Type;

const decodeRetain = Schema.decodeUnknownOption(QualificationCohortArtifactRetainInput);
const decodeFence = Schema.decodeUnknownOption(QualificationCohortArtifactFenceInput);
const decodeDeletePage = Schema.decodeUnknownOption(QualificationCohortArtifactDeletePageInput);
const decodeSealPage = Schema.decodeUnknownOption(QualificationCohortArtifactSealPageInput);
const decodeDeleteRoot = Schema.decodeUnknownOption(QualificationCohortArtifactDeleteRootInput);
const decodeSealRoot = Schema.decodeUnknownOption(QualificationCohortArtifactSealRootInput);
const decodeInspect = Schema.decodeUnknownOption(QualificationCohortArtifactInspectInput);

const decodeNullable =
  <A>(decoder: (input: unknown) => Option.Option<A>) =>
  (input: unknown) => {
    const decoded = decoder(input);
    return Option.isSome(decoded) ? decoded.value : null;
  };

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

export const decodeQualificationCohortArtifactDeletePageInput = decodeNullable(decodeDeletePage);
export const decodeQualificationCohortArtifactSealPageInput = decodeNullable(decodeSealPage);
export const decodeQualificationCohortArtifactDeleteRootInput = decodeNullable(decodeDeleteRoot);
export const decodeQualificationCohortArtifactSealRootInput = decodeNullable(decodeSealRoot);
export const decodeQualificationCohortArtifactInspectInput = decodeNullable(decodeInspect);

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

export interface QualificationCohortArtifactAbsenceProof {
  readonly artifactRecordsChecksum: string;
  readonly expectedArtifactCount: number;
  readonly expectedArtifactsChecksum: string;
  readonly operationId: string;
  readonly proofChecksum: string;
  readonly scope: "page" | "root";
}

export type QualificationCohortArtifactDeleteOutcome =
  | ({ readonly _tag: "Proven" } & QualificationCohortArtifactAbsenceProof)
  | {
      readonly _tag: "Retryable";
      readonly operationId: string;
      readonly survivingArtifactCount: number;
      readonly survivingArtifactsChecksum: string;
    }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Conflict"; readonly code: string }
  | { readonly _tag: "Missing"; readonly code: string };

export type QualificationCohortArtifactSealPageOutcome =
  | {
      readonly _tag: "Sealed";
      readonly pageChecksum: string;
      readonly position: number;
      readonly proofChecksum: string;
    }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Conflict"; readonly code: string }
  | { readonly _tag: "Missing"; readonly code: string };

export type QualificationCohortArtifactSealRootOutcome =
  | { readonly _tag: "Scrubbed"; readonly rootChecksum: string }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Conflict"; readonly code: string }
  | { readonly _tag: "Missing"; readonly code: string };

export type QualificationCohortArtifactInspection =
  | {
      readonly _tag: "Present";
      readonly artifactRecordCount: number;
      readonly lifecycle: "FENCED" | "OPEN";
      readonly pendingDeleteScope: "page" | "root" | null;
      readonly provenDeleteScope: "page" | "root" | null;
      readonly sealedPageCount: number;
    }
  | { readonly _tag: "Scrubbed"; readonly rootChecksum: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Conflict"; readonly code: string };

export const qualificationCohortArtifactPostDeleteSurvivors = (
  deleteThrew: boolean,
  operationId: string,
  survivingArtifactKeys: ReadonlyArray<string>,
): Extract<
  QualificationCohortArtifactDeleteOutcome,
  { readonly _tag: "Conflict" | "Retryable" }
> | null => {
  if (survivingArtifactKeys.length === 0) return null;
  return deleteThrew
    ? {
        _tag: "Retryable",
        operationId,
        survivingArtifactCount: survivingArtifactKeys.length,
        survivingArtifactsChecksum: qualificationChecksum({ survivingArtifactKeys }),
      }
    : { _tag: "Conflict", code: "resolvedDeleteRetainedSurvivor" };
};
