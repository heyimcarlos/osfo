ALTER TABLE "model_call_attempts" ADD COLUMN "model_binding" text;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "dispatch_state" text DEFAULT 'prepared' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
UPDATE "model_call_attempts" AS attempt
SET "model_binding" = model_call."model_binding",
    "dispatch_state" = CASE
      WHEN attempt."state" = 'succeeded' THEN 'confirmed'
      WHEN attempt."state" IN ('failed', 'canceled') THEN 'uncertain'
      ELSE 'prepared'
    END
FROM "model_calls" AS model_call
WHERE model_call."model_call_id" = attempt."model_call_id"
  AND model_call."agent_run_id" = attempt."agent_run_id";--> statement-breakpoint
ALTER TABLE "model_call_attempts" ALTER COLUMN "model_binding" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_binding_check" CHECK (length("model_binding") BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_dispatch_check" CHECK ((("dispatch_state" IN ('prepared', 'confirmed', 'not_dispatched', 'uncertain')
        AND ("provider_request_id" IS NULL OR "dispatch_state" = 'confirmed')
        AND ("provider_request_id" IS NULL OR length("provider_request_id") BETWEEN 1 AND 255)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_terminal_dispatch_check" CHECK ((("state" = 'started'
        OR ("state" = 'succeeded' AND "dispatch_state" = 'confirmed')
        OR ("state" IN ('failed', 'canceled') AND "dispatch_state" <> 'prepared')
      )) IS TRUE);
