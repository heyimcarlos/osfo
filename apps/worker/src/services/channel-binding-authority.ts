import { type Effect, Schema } from "effect";

import { ChannelBindingId, ChannelIdentity, UserId } from "../domain";

/** Identity of one fixed Channel Binding whose current authority must be checked. */
export const CurrentChannelBindingQuery = Schema.Struct({
  channelBindingId: ChannelBindingId,
  userId: UserId,
});

/** Identity of one fixed Channel Binding whose current authority must be checked. */
export type CurrentChannelBindingQuery = typeof CurrentChannelBindingQuery.Type;

/** Current active Channel Binding facts owned by the onboarding authority module. */
export const CurrentChannelBinding = Schema.Struct({
  channelBindingId: ChannelBindingId,
  channelIdentity: ChannelIdentity,
  userId: UserId,
});

/** Current active Channel Binding facts owned by the onboarding authority module. */
export type CurrentChannelBinding = typeof CurrentChannelBinding.Type;

/** Narrow application port for current Channel Binding authority. */
export interface Port<Failure> {
  readonly readCurrentBinding: (
    query: CurrentChannelBindingQuery,
  ) => Effect.Effect<CurrentChannelBinding | null, Failure>;
}
