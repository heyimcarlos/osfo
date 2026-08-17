import { sql } from "drizzle-orm";
import { check, index, primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { channelBindings } from "./onboarding";

/** Provider-global inbound identities recorded before Channel Binding resolution. */
export const inboundProviderEvents = pgTable(
  "inbound_whatsapp_events",
  {
    bindingResolvedAt: timestamp("binding_resolved_at", { withTimezone: true }),
    channelIdentity: text("channel_identity").notNull(),
    contentDigest: text("content_digest").notNull(),
    messageKind: text("message_kind").notNull(),
    eventScope: text("phone_number_id").notNull(),
    provider: text("provider").default("whatsapp").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedChannelBindingId: text("resolved_channel_binding_id").references(
      () => channelBindings.channelBindingId,
      { onDelete: "restrict" },
    ),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.eventScope, table.providerMessageId] }),
    check(
      "inbound_provider_events_provider_check",
      sql`${table.provider} in ('telegram', 'whatsapp')`,
    ),
    check(
      "inbound_whatsapp_events_message_kind_check",
      sql`${table.messageKind} in ('text', 'button_reply')`,
    ),
    check(
      "inbound_whatsapp_events_resolution_check",
      sql`${table.bindingResolvedAt} is not null or ${table.resolvedChannelBindingId} is null`,
    ),
    index("inbound_whatsapp_events_binding_index").on(table.resolvedChannelBindingId),
  ],
);

/** @deprecated Use the provider-neutral inbound event receipt. */
export const inboundWhatsAppEvents = inboundProviderEvents;
