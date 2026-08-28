CREATE TABLE `osfo_reminder_actions` (
	`action_id` text PRIMARY KEY NOT NULL,
	`fingerprint_json` text NOT NULL,
	`reminder_id` text NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`reminder_id`) REFERENCES `osfo_reminders`(`reminder_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_reminder_action_revision" CHECK("osfo_reminder_actions"."revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `osfo_reminder_actions_by_reminder` ON `osfo_reminder_actions` (`reminder_id`,`revision`);--> statement-breakpoint
CREATE TABLE `osfo_reminder_occurrences` (
	`accounting_recorded_at` text,
	`blocked_at` text,
	`body_snapshot` text NOT NULL,
	`canceled_at` text,
	`channel_link_id` text,
	`callback_capability` text NOT NULL,
	`callback_capability_revoked_at` text,
	`committed_at` text,
	`disposition_reason` text,
	`exposed_at` text,
	`nominal_due_at` text NOT NULL,
	`original_period_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`policy_version` text NOT NULL,
	`reminder_id` text NOT NULL,
	`revision` integer NOT NULL,
	`schedule_kind` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_revoked_at` text,
	`think_presented_at` text,
	`think_submission_id` text,
	`wakeup_prompted_at` text,
	`wakeup_requested_at` text,
	FOREIGN KEY (`reminder_id`) REFERENCES `osfo_reminders`(`reminder_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "osfo_reminder_occurrence_revision" CHECK("osfo_reminder_occurrences"."revision" > 0),
	CONSTRAINT "osfo_reminder_occurrence_schedule_kind" CHECK("osfo_reminder_occurrences"."schedule_kind" IN ('oneTime', 'recurring')),
	CONSTRAINT "osfo_reminder_occurrence_disposition" CHECK((("osfo_reminder_occurrences"."committed_at" IS NOT NULL) + ("osfo_reminder_occurrences"."blocked_at" IS NOT NULL) + ("osfo_reminder_occurrences"."canceled_at" IS NOT NULL)) = 1),
	CONSTRAINT "osfo_reminder_occurrence_delivery" CHECK(("osfo_reminder_occurrences"."committed_at" IS NOT NULL AND "osfo_reminder_occurrences"."channel_link_id" IS NOT NULL) OR ("osfo_reminder_occurrences"."committed_at" IS NULL AND "osfo_reminder_occurrences"."channel_link_id" IS NULL AND "osfo_reminder_occurrences"."accounting_recorded_at" IS NULL AND "osfo_reminder_occurrences"."wakeup_requested_at" IS NULL AND "osfo_reminder_occurrences"."wakeup_prompted_at" IS NULL AND "osfo_reminder_occurrences"."exposed_at" IS NULL AND "osfo_reminder_occurrences"."think_presented_at" IS NULL)),
	CONSTRAINT "osfo_reminder_occurrence_think_presentation" CHECK(("osfo_reminder_occurrences"."think_presented_at" IS NULL AND "osfo_reminder_occurrences"."think_submission_id" IS NULL) OR ("osfo_reminder_occurrences"."think_presented_at" IS NOT NULL AND "osfo_reminder_occurrences"."think_submission_id" IS NOT NULL)),
	CONSTRAINT "osfo_reminder_occurrence_source_revocation" CHECK("osfo_reminder_occurrences"."source_revoked_at" IS NULL OR "osfo_reminder_occurrences"."committed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_reminder_occurrences_source_identity_unique` ON `osfo_reminder_occurrences` (`source_identity`);--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_reminder_occurrence_identity` ON `osfo_reminder_occurrences` (`reminder_id`,`revision`,`nominal_due_at`);--> statement-breakpoint
CREATE INDEX `osfo_reminder_occurrences_pending_source` ON `osfo_reminder_occurrences` (`owner_user_id`,`exposed_at`,`committed_at`,`source_identity`);--> statement-breakpoint
CREATE TABLE `osfo_reminders` (
	`body` text NOT NULL,
	`callback_capability` text,
	`created_at` text NOT NULL,
	`creation_action_id` text NOT NULL,
	`first_due_at` text NOT NULL,
	`interval_milliseconds` integer,
	`next_due_at` text,
	`original_period_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`plan` text NOT NULL,
	`policy_version` text NOT NULL,
	`reminder_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`schedule_kind` text NOT NULL,
	`scheduler_id` text,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "osfo_reminder_revision" CHECK("osfo_reminders"."revision" > 0),
	CONSTRAINT "osfo_reminder_schedule_kind" CHECK("osfo_reminders"."schedule_kind" IN ('oneTime', 'recurring')),
	CONSTRAINT "osfo_reminder_schedule_shape" CHECK(("osfo_reminders"."schedule_kind" = 'oneTime' AND "osfo_reminders"."interval_milliseconds" IS NULL) OR ("osfo_reminders"."schedule_kind" = 'recurring' AND "osfo_reminders"."interval_milliseconds" >= 86400000)),
	CONSTRAINT "osfo_reminder_state" CHECK("osfo_reminders"."state" IN ('active', 'paused', 'canceled', 'completed')),
	CONSTRAINT "osfo_reminder_due_state" CHECK(("osfo_reminders"."state" IN ('active', 'paused') AND "osfo_reminders"."next_due_at" IS NOT NULL) OR ("osfo_reminders"."state" IN ('canceled', 'completed') AND "osfo_reminders"."next_due_at" IS NULL)),
	CONSTRAINT "osfo_reminder_schedule_binding" CHECK(("osfo_reminders"."scheduler_id" IS NULL AND "osfo_reminders"."callback_capability" IS NULL) OR ("osfo_reminders"."scheduler_id" IS NOT NULL AND "osfo_reminders"."callback_capability" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osfo_reminders_creation_action_id_unique` ON `osfo_reminders` (`creation_action_id`);--> statement-breakpoint
CREATE INDEX `osfo_reminders_by_owner_state` ON `osfo_reminders` (`owner_user_id`,`state`,`created_at`,`reminder_id`);