PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_osfo_memory_provider_outbox` (
	`allowance_period_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`claim_expires_at` text,
	`claim_token` text,
	`completed_at` text,
	`enqueued_at` text NOT NULL,
	`last_error` text,
	`operation_type` text NOT NULL,
	`ordering_key` text NOT NULL,
	`outbox_id` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`provider_applied_at` text,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`usage_json` text,
	CONSTRAINT "osfo_memory_provider_outbox_operation" CHECK("__new_osfo_memory_provider_outbox"."operation_type" IN ('saveConversation', 'deleteSessionConversation', 'deleteUserKnowledge', 'forgetKnowledge')),
	CONSTRAINT "osfo_memory_provider_outbox_status" CHECK("__new_osfo_memory_provider_outbox"."status" IN ('pending', 'claimed', 'completed')),
	CONSTRAINT "osfo_memory_provider_outbox_attempt_count" CHECK("__new_osfo_memory_provider_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
-- Conversation deltas cannot be reinterpreted as v4 snapshots; the pre-launch cutover discards them.
INSERT INTO `__new_osfo_memory_provider_outbox`("allowance_period_id", "attempt_count", "available_at", "claim_expires_at", "claim_token", "completed_at", "enqueued_at", "last_error", "operation_type", "ordering_key", "outbox_id", "payload_json", "provider_applied_at", "sequence", "status", "usage_json") SELECT "allowance_period_id", "attempt_count", "available_at", "claim_expires_at", "claim_token", "completed_at", "enqueued_at", "last_error", "operation_type", "ordering_key", "outbox_id", "payload_json", "provider_applied_at", "sequence", "status", "usage_json" FROM `osfo_memory_provider_outbox` WHERE "operation_type" <> 'appendConversationDelta';--> statement-breakpoint
DROP TABLE `osfo_memory_provider_outbox`;--> statement-breakpoint
ALTER TABLE `__new_osfo_memory_provider_outbox` RENAME TO `osfo_memory_provider_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_memory_provider_outbox_sequence_unique` ON `osfo_memory_provider_outbox` (`sequence`);--> statement-breakpoint
CREATE INDEX `osfo_memory_provider_outbox_reconciliation` ON `osfo_memory_provider_outbox` (`status`,`available_at`,`sequence`);--> statement-breakpoint
CREATE INDEX `osfo_memory_provider_outbox_order` ON `osfo_memory_provider_outbox` (`ordering_key`,`sequence`);
