CREATE TABLE `osfo_good_root_outcome_evaluations` (
	`evaluation_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`receipt_json` text NOT NULL,
	`retained_at_epoch_millis` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `osfo_good_root_outcome_evaluations_by_owner` ON `osfo_good_root_outcome_evaluations` (`owner_user_id`,`retained_at_epoch_millis`);