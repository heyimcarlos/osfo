CREATE TYPE b2_ordering AS ENUM ('database_first', 'publish_first', 'concurrent');

CREATE TABLE b2_admissions (
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    ordinal integer NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    ordering b2_ordering NOT NULL,
    root_agent_run_id uuid NOT NULL,
    agent_run_ids uuid[] NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (benchmark_id, ordinal),
    UNIQUE (idempotency_key),
    CHECK (cardinality(agent_run_ids) IN (1, 2)),
    CHECK (agent_run_ids[1] = root_agent_run_id)
);

CREATE TABLE b2_attempt_evidence (
    id bigserial PRIMARY KEY,
    benchmark_id uuid NOT NULL,
    ordinal integer NOT NULL,
    attempt integer NOT NULL,
    ordering b2_ordering NOT NULL,
    fault text NOT NULL,
    retry_expected boolean NOT NULL,
    started_at timestamptz NOT NULL,
    authority_committed_at timestamptz,
    publish_requested_at timestamptz,
    publish_confirmed_at timestamptz,
    response_completed_at timestamptz,
    caller_outcome text NOT NULL,
    provider_message_ids text[] NOT NULL DEFAULT '{}',
    error_class text,
    UNIQUE (benchmark_id, ordinal, attempt)
);

CREATE TABLE b2_publish_evidence (
    id bigserial PRIMARY KEY,
    benchmark_id uuid NOT NULL,
    ordinal integer NOT NULL,
    attempt integer NOT NULL,
    agent_run_id uuid NOT NULL,
    delivery_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    provider_message_id text,
    provider_confirmed_at timestamptz,
    observed_outcome text NOT NULL
);

CREATE INDEX b2_attempts_benchmark ON b2_attempt_evidence (benchmark_id, ordinal, attempt);
CREATE INDEX b2_publications_benchmark ON b2_publish_evidence (benchmark_id, agent_run_id);

-- Evidence tables are write-only during offer and drain windows. Candidate
-- logic never reads them and no process scans b2_admissions or agent_runs to
-- discover unpublished work. They exist only for the post-window audit.
