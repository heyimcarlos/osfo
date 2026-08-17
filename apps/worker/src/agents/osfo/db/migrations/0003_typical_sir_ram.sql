CREATE TABLE `osfo_session_command_receipts` (
	`accepted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`allowance_period_id` text NOT NULL,
	`channel_binding_id` text NOT NULL,
	`command` text NOT NULL,
	`current_session_id` text NOT NULL,
	`historical_session_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`receipt_id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	FOREIGN KEY (`current_session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`historical_session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`route_id`) REFERENCES `osfo_conversation_routes`(`route_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_session_command_receipts_user_message_id_unique` ON `osfo_session_command_receipts` (`user_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_session_command_receipt_channel_message_unique` ON `osfo_session_command_receipts` (`channel_binding_id`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `osfo_session_command_receipts_by_route` ON `osfo_session_command_receipts` (`route_id`,`accepted_at`);--> statement-breakpoint
CREATE TABLE `osfo_session_recall_cursors` (
	`after_ownership_sequence` integer,
	`cursor` text PRIMARY KEY NOT NULL,
	`expires_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes')) NOT NULL,
	`route_id` text NOT NULL,
	`snapshot_current_session_id` text NOT NULL,
	`snapshot_max_ownership_sequence` integer NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `osfo_conversation_routes`(`route_id`) ON UPDATE restrict ON DELETE cascade,
	FOREIGN KEY (`snapshot_current_session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `osfo_session_recall_cursors_by_expiry` ON `osfo_session_recall_cursors` (`expires_at`);--> statement-breakpoint
DROP INDEX `osfo_sessions_by_route`;--> statement-breakpoint
ALTER TABLE `osfo_session_ownership` ADD `ownership_sequence` integer;--> statement-breakpoint
UPDATE `osfo_session_ownership` SET `ownership_sequence` = `_rowid_` WHERE `ownership_sequence` IS NULL;--> statement-breakpoint
CREATE TRIGGER `osfo_session_ownership_sequence_required_insert`
BEFORE INSERT ON `osfo_session_ownership`
WHEN NEW.`ownership_sequence` IS NULL OR NEW.`ownership_sequence` <= 0
BEGIN
	SELECT RAISE(ABORT, 'ownership_sequence must be positive');
END;--> statement-breakpoint
CREATE TRIGGER `osfo_session_ownership_sequence_immutable_update`
BEFORE UPDATE OF `ownership_sequence` ON `osfo_session_ownership`
WHEN NEW.`ownership_sequence` IS NULL OR NEW.`ownership_sequence` <= 0 OR NEW.`ownership_sequence` <> OLD.`ownership_sequence`
BEGIN
	SELECT RAISE(ABORT, 'ownership_sequence is positive and immutable');
END;--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_session_ownership_ownership_sequence_unique` ON `osfo_session_ownership` (`ownership_sequence`);--> statement-breakpoint
CREATE INDEX `osfo_sessions_by_route` ON `osfo_session_ownership` (`route_id`,`ownership_sequence`);
