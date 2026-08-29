ALTER TABLE "scheduled_emails" DROP CONSTRAINT "scheduled_emails_identity_check";--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD COLUMN "send_claim_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_identity_check" CHECK (length(btrim("scheduled_emails"."workflow_id")) > 0
        and length(btrim("scheduled_emails"."action_id")) > 0
        and length(btrim("scheduled_emails"."user_id")) > 0
        and length(btrim("scheduled_emails"."agent_id")) > 0
        and length(btrim("scheduled_emails"."route_id")) > 0
        and length(btrim("scheduled_emails"."session_id")) > 0
        and "scheduled_emails"."input_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("scheduled_emails"."cloudflare_instance_id")) > 0
        and length("scheduled_emails"."approval_presentation") > 0
        and "scheduled_emails"."send_claim_generation" >= 0);