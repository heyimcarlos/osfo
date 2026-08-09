CREATE TABLE `activation_audit` (
	`activation_count` integer DEFAULT 0 NOT NULL,
	`agent_id` text PRIMARY KEY,
	`last_activated_at` integer NOT NULL,
	`last_activation_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_bindings` (
	`agent_id` text NOT NULL,
	`channel_identity` text PRIMARY KEY,
	`created_at` integer NOT NULL
);
