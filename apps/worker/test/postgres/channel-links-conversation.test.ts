import { channelLinks } from "@osfo/db/schema/channel-links";
import { BrowserCrypto } from "@effect/platform-browser";
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";

import { loadConfig } from "../../src/config";
import { Db } from "../../src/db";
import { UserId } from "../../src/domain";
import { ChannelLinks } from "../../src/services/channel-links";
import { companyAddressKey } from "../../src/agents/osfo/company-agent";
import { spawnApp } from "../support/spawn-app";

/* oxlint-disable effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- This test is the Layer entry point for the real authority and uses Effect tagged unions. */

it.effect("prefers active links at equal times and retains revoked boundaries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const identity = yield* Effect.promise(() =>
        app.auth.mintVerifiedUser({
          profile: {
            helpAreas: ["research"],
            locale: "en",
            preferredName: "Ada",
          },
        }),
      );

      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("company-attempt-author"),
        channelId: ChannelLinks.ChannelId.make("telegram"),
      });
      const channelLinksService = yield* ChannelLinks.Service;
      const initial = yield* channelLinksService.resolveConversation(address);
      expect(initial).toEqual({ _tag: "Unlinked", previousChannelLinkId: null });
      const initialKey = yield* companyAddressKey(address, null);

      const ensured = yield* channelLinksService.ensure(address);
      const invite = yield* ensured._tag === "Invited"
        ? Effect.succeed(ensured)
        : Effect.die(new Error("Expected an invitation"));
      const token = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
        invite.verificationUrl.pathname.split("/").at(-1) ?? "",
      );
      const link = yield* channelLinksService.accept(
        Redacted.make(token),
        UserId.make(identity.userId),
      );
      expect(yield* channelLinksService.resolveConversation(address)).toMatchObject({
        _tag: "Linked",
      });

      yield* channelLinksService.revoke({
        actorId: ChannelLinks.ChannelLinkActorId.make("system:test"),
        channelLinkId: link.channelLinkId,
        ownerUserId: UserId.make(identity.userId),
        reason: ChannelLinks.ChannelLinkRevocationReason.make("attempt isolation contract"),
      });
      const nextAttempt = yield* channelLinksService.resolveConversation(address);
      expect(nextAttempt).toEqual({
        _tag: "Unlinked",
        previousChannelLinkId: link.channelLinkId,
      });
      const replacementId = ChannelLinks.ChannelLinkId.make(
        "channel-link-00000000-0000-0000-0000-000000000000",
      );
      yield* Effect.gen(function* () {
        const database = yield* Db.database;
        yield* Effect.promise(() =>
          database.insert(channelLinks).values({
            channel_link_id: replacementId,
            channel_id: address.channelId,
            author_id: address.authorId,
            user_id: identity.userId,
            created_at: link.createdAt,
          }),
        );
      }).pipe(Effect.provide(Db.layer({ db: env.DB })));
      expect(replacementId < link.channelLinkId).toBe(true);
      expect(yield* channelLinksService.resolveConversation(address)).toMatchObject({
        _tag: "Linked",
        link: { channelLinkId: replacementId },
      });
      yield* channelLinksService.revoke({
        actorId: ChannelLinks.ChannelLinkActorId.make("system:test"),
        channelLinkId: replacementId,
        ownerUserId: UserId.make(identity.userId),
        reason: ChannelLinks.ChannelLinkRevocationReason.make("equal-time routing contract"),
      });
      expect(yield* channelLinksService.resolveConversation(address)).toEqual({
        _tag: "Unlinked",
        previousChannelLinkId: link.channelLinkId,
      });
      const nextKey = yield* companyAddressKey(address, link.channelLinkId);
      expect(nextKey).not.toBe(initialKey);
    }).pipe(Effect.provide(channelLinksLayer())),
  ),
);

// No public revocation route exists yet, so this focused PostgreSQL contract
// exercises the real authority directly to prove the attempt boundary.
const channelLinksLayer = () =>
  ChannelLinks.layerFromConfig(loadConfig(env)).pipe(
    Layer.provide(Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer)),
  );
