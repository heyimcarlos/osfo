CREATE TABLE "admission_principal_set_generation" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"generation" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "admission_principal_set_generation_singleton_check" CHECK ("singleton"),
	CONSTRAINT "admission_principal_set_generation_generation_check" CHECK ("generation" >= 0)
);
--> statement-breakpoint
INSERT INTO "admission_principal_set_generation" ("singleton", "generation")
VALUES (true, 0);
--> statement-breakpoint
CREATE FUNCTION bump_admission_principal_set_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE admission_principal_set_generation
  SET generation = generation + 1
  WHERE singleton = true;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admission_principal_set_generation_mutation
AFTER INSERT OR DELETE OR UPDATE OF principal_id ON principals
FOR EACH STATEMENT EXECUTE FUNCTION bump_admission_principal_set_generation();
--> statement-breakpoint
CREATE TRIGGER admission_principal_set_generation_truncate
AFTER TRUNCATE ON principals
FOR EACH STATEMENT EXECUTE FUNCTION bump_admission_principal_set_generation();
