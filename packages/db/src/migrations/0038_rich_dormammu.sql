ALTER TABLE "qualification_participant_allocations" DROP CONSTRAINT "qualification_root_attempts_user_period_fk";
--> statement-breakpoint
ALTER TABLE "qualification_root_attempts" ADD COLUMN "allowance_period_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "qualification_root_attempts" ADD CONSTRAINT "qualification_root_attempts_user_period_fk" FOREIGN KEY ("user_id","allowance_period_id") REFERENCES "public"."allowance_periods"("user_id","allowance_period_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_participant_allocations" DROP COLUMN "allowance_period_id";