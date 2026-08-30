/* oxlint-disable effecttsgo/global-date -- UTC round-trip validation is a pure boundary check for retained evidence. */
import { Option, Schema } from "effect";

import { AgentId, ConversationRouteId, Plan, SessionId, UserId } from "../domain";
import { FileDigest, type FileMediaType } from "../domain/file-content";
import { FileId, FileName, FileUploadId } from "../domain/file";
import { qualificationChecksum } from "./qualification-checksum";
import { qualificationCohortArtifactProtocol } from "./cohort-artifact-authority-contract";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const count = Schema.Int.check(Schema.isGreaterThan(0));
const byteLength = Schema.String.check(
  Schema.makeFilter((value) => /^[1-9][0-9]*$/u.test(value) || "must be a positive byte count"),
);

export const qualificationDocumentBuildFixtureBytes = new TextEncoder().encode(
  "Osfo disposable qualification document source v1.\nThis file verifies the real Document Build file boundary.\n",
);

export const QualificationDocumentBuildFixturePolicy = Schema.Struct({
  byteLength,
  fileIdDerivation: Schema.Literal("qualification-checksum-uuid-v1"),
  fileName: FileName,
  mediaType: Schema.Literal("text/plain"),
  sha256: FileDigest,
  version: Schema.Literal("qualification-document-build-file-v1"),
});
export type QualificationDocumentBuildFixturePolicy =
  typeof QualificationDocumentBuildFixturePolicy.Type;

export const QualificationDocumentBuildFixture = Schema.Struct({
  ...QualificationDocumentBuildFixturePolicy.fields,
  fileId: FileId,
  uploadId: FileUploadId,
});
export type QualificationDocumentBuildFixture = typeof QualificationDocumentBuildFixture.Type;

export const qualificationDocumentBuildFixturePolicy = QualificationDocumentBuildFixturePolicy.make(
  {
    byteLength: String(qualificationDocumentBuildFixtureBytes.byteLength),
    fileIdDerivation: "qualification-checksum-uuid-v1",
    fileName: "qualification-document-source.txt",
    mediaType: "text/plain",
    sha256: FileDigest.make(
      "sha256:d7a6eeb9ea1e679086bf7290262c26a4e1f5ca95d6f90f02c2e3abe659367b2c",
    ),
    version: "qualification-document-build-file-v1",
  },
);

const fixtureUploadId = (executionId: string, plan: Plan, index: number): FileUploadId => {
  const hex = qualificationChecksum({
    executionId,
    index,
    plan,
    version: qualificationDocumentBuildFixturePolicy.version,
  }).slice("sha256:".length);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return FileUploadId.make(uuid);
};

export const qualificationDocumentBuildFixture = (
  executionId: string,
  plan: Plan,
  index: number,
  policy: QualificationDocumentBuildFixturePolicy,
): QualificationDocumentBuildFixture => {
  const uploadId = fixtureUploadId(executionId, plan, index);
  return QualificationDocumentBuildFixture.make({
    ...policy,
    fileId: FileId.make(`web:${uploadId}`),
    uploadId,
  });
};

export const qualificationDocumentBuildMessage = (
  fixture: QualificationDocumentBuildFixture,
): string =>
  `Build a concise document from uploaded File ID ${fixture.fileId} and report the durable outcome.`;

export const qualificationDocumentBuildFixtureMatches = (
  fixture: QualificationDocumentBuildFixture,
  snapshot: {
    readonly byteLength: bigint;
    readonly fileId: string;
    readonly mediaType: FileMediaType;
    readonly sha256: FileDigest;
    readonly state: "ready";
    readonly userId: string;
  },
  expectedUserId: UserId,
): boolean =>
  snapshot.byteLength === BigInt(fixture.byteLength) &&
  snapshot.fileId === fixture.fileId &&
  snapshot.mediaType === fixture.mediaType &&
  snapshot.sha256 === fixture.sha256 &&
  snapshot.state === "ready" &&
  snapshot.userId === expectedUserId;

