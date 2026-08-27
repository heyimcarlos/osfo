CREATE TABLE "administrative_authorities" (
	"admin_actor_id" text PRIMARY KEY NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "administrative_authorities_actor_check" CHECK (length(btrim("administrative_authorities"."admin_actor_id")) > 0)
);
--> statement-breakpoint
INSERT INTO "administrative_authorities" ("admin_actor_id")
SELECT DISTINCT "requested_by_admin_id"
FROM "deletion_cases"
WHERE "requested_by_admin_id" IS NOT NULL
  AND length(btrim("requested_by_admin_id")) > 0
ON CONFLICT ("admin_actor_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_requested_by_admin_id_administrative_authorities_admin_actor_id_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "public"."administrative_authorities"("admin_actor_id") ON DELETE no action ON UPDATE no action;
