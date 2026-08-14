CREATE TABLE `agents` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`user_id` text PRIMARY KEY,
	CONSTRAINT `fk_agents_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `allowance_periods` (
	`allowance_period_id` text PRIMARY KEY,
	`ends_at` text NOT NULL,
	`plan` text NOT NULL,
	`plan_policy_version` text NOT NULL,
	`starts_at` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_allowance_periods_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `security_audit_facts` (
	`action` text NOT NULL,
	`occurred_at` text NOT NULL,
	`operation_id` text PRIMARY KEY,
	`outcome` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_security_audit_facts_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`created_at` text NOT NULL,
	`plan` text NOT NULL,
	`plan_policy_version` text NOT NULL,
	`subscription_id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_subscriptions_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`created_at` text NOT NULL,
	`registration_id` text NOT NULL,
	`user_id` text PRIMARY KEY
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_agent_id_unique` ON `agents` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `allowance_periods_user_start_unique` ON `allowance_periods` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `allowance_periods_user_end_index` ON `allowance_periods` (`user_id`,`ends_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_id_unique` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_registration_id_unique` ON `users` (`registration_id`);