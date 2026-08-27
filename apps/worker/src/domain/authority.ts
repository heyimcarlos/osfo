import { Schema } from "effect";

/** Stable identity of the authority that originated durable work. */
export const OriginatingAuthority = Schema.Union([
  Schema.TaggedStruct("AuthSession", { authSessionId: Schema.String }),
  Schema.TaggedStruct("ChannelLink", { channelLinkId: Schema.String }),
  Schema.TaggedStruct("DurableTrigger", {
    triggerId: Schema.String,
    triggerType: Schema.Literals(["deletionCase", "scheduledTask", "workflow"]),
  }),
]);

/** Stable identity of the authority that originated durable work. */
export type OriginatingAuthority = typeof OriginatingAuthority.Type;
