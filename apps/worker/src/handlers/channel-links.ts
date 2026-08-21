import {
  Api,
  ChannelLinkConflict,
  ChannelLinkInviteUnavailable,
  ChannelLinkRegistrationRequired,
  ChannelLinksUnavailable,
  CurrentUser,
} from "@osfo/api";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { UserId } from "../domain";
import { ChannelLinks } from "../services/channel-links";

/* oxlint-disable eslint/no-underscore-dangle -- Effect errors use the standard _tag discriminator. */

/** Implement public Channel Link Invite inspection and authenticated acceptance. */
export const layer = Layer.unwrap(
  Effect.map(ChannelLinks.Service, (channelLinks) =>
    HttpApiBuilder.group(Api, "channelLinks", (handlers) =>
      handlers
        .handle("inspect", ({ params }) =>
          Effect.gen(function* () {
            const token = yield* decodeToken(params.token);
            return yield* channelLinks.inspect(token);
          }).pipe(
            Effect.map((view) => ({ expiresAt: view.expiresAt, state: "pending" as const })),
            Effect.mapError(toInspectPublicError),
          ),
        )
        .handle("accept", ({ params }) =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            const token = yield* decodeToken(params.token);
            yield* channelLinks.accept(token, UserId.make(currentUser.userId));
            return { state: "linked" as const };
          }).pipe(Effect.mapError(toPublicError)),
        ),
    ),
  ),
);

const decodeToken = (value: string) =>
  Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(value).pipe(
    Effect.map(Redacted.make),
    Effect.mapError(() => new ChannelLinks.ChannelLinkInviteUnavailable({ reason: "invalid" })),
  );

const toPublicError = (error: { readonly _tag: string }) => {
  if (error._tag === "ChannelLinkInviteUnavailable") {
    return new ChannelLinkInviteUnavailable({
      message: "This channel link invitation is no longer available. Request a new link.",
    });
  }
  if (error._tag === "ChannelLinkConflict") {
    return new ChannelLinkConflict({
      message: "This channel address is already linked to another User.",
    });
  }
  if (error._tag === "ChannelLinkRegistrationRequired") {
    return new ChannelLinkRegistrationRequired({
      message: "Complete User Registration before linking this channel.",
    });
  }
  return new ChannelLinksUnavailable({
    message: "Channel linking is temporarily unavailable. Please try again.",
  });
};

const toInspectPublicError = (
  error: ChannelLinks.ChannelLinkInviteUnavailable | ChannelLinks.ChannelLinksUnavailable,
) =>
  error._tag === "ChannelLinkInviteUnavailable"
    ? new ChannelLinkInviteUnavailable({
        message: "This channel link invitation is no longer available. Request a new link.",
      })
    : new ChannelLinksUnavailable({
        message: "Channel linking is temporarily unavailable. Please try again.",
      });

export * as ChannelLinksHandlers from "./channel-links";
