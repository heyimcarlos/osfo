import { type Redacted, Schema } from "effect";

/** Expected failure at the Channel Links persistence or cryptography boundary. */
export class ChannelLinksUnavailable extends Schema.TaggedError<ChannelLinksUnavailable>()(
  "ChannelLinksUnavailable",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

/** Client-safe rejection for an unusable or unverifiable Channel Link Invite. */
export class ChannelLinkInviteUnavailable extends Schema.TaggedError<ChannelLinkInviteUnavailable>()(
  "ChannelLinkInviteUnavailable",
  {
    reason: Schema.Literals([
      "accepted",
      "cancelled",
      "expired",
      "forged",
      "invalid",
      "retired-key",
      "superseded",
      "wrong-version",
    ]),
  },
) {}

/** One rotation-capable Channel Link Invite signing key. */
export interface SigningKey {
  readonly id: string;
  readonly secret: Redacted.Redacted;
}
