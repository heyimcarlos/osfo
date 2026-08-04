DROP SCHEMA IF EXISTS agent_run_lifecycle CASCADE;
CREATE SCHEMA agent_run_lifecycle;
SET search_path TO agent_run_lifecycle, public;

CREATE TABLE agent_runs (
    run_id text PRIMARY KEY,
    parent_run_id text REFERENCES agent_runs(run_id),
    root_run_id text NOT NULL,
    principal_id text NOT NULL DEFAULT 'default',
    journey_kind text NOT NULL DEFAULT 'full-reference-journey',
    persistence_profile text NOT NULL DEFAULT 'cold-logical-reconstruction',
    workload_ordinal bigint,
    state text NOT NULL CHECK (state IN (
        'pending', 'running', 'waiting', 'retry_ready',
        'succeeded', 'failed', 'canceled'
    )),
    claim_epoch bigint NOT NULL DEFAULT 0,
    wake_count bigint NOT NULL DEFAULT 0,
    owner text,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_at timestamptz,
    CHECK ((state = 'running') = (owner IS NOT NULL)),
    CHECK ((state = 'running') = (lease_until IS NOT NULL))
);

CREATE INDEX agent_runs_claimable_idx
    ON agent_runs (created_at, run_id)
    WHERE state IN ('pending', 'retry_ready');

CREATE INDEX agent_runs_dispatch_claimable_idx
    ON agent_runs (created_at, run_id)
    WHERE workload_ordinal IS NOT NULL
      AND state IN ('pending', 'retry_ready');

CREATE INDEX agent_runs_dispatch_expired_idx
    ON agent_runs (lease_until, created_at, run_id)
    WHERE workload_ordinal IS NOT NULL
      AND state = 'running';

CREATE SEQUENCE root_run_id_seq;

CREATE TABLE admission_receipts (
    idempotency_key text PRIMARY KEY,
    request_hash text NOT NULL,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE threads (
    account_id text NOT NULL,
    thread_id text NOT NULL,
    next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account_id, thread_id)
);

CREATE TABLE thread_events (
    account_id text NOT NULL,
    thread_id text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_id text NOT NULL,
    event_type text NOT NULL,
    content text NOT NULL,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account_id, thread_id, sequence),
    UNIQUE (account_id, event_id),
    FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, thread_id)
);

CREATE INDEX thread_events_resume_idx
    ON thread_events (account_id, thread_id, sequence);

CREATE INDEX thread_events_run_lookup_idx
    ON thread_events (run_id, event_type)
    INCLUDE (account_id, thread_id);

CREATE TABLE message_admission_receipts (
    account_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    thread_id text NOT NULL,
    event_sequence bigint NOT NULL,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account_id, idempotency_key),
    FOREIGN KEY (account_id, thread_id, event_sequence)
        REFERENCES thread_events(account_id, thread_id, sequence)
);

CREATE TABLE stale_commit_rejections (
    rejection_id bigserial PRIMARY KEY,
    run_id text NOT NULL,
    attempted_epoch bigint NOT NULL,
    current_epoch bigint,
    rejected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE interaction_records (
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    sequence bigint NOT NULL,
    record_id text,
    semantic_record text NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id, sequence)
);

CREATE UNIQUE INDEX interaction_records_stable_id_idx
    ON interaction_records (run_id, record_id)
    WHERE record_id IS NOT NULL;

CREATE TABLE child_joins (
    join_id text PRIMARY KEY,
    parent_run_id text NOT NULL REFERENCES agent_runs(run_id),
    mode text NOT NULL CHECK (mode IN ('all_terminal', 'first_successful')),
    settled boolean NOT NULL DEFAULT false,
    settled_at timestamptz
);

CREATE TABLE child_join_members (
    join_id text NOT NULL REFERENCES child_joins(join_id),
    child_run_id text NOT NULL UNIQUE REFERENCES agent_runs(run_id),
    stable_order integer NOT NULL,
    terminal boolean NOT NULL DEFAULT false,
    outcome text,
    PRIMARY KEY (join_id, child_run_id),
    UNIQUE (join_id, stable_order)
);

