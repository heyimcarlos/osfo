ALTER TABLE "whatsapp_wakeups" DROP CONSTRAINT "whatsapp_wakeups_lifecycle_check";--> statement-breakpoint
ALTER TABLE "whatsapp_wakeups" ADD COLUMN "exposure_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_wakeups" ADD CONSTRAINT "whatsapp_wakeups_lifecycle_check" CHECK (("whatsapp_wakeups"."state" = 'pending'
          and "whatsapp_wakeups"."provider_outcome" is null and "whatsapp_wakeups"."requested_at" is null
          and "whatsapp_wakeups"."settled_at" is null and "whatsapp_wakeups"."exposure_completed_at" is null
          and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" = 'requested'
          and "whatsapp_wakeups"."provider_outcome" is null and "whatsapp_wakeups"."requested_at" is not null
          and "whatsapp_wakeups"."settled_at" is null and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null
          and ("whatsapp_wakeups"."exposure_completed_at" is null or "whatsapp_wakeups"."consume_requested_at" is not null))
        or ("whatsapp_wakeups"."state" in ('accepted', 'ambiguous')
          and "whatsapp_wakeups"."provider_outcome" = "whatsapp_wakeups"."state" and "whatsapp_wakeups"."requested_at" is not null
          and "whatsapp_wakeups"."settled_at" is not null and "whatsapp_wakeups"."exposure_completed_at" is null
          and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" = 'rejected'
          and "whatsapp_wakeups"."provider_outcome" = 'rejected' and "whatsapp_wakeups"."safe_failure_class" = 'providerRejected'
          and "whatsapp_wakeups"."requested_at" is not null and "whatsapp_wakeups"."settled_at" is not null
          and "whatsapp_wakeups"."exposure_completed_at" is null and "whatsapp_wakeups"."consumed_at" is null and "whatsapp_wakeups"."canceled_at" is null)
        or ("whatsapp_wakeups"."state" = 'consumed'
          and "whatsapp_wakeups"."exposure_completed_at" is not null and "whatsapp_wakeups"."consumed_at" is not null
          and "whatsapp_wakeups"."canceled_at" is null
          and ("whatsapp_wakeups"."provider_outcome" is null or "whatsapp_wakeups"."provider_outcome" in ('accepted', 'rejected', 'ambiguous')))
        or ("whatsapp_wakeups"."state" = 'canceled'
          and "whatsapp_wakeups"."exposure_completed_at" is null and "whatsapp_wakeups"."consumed_at" is null
          and "whatsapp_wakeups"."canceled_at" is not null
          and ("whatsapp_wakeups"."provider_outcome" is null or "whatsapp_wakeups"."provider_outcome" in ('accepted', 'rejected', 'ambiguous'))));