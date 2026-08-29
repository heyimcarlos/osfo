ALTER TABLE `osfo_model_call_usage_evidence` ADD `qualification_cost_reconciliation_id` text;--> statement-breakpoint
ALTER TABLE `osfo_model_call_usage_evidence` ADD `qualification_execution_id` text;--> statement-breakpoint
ALTER TABLE `osfo_model_call_usage_evidence` ADD `qualification_model_request_id` text;--> statement-breakpoint
ALTER TABLE `osfo_model_call_usage_evidence` ADD `qualification_outcome_id` text;--> statement-breakpoint
ALTER TABLE `osfo_model_call_usage_evidence` ADD `qualification_price_book_id` text;--> statement-breakpoint
ALTER TABLE `osfo_model_call_usage_evidence` ADD `qualification_root_id` text;--> statement-breakpoint
CREATE INDEX `osfo_model_call_usage_by_qualification_root` ON `osfo_model_call_usage_evidence` (`qualification_execution_id`,`qualification_root_id`);