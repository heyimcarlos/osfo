CREATE TABLE `osfo_acceptance_receipts` (
	`accepted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`allowance_period_id` text NOT NULL,
	`channel_binding_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`receipt_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`think_submission_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_acceptance_receipts_think_submission_id_unique` ON `osfo_acceptance_receipts` (`think_submission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_acceptance_receipts_user_message_id_unique` ON `osfo_acceptance_receipts` (`user_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_acceptance_receipt_channel_message_unique` ON `osfo_acceptance_receipts` (`channel_binding_id`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `osfo_acceptance_receipts_by_session` ON `osfo_acceptance_receipts` (`session_id`,`accepted_at`);