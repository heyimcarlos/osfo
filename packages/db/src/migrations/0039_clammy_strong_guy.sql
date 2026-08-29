ALTER TABLE "scheduled_emails" DROP CONSTRAINT "scheduled_emails_json_check";--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD COLUMN "qualification_context_json" text;--> statement-breakpoint
CREATE INDEX "scheduled_emails_qualification_root_index" ON "scheduled_emails" USING btree (("qualification_context_json"::jsonb ->> 'executionId'),("qualification_context_json"::jsonb ->> 'rootId'));--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_json_check" CHECK (jsonb_typeof("scheduled_emails"."originating_authority_json"::jsonb) = 'object'
        and jsonb_typeof("scheduled_emails"."approval_presentation"::jsonb) = 'object'
        and jsonb_typeof("scheduled_emails"."request_json"::jsonb) = 'object'
        and ("scheduled_emails"."qualification_context_json" is null or jsonb_typeof("scheduled_emails"."qualification_context_json"::jsonb) = 'object'));