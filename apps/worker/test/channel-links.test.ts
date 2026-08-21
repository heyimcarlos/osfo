import { BrowserCrypto } from "@effect/platform-browser";
import { expect, layer } from "@effect/vitest";
import {
  channelLinkAuditEvents,
  channelLinkInvites,
  channelLinks,
} from "@osfo/db/schema/channel-links";
import { users } from "@osfo/db/schema/auth";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { Crypto, DateTime, Effect, Layer, Redacted } from "effect";

import { Db } from "../src/db";
import { UserId } from "../src/domain";
import { ChannelLinks } from "../src/services/channel-links";
import { signInviteToken } from "../src/services/channel-links/token";

/* oxlint-disable eslint/no-underscore-dangle -- Effect results use the standard _tag discriminator. */
/* oxlint-disable eslint/no-shadow -- The canonical channelLinks table and service variable intentionally share the domain name. */
/* oxlint-disable typescript/consistent-return -- Effect generator defects are explicit test precondition exits. */

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));

const serviceLayer = ChannelLinks.layer({
  invitationLifetime: { hours: 24 },
  signingKeys: [
    {
      id: "test-current",
      secret: Redacted.make("test-only-channel-link-key-with-32-characters"),
    },
  ],
  verificationBaseUrl: new URL("https://osfo.test/verify/"),
}).pipe(
  Layer.provideMerge(Db.layerFromDatabase(fixture.database)),
  Layer.provideMerge(BrowserCrypto.layer),
);

