CREATE TABLE `osfo_web_operations` (
	`created_at_epoch_millis` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`kind` text NOT NULL,
	`operation_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`reserved_pages` integer NOT NULL,
	`result_json` text,
	`status` text NOT NULL,
	`turn_id` text NOT NULL,
	CONSTRAINT "osfo_web_operation_kind" CHECK("osfo_web_operations"."kind" IN ('page', 'search')),
	CONSTRAINT "osfo_web_operation_status" CHECK("osfo_web_operations"."status" IN ('pending', 'completed')),
	CONSTRAINT "osfo_web_operation_completion" CHECK(("osfo_web_operations"."status" = 'completed' AND "osfo_web_operations"."result_json" IS NOT NULL) OR ("osfo_web_operations"."status" = 'pending' AND "osfo_web_operations"."result_json" IS NULL)),
	CONSTRAINT "osfo_web_operation_pages" CHECK("osfo_web_operations"."reserved_pages" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE INDEX `osfo_web_operations_by_turn` ON `osfo_web_operations` (`owner_user_id`,`turn_id`,`status`);--> statement-breakpoint
CREATE TABLE `osfo_web_results` (
	`owner_user_id` text NOT NULL,
	`rank` integer NOT NULL,
	`result_id` text PRIMARY KEY NOT NULL,
	`result_json` text NOT NULL,
	`result_set_id` text NOT NULL,
	`retained_at_epoch_millis` integer NOT NULL,
	CONSTRAINT "osfo_web_result_rank" CHECK("osfo_web_results"."rank" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE INDEX `osfo_web_results_by_owner_set` ON `osfo_web_results` (`owner_user_id`,`retained_at_epoch_millis`,`result_set_id`);
