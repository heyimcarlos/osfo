ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_facts_json_contract_check" CHECK (jsonb_typeof("usage_events"."facts_json"::jsonb) = 'object'
        and "usage_events"."facts_json"::jsonb ?& array[
          'allowancePeriodId', 'capabilityCatalogVersion', 'evidenceReferences',
          'manifestVersion', 'modelAccessPolicyVersion', 'occurredAt', 'outcome',
          'rootOperationId', 'source', 'usagePolicyVersion'
        ]
        and "usage_events"."facts_json"::jsonb ->> 'allowancePeriodId' = "usage_events"."allowance_period_id"
        and "usage_events"."facts_json"::jsonb ->> 'capabilityCatalogVersion' = "usage_events"."capability_catalog_version"
        and ("usage_events"."facts_json"::jsonb ->> 'manifestVersion') is not distinct from "usage_events"."manifest_version"
        and "usage_events"."facts_json"::jsonb ->> 'modelAccessPolicyVersion' = "usage_events"."model_access_policy_version"
        and "usage_events"."facts_json"::jsonb ->> 'rootOperationId' = "usage_events"."root_operation_id"
        and "usage_events"."facts_json"::jsonb ->> 'usagePolicyVersion' = "usage_events"."usage_policy_version"
        and jsonb_typeof("usage_events"."facts_json"::jsonb -> 'evidenceReferences') = 'array'
        and jsonb_typeof("usage_events"."facts_json"::jsonb -> 'outcome') = 'object'
        and jsonb_typeof("usage_events"."facts_json"::jsonb -> 'source') = 'object'
        and "usage_events"."facts_json"::jsonb -> 'source' ->> 'sourceId' = "usage_events"."source_id"
        and "usage_events"."facts_json"::jsonb -> 'source' ->> 'sourceType' = "usage_events"."source_type"
        and case "usage_events"."outcome"
          when 'completed' then "usage_events"."facts_json"::jsonb -> 'outcome' ->> '_tag' = 'Completed'
          when 'useful_partial' then "usage_events"."facts_json"::jsonb -> 'outcome' ->> '_tag' = 'UsefulPartial'
          when 'failed' then "usage_events"."facts_json"::jsonb -> 'outcome' ->> '_tag' = 'Failed'
          when 'cancelled' then "usage_events"."facts_json"::jsonb -> 'outcome' ->> '_tag' = 'Cancelled'
          else false
        end);