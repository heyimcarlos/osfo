CREATE TABLE `osfo_memory_provider_configuration` (
	`configured_at` text,
	`scope` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` text NOT NULL,
	CONSTRAINT "osfo_memory_provider_configuration_scope" CHECK("osfo_memory_provider_configuration"."scope" IN ('organization', 'user')),
	CONSTRAINT "osfo_memory_provider_configuration_status" CHECK("osfo_memory_provider_configuration"."status" IN ('pending', 'configured')),
	CONSTRAINT "osfo_memory_provider_configuration_completion" CHECK(("osfo_memory_provider_configuration"."status" = 'configured' AND "osfo_memory_provider_configuration"."configured_at" IS NOT NULL) OR ("osfo_memory_provider_configuration"."status" = 'pending' AND "osfo_memory_provider_configuration"."configured_at" IS NULL))
);
