ALTER TABLE `osfo_personal_skill_learning_candidates` ADD `accepted_skill_version` text;--> statement-breakpoint
ALTER TABLE `osfo_personal_skill_learning_candidates` ADD `notification_delivered_at_epoch_millis` integer;--> statement-breakpoint
ALTER TABLE `osfo_personal_skill_learning_candidates` ADD `notification_text` text;--> statement-breakpoint
ALTER TABLE `osfo_personal_skill_learning_candidates` ADD `undo_target_skill_version` text;