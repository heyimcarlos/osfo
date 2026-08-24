import { Effect, Schema } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ChannelLinkId,
  ConversationRouteId,
  Plan,
  PlanPolicyVersion,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../domain";
import { AuthSessionId } from "./auth-session";
import { ChannelAddress } from "./channel-link";
import { OriginatingAuthority } from "./authority";
import { CoreMemoryAuthorizationSnapshotEncoded } from "./core-memory-authorization";
import { ManagedModelRoute } from "./model-access-policy";
import { governedCapabilitiesV1Version } from "./capability-catalog";

const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

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
  conservativeVendorUsdMicros: positiveInteger,
  coreMemoryAuthorization: CoreMemoryAuthorizationSnapshotEncoded,
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
