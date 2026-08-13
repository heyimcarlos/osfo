CREATE TABLE `denial_facts` (
	`denial_fact_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`resource_id` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_denial_facts_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `denial_facts_user_occurred_index` ON `denial_facts` (`user_id`,`occurred_at`);