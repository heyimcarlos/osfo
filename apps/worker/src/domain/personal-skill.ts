import { Result, Schema } from "effect";

/* oxlint-disable osfo/no-unknown-parameters -- These exported decoders are the owning trust boundary for persistence and Capability inputs. */

import { UserId } from "../domain";
import { CapabilityId, currentCapabilityCatalog } from "./capability-catalog";

const maximumVersionBytes = Number(currentCapabilityCatalog.skillLearning.skillVersionBytes);
const maximumInstructionBytes = Number(currentCapabilityCatalog.skillLearning.skillBodyBytes);
const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const nonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Closed task kinds used to narrow the personal Skill index deterministically. */
export const SkillTaskKind = Schema.Literals([
  "conversation",
  "diagram",
  "document",
  "file",
  "image",
  "integration",
  "memory",
  "reminder",
  "research",
  "skill",
  "web",
  "workflow",
]);

/** Closed task kinds used to narrow the personal Skill index deterministically. */
export type SkillTaskKind = typeof SkillTaskKind.Type;

/** Closed runtime facts a personal Skill may require before selection. */
export const SkillAvailabilityRequirement = Schema.Literals([
  "composio",
  "document-renderer",
  "file-storage",
  "native-memory",
  "personal-agent",
  "reminder-store",
  "session-history",
  "skill-store",
  "web-provider",
  "workflow-store",
]);

/** Closed runtime facts a personal Skill may require before selection. */
export type SkillAvailabilityRequirement = typeof SkillAvailabilityRequirement.Type;

/** Authority origins from which a personal Skill may be selected. */
export const SkillTurnOrigin = Schema.Literals([
  "authSession",
  "channelLink",
  "scheduledTask",
  "workflow",
]);

/** Authority origins from which a personal Skill may be selected. */
export type SkillTurnOrigin = typeof SkillTurnOrigin.Type;

/** Stable identity of one User-owned repeatable capability. */
export const PersonalSkillId = boundedText(100).pipe(Schema.brand("PersonalSkillId"));

/** Stable identity of one User-owned repeatable capability. */
export type PersonalSkillId = typeof PersonalSkillId.Type;

/** Stable identity of one immutable personal Skill revision. */
export const PersonalSkillVersionId = boundedText(100).pipe(Schema.brand("PersonalSkillVersionId"));

/** Stable identity of one immutable personal Skill revision. */
export type PersonalSkillVersionId = typeof PersonalSkillVersionId.Type;

/** Stable identity of one bounded post-turn learning candidate. */
export const SkillLearningCandidateId = boundedText(160).pipe(
  Schema.brand("SkillLearningCandidateId"),
);

/** Stable identity of one bounded post-turn learning candidate. */
export type SkillLearningCandidateId = typeof SkillLearningCandidateId.Type;

/** Closed trusted evidence references. Content stays in its owning store. */
export const SkillEvidenceReference = Schema.TaggedUnion({
  ConfirmedEffect: { referenceId: boundedText(200) },
  ConfirmedRootOutcome: { referenceId: boundedText(200) },
  ExplicitUserCorrection: { referenceId: boundedText(200) },
  OwnedArtifact: { referenceId: boundedText(200) },
  OwnedMemory: { referenceId: boundedText(200) },
  UserDecision: { referenceId: boundedText(200) },
});

/** Closed trusted evidence references. Content stays in its owning store. */
export type SkillEvidenceReference = typeof SkillEvidenceReference.Type;

/** Confirmed outcome facts retained without provider payloads or Session content. */
export const SkillOutcomeFacts = Schema.Struct({
  confirmedFailures: nonNegativeInteger,
  confirmedSuccesses: nonNegativeInteger,
});

/** Confirmed outcome facts retained without provider payloads or Session content. */
export type SkillOutcomeFacts = typeof SkillOutcomeFacts.Type;

const SkillInstructionText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (instructions) =>
      encodedBytes(instructions) <= maximumInstructionBytes ||
      `Personal Skill instructions must not exceed ${maximumInstructionBytes} encoded bytes`,
  ),
  Schema.makeFilter(
    (instructions) =>
      instructionIsSafe(instructions) ||
      "Personal Skill instructions must contain only bounded natural-language guidance",
  ),
);

/** Bounded direct User guidance admitted to the isolated learning pass. */
export const TrustedSkillLearningText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_000),
  Schema.makeFilter(
    (text) =>
      instructionIsSafe(text) ||
      "Skill Learning input must not contain executable, credential, authority, or provider payload content",
  ),
);

