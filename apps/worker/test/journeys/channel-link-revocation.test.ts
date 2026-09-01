import { BrowserCrypto } from "@effect/platform-browser";
import { ChannelLinkRevocationResponse, ChannelLinksResponse } from "@osfo/api";
import { allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import {
  channelLinkAuditEvents,
  channelLinkInvites,
  channelLinks,
} from "@osfo/db/schema/channel-links";
import { whatsappWakeups } from "@osfo/db/schema/whatsapp-wakeups";
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Layer, Redacted, Schema } from "effect";

import { loadConfig } from "../../src/config";
import { Db } from "../../src/db";
import { UserId } from "../../src/domain";
import { ChannelLinks } from "../../src/services/channel-links";
import { spawnApp } from "../support/spawn-app";

/* oxlint-disable effecttsgo/strict-effect-provide, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle -- This journey owns the real PostgreSQL authority Layer, fixed sentinel evidence, and Effect tagged outcomes. */

it.effect(
  "revokes only the authenticated owner's exhausted Telegram link and permits a fresh link",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ownerApp = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const outsiderApp = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const owner = yield* Effect.promise(() =>
          ownerApp.auth.mintVerifiedUser({
            profile: { helpAreas: [], locale: "en", preferredName: "Link Owner" },
          }),
        );
        const outsider = yield* Effect.promise(() =>
          outsiderApp.auth.mintVerifiedUser({
            profile: { helpAreas: [], locale: "en", preferredName: "Unrelated User" },
          }),
        );
        const database = yield* Db.database;
        const channelLinksService = yield* ChannelLinks.Service;
        const ownerUserId = UserId.make(owner.userId);
        const outsiderUserId = UserId.make(outsider.userId);
        const telegramAddress = address("telegram", "telegram-revocation-owner");
        const unrelatedWhatsAppAddress = address("whatsapp", "15550009999");
        const unrelatedPendingAddress = address("telegram", "telegram-unrelated-pending");

        const oldLink = yield* inviteAndAccept(channelLinksService, telegramAddress, ownerUserId);
        const unrelatedLink = yield* inviteAndAccept(
          channelLinksService,
          unrelatedWhatsAppAddress,
          outsiderUserId,
        );
        const unrelatedPending = yield* channelLinksService.ensure(unrelatedPendingAddress);
        expect(unrelatedPending._tag).toBe("Invited");

        const ownerRegistration = yield* Effect.promise(() =>
          ownerApp.database.registration(owner.userId),
        );
        if (ownerRegistration === null) {
          return yield* Effect.die(new Error("Registered owner state was not found"));
        }
        yield* Effect.promise(() =>
          database.insert(allowanceUsage).values({
            allowance_kind: "acceptedMessages",
            allowance_period_id: ownerRegistration.allowance_period_id,
            basis: "observed",
            quantity: 30n,
            source_id: "channel-link-revocation-exhausted-sentinel",
            source_type: "journeySentinel",
            user_id: owner.userId,
          }),
        );
        yield* Effect.promise(() =>
          database.insert(whatsappWakeups).values({
            channel_link_id: unrelatedLink.channelLinkId,
            endpoint_fingerprint: "b".repeat(64),
            fingerprint: "a".repeat(64),
            locale: "en",
            source_committed_at: new Date("2026-08-31T12:00:00.000Z"),
            source_identity: "unrelated-reminder",
            source_kind: "reminder",
            template_policy_version: "whatsapp-wakeup-v1",
            trace_id: "unrelated-trace",
            user_id: outsider.userId,
            wakeup_id: "unrelated-wakeup",
          }),
        );

        const listed = yield* Effect.promise(() => ownerApp.fetch("/v1/channel-links"));
        expect(listed.status).toBe(200);
        const listedText = yield* Effect.promise(() => listed.text());
        const initialSummary = yield* Schema.decodeEffect(
          Schema.fromJsonString(ChannelLinksResponse),
        )(listedText);
        expect(initialSummary.items).toEqual([
          {
            channel: "telegram",
            channelLinkId: oldLink.channelLinkId,
            linkedAt: oldLink.createdAt,
          },
        ]);
        expect(listedText).not.toContain(telegramAddress.authorId);

        const wrongOwner = yield* Effect.promise(() =>
          outsiderApp.fetch(`/v1/channel-links/${oldLink.channelLinkId}`, { method: "DELETE" }),
        );
        expect(wrongOwner.status).toBe(404);
        expect(yield* Effect.promise(() => wrongOwner.text())).not.toContain(
          telegramAddress.authorId,
        );
        expect(yield* channelLinksService.resolve(telegramAddress)).toMatchObject({
          channelLinkId: oldLink.channelLinkId,
        });

        const revoked = yield* Effect.promise(() =>
          ownerApp.fetch(`/v1/channel-links/${oldLink.channelLinkId}`, { method: "DELETE" }),
        );
        expect(revoked.status).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(ChannelLinkRevocationResponse)(
            yield* Effect.promise(() => revoked.json()),
          ),
        ).toEqual({ state: "unlinked" });

        const replay = yield* Effect.promise(() =>
          ownerApp.fetch(`/v1/channel-links/${oldLink.channelLinkId}`, { method: "DELETE" }),
        );
        expect(replay.status).toBe(404);
        expect(yield* Effect.promise(() => replay.text())).not.toContain(telegramAddress.authorId);
        expect(yield* channelLinksService.resolveConversation(telegramAddress)).toEqual({
          _tag: "Unlinked",
          previousChannelLinkId: oldLink.channelLinkId,
        });

        const freshInvite = yield* channelLinksService.ensure(telegramAddress);
        if (freshInvite._tag !== "Invited") {
          return yield* Effect.die(new Error("Unlinked Company Conversation received no invite"));
        }
        const freshToken = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
          freshInvite.verificationUrl.pathname.split("/").at(-1) ?? "",
        );
        const freshLink = yield* channelLinksService.accept(Redacted.make(freshToken), ownerUserId);

        const [newLink] = yield* Effect.promise(() =>
          database
            .select()
            .from(channelLinks)
            .where(
              and(
                eq(channelLinks.channel_id, telegramAddress.channelId),
                eq(channelLinks.author_id, telegramAddress.authorId),
                isNull(channelLinks.revoked_at),
              ),
            ),
        );
        expect(newLink).toMatchObject({ user_id: owner.userId });
        expect(newLink?.channel_link_id).toBe(freshLink.channelLinkId);
        expect(newLink?.channel_link_id).not.toBe(oldLink.channelLinkId);

        const [oldStored, revocationEvents, acceptedInvites, unrelatedStored] = yield* Effect.all([
          Effect.promise(() =>
            database
              .select()
              .from(channelLinks)
              .where(eq(channelLinks.channel_link_id, oldLink.channelLinkId)),
          ).pipe(Effect.map((rows) => rows[0])),
          Effect.promise(() =>
            database
              .select()
              .from(channelLinkAuditEvents)
              .where(
                and(
                  eq(channelLinkAuditEvents.channel_link_id, oldLink.channelLinkId),
                  eq(channelLinkAuditEvents.event_type, "link_revoked"),
                ),
              ),
          ),
          Effect.promise(() =>
            database
              .select()
              .from(channelLinkInvites)
              .where(
                and(
                  eq(channelLinkInvites.accepted_channel_link_id, newLink?.channel_link_id ?? ""),
                  eq(channelLinkInvites.state, "accepted"),
                ),
              ),
          ),
          readUnrelatedSentinels(database, outsider.userId, unrelatedLink.channelLinkId),
        ]);
        expect(oldStored).toMatchObject({
          revoked_by: expect.stringMatching(/^auth-session:/u),
          user_id: owner.userId,
        });
        expect(oldStored?.revoked_at).toBeInstanceOf(Date);
        expect(revocationEvents).toHaveLength(1);
        expect(revocationEvents[0]).toMatchObject({
          actor_id: oldStored?.revoked_by,
          user_id: owner.userId,
        });
        expect(acceptedInvites).toHaveLength(1);
        expect(unrelatedStored).toEqual({
          auditCount: 1,
          inviteState: "pending",
          linkActive: true,
          userExists: true,
          wakeState: "pending",
        });
        expect(
          yield* Effect.promise(() =>
            database
              .select()
              .from(allowanceUsage)
              .where(eq(allowanceUsage.source_id, "channel-link-revocation-exhausted-sentinel")),
          ),
        ).toHaveLength(1);
        return undefined;
      }).pipe(Effect.provide(channelLinksLayer())),
    ),
);