layer(serviceLayer)("ChannelLinks", (test) => {
  test.effect("resolves a missing Channel Address without granting User authority", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;

      const resolved = yield* channelLinks.resolve(
        ChannelLinks.ChannelAddress.make({
          authorId: ChannelLinks.ChannelAuthorId.make("opaque-author"),
          channelId: ChannelLinks.ChannelId.make("telegram-primary"),
        }),
      );

      expect(resolved).toBeNull();
    }),
  );

  test.effect("issues a private invitation without persisting bearer material", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("provider-secret-author"),
        channelId: ChannelLinks.ChannelId.make("telegram-primary"),
      });

      const result = yield* channelLinks.ensure(address);
      const rows = yield* Effect.promise(() => fixture.database.select().from(channelLinkInvites));

      expect(result._tag).toBe("Invited");
      if (result._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      expect(result.verificationUrl.origin).toBe("https://osfo.test");
      expect(result.verificationUrl.pathname).toMatch(
        /^\/verify\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
      );
      expect(result.verificationUrl.href).not.toContain(address.authorId);
      expect(result.verificationUrl.href).not.toContain(address.channelId);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0] ?? {})).not.toContain("token");
    }),
  );

  test.effect("inspects a signed invitation through a client-safe view", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const result = yield* channelLinks.ensure(
        ChannelLinks.ChannelAddress.make({
          authorId: ChannelLinks.ChannelAuthorId.make("inspect-author"),
          channelId: ChannelLinks.ChannelId.make("whatsapp-primary"),
        }),
      );
      expect(result._tag).toBe("Invited");
      if (result._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      const token = ChannelLinks.ChannelLinkInviteToken.make(
        result.verificationUrl.pathname.split("/").at(-1) ?? "",
      );

      const view = yield* channelLinks.inspect(Redacted.make(token));

      expect(view).toEqual({ expiresAt: result.expiresAt, state: "pending" });
      expect(view).not.toHaveProperty("address");
      expect(view).not.toHaveProperty("inviteId");
      expect(view).not.toHaveProperty("userId");
    }),
  );

  test.effect("atomically accepts an invitation for a registered User", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const userId = UserId.make("channel-link-user");
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("accept-author"),
        channelId: ChannelLinks.ChannelId.make("telegram-primary"),
      });
      yield* Effect.promise(() =>
        fixture.database.insert(users).values({
          email: "channel-link-user@example.test",
          id: userId,
          name: "Channel Link User",
          registrationCompletedAt: registeredAt,
        }),
      );
      const ensured = yield* channelLinks.ensure(address);
      expect(ensured._tag).toBe("Invited");
      if (ensured._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      const token = ChannelLinks.ChannelLinkInviteToken.make(
        ensured.verificationUrl.pathname.split("/").at(-1) ?? "",
      );

      const accepted = yield* channelLinks.accept(Redacted.make(token), userId);
      const resolved = yield* channelLinks.resolve(address);

      expect(accepted).toMatchObject({ address, revokedAt: null, userId });
      expect(resolved).toEqual(accepted);
    }),
  );

  test.effect("revokes only the selected Channel Link and converges on retries", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const userId = UserId.make("channel-link-revoke-user");
      yield* Effect.promise(() =>
        fixture.database.insert(users).values({
          email: "channel-link-revoke-user@example.test",
          id: userId,
          name: "Channel Link Revoke User",
          registrationCompletedAt: registeredAt,
        }),
      );
      const firstAddress = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("revoke-first"),
        channelId: ChannelLinks.ChannelId.make("telegram-primary"),
      });
      const secondAddress = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("revoke-second"),
        channelId: ChannelLinks.ChannelId.make("whatsapp-primary"),
      });
      const first = yield* acceptEnsured(channelLinks, firstAddress, userId);
      const second = yield* acceptEnsured(channelLinks, secondAddress, userId);
      const input = {
        actorId: ChannelLinks.ChannelLinkActorId.make("user:channel-link-revoke-user"),
        channelLinkId: first.channelLinkId,
        reason: ChannelLinks.ChannelLinkRevocationReason.make("User disconnected this channel"),
      };

      const revoked = yield* channelLinks.revoke(input);
      const repeated = yield* channelLinks.revoke(input);

      expect(revoked.revokedAt).toBeInstanceOf(Date);
      expect(repeated).toEqual(revoked);
      expect(yield* channelLinks.resolve(firstAddress)).toBeNull();
      expect(yield* channelLinks.resolve(secondAddress)).toEqual(second);
    }),
  );

  test.effect("reconstructs the same usable invitation for sequential and concurrent retries", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("retry-author"),
        channelId: ChannelLinks.ChannelId.make("telegram-secondary"),
      });

      const first = yield* channelLinks.ensure(address);
      const repeated = yield* channelLinks.ensure(address);
      const concurrent = yield* Effect.all(
        [channelLinks.ensure(address), channelLinks.ensure(address)],
        { concurrency: "unbounded" },
      );

      expect(first._tag).toBe("Invited");
      expect(repeated).toEqual(first);
      expect(concurrent).toEqual([first, first]);
    }),
  );

  test.effect("rejects acceptance until User Registration is complete", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const userId = UserId.make("channel-link-incomplete-user");
      yield* Effect.promise(() =>
        fixture.database.insert(users).values({
          email: "channel-link-incomplete@example.test",
          id: userId,
          name: "Incomplete User",
        }),
      );
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("incomplete-author"),
        channelId: ChannelLinks.ChannelId.make("whatsapp-secondary"),
      });
      const ensured = yield* channelLinks.ensure(address);
      if (ensured._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      const token = inviteToken(ensured.verificationUrl);

      const failure = yield* Effect.flip(channelLinks.accept(Redacted.make(token), userId));

      expect(failure).toMatchObject({ _tag: "ChannelLinkRegistrationRequired", userId });
      expect(yield* channelLinks.resolve(address)).toBeNull();
    }),
  );

  test.effect("accepts same-User retries and rejects reuse by another User", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const firstUserId = UserId.make("channel-link-retry-first");
      const secondUserId = UserId.make("channel-link-retry-second");
      yield* seedRegisteredUsers([firstUserId, secondUserId]);
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("accepted-retry-author"),
        channelId: ChannelLinks.ChannelId.make("telegram-retry"),
      });
      const ensured = yield* channelLinks.ensure(address);
      if (ensured._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      const token = inviteToken(ensured.verificationUrl);

      const first = yield* channelLinks.accept(Redacted.make(token), firstUserId);
      const repeated = yield* channelLinks.accept(Redacted.make(token), firstUserId);
      const consumed = yield* Effect.flip(channelLinks.accept(Redacted.make(token), secondUserId));

      expect(repeated).toEqual(first);
      expect(consumed).toMatchObject({
        _tag: "ChannelLinkInviteUnavailable",
        reason: "accepted",
      });
    }),
  );

  test.effect("fails closed when another User acquires the address before acceptance", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const invitedUserId = UserId.make("channel-link-conflict-invited");
      const ownerUserId = UserId.make("channel-link-conflict-owner");
      yield* seedRegisteredUsers([invitedUserId, ownerUserId]);
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("conflict-author"),
        channelId: ChannelLinks.ChannelId.make("whatsapp-conflict"),
      });
      const ensured = yield* channelLinks.ensure(address);
      if (ensured._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      yield* Effect.promise(() => insertStoredChannelLink(address, ownerUserId));

      const failure = yield* Effect.flip(
        channelLinks.accept(Redacted.make(inviteToken(ensured.verificationUrl)), invitedUserId),
      );

      expect(failure).toMatchObject({ _tag: "ChannelLinkConflict", channelId: address.channelId });
      expect(yield* channelLinks.resolve(address)).toMatchObject({ userId: ownerUserId });
    }),
  );

  test.effect("rejects forged tokens and keeps bearer and author data out of audit evidence", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const address = ChannelLinks.ChannelAddress.make({
        authorId: ChannelLinks.ChannelAuthorId.make("audit-private-author"),
        channelId: ChannelLinks.ChannelId.make("telegram-audit"),
      });
      const ensured = yield* channelLinks.ensure(address);
      if (ensured._tag !== "Invited")
        return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
      const token = inviteToken(ensured.verificationUrl);
      const separatorIndex = token.indexOf(".");
      const claims = token.slice(0, separatorIndex + 1);
      const signature = token.slice(separatorIndex + 1);
      const forged = ChannelLinks.ChannelLinkInviteToken.make(
        `${claims}${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`,
      );

      const failure = yield* Effect.flip(channelLinks.inspect(Redacted.make(forged)));
      const audit = yield* Effect.promise(() =>
        fixture.database.select().from(channelLinkAuditEvents),
      );
      expect(failure).toMatchObject({ _tag: "ChannelLinkInviteUnavailable", reason: "forged" });
      expect(audit.every((event) => !Object.values(event.metadata).includes(token))).toBe(true);
      expect(
        audit.every((event) => !Object.values(event.metadata).includes(address.authorId)),
      ).toBe(true);
    }),
  );

  test.effect("rejects a correctly signed token protocol version it does not implement", () =>
    Effect.gen(function* () {
      const channelLinks = yield* ChannelLinks.Service;
      const crypto = yield* Crypto.Crypto;
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const token = yield* signInviteToken(
        crypto,
        {
          id: "test-current",
          secret: Redacted.make("test-only-channel-link-key-with-32-characters"),
        },
        {
          e: Math.floor(now.getTime() / 1_000) + 3600,
          i: "unsupported-version-invite",
          k: "test-current",
          v: 2,
        },
      );

      const failure = yield* Effect.flip(channelLinks.inspect(Redacted.make(token)));

      expect(failure).toMatchObject({
        _tag: "ChannelLinkInviteUnavailable",
        reason: "wrong-version",
      });
    }),
  );
});

