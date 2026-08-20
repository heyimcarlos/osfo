import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Finite-lived web or messaging-provider invitations used only during onboarding. */
export const registrationInvitations = pgTable(
  "registration_invitations",
  {
    invitation_id: text().primaryKey(),
    token_digest: text().notNull().unique(),
    kind: text().default("whatsapp_first").notNull(),
    provider: text().notNull(),
    provider_event_id: text(),
    channel_identity: text(),
    invited_phone_number: text(),
    locale: text().notNull(),
    state: text().default("live").notNull(),
    expiry_reason: text(),
    consumption_digest: text(),
    binding_outcome: text(),
    channel_binding_id: text(),
    user_id: text().references(() => users.id, { onDelete: "cascade" }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp({ withTimezone: true }).notNull(),
    consumed_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    check(
      "registration_invitations_provider_check",
      sql`${table.provider} in ('telegram', 'whatsapp')`,
    ),
    check(
      "registration_invitations_kind_check",
      sql`${table.kind} in ('telegram_first', 'whatsapp_first', 'web_enrollment')`,
    ),
    check(
      "registration_invitations_state_check",
      sql`${table.state} in ('live', 'consumed', 'expired')`,
    ),
    check(
      "registration_invitations_expiry_reason_check",
      sql`(${table.state} = 'expired' and ${table.expiry_reason} in ('elapsed', 'replaced')) or (${table.state} <> 'expired' and ${table.expiry_reason} is null)`,
    ),
    check(
      "registration_invitations_consumption_digest_check",
      sql`(${table.state} = 'consumed' and ${table.consumption_digest} is not null) or (${table.state} <> 'consumed' and ${table.consumption_digest} is null)`,
    ),
    check(
      "registration_invitations_binding_outcome_check",
      sql`${table.binding_outcome} is null or ${table.binding_outcome} in ('created', 'existing', 'refused')`,
    ),
    check(
      "registration_invitations_binding_receipt_check",
      sql`(${table.binding_outcome} in ('created', 'existing') and ${table.channel_binding_id} is not null) or (${table.binding_outcome} = 'refused' and ${table.channel_binding_id} is null) or (${table.binding_outcome} is null and ${table.channel_binding_id} is null)`,
    ),
    check(
      "registration_invitations_lifecycle_check",
      sql`(${table.state} = 'live' and ${table.consumed_at} is null) or (${table.state} = 'consumed' and ${table.consumed_at} is not null) or (${table.state} = 'expired' and ${table.consumed_at} is null)`,
    ),
    check("registration_invitations_expiry_check", sql`${table.created_at} < ${table.expires_at}`),
    index("registration_invitations_expiry_index").on(table.state, table.expires_at),
    uniqueIndex("registration_invitations_provider_event_unique")
      .on(table.provider, table.provider_event_id)
      .where(sql`${table.provider_event_id} is not null`),
    uniqueIndex("registration_invitations_live_channel_unique")
      .on(table.provider, table.channel_identity)
      .where(sql`${table.state} = 'live' and ${table.channel_identity} is not null`),
    uniqueIndex("registration_invitations_live_web_user_unique")
      .on(table.user_id, table.kind)
      .where(
        sql`${table.state} = 'live' and ${table.kind} = 'web_enrollment' and ${table.user_id} is not null`,
      ),
  ],
);

/** Revocable associations between provider identities and registered Users. */
export const channelBindings = pgTable(
  "channel_bindings",
  {
    channel_binding_id: text().primaryKey(),
    provider: text().notNull(),
    channel_identity: text().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    check("channel_bindings_provider_check", sql`${table.provider} in ('telegram', 'whatsapp')`),
    uniqueIndex("channel_bindings_active_identity_unique")
      .on(table.provider, table.channel_identity)
      .where(sql`${table.revoked_at} is null`),
    uniqueIndex("channel_bindings_active_user_unique")
      .on(table.provider, table.user_id)
      .where(sql`${table.revoked_at} is null`),
    index("channel_bindings_user_index").on(table.user_id),
  ],
);
