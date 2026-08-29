CREATE TABLE "qualification_participant_provisions" (
	"cohort_id" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"enrollment_identifier" text NOT NULL,
	"execution_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"participant_index" integer NOT NULL,
	"plan" text NOT NULL,
	"provision_checksum" text NOT NULL,
	"provision_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"user_id" text,
	CONSTRAINT "qualification_participant_provisions_position_unique" UNIQUE("cohort_id","plan","participant_index"),
	CONSTRAINT "qualification_participant_provisions_identifier_unique" UNIQUE("enrollment_identifier"),
	CONSTRAINT "qualification_participant_provisions_user_unique" UNIQUE("user_id"),
	CONSTRAINT "qualification_participant_provisions_identity_unique" UNIQUE("provision_id","user_id"),
	CONSTRAINT "qualification_participant_provisions_time_bounds_check" CHECK ("qualification_participant_provisions"."created_at" < "qualification_participant_provisions"."expires_at"),
	CONSTRAINT "qualification_participant_provisions_index_check" CHECK ("qualification_participant_provisions"."participant_index" >= 0),
	CONSTRAINT "qualification_participant_provisions_lifecycle_check" CHECK (("qualification_participant_provisions"."state" = 'PENDING' and "qualification_participant_provisions"."consumed_at" is null and "qualification_participant_provisions"."user_id" is null)
        or ("qualification_participant_provisions"."state" = 'CONSUMED' and "qualification_participant_provisions"."consumed_at" is not null and "qualification_participant_provisions"."user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" ADD COLUMN "provision_checksum" text NOT NULL;--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" ADD COLUMN "provision_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "qualification_participant_provisions" ADD CONSTRAINT "qualification_participant_provisions_cohort_fk" FOREIGN KEY ("cohort_id","execution_id") REFERENCES "public"."qualification_cohorts"("cohort_id","execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" ADD CONSTRAINT "qualification_participant_allocations_provision_user_fk" FOREIGN KEY ("provision_id","user_id") REFERENCES "public"."qualification_participant_provisions"("provision_id","user_id") ON DELETE restrict ON UPDATE no action;