import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { accounts, users } from "./auth";

/** One revocable User-owned Gmail Integration Connection. */
export const gmailConnections = pgTable(
  "gmail_connections",
  {
    connectionId: text("connection_id").notNull().primaryKey(),
    credentialReference: text("credential_reference").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.credentialReference, table.userId, table.providerAccountId],
      foreignColumns: [accounts.id, accounts.userId, accounts.accountId],
      name: "gmail_connections_owned_account_fk",
    }).onDelete("cascade"),
    uniqueIndex("gmail_connections_user_unique").on(table.userId),
    uniqueIndex("gmail_connections_provider_account_unique").on(table.providerAccountId),
    index("gmail_connections_user_revoked_index").on(table.userId, table.revokedAt),
    check(
      "gmail_connections_grant_before_revocation_check",
      sql`${table.revokedAt} is null or ${table.grantedAt} <= ${table.revokedAt}`,
    ),
  ],
);

/** Gmail provider recovery evidence keyed by the existing Think Action identity. */
export const gmailSendAttempts = pgTable(
  "gmail_send_attempts",
  {
    actionId: text("action_id").notNull().primaryKey(),
    connectionId: text("connection_id").notNull(),
    contactedAt: timestamp("contacted_at", { withTimezone: true }),
    outcome: text("outcome").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("gmail_send_attempts_connection_index").on(table.connectionId),
    check(
      "gmail_send_attempts_outcome_check",
      sql`${table.outcome} in ('pending', 'applied', 'notApplied', 'ambiguous')`,
    ),
    check(
      "gmail_send_attempts_terminal_contact_check",
      sql`${table.outcome} = 'pending' or ${table.contactedAt} is not null`,
    ),
  ],
);
