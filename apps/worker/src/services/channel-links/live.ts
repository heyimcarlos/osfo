import {
  channelLinkAuditEvents,
  channelLinkInvites,
  channelLinks,
} from "@osfo/db/schema/channel-links";
import { whatsappWakeups } from "@osfo/db/schema/whatsapp-wakeups";
import type { ChannelLinkInviteToken } from "@osfo/api";
import { users } from "@osfo/db/schema/auth";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { Context, Crypto, DateTime, Duration, Effect, Layer, Redacted, Schema } from "effect";

import { Db } from "../../db";
import { publicWebBaseUrl, type CloudflareConfig } from "../../config";
import { ChannelLinkId, UserId } from "../../domain";
import { ChannelAddress, ChannelAuthorId, ChannelId } from "../../domain/channel-link";
import { ChannelLinkInviteUnavailable, ChannelLinksUnavailable } from "./model";
import { generateInviteToken, hashInviteToken } from "./token";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction callbacks are Promise boundaries. */
/* oxlint-disable eslint/no-underscore-dangle -- Effect and service results use the standard _tag discriminator. */

export { ChannelAddress, ChannelAuthorId, ChannelId } from "../../domain/channel-link";

export { ChannelLinkId } from "../../domain";
export { ChannelLinkInviteUnavailable, ChannelLinksUnavailable } from "./model";

/** Trusted internal actor responsible for ending Channel Link authority. */
export const ChannelLinkActorId = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.brand("ChannelLinkActorId"),
);

/** Bounded operator-readable reason for ending one Channel Link. */
export const ChannelLinkRevocationReason = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.trim().length > 0 && value.trim().length <= 200) ||
      "must contain between 1 and 200 characters",
  ),
).pipe(Schema.brand("ChannelLinkRevocationReason"));

/** Durable active or revoked relationship between a Channel Address and a User. */
export const ChannelLink = Schema.Struct({
  address: ChannelAddress,
  channelLinkId: ChannelLinkId,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
});

/** Stable identity for one finite-lived Channel Link Invite. */
export const ChannelLinkInviteId = Schema.String.pipe(Schema.brand("ChannelLinkInviteId"));

export { ChannelLinkInviteToken } from "@osfo/api";

/** Persisted Channel Link Invite facts owned by this authority. */
export const ChannelLinkInvite = Schema.Struct({
  address: ChannelAddress,
  expiresAt: Schema.Date,
  inviteId: ChannelLinkInviteId,
  state: Schema.Literals(["pending", "accepted", "expired", "cancelled", "superseded"]),
});

/** Client-safe projection of one invitation. */
export const ChannelLinkInviteView = Schema.Struct({
  expiresAt: Schema.Date,
  state: Schema.Literals(["pending", "accepted", "expired", "cancelled", "superseded"]),
});

/** Acceptance rejection when the authenticated identity has not completed registration. */
export class ChannelLinkRegistrationRequired extends Schema.TaggedError<ChannelLinkRegistrationRequired>()(
  "ChannelLinkRegistrationRequired",
  { userId: UserId },
) {}

/** Fail-closed rejection when another User owns the active Channel Address. */
export class ChannelLinkConflict extends Schema.TaggedError<ChannelLinkConflict>()(
  "ChannelLinkConflict",
  { channelId: ChannelId },
) {}

/** Expected rejection when a trusted actor names no durable Channel Link. */
export class ChannelLinkNotFound extends Schema.TaggedError<ChannelLinkNotFound>()(
  "ChannelLinkNotFound",
  { channelLinkId: ChannelLinkId },
) {}

/** Concrete policy captured when constructing the Channel Links authority. */
export interface Options {
  readonly invitationLifetime: Duration.Input;
  readonly verificationBaseUrl: URL;
}

