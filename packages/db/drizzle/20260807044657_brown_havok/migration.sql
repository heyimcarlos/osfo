ALTER TABLE "admission_global_capacity" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "admission_principal_capacity_nonzero_idx" ON "admission_principal_capacity" ("principal_id") WHERE "reserved_count" <> 0;--> statement-breakpoint
CREATE INDEX "agent_run_capacity_reservations_state_idx" ON "agent_run_capacity_reservations" ("state","principal_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_principal_state_idx" ON "agent_runs" ("principal_id","state","agent_run_id");--> statement-breakpoint
ALTER TABLE "admission_global_capacity" ADD CONSTRAINT "admission_global_capacity_revision_check" CHECK ("revision" >= 0);