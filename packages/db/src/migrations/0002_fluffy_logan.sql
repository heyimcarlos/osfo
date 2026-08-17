CREATE TABLE "deletion_cases" (
	"deletion_case_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"requested_by_admin_id" text NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_cases_actor_check" CHECK (length("deletion_cases"."requested_by_admin_id") > 0),
	CONSTRAINT "deletion_cases_reason_check" CHECK (length("deletion_cases"."reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "user_suspension_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"admin_actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_suspension_events_action_check" CHECK ("user_suspension_events"."action" in ('suspended', 'restored')),
	CONSTRAINT "user_suspension_events_actor_check" CHECK (length("user_suspension_events"."admin_actor_id") > 0),
	CONSTRAINT "user_suspension_events_reason_check" CHECK (length("user_suspension_events"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "deletion_cases" ADD CONSTRAINT "deletion_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_suspension_events" ADD CONSTRAINT "user_suspension_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_cases_user_unique" ON "deletion_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_suspension_events_user_order_index" ON "user_suspension_events" USING btree ("user_id","occurred_at","event_id");