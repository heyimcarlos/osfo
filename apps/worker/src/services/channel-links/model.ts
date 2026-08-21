import { Schema } from "effect";

/** Expected failure at the Channel Links persistence or cryptography boundary. */
export class ChannelLinksUnavailable extends Schema.TaggedError<ChannelLinksUnavailable>()(
  "ChannelLinksUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

/** Client-safe rejection for an unusable or unverifiable Channel Link Invite. */
export class ChannelLinkInviteUnavailable extends Schema.TaggedError<ChannelLinkInviteUnavailable>()(
  "ChannelLinkInviteUnavailable",
  {
    reason: Schema.Literals(["accepted", "cancelled", "expired", "invalid", "superseded"]),
  },
) {}