CREATE TABLE workflow_instances (
    workflow_instance_id text PRIMARY KEY,
    parent_run_id text NOT NULL REFERENCES agent_runs(run_id),
    tool_call_id text NOT NULL UNIQUE,
    mode text NOT NULL CHECK (mode IN ('awaited', 'detached')),
    state text NOT NULL CHECK (state IN ('start_intent', 'started', 'succeeded', 'failed', 'canceled')),
    outcome text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_at timestamptz
);

CREATE TABLE workflow_deliveries (
    delivery_id text PRIMARY KEY,
    workflow_instance_id text NOT NULL REFERENCES workflow_instances(workflow_instance_id),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE workflow_progress_deliveries (
    delivery_id text PRIMARY KEY,
    workflow_instance_id text NOT NULL REFERENCES workflow_instances(workflow_instance_id),
    progress text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE workflow_activities (
    activity_id text PRIMARY KEY,
    workflow_instance_id text NOT NULL REFERENCES workflow_instances(workflow_instance_id),
    state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'canceled')),
    terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE tool_calls (
    tool_call_id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    kind text NOT NULL CHECK (kind IN ('send_email')),
    state text NOT NULL CHECK (state IN (
        'waiting_approval', 'approved', 'rejected', 'running',
        'succeeded', 'failed', 'canceled'
    )),
    attempt_count integer NOT NULL DEFAULT 0,
    terminal_outcome text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_at timestamptz
);

CREATE TABLE approvals (
    approval_id text PRIMARY KEY,
    tool_call_id text NOT NULL UNIQUE REFERENCES tool_calls(tool_call_id),
    state text NOT NULL CHECK (state IN ('open', 'approved', 'rejected', 'canceled')),
    decision_id text UNIQUE,
    decided_at timestamptz
);

CREATE TABLE tool_attempts (
    attempt_id text PRIMARY KEY,
    tool_call_id text NOT NULL REFERENCES tool_calls(tool_call_id),
    claim_epoch bigint NOT NULL,
    state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'unknown')),
    outcome text,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz
);

CREATE TABLE agent_decisions (
    run_id text PRIMARY KEY REFERENCES agent_runs(run_id),
    source text NOT NULL,
    quick_reply boolean NOT NULL,
    child_agent_runs integer NOT NULL CHECK (child_agent_runs >= 0),
    awaited_child_agent_runs integer NOT NULL CHECK (awaited_child_agent_runs >= 0),
    detached_child_agent_runs integer NOT NULL CHECK (detached_child_agent_runs >= 0),
    temporal_workflows integer NOT NULL CHECK (temporal_workflows >= 0),
    temporal_activities integer NOT NULL CHECK (temporal_activities >= 0),
    approvals integer NOT NULL CHECK (approvals >= 0),
    tool_calls integer NOT NULL CHECK (tool_calls >= 0),
    proactive_messages integer NOT NULL CHECK (proactive_messages >= 0),
    scheduled_reminders integer NOT NULL CHECK (scheduled_reminders >= 0),
    sandbox_jobs integer NOT NULL CHECK (sandbox_jobs >= 0),
    artifact_commits integer NOT NULL CHECK (artifact_commits >= 0),
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE proactive_messages (
    proactive_message_id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    state text NOT NULL CHECK (state IN ('delivered', 'failed', 'canceled')),
    terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE scheduled_reminders (
    reminder_id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    workflow_instance_id text NOT NULL REFERENCES workflow_instances(workflow_instance_id),
    state text NOT NULL CHECK (state IN ('scheduled', 'delivered', 'canceled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sandbox_jobs (
    sandbox_job_id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'canceled')),
    terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE artifact_commits (
    artifact_id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES agent_runs(run_id),
    sandbox_job_id text REFERENCES sandbox_jobs(sandbox_job_id),
    state text NOT NULL CHECK (state IN ('committed', 'failed')),
    checksum_verified boolean NOT NULL,
    terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
