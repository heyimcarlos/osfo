CREATE TABLE `osfo_qualification_activation_receipts` (
	`activation_id` text NOT NULL,
	`artifact_checksum` text NOT NULL,
	`attempt_id` text PRIMARY KEY NOT NULL,
	`cause` text,
	`classification` text,
	`deployment_version_id` text,
	`execution_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`plan_checksum` text NOT NULL,
	`product_fact_id` text NOT NULL,
	`region` text NOT NULL,
	`request_id` text NOT NULL,
	`root_id` text NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`activation_id`) REFERENCES `osfo_qualification_runtime_activations`(`activation_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`request_id`) REFERENCES `osfo_qualification_admitted_request_activations`(`request_id`) ON UPDATE restrict ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_qualification_activation_receipt_cause" CHECK("osfo_qualification_activation_receipts"."cause" IS NULL OR "osfo_qualification_activation_receipts"."cause" IN ('deployment', 'firstUse', 'warm')),
	CONSTRAINT "osfo_qualification_activation_receipt_classification" CHECK("osfo_qualification_activation_receipts"."classification" IS NULL OR "osfo_qualification_activation_receipts"."classification" IN ('cold', 'warm')),
	CONSTRAINT "osfo_qualification_activation_receipt_pair" CHECK(("osfo_qualification_activation_receipts"."cause" IS NULL AND "osfo_qualification_activation_receipts"."classification" IS NULL) OR ("osfo_qualification_activation_receipts"."cause" IS NOT NULL AND "osfo_qualification_activation_receipts"."classification" IS NOT NULL)),
	CONSTRAINT "osfo_qualification_activation_receipt_region" CHECK("osfo_qualification_activation_receipts"."region" IN ('americas', 'asiaPacific', 'europe'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_activation_receipts_product_fact_id_unique` ON `osfo_qualification_activation_receipts` (`product_fact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_activation_root_unique` ON `osfo_qualification_activation_receipts` (`execution_id`,`root_id`);--> statement-breakpoint
CREATE INDEX `osfo_qualification_activation_by_execution_session` ON `osfo_qualification_activation_receipts` (`execution_id`,`session_id`,`run_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `osfo_qualification_activation_state` (
	`first_use_eligible` integer NOT NULL,
	`last_activation_id` text,
	`last_deployment_version_id` text,
	`request_count` integer NOT NULL,
	`singleton_key` text PRIMARY KEY NOT NULL,
	CONSTRAINT "osfo_qualification_activation_state_singleton" CHECK("osfo_qualification_activation_state"."singleton_key" = 'agent'),
	CONSTRAINT "osfo_qualification_activation_state_first_use_boolean" CHECK("osfo_qualification_activation_state"."first_use_eligible" IN (0, 1)),
	CONSTRAINT "osfo_qualification_activation_state_request_count" CHECK("osfo_qualification_activation_state"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `osfo_qualification_admitted_request_activations` (
	`activation_id` text NOT NULL,
	`cause` text,
	`classification` text,
	`deployment_version_id` text,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`request_id` text NOT NULL,
	`request_sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`activation_id`) REFERENCES `osfo_qualification_runtime_activations`(`activation_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_qualification_admitted_request_activation_cause" CHECK("osfo_qualification_admitted_request_activations"."cause" IS NULL OR "osfo_qualification_admitted_request_activations"."cause" IN ('deployment', 'firstUse', 'warm')),
	CONSTRAINT "osfo_qualification_admitted_request_activation_classification" CHECK("osfo_qualification_admitted_request_activations"."classification" IS NULL OR "osfo_qualification_admitted_request_activations"."classification" IN ('cold', 'warm')),
	CONSTRAINT "osfo_qualification_admitted_request_activation_pair" CHECK(("osfo_qualification_admitted_request_activations"."cause" IS NULL AND "osfo_qualification_admitted_request_activations"."classification" IS NULL) OR ("osfo_qualification_admitted_request_activations"."cause" IS NOT NULL AND "osfo_qualification_admitted_request_activations"."classification" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_admitted_request_activations_request_id_unique` ON `osfo_qualification_admitted_request_activations` (`request_id`);--> statement-breakpoint
CREATE INDEX `osfo_qualification_admitted_requests_by_session` ON `osfo_qualification_admitted_request_activations` (`session_id`,`request_sequence`);--> statement-breakpoint
CREATE TABLE `osfo_qualification_runtime_activations` (
	`activation_id` text PRIMARY KEY NOT NULL,
	`deployment_version_id` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `osfo_qualification_runtime_activations_started` ON `osfo_qualification_runtime_activations` (`started_at`);