/** Results from ensuring current durable state for one Channel Address. */
export type EnsureResult =
  | { readonly _tag: "Linked"; readonly link: typeof ChannelLink.Type }
  | { readonly _tag: "Invited"; readonly expiresAt: Date; readonly verificationUrl: URL };

/** Current routing boundary for one address-scoped Company Conversation attempt. */
export type ConversationResolution =
  | { readonly _tag: "Linked"; readonly link: typeof ChannelLink.Type }
  | {
      readonly _tag: "Unlinked";
      readonly previousChannelLinkId: ChannelLinkId | null;
    };

/** Fresh bearer material drawn for one invitation attempt. */
interface InviteDraw {
  readonly auditUuid: string;
  readonly candidate: {
    readonly expiresAt: Date;
    readonly inviteId: typeof ChannelLinkInviteId.Type;
    readonly tokenHash: string;
  };
  readonly token: typeof ChannelLinkInviteToken.Type;
}

/** Trusted actor facts required to revoke Channel Link authority. */
export interface RevokeInput {
  readonly actorId: typeof ChannelLinkActorId.Type;
  readonly channelLinkId: ChannelLinkId;
  readonly reason: typeof ChannelLinkRevocationReason.Type;
}

/** Public Channel Links authority. */
export interface Interface {
  readonly resolveConversation: (
    address: typeof ChannelAddress.Type,
  ) => Effect.Effect<ConversationResolution, ChannelLinksUnavailable>;
  readonly resolve: (
    address: typeof ChannelAddress.Type,
  ) => Effect.Effect<typeof ChannelLink.Type | null, ChannelLinksUnavailable>;
  readonly ensure: (
    address: typeof ChannelAddress.Type,
  ) => Effect.Effect<EnsureResult, ChannelLinksUnavailable>;
  readonly inspect: (
    token: Redacted.Redacted<typeof ChannelLinkInviteToken.Type>,
  ) => Effect.Effect<
    typeof ChannelLinkInviteView.Type,
    ChannelLinkInviteUnavailable | ChannelLinksUnavailable
  >;
  readonly accept: (
    token: Redacted.Redacted<typeof ChannelLinkInviteToken.Type>,
    userId: UserId,
  ) => Effect.Effect<
    typeof ChannelLink.Type,
    | ChannelLinkConflict
    | ChannelLinkInviteUnavailable
    | ChannelLinkRegistrationRequired
    | ChannelLinksUnavailable
  >;
  readonly revoke: (
    input: RevokeInput,
  ) => Effect.Effect<typeof ChannelLink.Type, ChannelLinkNotFound | ChannelLinksUnavailable>;
}

/** Complete owner of Channel Address, Channel Link Invite, and Channel Link lifecycles. */
export class Service extends Context.Service<Service, Interface>()("@osfo/ChannelLinks") {}

/**
 * Construct the authority from parsed Worker configuration under product-default
 * policy: 30-minute invitations delivered as `/verify/<token>` on the public web origin.
 */
export const layerFromConfig = (
  config: Pick<CloudflareConfig, "auth">,
  policy: Partial<Pick<Options, "invitationLifetime">> = {},
) =>
  layer({
    invitationLifetime: policy.invitationLifetime ?? { minutes: 30 },
    verificationBaseUrl: new URL("/verify/", publicWebBaseUrl(config.auth)),
  });

