CREATE TABLE `osfo_memory_provider_outbox` (
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
	CONSTRAINT "osfo_memory_provider_outbox_operation" CHECK("osfo_memory_provider_outbox"."operation_type" IN ('appendConversationDelta', 'deleteSessionConversation', 'deleteUserKnowledge', 'forgetKnowledge')),
	CONSTRAINT "osfo_memory_provider_outbox_status" CHECK("osfo_memory_provider_outbox"."status" IN ('pending', 'claimed', 'completed')),
	CONSTRAINT "osfo_memory_provider_outbox_attempt_count" CHECK("osfo_memory_provider_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_memory_provider_outbox_sequence_unique` ON `osfo_memory_provider_outbox` (`sequence`);--> statement-breakpoint
CREATE INDEX `osfo_memory_provider_outbox_reconciliation` ON `osfo_memory_provider_outbox` (`status`,`available_at`,`sequence`);--> statement-breakpoint
CREATE INDEX `osfo_memory_provider_outbox_order` ON `osfo_memory_provider_outbox` (`ordering_key`,`sequence`);
