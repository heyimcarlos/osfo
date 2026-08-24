import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Revocable authority linking one Channel Address to one registered User. */
export const channelLinks = pgTable(
  "channel_links",
  {
    channel_link_id: text().primaryKey(),
    channel_id: text().notNull(),
    author_id: text().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp({ withTimezone: true }),
    revoked_by: text(),
    revocation_reason: text(),
  },
  (table) => [
    check(
      "channel_links_revocation_check",
      sql`(${table.revoked_at} is null and ${table.revoked_by} is null and ${table.revocation_reason} is null)
        or (${table.revoked_at} is not null and ${table.revoked_by} is not null and ${table.revocation_reason} is not null and length(btrim(${table.revoked_by})) > 0 and length(btrim(${table.revocation_reason})) between 1 and 200)`,
    ),
    uniqueIndex("channel_links_active_address_unique")
      .on(table.channel_id, table.author_id)
      .where(sql`${table.revoked_at} is null`),
    index("channel_links_user_index").on(table.user_id),
  ],
);

/** Finite-lived bearer invitations for linking one external Channel Address. */
export const channelLinkInvites = pgTable(
  "channel_link_invites",
  {
    invite_id: text().primaryKey(),
    channel_id: text().notNull(),
    author_id: text().notNull(),
    token_hash: text().notNull(),
    state: text().default("pending").notNull(),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp({ withTimezone: true }).notNull(),
    accepted_at: timestamp({ withTimezone: true }),
    accepted_user_id: text().references(() => users.id, { onDelete: "cascade" }),
    accepted_channel_link_id: text().references(() => channelLinks.channel_link_id, {
      onDelete: "cascade",
    }),
    expired_at: timestamp({ withTimezone: true }),
    cancelled_at: timestamp({ withTimezone: true }),
    superseded_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    check("channel_link_invites_token_hash_check", sql`${table.token_hash} ~ '^[0-9a-f]{64}$'`),
    check("channel_link_invites_expiry_check", sql`${table.created_at} < ${table.expires_at}`),
    check(
      "channel_link_invites_state_check",
      sql`${table.state} in ('pending', 'accepted', 'expired', 'cancelled', 'superseded')`,
    ),
    check(
      "channel_link_invites_lifecycle_check",
      sql`(${table.state} = 'pending' and ${table.accepted_at} is null and ${table.accepted_user_id} is null and ${table.accepted_channel_link_id} is null and ${table.expired_at} is null and ${table.cancelled_at} is null and ${table.superseded_at} is null)
        or (${table.state} = 'accepted' and ${table.accepted_at} is not null and ${table.accepted_user_id} is not null and ${table.accepted_channel_link_id} is not null and ${table.expired_at} is null and ${table.cancelled_at} is null and ${table.superseded_at} is null)
        or (${table.state} = 'expired' and ${table.accepted_at} is null and ${table.accepted_user_id} is null and ${table.accepted_channel_link_id} is null and ${table.expired_at} is not null and ${table.cancelled_at} is null and ${table.superseded_at} is null)
        or (${table.state} = 'cancelled' and ${table.accepted_at} is null and ${table.accepted_user_id} is null and ${table.accepted_channel_link_id} is null and ${table.expired_at} is null and ${table.cancelled_at} is not null and ${table.superseded_at} is null)
        or (${table.state} = 'superseded' and ${table.accepted_at} is null and ${table.accepted_user_id} is null and ${table.accepted_channel_link_id} is null and ${table.expired_at} is null and ${table.cancelled_at} is null and ${table.superseded_at} is not null)`,
    ),
    uniqueIndex("channel_link_invites_pending_address_unique")
      .on(table.channel_id, table.author_id)
      .where(sql`${table.state} = 'pending'`),
    uniqueIndex("channel_link_invites_token_hash_unique").on(table.token_hash),
    index("channel_link_invites_expiry_index").on(table.state, table.expires_at),
  ],
);

/** Bounded audit evidence for Channel Link identity changes. */
export const channelLinkAuditEvents = pgTable(
  "channel_link_audit_events",
  {
    event_id: text().primaryKey(),
    event_type: text().notNull(),
    actor_id: text().notNull(),
    invite_id: text().references(() => channelLinkInvites.invite_id, { onDelete: "cascade" }),
    channel_link_id: text().references(() => channelLinks.channel_link_id, {
      onDelete: "cascade",
    }),
    user_id: text().references(() => users.id, { onDelete: "cascade" }),
    metadata: jsonb().$type<Readonly<Record<string, string>>>().default({}).notNull(),
    occurred_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "channel_link_audit_events_type_check",
      sql`${table.event_type} in ('invite_issued', 'link_accepted', 'accept_conflict', 'link_revoked')`,
    ),
    check("channel_link_audit_events_actor_check", sql`length(btrim(${table.actor_id})) > 0`),
    index("channel_link_audit_events_invite_index").on(table.invite_id),
    index("channel_link_audit_events_link_index").on(table.channel_link_id),
  ],
);