const address = (channelId: "telegram" | "whatsapp", authorId: string) =>
  ChannelLinks.ChannelAddress.make({
    authorId: ChannelLinks.ChannelAuthorId.make(authorId),
    channelId: ChannelLinks.ChannelId.make(channelId),
  });

const inviteAndAccept = (
  service: ChannelLinks.Interface,
  channelAddress: typeof ChannelLinks.ChannelAddress.Type,
  userId: UserId,
) =>
  Effect.gen(function* () {
    const ensured = yield* service.ensure(channelAddress);
    if (ensured._tag !== "Invited") {
      return yield* Effect.die(new Error("Expected a fresh Channel Link Invite"));
    }
    const token = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
      ensured.verificationUrl.pathname.split("/").at(-1) ?? "",
    );
    return yield* service.accept(Redacted.make(token), userId);
  });

const readUnrelatedSentinels = (
  database: Db.Database,
  userId: string,
  channelLinkId: ChannelLinks.ChannelLinkId,
) =>
  Effect.gen(function* () {
    const [userRows, linkRows, inviteRows, wakeRows, auditRows] = yield* Effect.all([
      Effect.promise(() => database.select().from(users).where(eq(users.id, userId))),
      Effect.promise(() =>
        database
          .select()
          .from(channelLinks)
          .where(
            and(eq(channelLinks.channel_link_id, channelLinkId), isNull(channelLinks.revoked_at)),
          ),
      ),
      Effect.promise(() =>
        database
          .select()
          .from(channelLinkInvites)
          .where(eq(channelLinkInvites.author_id, "telegram-unrelated-pending")),
      ),
      Effect.promise(() =>
        database
          .select()
          .from(whatsappWakeups)
          .where(eq(whatsappWakeups.wakeup_id, "unrelated-wakeup")),
      ),
      Effect.promise(() =>
        database
          .select()
          .from(channelLinkAuditEvents)
          .where(
            and(
              eq(channelLinkAuditEvents.channel_link_id, channelLinkId),
              eq(channelLinkAuditEvents.event_type, "link_accepted"),
            ),
          ),
      ),
    ]);
    return {
      auditCount: auditRows.length,
      inviteState: inviteRows[0]?.state,
      linkActive: linkRows.length === 1,
      userExists: userRows.length === 1,
      wakeState: wakeRows[0]?.state,
    };
  });

const channelLinksLayer = () =>
  ChannelLinks.layerFromConfig(loadConfig(env)).pipe(
    Layer.provideMerge(Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer)),
  );
