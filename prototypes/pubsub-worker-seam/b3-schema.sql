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

CREATE TABLE b3_inflight_budget (
    budget_stripe smallint PRIMARY KEY CHECK (budget_stripe BETWEEN 0 AND 63),
    capacity integer NOT NULL CHECK (capacity >= 0),
    in_use integer NOT NULL DEFAULT 0 CHECK (in_use >= 0 AND in_use <= capacity),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
) WITH (fillfactor = 50);

INSERT INTO b3_inflight_budget (budget_stripe, capacity)
SELECT generate_series(0, 63), 0;

CREATE SEQUENCE b3_outbox_sequence;

CREATE TABLE b3_outbox_sequence_gate (
    sequence_stripe smallint PRIMARY KEY CHECK (sequence_stripe BETWEEN 0 AND 63),
    next_sequence bigint NOT NULL DEFAULT 0
) WITH (fillfactor = 50);

INSERT INTO b3_outbox_sequence_gate (sequence_stripe)
SELECT generate_series(0, 63);

CREATE TABLE b3_outbox (
    retention_bucket date NOT NULL DEFAULT current_date,
    sequence bigint NOT NULL DEFAULT nextval('b3_outbox_sequence'),
    stripe_sequence bigint NOT NULL,
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    ordinal integer NOT NULL,
    agent_run_id uuid NOT NULL,
    delivery_id text NOT NULL,
    ordering_key text NOT NULL,
    shard smallint NOT NULL,
    sequence_stripe smallint NOT NULL,
    ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (retention_bucket, sequence),
    CHECK (shard BETWEEN 0 AND 3),
    CHECK (sequence_stripe BETWEEN 0 AND 63),
    CHECK (shard = sequence_stripe % 4)
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
    sequence_stripe smallint PRIMARY KEY CHECK (sequence_stripe BETWEEN 0 AND 63),
    last_sequence bigint NOT NULL DEFAULT 0,
    advanced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO b3_relay_progress (sequence_stripe)
SELECT generate_series(0, 63);

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

CREATE INDEX b3_outbox_stripe_sequence ON b3_outbox (sequence_stripe, stripe_sequence);
CREATE INDEX b3_outbox_sequence_lookup ON b3_outbox (sequence);
CREATE INDEX b3_outbox_benchmark ON b3_outbox (benchmark_id, agent_run_id);
CREATE INDEX b3_attempts_benchmark ON b3_attempt_evidence (benchmark_id, ordinal, attempt);
CREATE INDEX b3_publications_benchmark ON b3_publish_evidence (benchmark_id, agent_run_id);
CREATE INDEX b3_publications_outbox_sequence ON b3_publish_evidence (outbox_sequence)
WHERE provider_confirmed_at IS NOT NULL;

-- Candidate logic reads only b3_outbox and b3_relay_progress. The admissions,
-- AgentRun, attempt, publication, and delivery tables are audit evidence only.
