CREATE TABLE "acceptance_receipts" (
	"receipt_id" uuid PRIMARY KEY,
	"protocol_version" smallint NOT NULL,
	"principal_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"user_message_id" uuid NOT NULL UNIQUE,
	"agent_run_id" uuid NOT NULL UNIQUE,
	"thread_position" bigint NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "acceptance_receipts_principal_idempotency_unique" UNIQUE("principal_id","idempotency_key"),
	CONSTRAINT "acceptance_receipts_protocol_version_check" CHECK ("protocol_version" = 1),
	CONSTRAINT "acceptance_receipts_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "acceptance_receipts_thread_position_check" CHECK ("thread_position" > 0)
);
--> statement-breakpoint
CREATE TABLE "admission_global_capacity" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"reserved_count" integer NOT NULL,
	CONSTRAINT "admission_global_capacity_singleton_check" CHECK ("singleton"),
	CONSTRAINT "admission_global_capacity_reserved_count_check" CHECK ("reserved_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admission_principal_capacity" (
	"principal_id" uuid PRIMARY KEY,
	"reserved_count" integer NOT NULL,
	CONSTRAINT "admission_principal_capacity_reserved_count_check" CHECK ("reserved_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_run_capacity_reservations" (
	"agent_run_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"state" text NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "agent_run_capacity_reservations_state_check" CHECK ("state" IN ('held', 'released')),
	CONSTRAINT "agent_run_capacity_reservations_release_check" CHECK ((
        ("state" = 'held' AND "released_at" IS NULL)
        OR ("state" = 'released' AND "released_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"agent_run_id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL UNIQUE,
	"state" text NOT NULL,
	"execution_profile_ref" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_runs_run_principal_unique" UNIQUE("agent_run_id","principal_id"),
	CONSTRAINT "agent_runs_run_thread_principal_unique" UNIQUE("agent_run_id","thread_id","principal_id"),
	CONSTRAINT "agent_runs_state_check" CHECK ("state" IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "agent_runs_execution_profile_ref_check" CHECK (length("execution_profile_ref") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "authentication_sessions" (
	"session_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"token_sha256" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
	CONSTRAINT "authentication_sessions_token_sha256_check" CHECK ("token_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_obligations" (
	"outbox_id" uuid PRIMARY KEY,
	"agent_run_id" uuid NOT NULL UNIQUE,
	"thread_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" smallint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outbox_obligations_kind_check" CHECK ("kind" = 'AgentRunPending'),
	CONSTRAINT "outbox_obligations_version_check" CHECK ("version" = 1)
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"principal_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_events" (
	"thread_id" uuid NOT NULL,
	"position" bigint NOT NULL,
	"event_id" uuid NOT NULL UNIQUE,
	"principal_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" smallint NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_events_pkey" PRIMARY KEY("thread_id","position"),
	CONSTRAINT "thread_events_authority_unique" UNIQUE("thread_id","position","user_message_id","agent_run_id"),
	CONSTRAINT "thread_events_position_check" CHECK ("position" > 0),
	CONSTRAINT "thread_events_event_type_check" CHECK ("event_type" = 'UserMessageAppended'),
	CONSTRAINT "thread_events_event_version_check" CHECK ("event_version" = 1),
	CONSTRAINT "thread_events_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
	CONSTRAINT "thread_events_payload_shape_check" CHECK ("payload" = jsonb_build_object(
        'userMessageId', "payload" ->> 'userMessageId',
        'agentRunId', "payload" ->> 'agentRunId'
      )),
	CONSTRAINT "thread_events_payload_message_check" CHECK (("payload" ->> 'userMessageId')::uuid = "user_message_id"),
	CONSTRAINT "thread_events_payload_run_check" CHECK (("payload" ->> 'agentRunId')::uuid = "agent_run_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"thread_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"next_position" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
	CONSTRAINT "threads_thread_id_principal_id_unique" UNIQUE("thread_id","principal_id"),
	CONSTRAINT "threads_next_position_check" CHECK ("next_position" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_messages" (
	"user_message_id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_messages_message_thread_principal_unique" UNIQUE("user_message_id","thread_id","principal_id"),
	CONSTRAINT "user_messages_content_check" CHECK (length("content") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE INDEX "authentication_sessions_active_token_idx" ON "authentication_sessions" ("token_sha256") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_obligations_created_idx" ON "outbox_obligations" ("created_at","outbox_id");--> statement-breakpoint
ALTER TABLE "acceptance_receipts" ADD CONSTRAINT "acceptance_receipts_1vVD2rIpd8yN_fkey" FOREIGN KEY ("thread_id","principal_id") REFERENCES "threads"("thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "acceptance_receipts" ADD CONSTRAINT "acceptance_receipts_AYmlXTFfHNBK_fkey" FOREIGN KEY ("user_message_id","thread_id","principal_id") REFERENCES "user_messages"("user_message_id","thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "acceptance_receipts" ADD CONSTRAINT "acceptance_receipts_IkIBOveuS34A_fkey" FOREIGN KEY ("agent_run_id","thread_id","principal_id") REFERENCES "agent_runs"("agent_run_id","thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "acceptance_receipts" ADD CONSTRAINT "acceptance_receipts_f7VpWPAjO5Qf_fkey" FOREIGN KEY ("thread_id","thread_position","user_message_id","agent_run_id") REFERENCES "thread_events"("thread_id","position","user_message_id","agent_run_id");--> statement-breakpoint
ALTER TABLE "admission_principal_capacity" ADD CONSTRAINT "admission_principal_capacity_6cwhN3BxJnGF_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id");--> statement-breakpoint
ALTER TABLE "agent_run_capacity_reservations" ADD CONSTRAINT "agent_run_capacity_reservations_IN32xH7GFuJD_fkey" FOREIGN KEY ("agent_run_id","principal_id") REFERENCES "agent_runs"("agent_run_id","principal_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_myTxsGnWaphE_fkey" FOREIGN KEY ("thread_id","principal_id") REFERENCES "threads"("thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_TD8RYFVnyBKx_fkey" FOREIGN KEY ("user_message_id","thread_id","principal_id") REFERENCES "user_messages"("user_message_id","thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "authentication_sessions" ADD CONSTRAINT "authentication_sessions_sDQk3oH8u53Q_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id");--> statement-breakpoint
ALTER TABLE "outbox_obligations" ADD CONSTRAINT "outbox_obligations_i7cAT50cIV9M_fkey" FOREIGN KEY ("agent_run_id","thread_id","principal_id") REFERENCES "agent_runs"("agent_run_id","thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_thread_id_threads_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("thread_id");--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_Qj3GaShk04VC_fkey" FOREIGN KEY ("thread_id","principal_id") REFERENCES "threads"("thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_k2gA4P59BLPV_fkey" FOREIGN KEY ("user_message_id","thread_id","principal_id") REFERENCES "user_messages"("user_message_id","thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_CiLkR0UZnmVh_fkey" FOREIGN KEY ("agent_run_id","thread_id","principal_id") REFERENCES "agent_runs"("agent_run_id","thread_id","principal_id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_principal_id_principals_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id");--> statement-breakpoint
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_thread_id_threads_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("thread_id");--> statement-breakpoint
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_principal_id_principals_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id");--> statement-breakpoint
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_NBVxNjx8cZMa_fkey" FOREIGN KEY ("thread_id","principal_id") REFERENCES "threads"("thread_id","principal_id");--> statement-breakpoint
CREATE FUNCTION reject_immutable_authority_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER acceptance_receipts_immutable
BEFORE UPDATE OR DELETE ON acceptance_receipts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_authority_mutation();--> statement-breakpoint
CREATE TRIGGER user_messages_immutable
BEFORE UPDATE OR DELETE ON user_messages
FOR EACH ROW EXECUTE FUNCTION reject_immutable_authority_mutation();--> statement-breakpoint
CREATE TRIGGER thread_events_immutable
BEFORE UPDATE OR DELETE ON thread_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_authority_mutation();
