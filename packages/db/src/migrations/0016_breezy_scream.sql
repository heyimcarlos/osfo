DROP INDEX "whatsapp_wakeups_active_user_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_wakeups_active_user_unique" ON "whatsapp_wakeups" USING btree ("user_id") WHERE "whatsapp_wakeups"."state" in ('pending', 'requested', 'accepted', 'ambiguous')
          and "whatsapp_wakeups"."consume_requested_at" is null
          and "whatsapp_wakeups"."cancel_requested_at" is null;
