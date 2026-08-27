CREATE TABLE `osfo_personal_skill_learning_model_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`basis` text NOT NULL,
	`candidate_id` text NOT NULL,
	`model_input_tokens` integer NOT NULL,
	`model_output_tokens` integer NOT NULL,
	`outcome` text NOT NULL,
	`recorded_at_epoch_millis` integer NOT NULL,
	`vendor_usd_micros` integer NOT NULL,
	CONSTRAINT "osfo_personal_skill_learning_model_attempt_nonnegative" CHECK("osfo_personal_skill_learning_model_attempts"."model_input_tokens" >= 0 AND "osfo_personal_skill_learning_model_attempts"."model_output_tokens" >= 0 AND "osfo_personal_skill_learning_model_attempts"."vendor_usd_micros" >= 0)
);
--> statement-breakpoint
CREATE INDEX `osfo_personal_skill_learning_model_attempts_by_candidate` ON `osfo_personal_skill_learning_model_attempts` (`candidate_id`);