CREATE TABLE `osfo_qualification_admissions` (
	`acceptance_receipt_id` text NOT NULL,
	`admission_decision` text NOT NULL,
	`agent_id` text NOT NULL,
	`artifact_checksum` text NOT NULL,
	`attempt_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`plan_checksum` text NOT NULL,
	`product_fact_id` text NOT NULL,
	`root_id` text NOT NULL,
	`run_id` text NOT NULL,
	`think_submission_id` text,
	`user_message_id` text NOT NULL,
	`user_update_id` text NOT NULL,
	CONSTRAINT "osfo_qualification_admission_decision" CHECK("osfo_qualification_admissions"."admission_decision" IN ('accepted', 'capacityRejected', 'typedStressRejected')),
	CONSTRAINT "osfo_qualification_admission_submission" CHECK(("osfo_qualification_admissions"."admission_decision" = 'accepted' AND "osfo_qualification_admissions"."think_submission_id" IS NOT NULL) OR ("osfo_qualification_admissions"."admission_decision" != 'accepted' AND "osfo_qualification_admissions"."think_submission_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_admissions_acceptance_receipt_id_unique` ON `osfo_qualification_admissions` (`acceptance_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_admissions_product_fact_id_unique` ON `osfo_qualification_admissions` (`product_fact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_admission_root_unique` ON `osfo_qualification_admissions` (`execution_id`,`root_id`);--> statement-breakpoint
CREATE INDEX `osfo_qualification_admissions_by_execution` ON `osfo_qualification_admissions` (`execution_id`,`run_id`,`occurred_at`);