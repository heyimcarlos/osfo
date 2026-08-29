ALTER TABLE "scheduled_emails" DROP CONSTRAINT "scheduled_emails_outcome_check";--> statement-breakpoint
ALTER TABLE "scheduled_emails" DROP CONSTRAINT "scheduled_emails_lifecycle_check";--> statement-breakpoint
-- One-time repair for the historical false fact; runtime Allowance usage remains immutable.
DELETE FROM "allowance_usage"
USING "scheduled_emails"
WHERE "scheduled_emails"."send_outcome" = 'notApplied'
  AND "scheduled_emails"."send_accounting_basis" = 'conservative'
  AND "allowance_usage"."allowance_period_id" = "scheduled_emails"."allowance_period_id"
  AND "allowance_usage"."allowance_kind" = 'gmailSends'
  AND "allowance_usage"."basis" = 'conservative'
  AND "allowance_usage"."source_type" = 'integrationAction'
  AND "allowance_usage"."source_id" = "scheduled_emails"."action_id";--> statement-breakpoint
UPDATE "scheduled_emails"
SET "send_accounting_basis" = null
WHERE "send_accounting_basis" = 'conservative'
  AND (
    ("send_outcome" = 'ambiguous' AND "send_accounted_at" is null)
    OR "send_outcome" = 'notApplied'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "allowance_usage"
    WHERE "allowance_usage"."allowance_period_id" = "scheduled_emails"."allowance_period_id"
      AND "allowance_usage"."allowance_kind" = 'gmailSends'
      AND "allowance_usage"."source_type" = 'integrationAction'
      AND "allowance_usage"."source_id" = "scheduled_emails"."action_id"
  );--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_outcome_check" CHECK ((
          "scheduled_emails"."state" in ('admitted', 'accepted', 'waiting', 'sending', 'canceled')
          and "scheduled_emails"."send_outcome" is null
          and "scheduled_emails"."send_accounting_basis" is null
          and "scheduled_emails"."send_outcome_at" is null
          and "scheduled_emails"."provider_resource_id" is null
        ) or (
          "scheduled_emails"."state" = 'send_pending_reconciliation'
          and "scheduled_emails"."send_outcome" is not null
          and "scheduled_emails"."send_outcome" = 'ambiguous'
          and "scheduled_emails"."send_accounting_basis" is null
          and "scheduled_emails"."send_outcome_at" is not null
          and "scheduled_emails"."provider_resource_id" is null
        ) or (
          "scheduled_emails"."state" = 'success'
          and "scheduled_emails"."send_outcome" is not null
          and "scheduled_emails"."send_outcome" = 'applied'
          and "scheduled_emails"."send_accounting_basis" in ('observed', 'conservative')
          and "scheduled_emails"."send_outcome_at" is not null
          and "scheduled_emails"."provider_log_id" is not null
          and "scheduled_emails"."provider_resource_id" is not null
        ) or (
          "scheduled_emails"."state" = 'failure'
          and "scheduled_emails"."send_outcome" is not null
          and "scheduled_emails"."send_outcome" in ('notApplied', 'ambiguous')
          and ("scheduled_emails"."send_outcome" <> 'ambiguous' or "scheduled_emails"."send_accounting_basis" is null or "scheduled_emails"."send_accounting_basis" = 'conservative')
          and ("scheduled_emails"."send_outcome" <> 'notApplied' or "scheduled_emails"."send_accounting_basis" is null or "scheduled_emails"."send_accounting_basis" = 'conservative')
          and "scheduled_emails"."send_outcome_at" is not null
          and "scheduled_emails"."provider_resource_id" is null
        ));--> statement-breakpoint
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_lifecycle_check" CHECK ("scheduled_emails"."due_at" > "scheduled_emails"."admitted_at"
        and ("scheduled_emails"."accepted_at" is null or "scheduled_emails"."accepted_at" >= "scheduled_emails"."admitted_at")
        and ("scheduled_emails"."waiting_at" is null or "scheduled_emails"."accepted_at" is not null)
        and ("scheduled_emails"."send_started_at" is null or "scheduled_emails"."send_started_at" >= "scheduled_emails"."due_at")
        and ("scheduled_emails"."send_outcome_at" is null or "scheduled_emails"."send_started_at" is not null)
        and ("scheduled_emails"."cancel_requested_at" is null or "scheduled_emails"."cancel_requested_at" >= "scheduled_emails"."admitted_at")
        and (("scheduled_emails"."state" in ('success', 'failure', 'canceled')) = ("scheduled_emails"."terminal_at" is not null))
        and ("scheduled_emails"."state" <> 'send_pending_reconciliation' or ("scheduled_emails"."send_outcome" is not null and "scheduled_emails"."send_outcome" = 'ambiguous' and "scheduled_emails"."send_outcome_at" is not null and "scheduled_emails"."terminal_at" is null))
        and ("scheduled_emails"."state" not in ('sending', 'send_pending_reconciliation', 'success', 'failure') or "scheduled_emails"."send_started_at" is not null)
        and ("scheduled_emails"."state" <> 'success' or ("scheduled_emails"."send_outcome" is not null and "scheduled_emails"."send_outcome" = 'applied' and "scheduled_emails"."send_outcome_at" is not null and "scheduled_emails"."provider_log_id" is not null and "scheduled_emails"."provider_resource_id" is not null))
        and ("scheduled_emails"."send_accounted_at" is null or ("scheduled_emails"."send_outcome" = 'notApplied' or "scheduled_emails"."send_accounting_basis" is not null))
        and ("scheduled_emails"."send_accounting_basis" <> 'observed' or "scheduled_emails"."send_outcome" = 'applied')
        and ("scheduled_emails"."workflow_start_accounted_at" is null or "scheduled_emails"."accepted_at" is not null)
        and ("scheduled_emails"."safe_failure_code" is null or length(btrim("scheduled_emails"."safe_failure_code")) between 1 and 120));
