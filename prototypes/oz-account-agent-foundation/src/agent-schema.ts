import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const foundationReceipts = sqliteTable("oz_foundation_receipts", {
  accepted: integer("accepted", { mode: "boolean" }).notNull(),
  messageId: text("message_id").primaryKey(),
  recordedAt: integer("recorded_at").notNull(),
  status: text("status").notNull().default("accepted"),
  submissionId: text("submission_id").notNull(),
});

export const reminderDeliveries = sqliteTable("oz_reminder_deliveries", {
  deliveredAt: integer("delivered_at").notNull(),
  reminderId: text("reminder_id").primaryKey(),
  text: text("text").notNull(),
});
