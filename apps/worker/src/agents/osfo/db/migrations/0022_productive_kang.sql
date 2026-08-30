CREATE TABLE `osfo_qualification_controlled_agent_aborts` (
	`application_authority_fact_id` text,
	`applied_at` text,
	`armed_activation_id` text NOT NULL,
	`armed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`artifact_checksum` text NOT NULL,
	`attempt_id` text NOT NULL,
	`controller_operation_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`journey` text NOT NULL,
	`manifest_checksum` text NOT NULL,
	`offered_at_epoch_ms` integer NOT NULL,
	`plan_checksum` text NOT NULL,
	`proof_artifact_checksum` text NOT NULL,
	`proof_artifact_id` text NOT NULL,
	`recovered_activation_id` text,
	`recovery_artifact_checksum` text,
	`recovered_at` text,
	`region` text NOT NULL,
	`request_id` text,
	`restoration_authority_fact_id` text,
	`root_id` text NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`armed_activation_id`) REFERENCES `osfo_qualification_runtime_activations`(`activation_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`recovered_activation_id`) REFERENCES `osfo_qualification_runtime_activations`(`activation_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_qualification_controlled_agent_abort_state" CHECK("osfo_qualification_controlled_agent_aborts"."state" IN ('armed', 'recovered', 'consumed', 'interfered')),
	CONSTRAINT "osfo_qualification_controlled_agent_abort_recovery" CHECK(("osfo_qualification_controlled_agent_aborts"."state" = 'armed' AND "osfo_qualification_controlled_agent_aborts"."application_authority_fact_id" IS NULL AND "osfo_qualification_controlled_agent_aborts"."recovered_activation_id" IS NULL AND "osfo_qualification_controlled_agent_aborts"."recovery_artifact_checksum" IS NULL AND "osfo_qualification_controlled_agent_aborts"."restoration_authority_fact_id" IS NULL) OR ("osfo_qualification_controlled_agent_aborts"."state" != 'armed' AND "osfo_qualification_controlled_agent_aborts"."application_authority_fact_id" IS NOT NULL AND "osfo_qualification_controlled_agent_aborts"."applied_at" IS NOT NULL AND "osfo_qualification_controlled_agent_aborts"."recovered_activation_id" IS NOT NULL AND "osfo_qualification_controlled_agent_aborts"."recovered_at" IS NOT NULL AND "osfo_qualification_controlled_agent_aborts"."recovery_artifact_checksum" IS NOT NULL AND "osfo_qualification_controlled_agent_aborts"."restoration_authority_fact_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_controlled_agent_aborts_attempt_id_unique` ON `osfo_qualification_controlled_agent_aborts` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_controlled_agent_abort_root_unique` ON `osfo_qualification_controlled_agent_aborts` (`execution_id`,`root_id`);--> statement-breakpoint
CREATE INDEX `osfo_qualification_controlled_agent_abort_session` ON `osfo_qualification_controlled_agent_aborts` (`session_id`,`state`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_osfo_qualification_activation_receipts` (
	`activation_id` text NOT NULL,
	`artifact_checksum` text NOT NULL,
	`attempt_id` text PRIMARY KEY NOT NULL,
	`cause` text,
	`controller_operation_id` text,
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
	CONSTRAINT "osfo_qualification_activation_receipt_cause" CHECK("__new_osfo_qualification_activation_receipts"."cause" IS NULL OR "__new_osfo_qualification_activation_receipts"."cause" IN ('deployment', 'faultRecovery', 'firstUse', 'warm')),
	CONSTRAINT "osfo_qualification_activation_receipt_classification" CHECK("__new_osfo_qualification_activation_receipts"."classification" IS NULL OR "__new_osfo_qualification_activation_receipts"."classification" IN ('cold', 'warm')),
	CONSTRAINT "osfo_qualification_activation_receipt_pair" CHECK(("__new_osfo_qualification_activation_receipts"."cause" IS NULL AND "__new_osfo_qualification_activation_receipts"."classification" IS NULL) OR ("__new_osfo_qualification_activation_receipts"."cause" IS NOT NULL AND "__new_osfo_qualification_activation_receipts"."classification" IS NOT NULL)),
	CONSTRAINT "osfo_qualification_activation_receipt_controller" CHECK(("__new_osfo_qualification_activation_receipts"."cause" = 'faultRecovery' AND "__new_osfo_qualification_activation_receipts"."controller_operation_id" IS NOT NULL) OR ("__new_osfo_qualification_activation_receipts"."cause" != 'faultRecovery' AND "__new_osfo_qualification_activation_receipts"."controller_operation_id" IS NULL) OR ("__new_osfo_qualification_activation_receipts"."cause" IS NULL AND "__new_osfo_qualification_activation_receipts"."controller_operation_id" IS NULL)),
	CONSTRAINT "osfo_qualification_activation_receipt_region" CHECK("__new_osfo_qualification_activation_receipts"."region" IN ('americas', 'asiaPacific', 'europe'))
);
--> statement-breakpoint
INSERT INTO `__new_osfo_qualification_activation_receipts`("activation_id", "artifact_checksum", "attempt_id", "cause", "controller_operation_id", "classification", "deployment_version_id", "execution_id", "occurred_at", "plan_checksum", "product_fact_id", "region", "request_id", "root_id", "run_id", "session_id") SELECT "activation_id", "artifact_checksum", "attempt_id", "cause", NULL, "classification", "deployment_version_id", "execution_id", "occurred_at", "plan_checksum", "product_fact_id", "region", "request_id", "root_id", "run_id", "session_id" FROM `osfo_qualification_activation_receipts`;--> statement-breakpoint
DROP TABLE `osfo_qualification_activation_receipts`;--> statement-breakpoint
ALTER TABLE `__new_osfo_qualification_activation_receipts` RENAME TO `osfo_qualification_activation_receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_activation_receipts_product_fact_id_unique` ON `osfo_qualification_activation_receipts` (`product_fact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_activation_root_unique` ON `osfo_qualification_activation_receipts` (`execution_id`,`root_id`);--> statement-breakpoint
CREATE INDEX `osfo_qualification_activation_by_execution_session` ON `osfo_qualification_activation_receipts` (`execution_id`,`session_id`,`run_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `__new_osfo_qualification_admitted_request_activations` (
	`activation_id` text NOT NULL,
	`cause` text,
	`classification` text,
	`controller_operation_id` text,
	`deployment_version_id` text,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`request_id` text NOT NULL,
	`request_sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`activation_id`) REFERENCES `osfo_qualification_runtime_activations`(`activation_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `osfo_session_ownership`(`session_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_qualification_admitted_request_activation_cause" CHECK("__new_osfo_qualification_admitted_request_activations"."cause" IS NULL OR "__new_osfo_qualification_admitted_request_activations"."cause" IN ('deployment', 'faultRecovery', 'firstUse', 'warm')),
	CONSTRAINT "osfo_qualification_admitted_request_activation_classification" CHECK("__new_osfo_qualification_admitted_request_activations"."classification" IS NULL OR "__new_osfo_qualification_admitted_request_activations"."classification" IN ('cold', 'warm')),
	CONSTRAINT "osfo_qualification_admitted_request_activation_pair" CHECK(("__new_osfo_qualification_admitted_request_activations"."cause" IS NULL AND "__new_osfo_qualification_admitted_request_activations"."classification" IS NULL) OR ("__new_osfo_qualification_admitted_request_activations"."cause" IS NOT NULL AND "__new_osfo_qualification_admitted_request_activations"."classification" IS NOT NULL)),
	CONSTRAINT "osfo_qualification_admitted_request_activation_controller" CHECK(("__new_osfo_qualification_admitted_request_activations"."cause" = 'faultRecovery' AND "__new_osfo_qualification_admitted_request_activations"."controller_operation_id" IS NOT NULL) OR ("__new_osfo_qualification_admitted_request_activations"."cause" != 'faultRecovery' AND "__new_osfo_qualification_admitted_request_activations"."controller_operation_id" IS NULL) OR ("__new_osfo_qualification_admitted_request_activations"."cause" IS NULL AND "__new_osfo_qualification_admitted_request_activations"."controller_operation_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_osfo_qualification_admitted_request_activations`("activation_id", "cause", "classification", "controller_operation_id", "deployment_version_id", "observed_at", "request_id", "request_sequence", "session_id") SELECT "activation_id", "cause", "classification", NULL, "deployment_version_id", "observed_at", "request_id", "request_sequence", "session_id" FROM `osfo_qualification_admitted_request_activations`;--> statement-breakpoint
DROP TABLE `osfo_qualification_admitted_request_activations`;--> statement-breakpoint
ALTER TABLE `__new_osfo_qualification_admitted_request_activations` RENAME TO `osfo_qualification_admitted_request_activations`;--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_qualification_admitted_request_activations_request_id_unique` ON `osfo_qualification_admitted_request_activations` (`request_id`);--> statement-breakpoint
CREATE INDEX `osfo_qualification_admitted_requests_by_session` ON `osfo_qualification_admitted_request_activations` (`session_id`,`request_sequence`);
