import { Schema } from "effect";

import { ChannelLinkId, UserId } from "../domain";

/** Immutable configured identity for one Think messenger endpoint. */
export const ChannelId = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "must not be empty"),
).pipe(Schema.brand("ChannelId"));

/** Opaque provider-normalized identity for one messenger author. */
export const ChannelAuthorId = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
).pipe(Schema.brand("ChannelAuthorId"));

/** One external messenger address scoped by its immutable configured endpoint. */
export const ChannelAddress = Schema.Struct({ authorId: ChannelAuthorId, channelId: ChannelId });

/** Current Channel Link authority fact used by protected-effect authorization. */
export const ChannelLinkAuthorityFact = Schema.Union([
  Schema.TaggedStruct("ChannelLink", {
    address: ChannelAddress,
    channelLinkId: ChannelLinkId,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedChannelLink", {
    address: ChannelAddress,
    channelLinkId: ChannelLinkId,
    userId: UserId,
  }),
]);

/** Current Channel Link authority fact used by protected-effect authorization. */
export type ChannelLinkAuthorityFact = typeof ChannelLinkAuthorityFact.Type;
