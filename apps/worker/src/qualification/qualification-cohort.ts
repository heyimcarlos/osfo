/* oxlint-disable effecttsgo/global-date -- UTC round-trip validation is a pure boundary check for retained evidence. */
import { Option, Schema } from "effect";

import { AgentId, ConversationRouteId, Plan, SessionId, UserId } from "../domain";
import { qualificationChecksum } from "./qualification-checksum";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const count = Schema.Int.check(Schema.isGreaterThan(0));

/** Compact frozen descriptor for an isolated disposable production qualification cohort. */
export const QualificationCohortManifest = Schema.Struct({
  artifactChecksum: identity,
  cohortId: identity,
  createdAtUtc: Schema.String,
  executionId: identity,
  expiresAtUtc: Schema.String,
  grantPrefix: identity,
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
