CREATE TABLE "whatsapp_wakeup_sources" (
	"request_wakeup_id" text PRIMARY KEY NOT NULL,
	"wakeup_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_committed_at" timestamp with time zone NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_wakeup_sources_identity_check" CHECK (length(btrim("whatsapp_wakeup_sources"."request_wakeup_id")) > 0
        and "whatsapp_wakeup_sources"."fingerprint" ~ '^[0-9a-f]{64}$'
        and length(btrim("whatsapp_wakeup_sources"."source_identity")) > 0
        and length(btrim("whatsapp_wakeup_sources"."trace_id")) > 0),
	CONSTRAINT "whatsapp_wakeup_sources_kind_check" CHECK ("whatsapp_wakeup_sources"."source_kind" in ('reminder', 'researchReport', 'documentBuild', 'scheduledEmail'))
);
--> statement-breakpoint
ALTER TABLE "whatsapp_wakeup_sources" ADD CONSTRAINT "whatsapp_wakeup_sources_wakeup_id_whatsapp_wakeups_wakeup_id_fk" FOREIGN KEY ("wakeup_id") REFERENCES "public"."whatsapp_wakeups"("wakeup_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_wakeup_sources_latch_index" ON "whatsapp_wakeup_sources" USING btree ("wakeup_id","source_committed_at","request_wakeup_id");--> statement-breakpoint
CREATE INDEX "whatsapp_wakeup_sources_authority_index" ON "whatsapp_wakeup_sources" USING btree ("wakeup_id","source_kind","source_identity");