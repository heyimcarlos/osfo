CREATE TABLE `osfo_messenger_acceptance_receipts` (
	`submission_id` text PRIMARY KEY NOT NULL,
	`receipt_json` text NOT NULL,
	`input_digest` text NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `osfo_messenger_receipts_by_session` ON `osfo_messenger_acceptance_receipts` (`session_id`);