/** Construct the Channel Links authority and capture all implementation dependencies. */
export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Db.database;
      const crypto = yield* Crypto.Crypto;

      const resolve = Effect.fn("ChannelLinks.resolve")((address: typeof ChannelAddress.Type) =>
        Effect.tryPromise({
          try: () =>
            db
              .select({
                authorId: channelLinks.author_id,
                channelId: channelLinks.channel_id,
                channelLinkId: channelLinks.channel_link_id,
                createdAt: channelLinks.created_at,
                revokedAt: channelLinks.revoked_at,
                userId: channelLinks.user_id,
              })
              .from(channelLinks)
              .where(
                and(
                  eq(channelLinks.channel_id, address.channelId),
                  eq(channelLinks.author_id, address.authorId),
                  isNull(channelLinks.revoked_at),
                ),
              )
              .limit(1),
          catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "resolve" }),
        }).pipe(
          Effect.flatMap((rows) => {
            const row = rows[0];
            return row === undefined ? Effect.succeed(null) : decodeChannelLinkRow(row);
          }),
        ),
      );

      const resolveConversation = Effect.fn("ChannelLinks.resolveConversation")(function* (
        address: typeof ChannelAddress.Type,
      ) {
        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select({
                authorId: channelLinks.author_id,
                channelId: channelLinks.channel_id,
                channelLinkId: channelLinks.channel_link_id,
                createdAt: channelLinks.created_at,
                revokedAt: channelLinks.revoked_at,
                userId: channelLinks.user_id,
              })
              .from(channelLinks)
              .where(
                and(
                  eq(channelLinks.channel_id, address.channelId),
                  eq(channelLinks.author_id, address.authorId),
                ),
              )
              .orderBy(desc(channelLinks.created_at), desc(channelLinks.channel_link_id))
              .limit(1),
          catch: (cause) =>
            new ChannelLinksUnavailable({ cause, operation: "resolveConversation" }),
        });
        const row = rows[0];
        if (row === undefined) return { _tag: "Unlinked" as const, previousChannelLinkId: null };
        const link = yield* decodeChannelLinkRow(row);
        return link.revokedAt === null
          ? { _tag: "Linked" as const, link }
          : {
              _tag: "Unlinked" as const,
              previousChannelLinkId: link.channelLinkId,
            };
      });

      const ensure = Effect.fn("ChannelLinks.ensure")(function* (
        address: typeof ChannelAddress.Type,
      ) {
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const lifetimeMillis = Duration.toMillis(
          Duration.fromInputUnsafe(options.invitationLifetime),
        );
        const expiresAt = DateTime.toDateUtc(
          DateTime.makeUnsafe(Math.floor((now.getTime() + lifetimeMillis) / 1_000) * 1_000),
        );

        const mintInviteDraw = Effect.fn("ChannelLinks.ensure.draw")(function* () {
          const [inviteUuid, auditUuid] = yield* Effect.all([
            crypto.randomUUIDv7,
            crypto.randomUUIDv7,
          ]).pipe(
            Effect.mapError(
              (cause) => new ChannelLinksUnavailable({ cause, operation: "ensure.identity" }),
            ),
          );
          const token = yield* generateInviteToken(crypto);
          const tokenHash = yield* hashInviteToken(crypto, Redacted.make(token));
          return {
            auditUuid,
            candidate: {
              expiresAt,
              inviteId: ChannelLinkInviteId.make(`channel-link-invite-${inviteUuid}`),
              tokenHash,
            },
            token,
          };
        });

        const runEnsureTransaction = (drawn: InviteDraw) =>
          Effect.tryPromise({
            try: () =>
              db.transaction(async (transaction) => {
                const [active] = await transaction
                  .select({
                    authorId: channelLinks.author_id,
                    channelId: channelLinks.channel_id,
                    channelLinkId: channelLinks.channel_link_id,
                    createdAt: channelLinks.created_at,
                    revokedAt: channelLinks.revoked_at,
                    userId: channelLinks.user_id,
                  })
                  .from(channelLinks)
                  .where(
                    and(
                      eq(channelLinks.channel_id, address.channelId),
                      eq(channelLinks.author_id, address.authorId),
                      isNull(channelLinks.revoked_at),
                    ),
                  )
                  .for("update")
                  .limit(1);
                if (active !== undefined) return { _tag: "Linked" as const, row: active };

                await transaction
                  .update(channelLinkInvites)
                  .set({ expired_at: now, state: "expired" })
                  .where(
                    and(
                      eq(channelLinkInvites.channel_id, address.channelId),
                      eq(channelLinkInvites.author_id, address.authorId),
                      eq(channelLinkInvites.state, "pending"),
                      lte(channelLinkInvites.expires_at, now),
                    ),
                  );

                // Every request mints fresh bearer material: supersede any surviving
                // pending invite so delivered URLs reset the clock and old links die.
                await transaction
                  .update(channelLinkInvites)
                  .set({ superseded_at: now, state: "superseded" })
                  .where(
                    and(
                      eq(channelLinkInvites.channel_id, address.channelId),
                      eq(channelLinkInvites.author_id, address.authorId),
                      eq(channelLinkInvites.state, "pending"),
                    ),
                  );

                const [inserted] = await transaction
                  .insert(channelLinkInvites)
                  .values({
                    author_id: address.authorId,
                    channel_id: address.channelId,
                    created_at: now,
                    expires_at: drawn.candidate.expiresAt,
                    invite_id: drawn.candidate.inviteId,
                    token_hash: drawn.candidate.tokenHash,
                  })
                  .onConflictDoNothing()
                  .returning({ inviteId: channelLinkInvites.invite_id });
                if (inserted === undefined) return { _tag: "Conflict" as const };

                await transaction.insert(channelLinkAuditEvents).values({
                  actor_id: "system:channel-links",
                  event_id: `channel-link-audit-${drawn.auditUuid}`,
                  event_type: "invite_issued",
                  invite_id: inserted.inviteId,
                  metadata: {},
                  occurred_at: now,
                });
                return { _tag: "Invited" as const, token: drawn.token };
              }),
            catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "ensure" }),
          });

        let result = yield* Effect.flatMap(mintInviteDraw(), runEnsureTransaction);
        // A simultaneous ensure for the same address can win the one-pending slot;
        // redrawing supersedes the winner and converges on our own fresh invitation.
        for (let attempt = 0; result._tag === "Conflict" && attempt < 2; attempt += 1) {
          result = yield* Effect.flatMap(mintInviteDraw(), runEnsureTransaction);
        }
        if (result._tag === "Conflict") {
          return yield* new ChannelLinksUnavailable({
            cause: { address },
            operation: "ensure.conflict",
          });
        }

        if (result._tag === "Linked") {
          return {
            _tag: "Linked" as const,
            link: yield* decodeChannelLinkRow(result.row),
          };
        }
        return {
          _tag: "Invited" as const,
          expiresAt,
          verificationUrl: new URL(result.token, options.verificationBaseUrl),
        };
      });

      const inspect = Effect.fn("ChannelLinks.inspect")(function* (
        token: Redacted.Redacted<typeof ChannelLinkInviteToken.Type>,
      ) {
        const tokenHash = yield* hashInviteToken(crypto, token);
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const row = yield* Effect.tryPromise({
          try: () =>
            db
              .select({
                expiresAt: channelLinkInvites.expires_at,
                state: channelLinkInvites.state,
              })
              .from(channelLinkInvites)
              .where(eq(channelLinkInvites.token_hash, tokenHash))
              .limit(1),
          catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "inspect" }),
        }).pipe(Effect.map((rows) => rows[0]));
        if (row === undefined) {
          return yield* new ChannelLinkInviteUnavailable({ reason: "invalid" });
        }
        if (row.state === "pending" && row.expiresAt.getTime() <= now.getTime()) {
          yield* Effect.tryPromise({
            try: () =>
              db
                .update(channelLinkInvites)
                .set({ expired_at: now, state: "expired" })
                .where(
                  and(
                    eq(channelLinkInvites.token_hash, tokenHash),
                    eq(channelLinkInvites.state, "pending"),
                  ),
                ),
            catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "inspect.expire" }),
          });
          return yield* new ChannelLinkInviteUnavailable({ reason: "expired" });
        }
        if (row.state !== "pending") {
          const reason =
            row.state === "accepted" ||
            row.state === "cancelled" ||
            row.state === "expired" ||
            row.state === "superseded"
              ? row.state
              : "invalid";
          return yield* new ChannelLinkInviteUnavailable({ reason });
        }
        return ChannelLinkInviteView.make({ expiresAt: row.expiresAt, state: "pending" });
      });

      const accept = Effect.fn("ChannelLinks.accept")(function* (
        token: Redacted.Redacted<typeof ChannelLinkInviteToken.Type>,
        userId: UserId,
      ) {
        const tokenHash = yield* hashInviteToken(crypto, token);
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const [linkUuid, auditUuid] = yield* Effect.all([
          crypto.randomUUIDv7,
          crypto.randomUUIDv7,
        ]).pipe(
          Effect.mapError(
            (cause) => new ChannelLinksUnavailable({ cause, operation: "accept.identity" }),
          ),
        );
        const channelLinkId = ChannelLinkId.make(`channel-link-${linkUuid}`);

        const result = yield* Effect.tryPromise({
          try: () =>
            db.transaction(async (transaction) => {
              const [invite] = await transaction
                .select({
                  acceptedUserId: channelLinkInvites.accepted_user_id,
                  acceptedChannelLinkId: channelLinkInvites.accepted_channel_link_id,
                  authorId: channelLinkInvites.author_id,
                  channelId: channelLinkInvites.channel_id,
                  expiresAt: channelLinkInvites.expires_at,
                  inviteId: channelLinkInvites.invite_id,
                  state: channelLinkInvites.state,
                })
                .from(channelLinkInvites)
                .where(eq(channelLinkInvites.token_hash, tokenHash))
                .for("update")
                .limit(1);
              if (invite === undefined)
                return { _tag: "Unavailable" as const, reason: "invalid" as const };
              if (invite.state === "pending" && invite.expiresAt.getTime() <= now.getTime()) {
                await transaction
                  .update(channelLinkInvites)
                  .set({ expired_at: now, state: "expired" })
                  .where(eq(channelLinkInvites.invite_id, invite.inviteId));
                return { _tag: "Unavailable" as const, reason: "expired" as const };
              }
              if (invite.state === "accepted") {
                if (invite.acceptedUserId !== userId || invite.acceptedChannelLinkId === null) {
                  return { _tag: "Unavailable" as const, reason: "accepted" as const };
                }
                const [repeated] = await transaction
                  .select({
                    authorId: channelLinks.author_id,
                    channelId: channelLinks.channel_id,
                    channelLinkId: channelLinks.channel_link_id,
                    createdAt: channelLinks.created_at,
                    revokedAt: channelLinks.revoked_at,
                    userId: channelLinks.user_id,
                  })
                  .from(channelLinks)
                  .where(
                    and(
                      eq(channelLinks.channel_link_id, invite.acceptedChannelLinkId),
                      eq(channelLinks.user_id, userId),
                    ),
                  )
                  .limit(1);
                return repeated === undefined
                  ? { _tag: "Inconsistent" as const }
                  : { _tag: "Accepted" as const, row: repeated };
              }
              if (invite.state !== "pending") {
                const reason =
                  invite.state === "cancelled" ||
                  invite.state === "expired" ||
                  invite.state === "superseded"
                    ? invite.state
                    : "invalid";
                return { _tag: "Unavailable" as const, reason };
              }

              const [registered] = await transaction
                .select({ registrationCompletedAt: users.registrationCompletedAt })
                .from(users)
                .where(eq(users.id, userId))
                .for("update")
                .limit(1);
              if (registered?.registrationCompletedAt === null || registered === undefined) {
                return { _tag: "RegistrationRequired" as const };
              }

              const [active] = await transaction
                .select({
                  authorId: channelLinks.author_id,
                  channelId: channelLinks.channel_id,
                  channelLinkId: channelLinks.channel_link_id,
                  createdAt: channelLinks.created_at,
                  revokedAt: channelLinks.revoked_at,
                  userId: channelLinks.user_id,
                })
                .from(channelLinks)
                .where(
                  and(
                    eq(channelLinks.channel_id, invite.channelId),
                    eq(channelLinks.author_id, invite.authorId),
                    isNull(channelLinks.revoked_at),
                  ),
                )
                .for("update")
                .limit(1);
              if (active !== undefined && active.userId !== userId) {
                await transaction.insert(channelLinkAuditEvents).values({
                  actor_id: `user:${userId}`,
                  channel_link_id: active.channelLinkId,
                  event_id: `channel-link-audit-${auditUuid}`,
                  event_type: "accept_conflict",
                  invite_id: invite.inviteId,
                  metadata: {},
                  occurred_at: now,
                  user_id: userId,
                });
                return { _tag: "Conflict" as const, channelId: invite.channelId };
              }

              const accepted =
                active ??
                (
                  await transaction
                    .insert(channelLinks)
                    .values({
                      author_id: invite.authorId,
                      channel_id: invite.channelId,
                      channel_link_id: channelLinkId,
                      created_at: now,
                      user_id: userId,
                    })
                    .returning({
                      authorId: channelLinks.author_id,
                      channelId: channelLinks.channel_id,
                      channelLinkId: channelLinks.channel_link_id,
                      createdAt: channelLinks.created_at,
                      revokedAt: channelLinks.revoked_at,
                      userId: channelLinks.user_id,
                    })
                )[0];
              if (accepted === undefined) return { _tag: "Inconsistent" as const };

              await transaction
                .update(channelLinkInvites)
                .set({
                  accepted_at: now,
                  accepted_channel_link_id: accepted.channelLinkId,
                  accepted_user_id: userId,
                  state: "accepted",
                })
                .where(eq(channelLinkInvites.invite_id, invite.inviteId));
              await transaction.insert(channelLinkAuditEvents).values({
                actor_id: `user:${userId}`,
                channel_link_id: accepted.channelLinkId,
                event_id: `channel-link-audit-${auditUuid}`,
                event_type: "link_accepted",
                invite_id: invite.inviteId,
                metadata: {},
                occurred_at: now,
                user_id: userId,
              });
              return { _tag: "Accepted" as const, row: accepted };
            }),
          catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "accept" }),
        });

        if (result._tag === "Accepted") return yield* decodeChannelLinkRow(result.row);
        if (result._tag === "Unavailable") {
          const reason =
            result.reason === "accepted" ||
            result.reason === "cancelled" ||
            result.reason === "expired" ||
            result.reason === "superseded"
              ? result.reason
              : "invalid";
          return yield* new ChannelLinkInviteUnavailable({ reason });
        }
        if (result._tag === "RegistrationRequired") {
          return yield* new ChannelLinkRegistrationRequired({ userId });
        }
        if (result._tag === "Conflict") {
          const channelId = yield* Schema.decodeEffect(ChannelId)(result.channelId).pipe(
            Effect.mapError(
              (cause) => new ChannelLinksUnavailable({ cause, operation: "accept.readback" }),
            ),
          );
          return yield* new ChannelLinkConflict({ channelId });
        }
        return yield* new ChannelLinksUnavailable({ cause: result, operation: "accept.readback" });
      });

      const revoke = Effect.fn("ChannelLinks.revoke")(function* (input: RevokeInput) {
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const auditUuid = yield* crypto.randomUUIDv7.pipe(
          Effect.mapError(
            (cause) => new ChannelLinksUnavailable({ cause, operation: "revoke.identity" }),
          ),
        );
        const result = yield* Effect.tryPromise({
          try: () =>
            db.transaction(async (transaction) => {
              const [stored] = await transaction
                .select({
                  authorId: channelLinks.author_id,
                  channelId: channelLinks.channel_id,
                  channelLinkId: channelLinks.channel_link_id,
                  createdAt: channelLinks.created_at,
                  revokedAt: channelLinks.revoked_at,
                  userId: channelLinks.user_id,
                })
                .from(channelLinks)
                .where(eq(channelLinks.channel_link_id, input.channelLinkId))
                .for("update")
                .limit(1);
              if (stored === undefined) return null;
              if (stored.revokedAt !== null) return stored;

              const [revoked] = await transaction
                .update(channelLinks)
                .set({
                  revocation_reason: input.reason.trim(),
                  revoked_at: now,
                  revoked_by: input.actorId,
                })
                .where(eq(channelLinks.channel_link_id, input.channelLinkId))
                .returning({
                  authorId: channelLinks.author_id,
                  channelId: channelLinks.channel_id,
                  channelLinkId: channelLinks.channel_link_id,
                  createdAt: channelLinks.created_at,
                  revokedAt: channelLinks.revoked_at,
                  userId: channelLinks.user_id,
                });
              if (revoked === undefined) throw new Error("Revoked Channel Link disappeared");
              await transaction
                .update(whatsappWakeups)
                .set({
                  canceled_at: now,
                  lease_expires_at: null,
                  lease_id: null,
                  safe_failure_class: "authorityLost",
                  state: "canceled",
                  updated_at: now,
                })
                .where(
                  and(
                    eq(whatsappWakeups.channel_link_id, input.channelLinkId),
                    inArray(whatsappWakeups.state, ["pending", "accepted", "ambiguous"]),
                  ),
                );
              await transaction.insert(channelLinkAuditEvents).values({
                actor_id: input.actorId,
                channel_link_id: revoked.channelLinkId,
                event_id: `channel-link-audit-${auditUuid}`,
                event_type: "link_revoked",
                metadata: {},
                occurred_at: now,
                user_id: revoked.userId,
              });
              return revoked;
            }),
          catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "revoke" }),
        });
        if (result === null) {
          return yield* new ChannelLinkNotFound({ channelLinkId: input.channelLinkId });
        }
        return yield* decodeChannelLinkRow(result);
      });

      return Service.of({
        accept,
        ensure,
        inspect,
        resolve,
        resolveConversation,
        revoke,
      });
    }),
  );

