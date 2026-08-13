import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  DeletionManifestDigest,
  DirectoryCommandId,
  DirectoryRequestDigest,
  DirectoryTimestamp,
  ErasedResourceId,
  ErasureReceiptId,
  ErasureScope,
} from "./directory-model";

/** Idempotency records stored with the independent Erasure Receipt ledger. */
export const erasureCommands = sqliteTable("erasure_commands", {
  commandId: text("command_id").$type<DirectoryCommandId>().notNull().primaryKey(),
  completedAt: text("completed_at").$type<DirectoryTimestamp>().notNull(),
  requestDigest: text("request_digest").$type<DirectoryRequestDigest>().notNull(),
});

/** Content-free deletion facts stored outside the directory restore target. */
export const erasureReceipts = sqliteTable("erasure_receipts", {
  manifestDigest: text("manifest_digest").$type<DeletionManifestDigest>().notNull(),
  receiptId: text("receipt_id").$type<ErasureReceiptId>().notNull().primaryKey(),
  recordedAt: text("recorded_at").$type<DirectoryTimestamp>().notNull(),
  resourceId: text("resource_id").$type<ErasedResourceId>().notNull(),
  scope: text("scope", {
    enum: ["account_deletion", "message_redaction", "source_deletion", "thread_reset"],
  })
    .$type<ErasureScope>()
    .notNull(),
});