const acceptEnsured = (
  channelLinks: ChannelLinks.Interface,
  address: typeof ChannelLinks.ChannelAddress.Type,
  userId: UserId,
) =>
  Effect.gen(function* () {
    const ensured = yield* channelLinks.ensure(address);
    if (ensured._tag !== "Invited") return ensured.link;
    const token = inviteToken(ensured.verificationUrl);
    return yield* channelLinks.accept(Redacted.make(token), userId);
  });

const inviteToken = (url: URL) =>
  ChannelLinks.ChannelLinkInviteToken.make(url.pathname.split("/").at(-1) ?? "");

const seedRegisteredUsers = (userIds: ReadonlyArray<UserId>) =>
  Effect.promise(() =>
    fixture.database.insert(users).values(
      userIds.map((userId) => ({
        email: `${userId}@example.test`,
        id: userId,
        name: "Registered Channel Link User",
        registrationCompletedAt: registeredAt,
      })),
    ),
  );

const registeredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-20T20:00:00.000Z"));

const insertStoredChannelLink = (
  address: typeof ChannelLinks.ChannelAddress.Type,
  userId: UserId,
) =>
  fixture.database.insert(channelLinks).values({
    author_id: address.authorId,
    channel_id: address.channelId,
    channel_link_id: "channel-link-conflict-existing",
    user_id: userId,
  });
