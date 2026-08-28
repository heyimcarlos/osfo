ALTER TABLE "research_reports" DROP CONSTRAINT "research_reports_identity_check";--> statement-breakpoint
ALTER TABLE "research_reports" DROP CONSTRAINT "research_reports_json_check";--> statement-breakpoint
ALTER TABLE "research_reports" ADD COLUMN "action_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "research_reports" ADD COLUMN "approval_json" text;--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_identity_check" CHECK (length(btrim("research_reports"."workflow_id")) > 0
        and length(btrim("research_reports"."user_id")) > 0
        and length(btrim("research_reports"."action_id")) > 0
        and length(btrim("research_reports"."agent_id")) > 0
        and length(btrim("research_reports"."route_id")) > 0
        and length(btrim("research_reports"."session_id")) > 0
        and "research_reports"."input_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("research_reports"."cloudflare_instance_id")) > 0);--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_json_check" CHECK (jsonb_typeof("research_reports"."originating_authority_json"::jsonb) = 'object'
        and ("research_reports"."approval_json" is null or jsonb_typeof("research_reports"."approval_json"::jsonb) = 'object')
        and jsonb_typeof("research_reports"."request_json"::jsonb) = 'object');