CREATE TABLE "incident_controls" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"pause_new_ingress" boolean DEFAULT false NOT NULL,
	"pause_new_costly_work" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "incident_controls_singleton_check" CHECK ("incident_controls"."id" = true),
	CONSTRAINT "incident_controls_actor_check" CHECK (length(trim("incident_controls"."actor")) > 0),
	CONSTRAINT "incident_controls_reason_check" CHECK (length(trim("incident_controls"."reason")) > 0)
);
--> statement-breakpoint
INSERT INTO "incident_controls" ("id", "pause_new_ingress", "pause_new_costly_work", "actor", "reason")
VALUES (true, false, false, 'migration', 'Initial inactive incident controls');