/** Compact frozen descriptor for an isolated disposable production qualification cohort. */
export const QualificationCohortManifest = Schema.Struct({
  artifactAuthorityProtocol: Schema.Literal(qualificationCohortArtifactProtocol),
  artifactChecksum: identity,
  cohortId: identity,
  createdAtUtc: Schema.String,
  executionId: identity,
  expiresAtUtc: Schema.String,
  grantPrefix: identity,
  documentBuildFixturePolicy: Schema.optional(QualificationDocumentBuildFixturePolicy),
  manifestChecksum: identity,
  notBeforeUtc: Schema.String,
  participantCounts: Schema.Struct({ adventurer: count, free: count }),
  planChecksum: identity,
  sourceVersion: identity,
  teardownPolicy: Schema.Literal("permanentAccountDeletion"),
});

/** One server-owned grant for a User created solely for this qualification execution. */
export const QualificationParticipantGrant = Schema.Struct({
  agentId: AgentId,
  artifactChecksum: identity,
  cohortChecksum: identity,
  cohortId: identity,
  createdAtUtc: Schema.String,
  executionId: identity,
  expiresAtUtc: Schema.String,
  documentBuildFixture: Schema.optional(QualificationDocumentBuildFixture),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  isolation: Schema.Literal("disposableQualificationUser"),
  notBeforeUtc: Schema.String,
  plan: Plan,
  provisionChecksum: identity,
  provisionId: identity,
  routeId: ConversationRouteId,
  scheduledEmailFixture: Schema.optional(
    Schema.Struct({
      approval: Schema.Literal("approveExactProtectedSend"),
      gmailResource: Schema.Literal("primary"),
      recipient: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
      version: Schema.Literal("qualification-scheduled-email-v1"),
    }),
  ),
  sessionId: SessionId,
  status: Schema.Literal("ACTIVE"),
  userId: UserId,
});

export type QualificationCohortManifest = typeof QualificationCohortManifest.Type;
export type QualificationParticipantGrant = typeof QualificationParticipantGrant.Type;

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(QualificationCohortManifest),
);
const decodeGrant = Schema.decodeUnknownOption(
  Schema.fromJsonString(QualificationParticipantGrant),
);

const hasValidChecksum = (value: { readonly artifactChecksum: string }): boolean => {
  const { artifactChecksum, ...content } = value;
  return artifactChecksum === qualificationChecksum(content);
};

const isExactUtcInstant = (value: string): boolean => {
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
};

const hasValidLifetime = (value: {
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  readonly notBeforeUtc: string;
}): boolean =>
  isExactUtcInstant(value.createdAtUtc) &&
  isExactUtcInstant(value.notBeforeUtc) &&
  isExactUtcInstant(value.expiresAtUtc) &&
  Date.parse(value.createdAtUtc) <= Date.parse(value.notBeforeUtc) &&
  Date.parse(value.notBeforeUtc) < Date.parse(value.expiresAtUtc);

export const decodeQualificationCohortManifest = (
  encoded: string,
): QualificationCohortManifest | null => {
  const decoded = decodeManifest(encoded);
  return Option.isSome(decoded) &&
    hasValidChecksum(decoded.value) &&
    hasValidLifetime(decoded.value)
    ? decoded.value
    : null;
};

export const decodeQualificationParticipantGrant = (
  encoded: string,
): QualificationParticipantGrant | null => {
  const decoded = decodeGrant(encoded);
  return Option.isSome(decoded) &&
    hasValidChecksum(decoded.value) &&
    hasValidLifetime(decoded.value)
    ? decoded.value
    : null;
};

export const qualificationCohortArtifactId = (executionId: string): string =>
  `qualification/executions/${encodeURIComponent(executionId)}/cohort/manifest.json`;

export const qualificationParticipantGrantArtifactId = (
  manifest: QualificationCohortManifest,
  plan: Plan,
  index: number,
): string => `${manifest.grantPrefix}/${plan}/${index.toString().padStart(8, "0")}.json`;
