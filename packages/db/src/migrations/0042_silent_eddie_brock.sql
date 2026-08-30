ALTER TABLE "document_builds" DROP CONSTRAINT "document_builds_json_check";--> statement-breakpoint
ALTER TABLE "document_builds" ADD COLUMN "qualification_context_json" text;--> statement-breakpoint
CREATE INDEX "document_builds_qualification_root_index" ON "document_builds" USING btree (("qualification_context_json"::jsonb ->> 'executionId'),("qualification_context_json"::jsonb ->> 'rootId'));--> statement-breakpoint
ALTER TABLE "document_builds" ADD CONSTRAINT "document_builds_json_check" CHECK (jsonb_typeof("document_builds"."originating_authority_json"::jsonb) = 'object'
        and jsonb_typeof("document_builds"."request_json"::jsonb) = 'object'
        and ("document_builds"."qualification_context_json" is null or jsonb_typeof("document_builds"."qualification_context_json"::jsonb) = 'object')
        and ("document_builds"."cost_evidence_json" is null or jsonb_typeof("document_builds"."cost_evidence_json"::jsonb) = 'object'));