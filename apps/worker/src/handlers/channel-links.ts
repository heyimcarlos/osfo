import {
  Api,
  ChannelLinkChannel,
  ChannelLinkConflict,
  ChannelLinkInviteUnavailable,
  ChannelLinkRegistrationRequired,
  ChannelLinkUnavailable,
  ChannelLinksUnavailable,
  CurrentUser,
} from "@osfo/api";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ChannelLinkId, UserId } from "../domain";
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
        )
        .handle("list", () =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            const links = yield* channelLinks.listActive(UserId.make(currentUser.userId));
            const items = yield* Effect.all(
              links.map((link) =>
                Schema.decodeUnknownEffect(ChannelLinkChannel)(link.address.channelId).pipe(
                  Effect.map((channel) => ({
                    channel,
                    channelLinkId: link.channelLinkId,
                    linkedAt: link.createdAt,
                  })),
                  Effect.mapError(
                    (cause) =>
                      new ChannelLinks.ChannelLinksUnavailable({
                        cause,
                        operation: "listActive.project",
                      }),
                  ),
                ),
              ),
            );
            return { items };
          }).pipe(Effect.mapError(toListPublicError)),
        )
        .handle("revoke", ({ params }) =>
          Effect.gen(function* () {
            const currentUser = yield* CurrentUser;
            yield* channelLinks.revoke({
              actorId: ChannelLinks.ChannelLinkActorId.make(
                `auth-session:${currentUser.authSessionId}`,
              ),
              channelLinkId: ChannelLinkId.make(params.channelLinkId),
              ownerUserId: UserId.make(currentUser.userId),
              reason: ChannelLinks.ChannelLinkRevocationReason.make(
                "User disconnected channel in Settings",
              ),
            });
            return { state: "unlinked" as const };
          }).pipe(Effect.mapError(toRevokePublicError)),
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

const toListPublicError = () =>
  new ChannelLinksUnavailable({
    message: "Channel links are temporarily unavailable. Please try again.",
  });

const toRevokePublicError = (
  error: ChannelLinks.ChannelLinkNotFound | ChannelLinks.ChannelLinksUnavailable,
) =>
  error._tag === "ChannelLinkNotFound"
    ? new ChannelLinkUnavailable({
        message: "This channel link is not active. Refresh and try again.",
      })
    : new ChannelLinksUnavailable({
        message: "Channel links are temporarily unavailable. Please try again.",
      });

export * as ChannelLinksHandlers from "./channel-links";