/** One immutable, evidence-backed personal Skill revision. */
export const PersonalSkillVersion = Schema.Struct({
  allowedOrigins: Schema.Array(SkillTurnOrigin).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  capabilityIds: Schema.Array(CapabilityId).check(Schema.isMinLength(1), Schema.isMaxLength(22)),
  createdAtEpochMillis: nonNegativeInteger,
  createdBy: Schema.Literals(["learning", "rollback", "user"]),
  creationEvidence: Schema.Array(SkillEvidenceReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  description: boundedText(500),
  instructions: SkillInstructionText,
  keywords: Schema.Array(boundedText(100)).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  lastUsedAtEpochMillis: Schema.NullOr(nonNegativeInteger),
  origin: Schema.Literals(["learned", "userAuthored"]),
  outcomeFacts: SkillOutcomeFacts,
  ownerUserId: UserId,
  parentSkillVersion: Schema.NullOr(PersonalSkillVersionId),
  requirements: Schema.Array(SkillAvailabilityRequirement).check(Schema.isMaxLength(10)),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  skillId: PersonalSkillId,
  skillVersion: PersonalSkillVersionId,
  status: Schema.Literals(["active", "archived"]),
  taskDescription: boundedText(500),
  taskKinds: Schema.Array(SkillTaskKind).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  updatedAtEpochMillis: nonNegativeInteger,
  updateEvidence: Schema.Array(SkillEvidenceReference).check(Schema.isMaxLength(20)),
}).check(
  Schema.makeFilter(
    (version) =>
      encodedBytes(JSON.stringify(version)) <= maximumVersionBytes ||
      `Personal Skill versions must not exceed ${maximumVersionBytes} encoded bytes`,
  ),
);

/** One immutable, evidence-backed personal Skill revision. */
export interface PersonalSkillVersion extends Schema.Schema.Type<typeof PersonalSkillVersion> {}

/** Copy a decoded immutable Skill Version into a plain value for a later version constructor. */
export const personalSkillVersionValues = (version: PersonalSkillVersion) => ({
  allowedOrigins: version.allowedOrigins,
  capabilityIds: version.capabilityIds,
  createdAtEpochMillis: version.createdAtEpochMillis,
  createdBy: version.createdBy,
  creationEvidence: version.creationEvidence,
  description: version.description,
  instructions: version.instructions,
  keywords: version.keywords,
  lastUsedAtEpochMillis: version.lastUsedAtEpochMillis,
  origin: version.origin,
  outcomeFacts: version.outcomeFacts,
  ownerUserId: version.ownerUserId,
  parentSkillVersion: version.parentSkillVersion,
  requirements: version.requirements,
  revision: version.revision,
  skillId: version.skillId,
  skillVersion: version.skillVersion,
  status: version.status,
  taskDescription: version.taskDescription,
  taskKinds: version.taskKinds,
  updatedAtEpochMillis: version.updatedAtEpochMillis,
  updateEvidence: version.updateEvidence,
});

/** Bounded trusted input admitted only after a completed root outcome commits. */
export const SkillLearningCandidate = Schema.Struct({
  candidateBytes: Schema.BigIntFromString.check(Schema.isGreaterThanBigInt(0n)),
  candidateId: SkillLearningCandidateId,
  corrections: Schema.Array(TrustedSkillLearningText).check(Schema.isMaxLength(10)),
  createdAtEpochMillis: nonNegativeInteger,
  decisions: Schema.Array(TrustedSkillLearningText).check(Schema.isMaxLength(10)),
  evidence: Schema.Array(SkillEvidenceReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  ownerUserId: UserId,
  priorSkillId: Schema.NullOr(PersonalSkillId),
  priorSkillVersion: Schema.NullOr(PersonalSkillVersionId),
  rootOutcomeReferenceId: boundedText(200),
  taskDescription: boundedText(500),
}).check(
  Schema.makeFilter(
    (candidate) =>
      (candidate.priorSkillId === null) === (candidate.priorSkillVersion === null) ||
      "A learning candidate must name both prior Skill identities or neither",
  ),
);

/** Bounded trusted input admitted only after a completed root outcome commits. */
export interface SkillLearningCandidate extends Schema.Schema.Type<typeof SkillLearningCandidate> {}

/** Decode an unknown personal Skill revision without throwing. */
export const decodePersonalSkillVersion = (input: unknown) =>
  Schema.decodeUnknownResult(PersonalSkillVersion, { onExcessProperty: "error" })(input);

/** Return only schema-valid personal Skill revisions from a mixed persistence boundary. */
export const decodePersonalSkillVersions = (
  values: ReadonlyArray<unknown>,
): ReadonlyArray<PersonalSkillVersion> =>
  values.flatMap((value) => {
    const decoded = decodePersonalSkillVersion(value);
    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });

const encodedBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const instructionIsSafe = (instructions: string): boolean => {
  const forbidden = [
    /```/u,
    /(^|\n)\s*#!\//u,
    /<script\b/iu,
    /\b(?:api[-_ ]?key|authorization\s*:|bearer\s+[A-Za-z0-9._~-]+|client[-_ ]?secret|password\s*=|private[-_ ]?key)\b/iu,
    /https?:\/\/\S+[?&](?:access_token|api_key|auth|key|signature|token)=/iu,
    /\b(?:bypass|disable|skip)\s+(?:an?\s+)?(?:approval|authorization|policy)\b/iu,
    /\bgrant(?:s|ed)?\s+(?:the\s+)?(?:tool|permission|plan|authority|access)\b/iu,
    /\bignore\s+(?:the\s+)?(?:current\s+)?(?:user request|product policy|authorization policy)\b/iu,
    /"(?:properties|additionalProperties|oneOf|anyOf|allOf)"\s*:/u,
  ];
  return forbidden.every((pattern) => !pattern.test(instructions));
};

export * as PersonalSkill from "./personal-skill";
