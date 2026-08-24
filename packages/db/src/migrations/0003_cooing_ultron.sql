ALTER TABLE "usage_event_components" ADD CONSTRAINT "usage_event_components_activity_check" CHECK ("usage_event_components"."activity" in ('conversationsAndMemory', 'webAndResearch', 'integrations', 'filesAndArtifacts', 'imagesAndDiagrams', 'automations'));--> statement-breakpoint
ALTER TABLE "usage_event_components" ADD CONSTRAINT "usage_event_components_component_kind_check" CHECK ("usage_event_components"."component_kind" in ('model', 'non_model'));--> statement-breakpoint
ALTER TABLE "usage_event_components" ADD CONSTRAINT "usage_event_components_index_check" CHECK ("usage_event_components"."component_index" >= 0);--> statement-breakpoint
ALTER TABLE "usage_event_components" ADD CONSTRAINT "usage_event_components_required_text_check" CHECK (length(btrim("usage_event_components"."allowance_period_id")) > 0
        and length(btrim("usage_event_components"."evidence_json")) > 0
        and length(btrim("usage_event_components"."resource_price_version")) > 0
        and length(btrim("usage_event_components"."source_id")) > 0
        and length(btrim("usage_event_components"."source_type")) > 0);--> statement-breakpoint
ALTER TABLE "usage_event_evidence_references" ADD CONSTRAINT "usage_event_evidence_references_kind_check" CHECK ("usage_event_evidence_references"."reference_kind" in ('providerLog', 'gatewayLog', 'companyCost', 'operationEvidence'));--> statement-breakpoint
ALTER TABLE "usage_event_evidence_references" ADD CONSTRAINT "usage_event_evidence_references_required_text_check" CHECK (length(btrim("usage_event_evidence_references"."allowance_period_id")) > 0
        and length(btrim("usage_event_evidence_references"."reference")) > 0
        and length(btrim("usage_event_evidence_references"."source_id")) > 0
        and length(btrim("usage_event_evidence_references"."source_type")) > 0);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_outcome_check" CHECK ("usage_events"."outcome" in ('completed', 'useful_partial', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_required_text_check" CHECK (length(btrim("usage_events"."allowance_period_id")) > 0
        and length(btrim("usage_events"."capability_catalog_version")) > 0
        and length(btrim("usage_events"."facts_json")) > 0
        and ("usage_events"."manifest_version" is null or length(btrim("usage_events"."manifest_version")) > 0)
        and length(btrim("usage_events"."model_access_policy_version")) > 0
        and length(btrim("usage_events"."root_operation_id")) > 0
        and length(btrim("usage_events"."source_id")) > 0
        and length(btrim("usage_events"."source_type")) > 0
        and length(btrim("usage_events"."usage_policy_version")) > 0
        and length(btrim("usage_events"."user_id")) > 0);