import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { channelLinks } from "./channel-links";

/** One privacy-safe latch asking a WhatsApp User to return for committed work. */
export const whatsappWakeups = pgTable(
  "whatsapp_wakeups",
  {
    wakeup_id: text().primaryKey(),
    fingerprint: text().notNull(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel_link_id: text()
      .notNull()
      .references(() => channelLinks.channel_link_id, { onDelete: "cascade" }),
    endpoint_fingerprint: text().notNull(),
    source_kind: text().notNull(),
    source_identity: text().notNull(),
    source_committed_at: timestamp({ withTimezone: true }).notNull(),
    locale: text().notNull(),
    template_policy_version: text().notNull(),
    state: text().default("pending").notNull(),
    provider_outcome: text(),
    provider_message_id_hash: text(),
    safe_failure_class: text(),
    trace_id: text().notNull(),
    lease_id: text(),
    lease_expires_at: timestamp({ withTimezone: true }),
    requested_at: timestamp({ withTimezone: true }),
    settled_at: timestamp({ withTimezone: true }),
    consume_requested_at: timestamp({ withTimezone: true }),
    consumed_at: timestamp({ withTimezone: true }),
    canceled_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "whatsapp_wakeups_identity_check",
      sql`length(btrim(${table.wakeup_id})) > 0
        and ${table.fingerprint} ~ '^[0-9a-f]{64}$'
        and ${table.endpoint_fingerprint} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.source_identity})) > 0
        and length(btrim(${table.template_policy_version})) > 0
        and length(btrim(${table.trace_id})) > 0`,
    ),
    check(
      "whatsapp_wakeups_source_kind_check",
      sql`${table.source_kind} in ('reminder', 'researchReport', 'documentBuild', 'scheduledEmail')`,
    ),
    check("whatsapp_wakeups_locale_check", sql`${table.locale} in ('en', 'es')`),
    check(
      "whatsapp_wakeups_state_check",
      sql`${table.state} in ('pending', 'requested', 'accepted', 'rejected', 'ambiguous', 'consumed', 'canceled')`,
    ),
    check(
      "whatsapp_wakeups_provider_outcome_check",
      sql`${table.provider_outcome} is null or ${table.provider_outcome} in ('accepted', 'rejected', 'ambiguous')`,
    ),
    check(
      "whatsapp_wakeups_failure_class_check",
      sql`${table.safe_failure_class} is null or ${table.safe_failure_class} in ('providerRejected', 'providerTimeout', 'connectionLost', 'malformedSuccess', 'authorityLost', 'sourceCanceled', 'endpointSuspended', 'accountDeletion', 'inboundBeforeSend')`,
    ),
    check(
      "whatsapp_wakeups_lease_check",
      sql`(${table.lease_id} is null and ${table.lease_expires_at} is null)
        or (${table.state} = 'pending' and ${table.lease_id} is not null and length(btrim(${table.lease_id})) > 0 and ${table.lease_expires_at} is not null)`,
    ),
    check(
      "whatsapp_wakeups_lifecycle_check",
      sql`(${table.state} = 'pending'
          and ${table.provider_outcome} is null and ${table.requested_at} is null
          and ${table.settled_at} is null and ${table.consumed_at} is null and ${table.canceled_at} is null)
        or (${table.state} = 'requested'
          and ${table.provider_outcome} is null and ${table.requested_at} is not null
          and ${table.settled_at} is null and ${table.consumed_at} is null and ${table.canceled_at} is null)
        or (${table.state} in ('accepted', 'ambiguous')
          and ${table.provider_outcome} = ${table.state} and ${table.requested_at} is not null
          and ${table.settled_at} is not null and ${table.consumed_at} is null and ${table.canceled_at} is null)
        or (${table.state} = 'rejected'
          and ${table.provider_outcome} = 'rejected' and ${table.safe_failure_class} = 'providerRejected'
          and ${table.requested_at} is not null and ${table.settled_at} is not null
          and ${table.consumed_at} is null and ${table.canceled_at} is null)
        or (${table.state} = 'consumed'
          and ${table.consumed_at} is not null and ${table.canceled_at} is null
          and (${table.provider_outcome} is null or ${table.provider_outcome} in ('accepted', 'ambiguous')))
        or (${table.state} = 'canceled'
          and ${table.consumed_at} is null and ${table.canceled_at} is not null
          and (${table.provider_outcome} is null or ${table.provider_outcome} in ('accepted', 'ambiguous')))`,
    ),
    uniqueIndex("whatsapp_wakeups_active_user_unique")
      .on(table.user_id)
      .where(sql`${table.state} in ('pending', 'requested', 'accepted', 'ambiguous')`),
    index("whatsapp_wakeups_pending_lease_index").on(
      table.state,
      table.lease_expires_at,
      table.created_at,
    ),
    index("whatsapp_wakeups_channel_link_index").on(table.channel_link_id, table.state),
  ],
);
