import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./auth";

/** Current trusted authority for one v1 administrator. Missing and revoked records fail closed. */
export const administrativeAuthorities = pgTable(
  "administrative_authorities",
  {
    admin_actor_id: text().primaryKey(),
    granted_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    check(
      "administrative_authorities_actor_check",
      sql`length(btrim(${table.admin_actor_id})) > 0`,
    ),
  ],
);

/** Append-only administrative suspension and restoration history. */
export const userSuspensionEvents = pgTable(
  "user_suspension_events",
  {
    event_id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text().notNull(),
    admin_actor_id: text().notNull(),
    reason: text().notNull(),
    occurred_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("user_suspension_events_action_check", sql`${table.action} in ('suspended', 'restored')`),
    check("user_suspension_events_actor_check", sql`length(btrim(${table.admin_actor_id})) > 0`),
    check("user_suspension_events_reason_check", sql`length(btrim(${table.reason})) > 0`),
    index("user_suspension_events_user_order_index").on(
      table.user_id,
      table.occurred_at,
      table.event_id,
    ),
  ],
);

/** One User- or administrator-requested deletion that immediately ends User access. */
export const deletionCases = pgTable(
  "deletion_cases",
  {
    deletion_case_id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requested_by_admin_id: text().references(() => administrativeAuthorities.admin_actor_id),
    requested_by_user_id: text().references(() => users.id, { onDelete: "cascade" }),
    approval_action_id: text(),
    approval_presentation: text(),
    access_fenced_at: timestamp({ withTimezone: true }),
    integration_targets: jsonb().default([]).notNull(),
    reason: text().notNull(),
    requested_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("deletion_cases_user_unique").on(table.user_id),
    uniqueIndex("deletion_cases_identity_unique").on(table.deletion_case_id, table.user_id),
    check(
      "deletion_cases_actor_check",
      sql`(${table.requested_by_admin_id} is not null and length(btrim(${table.requested_by_admin_id})) > 0 and ${table.requested_by_user_id} is null and ${table.approval_action_id} is null and ${table.approval_presentation} is null)
        or (${table.requested_by_admin_id} is null and ${table.requested_by_user_id} is not null and ${table.requested_by_user_id} = ${table.user_id} and ${table.approval_action_id} is not null and length(btrim(${table.approval_action_id})) > 0 and ${table.approval_presentation} is not null and length(btrim(${table.approval_presentation})) > 0)`,
    ),
    check("deletion_cases_reason_check", sql`length(btrim(${table.reason})) > 0`),
  ],
);

/** One expiring server-owned capability for approving self-service account deletion. */
export const accountDeletionActions = pgTable(
  "account_deletion_actions",
  {
    action_id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    auth_session_id: text().notNull(),
    presentation: text().notNull(),
    presentation_version: text().notNull(),
    expires_at: timestamp({ withTimezone: true }).notNull(),
    consumed_at: timestamp({ withTimezone: true }),
    deletion_case_id: text(),
    invalidated_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("account_deletion_actions_user_index").on(table.user_id),
    foreignKey({
      columns: [table.deletion_case_id, table.user_id],
      foreignColumns: [deletionCases.deletion_case_id, deletionCases.user_id],
      name: "account_deletion_actions_case_user_fk",
    }),
    check(
      "account_deletion_actions_identity_check",
      sql`length(btrim(${table.action_id})) > 0 and length(btrim(${table.auth_session_id})) > 0`,
    ),
    check(
      "account_deletion_actions_presentation_check",
      sql`length(btrim(${table.presentation})) > 0 and length(btrim(${table.presentation_version})) > 0`,
    ),
    check(
      "account_deletion_actions_lifecycle_check",
      sql`${table.expires_at} > ${table.created_at}
        and (${table.consumed_at} is null or ${table.consumed_at} >= ${table.created_at})
        and (${table.invalidated_at} is null or ${table.invalidated_at} >= ${table.created_at})
        and (${table.consumed_at} is null or ${table.invalidated_at} is null)
        and ((${table.consumed_at} is null and ${table.deletion_case_id} is null)
          or (${table.consumed_at} is not null and ${table.deletion_case_id} is not null and length(btrim(${table.deletion_case_id})) > 0))`,
    ),
  ],
);
