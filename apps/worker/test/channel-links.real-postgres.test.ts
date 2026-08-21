import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import type { Database } from "@osfo/db";
import { accounts, sessions, users } from "@osfo/db/schema/auth";
import {
  channelLinkAuditEvents,
  channelLinkInvites,
  channelLinks,
} from "@osfo/db/schema/channel-links";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Redacted } from "effect";

import { Db } from "../src/db";
import { UserId } from "../src/domain";
import { ChannelLinks } from "../src/services/channel-links";
import { withRealPostgresFixture } from "./real-postgres-fixture";

/* oxlint-disable effecttsgo/strict-effect-provide -- Native PostgreSQL tests build the production service at its public seam. */
/* oxlint-disable eslint/no-underscore-dangle -- Effect results use the standard _tag discriminator. */
/* oxlint-disable eslint/no-shadow -- The canonical channelLinks table and service variable intentionally share the domain name. */
/* oxlint-disable typescript/consistent-return -- Effect generator defects are explicit test precondition exits. */

describe("ChannelLinks with native PostgreSQL", () => {
  it.effect("converges concurrent invitation creation on one pending invite", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const channelLinks = yield* makeChannelLinks(database);
        const address = ChannelLinks.ChannelAddress.make({
          authorId: ChannelLinks.ChannelAuthorId.make("native-concurrent-author"),
          channelId: ChannelLinks.ChannelId.make("telegram-native"),
        });

        const results = yield* Effect.all(
          [channelLinks.ensure(address), channelLinks.ensure(address)],
          { concurrency: "unbounded" },
        );
        const pending = yield* Effect.promise(() => database.select().from(channelLinkInvites));

        expect(results[0]).toEqual(results[1]);
        expect(pending).toHaveLength(1);
      }),
    ),
  );

  it.effect("allows only one User to win concurrent acceptance", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const firstUserId = UserId.make("native-channel-link-first");
        const secondUserId = UserId.make("native-channel-link-second");
        yield* seedRegisteredUsers(database, [firstUserId, secondUserId]);
        const channelLinks = yield* makeChannelLinks(database);
        const address = ChannelLinks.ChannelAddress.make({
          authorId: ChannelLinks.ChannelAuthorId.make("native-accept-author"),
          channelId: ChannelLinks.ChannelId.make("whatsapp-native"),
        });
        const ensured = yield* channelLinks.ensure(address);
        if (ensured._tag !== "Invited")
          return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
        const token = ChannelLinks.ChannelLinkInviteToken.make(
          ensured.verificationUrl.pathname.split("/").at(-1) ?? "",
        );

        const outcomes = yield* Effect.all(
          [firstUserId, secondUserId].map((userId) =>
            channelLinks.accept(Redacted.make(token), userId).pipe(
              Effect.match({
                onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
                onSuccess: (link) => ({ _tag: "Success" as const, link }),
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        const links = yield* readStoredChannelLinks(database);

        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1);
        expect(links).toHaveLength(1);
      }),
    ),
  );

  it.live("proves active, revoked, expired, and linked lifecycle state", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const userId = UserId.make("native-lifecycle-user");
        yield* seedRegisteredUsers(database, [userId]);
        const channelLinksService = yield* makeChannelLinks(database);
        const shortLivedService = yield* makeChannelLinks(database, {
          invitationLifetime: { seconds: 1 },
        });
        const activeAddress = makeAddress("native-lifecycle-active", "telegram-native");
        const expiringAddress = makeAddress("native-lifecycle-expiring", "whatsapp-native");

        const active = yield* acceptEnsured(channelLinksService, activeAddress, userId);
        expect(yield* channelLinksService.resolve(activeAddress)).toEqual(active);
        expect(yield* channelLinksService.ensure(activeAddress)).toEqual({
          _tag: "Linked",
          link: active,
        });

        const expiring = yield* shortLivedService.ensure(expiringAddress);
        if (expiring._tag !== "Invited")
          return yield* Effect.die(new Error("Expected an expiring Channel Link Invite"));
        yield* Effect.sleep("1500 millis");
        const expired = yield* Effect.flip(
          shortLivedService.inspect(Redacted.make(inviteToken(expiring.verificationUrl))),
        );
        const replacement = yield* shortLivedService.ensure(expiringAddress);
        const storedInvites = yield* Effect.promise(() =>
          database
            .select()
            .from(channelLinkInvites)
            .where(eq(channelLinkInvites.author_id, expiringAddress.authorId)),
        );
        expect(replacement._tag).toBe("Invited");
        expect(expired).toMatchObject({ reason: "expired" });
        expect(new Set(storedInvites.map((invite) => invite.state))).toEqual(
          new Set(["expired", "pending"]),
        );

        const revoked = yield* channelLinksService.revoke({
          actorId: ChannelLinks.ChannelLinkActorId.make("user:native-lifecycle-user"),
          channelLinkId: active.channelLinkId,
          reason: ChannelLinks.ChannelLinkRevocationReason.make("Disconnected in settings"),
        });
        expect(revoked.revokedAt).toBeInstanceOf(Date);
        expect(yield* channelLinksService.resolve(activeAddress)).toBeNull();
      }),
    ),
  );

  it.effect("rejects every persisted terminal invitation state", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const userId = UserId.make("native-terminal-user");
        yield* seedRegisteredUsers(database, [userId]);
        const channelLinksService = yield* makeChannelLinks(database);
        const acceptedAddress = makeAddress("native-terminal-accepted", "telegram-native");
        const acceptedInvite = yield* channelLinksService.ensure(acceptedAddress);
        if (acceptedInvite._tag !== "Invited")
          return yield* Effect.die(new Error("Expected an accepted-state invitation"));
        const acceptedToken = inviteToken(acceptedInvite.verificationUrl);
        yield* channelLinksService.accept(Redacted.make(acceptedToken), userId);

        const terminalCases = ["cancelled", "superseded"] as const;
        const terminalAt = DateTime.toDateUtc(yield* DateTime.now);
        const terminalTokens = yield* Effect.forEach(terminalCases, (state) =>
          Effect.gen(function* () {
            const address = makeAddress(`native-terminal-${state}`, "whatsapp-native");
            const ensured = yield* channelLinksService.ensure(address);
            if (ensured._tag !== "Invited")
              return yield* Effect.die(new Error(`Expected a ${state} invitation`));
            yield* Effect.promise(() =>
              database
                .update(channelLinkInvites)
                .set({ [`${state}_at`]: terminalAt, state })
                .where(eq(channelLinkInvites.author_id, address.authorId)),
            );
            return [state, inviteToken(ensured.verificationUrl)] as const;
          }),
        );

        const acceptedFailure = yield* Effect.flip(
          channelLinksService.inspect(Redacted.make(acceptedToken)),
        );
        expect(acceptedFailure).toMatchObject({ reason: "accepted" });
        for (const [state, token] of terminalTokens) {
          const failure = yield* Effect.flip(channelLinksService.inspect(Redacted.make(token)));
          expect(failure).toMatchObject({ reason: state });
        }
      }),
    ),
  );

  it.effect("keeps pending invitations usable during signing-key rotation", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const oldKey = {
          id: "native-old",
          secret: Redacted.make("native-old-channel-link-signing-key-32-characters"),
        } satisfies ChannelLinks.SigningKey;
        const currentKey = {
          id: "native-current",
          secret: Redacted.make("native-current-channel-link-signing-key-32-characters"),
        } satisfies ChannelLinks.SigningKey;
        const issuingService = yield* makeChannelLinks(database, { signingKeys: [oldKey] });
        const ensured = yield* issuingService.ensure(
          makeAddress("native-rotation-author", "telegram-native"),
        );
        if (ensured._tag !== "Invited")
          return yield* Effect.die(new Error("Expected a rotation invitation"));
        const token = Redacted.make(inviteToken(ensured.verificationUrl));

        const rotatingService = yield* makeChannelLinks(database, {
          signingKeys: [currentKey, oldKey],
        });
        expect(yield* rotatingService.inspect(token)).toEqual({
          expiresAt: ensured.expiresAt,
          state: "pending",
        });

        const retiredService = yield* makeChannelLinks(database, { signingKeys: [currentKey] });
        const retired = yield* Effect.flip(retiredService.inspect(token));
        expect(retired).toMatchObject({ reason: "retired-key" });
      }),
    ),
  );

  it.effect("rolls acceptance back when link creation cannot commit", () =>
    withRealPostgresFixture(({ client, database }) =>
      Effect.gen(function* () {
        const userId = UserId.make("native-rollback-user");
        yield* seedRegisteredUsers(database, [userId]);
        const channelLinksService = yield* makeChannelLinks(database);
        const ensured = yield* channelLinksService.ensure(
          makeAddress("native-rollback-author", "telegram-native"),
        );
        if (ensured._tag !== "Invited")
          return yield* Effect.die(new Error("Expected a rollback invitation"));
        yield* Effect.promise(() =>
          client.unsafe(`
            CREATE FUNCTION reject_channel_link() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test rejection'; END $$;
            CREATE TRIGGER reject_channel_link BEFORE INSERT ON channel_links
            FOR EACH ROW EXECUTE FUNCTION reject_channel_link();
          `),
        );

        const failure = yield* Effect.flip(
          channelLinksService.accept(Redacted.make(inviteToken(ensured.verificationUrl)), userId),
        );
        const invites = yield* Effect.promise(() => database.select().from(channelLinkInvites));
        const links = yield* readStoredChannelLinks(database);
        const acceptedAudits = yield* Effect.promise(() =>
          database
            .select()
            .from(channelLinkAuditEvents)
            .where(eq(channelLinkAuditEvents.event_type, "link_accepted")),
        );

        expect(failure).toMatchObject({ _tag: "ChannelLinksUnavailable", operation: "accept" });
        expect(invites).toMatchObject([{ state: "pending" }]);
        expect(links).toEqual([]);
        expect(acceptedAudits).toEqual([]);
      }),
    ),
  );

  it.effect("revokes one link without changing Accounts, AuthSessions, or sibling links", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.gen(function* () {
        const userId = UserId.make("native-independent-authorities-user");
        const now = DateTime.toDateUtc(yield* DateTime.now);
        yield* seedRegisteredUsers(database, [userId]);
        yield* Effect.promise(() =>
          database.insert(accounts).values({
            accountId: "native-phone-account",
            id: "native-phone-account",
            providerId: "phone-number",
            updatedAt: now,
            userId,
          }),
        );
        yield* Effect.promise(() =>
          database.insert(sessions).values({
            expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2027-08-21T00:00:00.000Z")),
            id: "native-auth-session",
            token: "native-auth-session-token",
            updatedAt: now,
            userId,
          }),
        );
        const channelLinksService = yield* makeChannelLinks(database);
        const first = yield* acceptEnsured(
          channelLinksService,
          makeAddress("native-independent-first", "telegram-native"),
          userId,
        );
        const second = yield* acceptEnsured(
          channelLinksService,
          makeAddress("native-independent-second", "whatsapp-native"),
          userId,
        );

        const revoked = yield* channelLinksService.revoke({
          actorId: ChannelLinks.ChannelLinkActorId.make("user:native-independent-authorities-user"),
          channelLinkId: first.channelLinkId,
          reason: ChannelLinks.ChannelLinkRevocationReason.make("Disconnected in settings"),
        });
        const repeated = yield* channelLinksService.revoke({
          actorId: ChannelLinks.ChannelLinkActorId.make("user:native-independent-authorities-user"),
          channelLinkId: first.channelLinkId,
          reason: ChannelLinks.ChannelLinkRevocationReason.make("Disconnected in settings"),
        });
        const unknown = yield* Effect.flip(
          channelLinksService.revoke({
            actorId: ChannelLinks.ChannelLinkActorId.make(
              "user:native-independent-authorities-user",
            ),
            channelLinkId: ChannelLinks.ChannelLinkId.make("missing-native-channel-link"),
            reason: ChannelLinks.ChannelLinkRevocationReason.make("Disconnected in settings"),
          }),
        );

        expect(repeated).toEqual(revoked);
        expect(unknown).toMatchObject({ _tag: "ChannelLinkNotFound" });
        expect(yield* channelLinksService.resolve(second.address)).toEqual(second);
        expect(yield* Effect.promise(() => database.select().from(accounts))).toHaveLength(1);
        expect(yield* Effect.promise(() => database.select().from(sessions))).toHaveLength(1);
      }),
    ),
  );
});

