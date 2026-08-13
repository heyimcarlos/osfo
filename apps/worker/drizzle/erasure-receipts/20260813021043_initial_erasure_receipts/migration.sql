CREATE TABLE `erasure_commands` (
	`command_id` text PRIMARY KEY,
	`completed_at` text NOT NULL,
	`request_digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `erasure_receipts` (
	`manifest_digest` text NOT NULL,
	`receipt_id` text PRIMARY KEY,
	`recorded_at` text NOT NULL,
	`resource_id` text NOT NULL,
	`scope` text NOT NULL
);
