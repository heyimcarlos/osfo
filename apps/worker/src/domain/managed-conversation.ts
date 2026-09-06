import { Effect, Result, Schema } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ChannelLinkId,
  ConversationRouteId,
  Plan,
  PlanPolicyVersion,
  ResourcePriceVersion,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../domain";
import { AuthSessionId } from "./auth-session";
import { ChannelAddress } from "./channel-link";
import { OriginatingAuthority } from "./authority";
import { CoreMemoryAuthorizationSnapshotEncoded } from "./core-memory-authorization";
import { ManagedModelRoute } from "./model-access-policy";
import {
  CapabilityId,
  governedCapabilitiesV1Version,
  maximumCapabilityIds,
  retainedCapabilityCatalogs,
  resolveCapabilityCatalog,
} from "./capability-catalog";
import { FileAnalysisId } from "./file";
import {
  PersonalSkillId,
  PersonalSkillVersionId,
  TrustedSkillLearningText,
} from "./personal-skill";

const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const maximumManagedSkillBodyBytes = Number(
  Result.getOrThrow(
    resolveCapabilityCatalog(retainedCapabilityCatalogs, governedCapabilitiesV1Version),
  ).skillLearning.skillBodyBytes,
);
const ManagedSkillBody = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (instructions) =>
      new TextEncoder().encode(instructions).byteLength <= maximumManagedSkillBodyBytes ||
      `Managed Skill bodies must not exceed ${maximumManagedSkillBodyBytes} encoded bytes`,
  ),
);

/** Maximum immutable Skill bodies that one managed turn may retain and activate. */
export const maximumLoadedSkillsPerTurn = 5;

/** Exact immutable personal Skill identity admitted to one managed turn. */
export const ManagedEligiblePersonalSkill = Schema.Struct({
  skillId: PersonalSkillId,
  skillVersion: PersonalSkillVersionId,
});

/** Exact immutable personal Skill identity admitted to one managed turn. */
export type ManagedEligiblePersonalSkill = typeof ManagedEligiblePersonalSkill.Type;

/** Durable direct-User learning intent retained until the accepted root outcome commits. */
export const ManagedSkillLearningDraft = Schema.Struct({
  availableCapabilityIds: Schema.Array(CapabilityId).check(
    Schema.isMaxLength(maximumCapabilityIds),
  ),
  availableRequirements: Schema.Array(
    Schema.Literals([
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
    ]),
  ).check(Schema.isMaxLength(10)),
  taskDescription: TrustedSkillLearningText,
});

/** Durable direct-User learning intent retained until the accepted root outcome commits. */
export type ManagedSkillLearningDraft = typeof ManagedSkillLearningDraft.Type;

/** Immutable server receipt for one Skill body loaded during an exact managed Submission. */
export const ManagedLoadedSkillReceipt = Schema.Struct({
  capabilityIds: Schema.Array(CapabilityId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumCapabilityIds),
  ),
  catalogVersion: CapabilityCatalogVersion,
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  instructions: ManagedSkillBody,
  skillId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  skillVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  source: Schema.Literals(["personal", "system"]),
  submissionId: ThinkSubmissionId,
});

/** Immutable server receipt for one Skill body loaded during an exact managed Submission. */
export type ManagedLoadedSkillReceipt = typeof ManagedLoadedSkillReceipt.Type;

/** Trusted pending analysis retained for a natural follow-up turn. */
export const ManagedPendingFileAnalysis = Schema.Struct({
  analysisId: FileAnalysisId,
});

/** Trusted pending analysis retained for a natural follow-up turn. */
export type ManagedPendingFileAnalysis = typeof ManagedPendingFileAnalysis.Type;

/**
 * Server-owned progressive state stored on the durable managed-turn message.
 * Component limits keep the complete JSON receipt below Think's metadata row budget.
 */
export const ManagedCapabilityTurnState = Schema.Struct({
  eligiblePersonalSkills: Schema.Array(ManagedEligiblePersonalSkill)
    .check(Schema.isMaxLength(20))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  initialized: Schema.Boolean,
  loadedSkillReceipts: Schema.Array(ManagedLoadedSkillReceipt).check(
    Schema.isMaxLength(maximumLoadedSkillsPerTurn),
  ),
  pendingFileAnalyses: Schema.Array(ManagedPendingFileAnalysis).check(Schema.isMaxLength(20)),
  skillLearningDraft: Schema.NullOr(ManagedSkillLearningDraft).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});

/** Server-owned progressive state stored on the durable managed-turn message. */
export type ManagedCapabilityTurnState = typeof ManagedCapabilityTurnState.Type;

/** Stable authority identity retained for current protected-effect rechecks. */
export const ManagedTurnAuthorityIdentity = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: AuthSessionId, userId: UserId }),
  Schema.TaggedStruct("ChannelLink", {
    address: ChannelAddress,
    channelLinkId: ChannelLinkId,
    userId: UserId,
  }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
    userId: UserId,
  }),
]);

/** Stable authority identity retained for current protected-effect rechecks. */
export type ManagedTurnAuthorityIdentity = typeof ManagedTurnAuthorityIdentity.Type;

/** Trusted cancellation of one Think-owned managed conversation Submission. */
export const CancelManagedConversationInput = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  submissionId: ThinkSubmissionId,
});

/** JSON-safe policy facts pinned to an existing Think Submission. */
export const ManagedTurnMetadata = Schema.TaggedStruct("OsfoManagedTurn", {
  allowancePeriodId: AllowancePeriodId,
  authorityIdentity: ManagedTurnAuthorityIdentity,
  capabilityCatalogVersion: CapabilityCatalogVersion.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(governedCapabilitiesV1Version)),
  ),
  capabilityTurnState: ManagedCapabilityTurnState.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({
        eligiblePersonalSkills: [],
        initialized: false,
        loadedSkillReceipts: [],
        pendingFileAnalyses: [],
        skillLearningDraft: null,
      }),
    ),
  ),
  conversationResourcePriceVersion: Schema.optionalKey(ResourcePriceVersion),
  conservativeVendorUsdMicros: positiveInteger,
  companyCostResourcePriceVersion: Schema.optionalKey(ResourcePriceVersion),
  coreMemoryAuthorization: CoreMemoryAuthorizationSnapshotEncoded,
  executionMode: Schema.optionalKey(
    Schema.Literals(["companyContinuity", "exhaustedConversation", "normalPlanUsage"]),
  ),
  maxInputTokens: positiveInteger,
  maxOutputTokens: positiveInteger,
  maxRetries: Schema.Literal(0),
  maxSteps: positiveInteger,
  originatingAuthority: OriginatingAuthority,
  plan: Plan,
  planPolicyVersion: PlanPolicyVersion,
  routeId: ConversationRouteId,
  route: ManagedModelRoute,
  sessionId: SessionId,
  submissionId: ThinkSubmissionId,
  targetInputTokens: positiveInteger,
});

/** JSON-safe policy facts pinned to an existing Think Submission. */
export type ManagedTurnMetadata = typeof ManagedTurnMetadata.Type;
