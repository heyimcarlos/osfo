CREATE TABLE `osfo_personal_skill_learning_candidates` (
	`attempts` integer DEFAULT 0 NOT NULL,
	`candidate_id` text PRIMARY KEY NOT NULL,
	`candidate_json` text NOT NULL,
	`claim_expires_at_epoch_millis` integer,
	`claim_token` text,
	`created_at_epoch_millis` integer NOT NULL,
	`owner_user_id` text NOT NULL,
	`prior_skill_version` text,
	`status` text NOT NULL,
	`updated_at_epoch_millis` integer NOT NULL,
	CONSTRAINT "osfo_personal_skill_learning_attempts" CHECK("osfo_personal_skill_learning_candidates"."attempts" >= 0),
	CONSTRAINT "osfo_personal_skill_learning_status" CHECK("osfo_personal_skill_learning_candidates"."status" IN ('pending', 'claimed', 'accepted', 'rejected')),
	CONSTRAINT "osfo_personal_skill_learning_claim" CHECK(("osfo_personal_skill_learning_candidates"."status" = 'claimed' AND "osfo_personal_skill_learning_candidates"."claim_token" IS NOT NULL AND "osfo_personal_skill_learning_candidates"."claim_expires_at_epoch_millis" IS NOT NULL) OR ("osfo_personal_skill_learning_candidates"."status" != 'claimed' AND "osfo_personal_skill_learning_candidates"."claim_token" IS NULL AND "osfo_personal_skill_learning_candidates"."claim_expires_at_epoch_millis" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `osfo_personal_skill_learning_by_owner_status` ON `osfo_personal_skill_learning_candidates` (`owner_user_id`,`status`,`created_at_epoch_millis`);--> statement-breakpoint
CREATE TABLE `osfo_personal_skill_versions` (
	`revision` integer NOT NULL,
	`skill_id` text NOT NULL,
	`skill_version` text NOT NULL,
	`version_json` text NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `osfo_personal_skills`(`skill_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_personal_skill_version_revision_positive" CHECK("osfo_personal_skill_versions"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_personal_skill_versions_skill_version_unique` ON `osfo_personal_skill_versions` (`skill_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_personal_skill_version_revision` ON `osfo_personal_skill_versions` (`skill_id`,`revision`);--> statement-breakpoint
CREATE TABLE `osfo_personal_skills` (
	`current_revision` integer NOT NULL,
	`current_skill_version` text NOT NULL,
	`last_used_at_epoch_millis` integer,
	`owner_user_id` text NOT NULL,
	`skill_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT "osfo_personal_skill_revision_positive" CHECK("osfo_personal_skills"."current_revision" > 0),
	CONSTRAINT "osfo_personal_skill_status" CHECK("osfo_personal_skills"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_personal_skills_current_skill_version_unique` ON `osfo_personal_skills` (`current_skill_version`);--> statement-breakpoint
CREATE INDEX `osfo_personal_skills_by_owner_status` ON `osfo_personal_skills` (`owner_user_id`,`status`);