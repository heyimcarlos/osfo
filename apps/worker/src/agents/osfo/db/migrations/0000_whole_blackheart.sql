CREATE TABLE `osfo_agent_initialization` (
	`agent_id` text NOT NULL,
	`initialization_id` text NOT NULL,
	`initialized_at` text NOT NULL,
	`singleton_key` text PRIMARY KEY NOT NULL,
	CONSTRAINT "osfo_agent_initialization_singleton" CHECK("osfo_agent_initialization"."singleton_key" = 'agent')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_agent_initialization_agent_id_unique` ON `osfo_agent_initialization` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_agent_initialization_initialization_id_unique` ON `osfo_agent_initialization` (`initialization_id`);--> statement-breakpoint
CREATE TABLE `osfo_committed_turns` (
	`assistant_message_id` text PRIMARY KEY NOT NULL,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`session_id` text NOT NULL,
	`source` text NOT NULL,
	`think_request_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "osfo_committed_turn_source" CHECK("osfo_committed_turns"."source" IN ('hook', 'reconciliation'))
);
--> statement-breakpoint
CREATE INDEX `osfo_committed_turns_by_session` ON `osfo_committed_turns` (`session_id`,`assistant_message_id`);--> statement-breakpoint
CREATE TABLE `osfo_conversation_routes` (
	`is_primary` integer NOT NULL,
	`route_id` text PRIMARY KEY NOT NULL,
	CONSTRAINT "osfo_conversation_route_primary_boolean" CHECK("osfo_conversation_routes"."is_primary" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_one_primary_route` ON `osfo_conversation_routes` (`is_primary`) WHERE "osfo_conversation_routes"."is_primary" = 1;--> statement-breakpoint
CREATE TABLE `osfo_session_ownership` (
	`became_current_at` text NOT NULL,
	`replaced_at` text,
	`route_id` text NOT NULL,
	`session_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `osfo_conversation_routes`(`route_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_one_current_session_per_route` ON `osfo_session_ownership` (`route_id`) WHERE "osfo_session_ownership"."replaced_at" IS NULL;--> statement-breakpoint
CREATE INDEX `osfo_sessions_by_route` ON `osfo_session_ownership` (`route_id`,`became_current_at`);