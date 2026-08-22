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

it.effect("advances the unlinked conversation attempt after acceptance and revocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const phoneNumber = "+15550002470";
      yield* Effect.promise(() => app.auth.sendPhoneOtp(phoneNumber));
      yield* Effect.promise(() => app.auth.verifyPhoneOtp(phoneNumber, "424242"));
      const completed = yield* Effect.promise(() =>
        app.registration.complete({
          helpAreas: ["research"],
          locale: "en",
          preferredName: "Ada",
        }),
      );
      const identity = yield* completed.body === undefined
        ? Effect.die(new Error("Registration did not return an identity"))
        : Effect.succeed(completed.body);

      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("company-attempt-author"),
        channelId: ChannelLinks.ChannelId.make("telegram"),
      });
      const channelLinks = yield* ChannelLinks.Service;
      const initial = yield* channelLinks.resolveConversation(address);
      expect(initial).toEqual({ _tag: "Unlinked", previousChannelLinkId: null });
      const initialKey = yield* companyAddressKey(address, null);

      const ensured = yield* channelLinks.ensure(address);
      const invite = yield* ensured._tag === "Invited"
        ? Effect.succeed(ensured)
        : Effect.die(new Error("Expected an invitation"));
      const token = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
        invite.verificationUrl.pathname.split("/").at(-1) ?? "",
      );
      const link = yield* channelLinks.accept(Redacted.make(token), UserId.make(identity.userId));
      expect(yield* channelLinks.resolveConversation(address)).toMatchObject({ _tag: "Linked" });

      yield* channelLinks.revoke({
        actorId: ChannelLinks.ChannelLinkActorId.make("system:test"),
        channelLinkId: link.channelLinkId,
        reason: ChannelLinks.ChannelLinkRevocationReason.make("attempt isolation contract"),
      });
      const nextAttempt = yield* channelLinks.resolveConversation(address);
      expect(nextAttempt).toEqual({
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
