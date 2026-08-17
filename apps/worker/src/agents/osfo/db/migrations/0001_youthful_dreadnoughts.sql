CREATE TABLE `osfo_model_call_usage_evidence` (
	`allowance_period_id` text NOT NULL,
	`attempt_id` text PRIMARY KEY NOT NULL,
	`dispatched_at` text,
	`items_json` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `osfo_model_call_usage_pending` ON `osfo_model_call_usage_evidence` (`recorded_at`) WHERE "osfo_model_call_usage_evidence"."dispatched_at" IS NULL;