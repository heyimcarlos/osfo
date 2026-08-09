CREATE TABLE `oz_foundation_receipts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`accepted` integer NOT NULL,
	`recorded_at` integer NOT NULL
);

CREATE TABLE `oz_reminder_deliveries` (
	`reminder_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`delivered_at` integer NOT NULL
);
