import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { Auth } from "../middleware/auth";

/** Opaque 8-character alphanumeric bearer value naming one Channel Link Invite. */
export const ChannelLinkInviteToken = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[A-Za-z0-9]{8}$/u.test(value) || "must be an 8-character alphanumeric token",
  ),
).pipe(Schema.brand("ChannelLinkInviteToken"));

/** Safe invitation state exposed before an authenticated acceptance. */
export const ChannelLinkInviteResponse = Schema.Struct({
  expiresAt: Schema.DateFromString,
  state: Schema.Literal("pending"),
});

/** Minimal acknowledgement after authenticated Channel Link acceptance. */
export const ChannelLinkAcceptanceResponse = Schema.Struct({ state: Schema.Literal("linked") });

/** Stable client error for an expired, consumed, replaced, or invalid invite. */
export class ChannelLinkInviteUnavailable extends Schema.TaggedError<ChannelLinkInviteUnavailable>()(
  "ChannelLinkInviteUnavailable",
  { message: Schema.String },
  { httpApiStatus: 410 },
) {}

/** Stable client error when another User already owns the address. */
export class ChannelLinkConflict extends Schema.TaggedError<ChannelLinkConflict>()(
  "ChannelLinkConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Stable client error when the authenticated User has not completed registration. */
export class ChannelLinkRegistrationRequired extends Schema.TaggedError<ChannelLinkRegistrationRequired>()(
  "ChannelLinkRegistrationRequired",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Stable client error for unavailable Channel Links dependencies. */
export class ChannelLinksUnavailable extends Schema.TaggedError<ChannelLinksUnavailable>()(
  "ChannelLinksUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** Public inspection and server-authenticated acceptance of Channel Link Invites. */
export const ChannelLinksGroup = HttpApiGroup.make("channelLinks")
  .add(
    HttpApiEndpoint.get("inspect", "/v1/channel-link-invites/:token", {
      error: [ChannelLinkInviteUnavailable, ChannelLinksUnavailable],
      params: { token: Schema.String },
      success: ChannelLinkInviteResponse,
    }).annotateMerge(
      OpenApi.annotations({
        description: "Inspect a Channel Link Invite without exposing its external address.",
        identifier: "channelLinks.inspect",
        summary: "Inspect Channel Link Invite",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("accept", "/v1/channel-link-invites/:token/accept", {
      error: [
        ChannelLinkConflict,
        ChannelLinkInviteUnavailable,
        ChannelLinkRegistrationRequired,
        ChannelLinksUnavailable,
      ],
      params: { token: Schema.String },
      success: ChannelLinkAcceptanceResponse,
    })
      .middleware(Auth)
      .annotateMerge(
        OpenApi.annotations({
          description: "Accept an invite for the server-authenticated registered User.",
          identifier: "channelLinks.accept",
          summary: "Accept Channel Link Invite",
        }),
      ),
  );
