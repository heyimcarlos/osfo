CREATE TABLE b3_admissions (
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    ordinal integer NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    root_agent_run_id uuid NOT NULL,
    agent_run_ids uuid[] NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (benchmark_id, ordinal),
    UNIQUE (idempotency_key),
    CHECK (cardinality(agent_run_ids) IN (1, 2)),
    CHECK (agent_run_ids[1] = root_agent_run_id)
);

CREATE SEQUENCE b3_outbox_sequence;

CREATE TABLE b3_outbox_sequence_gate (
    shard smallint PRIMARY KEY CHECK (shard BETWEEN 0 AND 3),
    next_sequence bigint NOT NULL DEFAULT 0
) WITH (fillfactor = 50);

INSERT INTO b3_outbox_sequence_gate (shard)
SELECT generate_series(0, 3);

CREATE TABLE b3_outbox (
    retention_bucket date NOT NULL DEFAULT current_date,
    sequence bigint NOT NULL DEFAULT nextval('b3_outbox_sequence'),
    shard_sequence bigint NOT NULL,
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    ordinal integer NOT NULL,
    agent_run_id uuid NOT NULL,
    delivery_id text NOT NULL,
    ordering_key text NOT NULL,
    shard smallint NOT NULL,
    ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (retention_bucket, sequence),
    CHECK (shard BETWEEN 0 AND 3)
) PARTITION BY RANGE (retention_bucket);

DO $migration$
DECLARE
    bucket date := current_date;
BEGIN
    EXECUTE format(
        'CREATE TABLE b3_outbox_%s PARTITION OF b3_outbox FOR VALUES FROM (%L) TO (%L)',
        to_char(bucket, 'YYYYMMDD'), bucket, bucket + 1
    );
    EXECUTE format(
        'CREATE TABLE b3_outbox_%s PARTITION OF b3_outbox FOR VALUES FROM (%L) TO (%L)',
        to_char(bucket + 1, 'YYYYMMDD'), bucket + 1, bucket + 2
    );
END
$migration$;

CREATE TABLE b3_relay_progress (
    shard smallint PRIMARY KEY CHECK (shard BETWEEN 0 AND 3),
    last_sequence bigint NOT NULL DEFAULT 0,
    advanced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO b3_relay_progress (shard)
SELECT generate_series(0, 3);

CREATE TABLE b3_attempt_evidence (
    id bigserial PRIMARY KEY,
    benchmark_id uuid NOT NULL,
    ordinal integer NOT NULL,
    attempt integer NOT NULL,
    fault text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    authority_committed_at timestamptz,
    response_completed_at timestamptz,
    caller_outcome text NOT NULL DEFAULT 'in_flight',
    error_class text,
    UNIQUE (benchmark_id, ordinal, attempt)
);

CREATE TABLE b3_publish_evidence (
    id bigserial PRIMARY KEY,
    outbox_sequence bigint NOT NULL,
    benchmark_id uuid NOT NULL,
    agent_run_id uuid NOT NULL,
    delivery_id text NOT NULL,
    relay_owner text NOT NULL,
    requested_at timestamptz NOT NULL,
    provider_message_id text,
    provider_confirmed_at timestamptz,
    observed_outcome text NOT NULL
);

CREATE INDEX b3_outbox_shard_sequence ON b3_outbox (shard, shard_sequence);
CREATE INDEX b3_outbox_benchmark ON b3_outbox (benchmark_id, agent_run_id);
CREATE INDEX b3_attempts_benchmark ON b3_attempt_evidence (benchmark_id, ordinal, attempt);
CREATE INDEX b3_publications_benchmark ON b3_publish_evidence (benchmark_id, agent_run_id);

-- Candidate logic reads only b3_outbox and b3_relay_progress. The admissions,
-- AgentRun, attempt, publication, and delivery tables are audit evidence only.
