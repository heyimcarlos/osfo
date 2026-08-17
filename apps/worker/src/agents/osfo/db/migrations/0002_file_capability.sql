CREATE TABLE `osfo_file_analyses` (
	`allowance_period_id` text NOT NULL,
	`analysis_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`failure` text,
	`file_id` text NOT NULL,
	`prompt` text NOT NULL,
	`result_text` text,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	`vendor_usd_micros` integer,
	FOREIGN KEY (`file_id`) REFERENCES `osfo_files`(`file_id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "osfo_file_analysis_state" CHECK("osfo_file_analyses"."state" IN ('pending', 'ambiguous', 'completed_cleanup_pending', 'failed_cleanup_pending', 'completed', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX `osfo_file_analyses_by_file` ON `osfo_file_analyses` (`file_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `osfo_file_deletions` (
	`action_id` text NOT NULL,
	`analysis_count` integer NOT NULL,
	`deleted_at` text NOT NULL,
	`file_id` text PRIMARY KEY NOT NULL,
	`source_object_key` text NOT NULL,
	`source_sha256` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `osfo_files`(`file_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `osfo_files` (
	`accepted_at` text NOT NULL,
	`allowance_period_id` text NOT NULL,
	`byte_length` integer NOT NULL,
	`deleted_at` text,
	`file_id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`normalization_claimed_at` text,
	`normalization_error` text,
	`normalized_text` text,
	`object_key` text NOT NULL,
	`provenance_json` text,
	`sha256` text NOT NULL,
	`state` text NOT NULL,
	`upload_id` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT "osfo_file_byte_length_positive" CHECK("osfo_files"."byte_length" > 0),
	CONSTRAINT "osfo_file_state" CHECK("osfo_files"."state" IN ('pending_storage', 'stored', 'normalizing', 'ready', 'normalization_failed', 'deleting', 'deleted')),
	CONSTRAINT "osfo_file_normalizing_state" CHECK(("osfo_files"."state" = 'normalizing' AND "osfo_files"."normalization_claimed_at" IS NOT NULL) OR ("osfo_files"."state" != 'normalizing' AND "osfo_files"."normalization_claimed_at" IS NULL)),
	CONSTRAINT "osfo_file_deleted_state" CHECK(("osfo_files"."state" = 'deleted' AND "osfo_files"."deleted_at" IS NOT NULL) OR ("osfo_files"."state" != 'deleted' AND "osfo_files"."deleted_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_files_object_key_unique` ON `osfo_files` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_files_upload_id_unique` ON `osfo_files` (`upload_id`);--> statement-breakpoint
CREATE INDEX `osfo_files_by_owner_state` ON `osfo_files` (`user_id`,`state`);
