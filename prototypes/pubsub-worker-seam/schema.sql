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
    principal_key text,
    thread_key text NOT NULL,
    thread_sequence integer NOT NULL,
    workload_ms integer NOT NULL,
    execution_profile_ref text NOT NULL DEFAULT 'benchmark/deterministic-v1',
    budget_stripe smallint,
    principal_budget_stripe smallint,
    fair_dispatch boolean NOT NULL DEFAULT false,
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
    CHECK (budget_stripe IS NULL OR budget_stripe BETWEEN 0 AND 63),
    CHECK (principal_budget_stripe IS NULL OR principal_budget_stripe BETWEEN 0 AND 15),
    CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK ((state IN ('succeeded', 'canceled')) = (completed_at IS NOT NULL))
);

CREATE TABLE agent_run_attempts (
    agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
    claim_epoch bigint NOT NULL,
    benchmark_id uuid NOT NULL,
    lease_owner text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    outcome text,
    PRIMARY KEY (agent_run_id, claim_epoch),
    CHECK ((completed_at IS NULL) = (outcome IS NULL))
);

CREATE TABLE model_calls (
    id uuid PRIMARY KEY,
    agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
    call_ordinal integer NOT NULL,
    normalized_intent text NOT NULL,
    logical_status text NOT NULL DEFAULT 'pending',
    final_outcome text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    UNIQUE (agent_run_id, call_ordinal),
    CHECK ((logical_status = 'succeeded') = (final_outcome IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE model_call_attempts (
    id uuid PRIMARY KEY,
    model_call_id uuid NOT NULL REFERENCES model_calls(id),
    agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
    claim_epoch bigint NOT NULL,
    attempt_ordinal integer NOT NULL,
    binding_ref text NOT NULL,
    adapter_compatibility_identity text NOT NULL,
    idempotency_key text NOT NULL,
    dispatch_evidence text NOT NULL DEFAULT 'not_dispatched',
    outcome text,
    usage_status text,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    UNIQUE (model_call_id, attempt_ordinal),
    UNIQUE (idempotency_key),
    FOREIGN KEY (agent_run_id, claim_epoch) REFERENCES agent_run_attempts(agent_run_id, claim_epoch),
    CHECK ((completed_at IS NULL) = (outcome IS NULL)),
    CHECK (usage_status IS NULL OR usage_status IN ('reported', 'estimated', 'unknown'))
);

CREATE TABLE delivery_attempts (
    id bigserial PRIMARY KEY,
    benchmark_id uuid NOT NULL,
    agent_run_id uuid NOT NULL,
    protocol text NOT NULL,
    message_id text NOT NULL,
    broker_attempt integer NOT NULL,
    published_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    slot_acquired_at timestamptz,
    database_acquire_started_at timestamptz,
    database_acquired_at timestamptz,
    claim_completed_at timestamptz,
    terminal_started_at timestamptz,
    terminal_evidence_at timestamptz,
    outcome text NOT NULL
);

CREATE INDEX agent_runs_benchmark_state ON agent_runs (benchmark_id, state);
CREATE INDEX agent_runs_principal_state ON agent_runs (benchmark_id, principal_key, state)
WHERE principal_key IS NOT NULL;
CREATE INDEX agent_runs_thread_order ON agent_runs (benchmark_id, thread_key, thread_sequence);
CREATE INDEX agent_run_attempts_benchmark ON agent_run_attempts (benchmark_id, started_at);
CREATE INDEX model_calls_agent_run ON model_calls (agent_run_id, call_ordinal);
CREATE INDEX model_call_attempts_agent_run ON model_call_attempts (agent_run_id, attempt_ordinal);
CREATE INDEX delivery_attempts_benchmark ON delivery_attempts (benchmark_id, received_at);
