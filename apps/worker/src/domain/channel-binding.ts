import { Schema } from "effect";

import { ChannelBindingId, UserId } from "../domain";

/** Current Channel Binding authority fact used by protected-effect authorization. */
export const ChannelBindingAuthorityFact = Schema.Union([
  Schema.TaggedStruct("ChannelBinding", {
    channelBindingId: ChannelBindingId,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedChannelBinding", {
    channelBindingId: ChannelBindingId,
    userId: UserId,
  }),
]);

/** Current Channel Binding authority fact used by protected-effect authorization. */
export type ChannelBindingAuthorityFact = typeof ChannelBindingAuthorityFact.Type;
