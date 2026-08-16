CREATE TABLE `osfo_action_presentations` (
	`action_definition_version` text NOT NULL,
	`action_digest` text NOT NULL,
	`action_id` text NOT NULL,
	`consequences_json` text NOT NULL,
	`created_at` text NOT NULL,
	`description` text NOT NULL,
	`execution_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`fields_json` text NOT NULL,
	`operation` text NOT NULL,
	`originating_authority_id` text NOT NULL,
	`originating_authority_kind` text NOT NULL,
	`presentation_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT "osfo_action_presentation_authority_kind" CHECK("osfo_action_presentations"."originating_authority_kind" IN ('authSession', 'channelBinding', 'scheduledTask', 'workflow')),
	CONSTRAINT "osfo_action_presentation_expiry_after_creation" CHECK(julianday("osfo_action_presentations"."expires_at") > julianday("osfo_action_presentations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_action_presentations_action_id_unique` ON `osfo_action_presentations` (`action_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_action_presentations_execution_id_unique` ON `osfo_action_presentations` (`execution_id`);--> statement-breakpoint
CREATE INDEX `osfo_action_presentations_by_user` ON `osfo_action_presentations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `osfo_approval_requests` (
	`actor_authority_id` text,
	`actor_authority_kind` text,
	`approval_request_id` text NOT NULL,
	`decided_at` text,
	`dispatch_ambiguous_at` text,
	`dispatched_at` text,
	`presentation_id` text PRIMARY KEY NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	FOREIGN KEY (`presentation_id`) REFERENCES `osfo_action_presentations`(`presentation_id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "osfo_approval_request_status" CHECK("osfo_approval_requests"."status" IN ('pending', 'approved', 'denied', 'expired', 'canceled')),
	CONSTRAINT "osfo_approval_request_terminal_facts" CHECK(("osfo_approval_requests"."status" = 'pending' AND "osfo_approval_requests"."decided_at" IS NULL AND "osfo_approval_requests"."dispatch_ambiguous_at" IS NULL AND "osfo_approval_requests"."dispatched_at" IS NULL AND "osfo_approval_requests"."actor_authority_kind" IS NULL AND "osfo_approval_requests"."actor_authority_id" IS NULL)
        OR ("osfo_approval_requests"."status" IN ('approved', 'denied') AND "osfo_approval_requests"."decided_at" IS NOT NULL AND "osfo_approval_requests"."actor_authority_kind" IS NOT NULL AND "osfo_approval_requests"."actor_authority_id" IS NOT NULL)
        OR ("osfo_approval_requests"."status" IN ('expired', 'canceled') AND "osfo_approval_requests"."decided_at" IS NOT NULL AND "osfo_approval_requests"."actor_authority_kind" IS NULL AND "osfo_approval_requests"."actor_authority_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_approval_requests_approval_request_id_unique` ON `osfo_approval_requests` (`approval_request_id`);--> statement-breakpoint
CREATE INDEX `osfo_approval_requests_by_status` ON `osfo_approval_requests` (`status`);--> statement-breakpoint
CREATE TABLE `osfo_model_call_usage_evidence` (
	`allowance_period_id` text NOT NULL,
	`attempt_id` text PRIMARY KEY NOT NULL,
	`dispatched_at` text,
	`items_json` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `osfo_model_call_usage_pending` ON `osfo_model_call_usage_evidence` (`recorded_at`) WHERE "osfo_model_call_usage_evidence"."dispatched_at" IS NULL;