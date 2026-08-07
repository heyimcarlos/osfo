CREATE FUNCTION text_utf16_code_units(value text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT COALESCE(sum(
    CASE WHEN ascii(substring(value FROM character_index FOR 1)) > 65535
      THEN 2
      ELSE 1
    END
  ), 0)::integer
  FROM generate_series(1, length(value)) AS character_index;
$$;--> statement-breakpoint
ALTER TABLE "model_call_fragments" DROP CONSTRAINT "model_call_fragments_text_check";--> statement-breakpoint
ALTER TABLE "model_call_fragments" ADD CONSTRAINT "model_call_fragments_text_check" CHECK (text_utf16_code_units("text") BETWEEN 1 AND 16384);--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "model_binding" text;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "dispatch_state" text DEFAULT 'prepared' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD COLUMN "reasoning_units" integer;--> statement-breakpoint
UPDATE "model_call_attempts" AS attempt
SET "model_binding" = model_call."model_binding",
    "dispatch_state" = CASE
      WHEN EXISTS (
        SELECT 1
        FROM "model_call_fragments" AS fragment
        WHERE fragment."model_call_attempt_id" = attempt."model_call_attempt_id"
      ) THEN 'confirmed'
      WHEN attempt."state" = 'succeeded' THEN 'confirmed'
      WHEN attempt."state" IN ('failed', 'canceled') THEN 'uncertain'
      ELSE 'prepared'
    END
FROM "model_calls" AS model_call
WHERE model_call."model_call_id" = attempt."model_call_id"
  AND model_call."agent_run_id" = attempt."agent_run_id";--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_binding_check" CHECK (length("model_binding") BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_dispatch_check" CHECK ((("dispatch_state" IN ('prepared', 'confirmed', 'not_dispatched', 'uncertain')
        AND ("provider_request_id" IS NULL OR "dispatch_state" = 'confirmed')
        AND ("provider_request_id" IS NULL OR length("provider_request_id") BETWEEN 1 AND 255)
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "model_call_attempts" DROP CONSTRAINT "model_call_attempts_usage_check";--> statement-breakpoint
ALTER TABLE "model_call_attempts" ADD CONSTRAINT "model_call_attempts_usage_check" CHECK (((
        ("usage_type" = 'unknown'
          AND "input_units" IS NULL
          AND "output_units" IS NULL
          AND "reasoning_units" IS NULL)
        OR ("usage_type" IN ('reported', 'estimated')
          AND "input_units" >= 0
          AND "output_units" >= 0
          AND ("reasoning_units" IS NULL OR (
            "reasoning_units" >= 0
            AND "reasoning_units" <= "output_units")))
      )) IS TRUE);--> statement-breakpoint
CREATE FUNCTION complete_model_call_attempt_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_binding IS NULL THEN
    SELECT model_call.model_binding
    INTO NEW.model_binding
    FROM model_calls AS model_call
    WHERE model_call.model_call_id = NEW.model_call_id
      AND model_call.agent_run_id = NEW.agent_run_id;
  END IF;

  IF NEW.state <> 'started' AND NEW.dispatch_state = 'prepared' THEN
    NEW.dispatch_state := CASE
      WHEN NEW.state = 'succeeded' THEN 'confirmed'
      WHEN EXISTS (
        SELECT 1
        FROM model_call_fragments AS fragment
        WHERE fragment.model_call_attempt_id = NEW.model_call_attempt_id
      ) THEN 'confirmed'
      ELSE 'uncertain'
    END;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
COMMENT ON FUNCTION complete_model_call_attempt_evidence() IS
  'Expand-contract compatibility for attempt writers that omit binding and dispatch evidence. Remove only after those revisions are drained and a later contract migration enforces the completed invariants.';--> statement-breakpoint
CREATE TRIGGER model_call_attempts_complete_expand_evidence
BEFORE INSERT OR UPDATE ON model_call_attempts
FOR EACH ROW EXECUTE FUNCTION complete_model_call_attempt_evidence();