const makeChannelLinks = (
  database: Database,
  options: {
    readonly invitationLifetime?: Parameters<typeof ChannelLinks.layer>[0]["invitationLifetime"];
    readonly signingKeys?: readonly [
      ChannelLinks.SigningKey,
      ...ReadonlyArray<ChannelLinks.SigningKey>,
    ];
  } = {},
) =>
  Effect.scoped(
    ChannelLinks.Service.pipe(
      Effect.provide(
        ChannelLinks.layer({
          invitationLifetime: options.invitationLifetime ?? { hours: 24 },
          signingKeys: options.signingKeys ?? [
            {
              id: "native-current",
              secret: Redacted.make("native-channel-link-signing-key-with-32-characters"),
            },
          ],
          verificationBaseUrl: new URL("https://osfo.test/verify/"),
        }).pipe(
          Layer.provideMerge(Db.layerFromDatabase(database)),
          Layer.provide(BrowserCrypto.layer),
        ),
      ),
    ),
  );

const seedRegisteredUsers = (database: Database, userIds: ReadonlyArray<UserId>) =>
  Effect.promise(() =>
    database.insert(users).values(
      userIds.map((userId) => ({
        email: `${userId}@example.test`,
        id: userId,
        name: "Native Channel Link User",
        registrationCompletedAt: DateTime.toDateUtc(
          DateTime.makeUnsafe("2026-08-20T20:00:00.000Z"),
        ),
      })),
    ),
  );

const readStoredChannelLinks = (database: Database) =>
  Effect.promise(() => database.select().from(channelLinks));

const makeAddress = (authorId: string, channelId: string) =>
  ChannelLinks.ChannelAddress.make({
    authorId: ChannelLinks.ChannelAuthorId.make(authorId),
    channelId: ChannelLinks.ChannelId.make(channelId),
  });

const inviteToken = (url: URL) =>
  ChannelLinks.ChannelLinkInviteToken.make(url.pathname.split("/").at(-1) ?? "");

const acceptEnsured = (
  channelLinksService: ChannelLinks.Interface,
  address: typeof ChannelLinks.ChannelAddress.Type,
  userId: UserId,
) =>
  Effect.gen(function* () {
    const ensured = yield* channelLinksService.ensure(address);
    if (ensured._tag !== "Invited") return ensured.link;
    return yield* channelLinksService.accept(
      Redacted.make(inviteToken(ensured.verificationUrl)),
      userId,
    );
  });
