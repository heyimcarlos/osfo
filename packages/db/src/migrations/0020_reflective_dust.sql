ALTER TABLE "research_reports" DROP CONSTRAINT "research_reports_identity_check";--> statement-breakpoint
ALTER TABLE "research_reports" DROP CONSTRAINT "research_reports_lifecycle_check";--> statement-breakpoint
ALTER TABLE "research_reports" ADD COLUMN "source_manifest_digest" text;--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_identity_check" CHECK (length(btrim("research_reports"."workflow_id")) > 0
        and length(btrim("research_reports"."user_id")) > 0
        and length(btrim("research_reports"."action_id")) > 0
        and length(btrim("research_reports"."agent_id")) > 0
        and length(btrim("research_reports"."route_id")) > 0
        and length(btrim("research_reports"."session_id")) > 0
        and "research_reports"."input_digest" ~ '^[0-9a-f]{64}$'
        and ("research_reports"."source_manifest_digest" is null or "research_reports"."source_manifest_digest" ~ '^[0-9a-f]{64}$')
        and length(btrim("research_reports"."cloudflare_instance_id")) > 0);--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_lifecycle_check" CHECK ("research_reports"."deadline_at" > "research_reports"."admitted_at"
        and ("research_reports"."accepted_at" is null or "research_reports"."accepted_at" >= "research_reports"."admitted_at")
        and ("research_reports"."started_at" is null or "research_reports"."started_at" >= "research_reports"."admitted_at")
        and ("research_reports"."started_at" is null or "research_reports"."accepted_at" is not null)
        and ("research_reports"."sources_committed_at" is null or "research_reports"."sources_committed_at" >= "research_reports"."admitted_at")
        and ("research_reports"."artifact_stored_at" is null or "research_reports"."artifact_stored_at" >= "research_reports"."admitted_at")
        and ("research_reports"."cancel_requested_at" is null or "research_reports"."cancel_requested_at" >= "research_reports"."admitted_at")
        and ("research_reports"."terminal_at" is null or "research_reports"."terminal_at" >= "research_reports"."admitted_at")
        and (("research_reports"."state" in ('success', 'failure', 'canceled')) = ("research_reports"."terminal_at" is not null))
        and (("research_reports"."state" in ('failure', 'canceled')) = ("research_reports"."safe_failure_code" is not null))
        and ("research_reports"."safe_failure_code" is null or (length(btrim("research_reports"."safe_failure_code")) between 1 and 120))
        and (("research_reports"."source_manifest_key" is null) = ("research_reports"."source_manifest_digest" is null))
        and ("research_reports"."state" not in ('running', 'sources_committed', 'artifact_stored', 'success', 'failure') or ("research_reports"."accepted_at" is not null and "research_reports"."started_at" is not null))
        and ("research_reports"."state" not in ('sources_committed', 'artifact_stored', 'success') or ("research_reports"."source_manifest_key" is not null and "research_reports"."source_manifest_digest" is not null))
        and ("research_reports"."state" not in ('artifact_stored', 'success') or ("research_reports"."artifact_content_id" is not null and "research_reports"."artifact_stored_at" is not null)));