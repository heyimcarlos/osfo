import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Finite-lived web or WhatsApp invitations used only during onboarding. */
export const registrationInvitations = pgTable(
  "registration_invitations",
  {
    invitationId: text("invitation_id").primaryKey(),
    tokenDigest: text("token_digest").notNull().unique(),
    kind: text("kind").default("whatsapp_first").notNull(),
    provider: text("provider").notNull(),
    channelIdentity: text("channel_identity"),
    invitedPhoneNumber: text("invited_phone_number"),
    locale: text("locale").notNull(),
    state: text("state").default("live").notNull(),
    expiryReason: text("expiry_reason"),
    consumptionDigest: text("consumption_digest"),
    bindingOutcome: text("binding_outcome"),
    channelBindingId: text("channel_binding_id"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    check("registration_invitations_provider_check", sql`${table.provider} = 'whatsapp'`),
    check(
      "registration_invitations_kind_check",
      sql`${table.kind} in ('whatsapp_first', 'web_enrollment')`,
    ),
    check(
      "registration_invitations_state_check",
      sql`${table.state} in ('live', 'consumed', 'expired')`,
    ),
    check(
      "registration_invitations_expiry_reason_check",
      sql`(${table.state} = 'expired' and ${table.expiryReason} in ('elapsed', 'replaced')) or (${table.state} <> 'expired' and ${table.expiryReason} is null)`,
    ),
    check(
      "registration_invitations_consumption_digest_check",
      sql`(${table.state} = 'consumed' and ${table.consumptionDigest} is not null) or (${table.state} <> 'consumed' and ${table.consumptionDigest} is null)`,
    ),
    check(
      "registration_invitations_binding_outcome_check",
      sql`${table.bindingOutcome} is null or ${table.bindingOutcome} in ('created', 'existing', 'refused')`,
    ),
    check(
      "registration_invitations_binding_receipt_check",
      sql`(${table.bindingOutcome} in ('created', 'existing') and ${table.channelBindingId} is not null) or (${table.bindingOutcome} = 'refused' and ${table.channelBindingId} is null) or (${table.bindingOutcome} is null and ${table.channelBindingId} is null)`,
    ),
    check(
      "registration_invitations_lifecycle_check",
      sql`(${table.state} = 'live' and ${table.consumedAt} is null) or (${table.state} = 'consumed' and ${table.consumedAt} is not null) or (${table.state} = 'expired' and ${table.consumedAt} is null)`,
    ),
    check("registration_invitations_expiry_check", sql`${table.createdAt} < ${table.expiresAt}`),
    index("registration_invitations_expiry_index").on(table.state, table.expiresAt),
    uniqueIndex("registration_invitations_live_channel_unique")
      .on(table.provider, table.channelIdentity)
      .where(sql`${table.state} = 'live' and ${table.channelIdentity} is not null`),
    uniqueIndex("registration_invitations_live_web_user_unique")
      .on(table.userId, table.kind)
      .where(
        sql`${table.state} = 'live' and ${table.kind} = 'web_enrollment' and ${table.userId} is not null`,
      ),
  ],
);

/** Revocable associations between provider identities and registered Users. */
export const channelBindings = pgTable(
  "channel_bindings",
  {
    channelBindingId: text("channel_binding_id").primaryKey(),
    provider: text("provider").notNull(),
    channelIdentity: text("channel_identity").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check("channel_bindings_provider_check", sql`${table.provider} = 'whatsapp'`),
    uniqueIndex("channel_bindings_active_identity_unique")
      .on(table.provider, table.channelIdentity)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex("channel_bindings_active_user_unique")
      .on(table.provider, table.userId)
      .where(sql`${table.revokedAt} is null`),
    index("channel_bindings_user_index").on(table.userId),
  ],
);
