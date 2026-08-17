import { Schema } from "effect";

import { Plan, PlanPolicyVersion, UserId } from "../domain";

const ActingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", {
    authSessionId: Schema.String,
    expiresAt: Schema.DateFromString,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedAuthSession", {
    authSessionId: Schema.String,
    userId: UserId,
  }),
  Schema.TaggedStruct("ChannelBinding", {
    channelBindingId: Schema.String,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedChannelBinding", {
    channelBindingId: Schema.String,
    userId: UserId,
  }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
    userId: UserId,
  }),
]);
const OriginatingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: Schema.String }),
  Schema.TaggedStruct("ChannelBinding", { channelBindingId: Schema.String }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["scheduledTask", "workflow"]),
  }),
]);

/** Recovery-safe current authority facts needed by a protected Core Memory clear. */
export const CoreMemoryAuthorizationSnapshot = Schema.Struct({
  authority: Schema.NullOr(ActingAuthority),
  deletionAccess: Schema.Union([
    Schema.TaggedStruct("DeletionAccessAvailable", {}),
    Schema.TaggedStruct("DeletionAccessRevoked", {}),
  ]),
  now: Schema.DateFromString,
  originatingAuthority: OriginatingAuthority,
  resourceOwnerUserId: Schema.NullOr(UserId),
  subscription: Schema.Struct({ plan: Plan, planPolicyVersion: PlanPolicyVersion }),
  user: Schema.Union([
    Schema.TaggedStruct("ActiveUser", { userId: UserId }),
    Schema.TaggedStruct("SuspendedUser", { userId: UserId }),
  ]),
});

/** Recovery-safe encoded current authority facts for Think turn metadata. */
export const CoreMemoryAuthorizationSnapshotEncoded = Schema.toEncoded(
  CoreMemoryAuthorizationSnapshot,
);

/** Recovery-safe current authority facts needed by a protected Core Memory clear. */
export type CoreMemoryAuthorizationSnapshot = typeof CoreMemoryAuthorizationSnapshot.Type;
