import { sql } from "drizzle-orm";
import { check, index, primaryKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { channelBindings } from "./onboarding";

/** Provider-global inbound identities recorded before Channel Binding resolution. */
export const inboundWhatsAppEvents = pgTable(
  "inbound_whatsapp_events",
  {
    bindingResolvedAt: timestamp("binding_resolved_at", { withTimezone: true }),
    channelIdentity: text("channel_identity").notNull(),
    contentDigest: text("content_digest").notNull(),
    messageKind: text("message_kind").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedChannelBindingId: text("resolved_channel_binding_id").references(
      () => channelBindings.channelBindingId,
      { onDelete: "restrict" },
    ),
  },
  (table) => [
    primaryKey({ columns: [table.phoneNumberId, table.providerMessageId] }),
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