/** Expire elapsed invitations from the scheduled Worker entry point. */
export const expirePending = Effect.fn("ChannelLinks.expirePending")(function* () {
  const db = yield* Db.database;
  const now = DateTime.toDateUtc(yield* DateTime.now);
  return yield* Effect.tryPromise({
    try: () =>
      db
        .update(channelLinkInvites)
        .set({ expired_at: now, state: "expired" })
        .where(
          and(eq(channelLinkInvites.state, "pending"), lte(channelLinkInvites.expires_at, now)),
        )
        .returning({ inviteId: channelLinkInvites.invite_id }),
    catch: (cause) => new ChannelLinksUnavailable({ cause, operation: "expirePending" }),
  }).pipe(Effect.map((rows) => rows.length));
});

const ChannelLinkRow = Schema.Struct({
  authorId: ChannelAuthorId,
  channelId: ChannelId,
  channelLinkId: ChannelLinkId,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date),
  userId: UserId,
});

const decodeChannelLinkRow = (row: typeof ChannelLinkRow.Encoded) =>
  Schema.decodeEffect(ChannelLinkRow)(row).pipe(
    Effect.map((decoded) =>
      ChannelLink.make({
        address: ChannelAddress.make({
          authorId: decoded.authorId,
          channelId: decoded.channelId,
        }),
        channelLinkId: decoded.channelLinkId,
        createdAt: decoded.createdAt,
        revokedAt: decoded.revokedAt,
        userId: decoded.userId,
      }),
    ),
    Effect.mapError(
      (cause) => new ChannelLinksUnavailable({ cause, operation: "decodeChannelLinkRow" }),
    ),
  );
