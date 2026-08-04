CREATE TYPE agent_run_state AS ENUM ('pending', 'running', 'succeeded', 'canceled');

CREATE TABLE benchmarks (
    id uuid PRIMARY KEY,
    candidate text NOT NULL,
    lane text NOT NULL,
    expected_runs integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    offer_started_at timestamptz,
    offer_ended_at timestamptz
);

CREATE TABLE agent_runs (
    id uuid PRIMARY KEY,
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    ordinal integer NOT NULL,
    thread_key text NOT NULL,
    thread_sequence integer NOT NULL,
    workload_ms integer NOT NULL,
    state agent_run_state NOT NULL DEFAULT 'pending',
    claim_epoch bigint NOT NULL DEFAULT 0,
    lease_owner text,
    lease_expires_at timestamptz,
    first_published_at timestamptz,
    first_claimed_at timestamptz,
    completed_at timestamptz,
    terminal_commits integer NOT NULL DEFAULT 0,
    crash_once boolean NOT NULL DEFAULT false,
    crash_injected boolean NOT NULL DEFAULT false,
    UNIQUE (benchmark_id, ordinal),
    UNIQUE (benchmark_id, thread_key, thread_sequence),
    CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK ((state IN ('succeeded', 'canceled')) = (completed_at IS NOT NULL))
);

CREATE TABLE delivery_attempts (
    id bigserial PRIMARY KEY,
    benchmark_id uuid NOT NULL,
    agent_run_id uuid NOT NULL,
    protocol text NOT NULL,
    message_id text NOT NULL,
    broker_attempt integer NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    outcome text NOT NULL
);

CREATE INDEX agent_runs_benchmark_state ON agent_runs (benchmark_id, state);
CREATE INDEX agent_runs_thread_order ON agent_runs (benchmark_id, thread_key, thread_sequence);
CREATE INDEX delivery_attempts_benchmark ON delivery_attempts (benchmark_id, received_at);
