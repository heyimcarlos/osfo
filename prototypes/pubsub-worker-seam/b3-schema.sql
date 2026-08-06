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
    principal_key text,
    thread_key text,
    thread_sequence integer,
    delivery_id text NOT NULL,
    ordering_key text NOT NULL,
    shard smallint NOT NULL,
    sequence_stripe smallint NOT NULL,
    ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    fair_selected_at timestamptz,
    fair_published_at timestamptz,
    fair_permit_released_at timestamptz,
    PRIMARY KEY (retention_bucket, sequence),
    CHECK (shard BETWEEN 0 AND 3),
    CHECK (sequence_stripe BETWEEN 0 AND 63),
    CHECK ((principal_key IS NULL) = (thread_key IS NULL)),
    CHECK ((principal_key IS NULL) = (thread_sequence IS NULL)),
    CHECK (fair_published_at IS NULL OR fair_selected_at IS NOT NULL),
    CHECK (fair_permit_released_at IS NULL OR fair_selected_at IS NOT NULL),
    CHECK (shard = sequence_stripe % 4)
) PARTITION BY RANGE (retention_bucket);

CREATE TABLE b3_fair_dispatch_budget (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    capacity integer NOT NULL CHECK (capacity > 0),
    principal_capacity integer NOT NULL CHECK (principal_capacity > 0),
    in_use integer NOT NULL DEFAULT 0 CHECK (in_use >= 0 AND in_use <= capacity),
    virtual_time bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE b3_fair_dispatch_permits (
    slot integer PRIMARY KEY CHECK (slot > 0),
    agent_run_id uuid UNIQUE REFERENCES agent_runs(id),
    selected_at timestamptz,
    CHECK ((agent_run_id IS NULL) = (selected_at IS NULL))
);

-- Active publication work is separate from execution permits. The selector
-- creates these rows atomically, then publishers claim them after the selector
-- lock has been released. Completed rows are deleted so this hot relation is
-- bounded by active obligations rather than retained history.
CREATE TABLE b3_fair_publication_tasks (
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
    outbox_sequence bigint NOT NULL,
    owner text,
    lease_acquired_at timestamptz,
    lease_expires_at timestamptz,
    publish_epoch bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (benchmark_id, agent_run_id),
    CHECK ((owner IS NULL) = (lease_acquired_at IS NULL)),
    CHECK ((owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK (publish_epoch >= 0)
);

CREATE TABLE b3_fair_principals (
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    principal_key text NOT NULL,
    virtual_pass bigint NOT NULL DEFAULT 0,
    selected_count bigint NOT NULL DEFAULT 0,
    last_selected_at timestamptz,
    PRIMARY KEY (benchmark_id, principal_key)
);

CREATE TABLE b3_fair_principal_budget (
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    principal_key text NOT NULL,
    budget_stripe smallint NOT NULL CHECK (budget_stripe BETWEEN 0 AND 15),
    capacity integer NOT NULL CHECK (capacity >= 0),
    in_use integer NOT NULL DEFAULT 0 CHECK (in_use >= 0 AND in_use <= capacity),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (benchmark_id, principal_key, budget_stripe),
    FOREIGN KEY (benchmark_id, principal_key)
        REFERENCES b3_fair_principals(benchmark_id, principal_key)
) WITH (fillfactor = 50);

CREATE TABLE b3_fair_threads (
    benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
    principal_key text NOT NULL,
    thread_key text NOT NULL,
    next_admission_sequence integer NOT NULL DEFAULT 0,
    next_dispatch_sequence integer NOT NULL DEFAULT 0,
    virtual_pass bigint NOT NULL DEFAULT 0,
    queued_count integer NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
    in_flight boolean NOT NULL DEFAULT false,
    selected_count bigint NOT NULL DEFAULT 0,
    last_selected_at timestamptz,
    PRIMARY KEY (benchmark_id, principal_key, thread_key),
    FOREIGN KEY (benchmark_id, principal_key)
        REFERENCES b3_fair_principals(benchmark_id, principal_key)
);

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
    publication_epoch bigint,
    lease_acquired_at timestamptz,
    lease_expires_at timestamptz,
    requested_at timestamptz NOT NULL,
    provider_message_id text,
    provider_confirmed_at timestamptz,
    observed_outcome text NOT NULL
);

CREATE INDEX b3_outbox_stripe_sequence ON b3_outbox (sequence_stripe, stripe_sequence);
CREATE INDEX b3_outbox_sequence_lookup ON b3_outbox (sequence);
CREATE INDEX b3_outbox_benchmark ON b3_outbox (benchmark_id, agent_run_id);
CREATE INDEX b3_outbox_fair_thread_head ON b3_outbox
    (benchmark_id, principal_key, thread_key, thread_sequence)
WHERE principal_key IS NOT NULL;
CREATE INDEX b3_outbox_fair_recovery ON b3_outbox (fair_selected_at, sequence)
WHERE fair_selected_at IS NOT NULL AND fair_published_at IS NULL;
CREATE INDEX b3_outbox_fair_active_permits ON b3_outbox (fair_selected_at, sequence)
WHERE fair_selected_at IS NOT NULL AND fair_permit_released_at IS NULL;
CREATE INDEX b3_fair_publication_claimable ON b3_fair_publication_tasks
    (lease_expires_at, created_at, outbox_sequence);
CREATE INDEX b3_fair_principals_order ON b3_fair_principals
    (virtual_pass, principal_key);
CREATE INDEX b3_fair_threads_ready ON b3_fair_threads
    (benchmark_id, principal_key, virtual_pass, thread_key)
WHERE queued_count > 0 AND NOT in_flight;

CREATE OR REPLACE FUNCTION b3_select_fair_batch(selection_limit integer)
RETURNS TABLE (
    sequence bigint,
    stripe_sequence bigint,
    benchmark_id uuid,
    ordinal integer,
    agent_run_id uuid,
    principal_key text,
    thread_key text,
    thread_sequence integer,
    delivery_id text,
    ordering_key text,
    shard smallint,
    sequence_stripe smallint,
    ready_at timestamptz,
    fair_selected_at timestamptz,
    fair_published_at timestamptz
)
LANGUAGE sql
AS $function$
WITH free_permits AS MATERIALIZED (
    SELECT p.slot,
           row_number() OVER (ORDER BY p.slot) AS permit_rank
    FROM b3_fair_dispatch_permits p
    WHERE p.agent_run_id IS NULL
    ORDER BY p.slot
    LIMIT selection_limit
),
eligible AS MATERIALIZED (
    SELECT p.benchmark_id,
           p.principal_key,
           p.virtual_pass,
           t.thread_key,
           t.next_dispatch_sequence,
           row_number() OVER (
               PARTITION BY p.benchmark_id, p.principal_key
               ORDER BY t.virtual_pass, t.thread_key
           ) AS principal_rank
    FROM b3_fair_threads t
    JOIN b3_fair_principals p
      ON p.benchmark_id = t.benchmark_id
     AND p.principal_key = t.principal_key
    WHERE t.queued_count > 0 AND NOT t.in_flight
),
chosen AS MATERIALIZED (
    SELECT ranked.*,
           row_number() OVER (
               ORDER BY ranked.dispatch_pass, ranked.benchmark_id,
                        ranked.principal_key, ranked.principal_rank
           ) AS dispatch_rank
    FROM (
        SELECT e.*,
               e.virtual_pass + e.principal_rank - 1 AS dispatch_pass
        FROM eligible e
    ) ranked
    ORDER BY ranked.dispatch_pass, ranked.benchmark_id,
             ranked.principal_key, ranked.principal_rank
    LIMIT (SELECT count(*) FROM free_permits)
),
chosen_slots AS MATERIALIZED (
    SELECT c.*, permits.slot
    FROM chosen c
    JOIN free_permits permits ON permits.permit_rank = c.dispatch_rank
),
principal_counts AS MATERIALIZED (
    SELECT c.benchmark_id, c.principal_key,
           count(*)::bigint AS selected_count
    FROM chosen_slots c
    GROUP BY c.benchmark_id, c.principal_key
),
updated_principals AS (
    UPDATE b3_fair_principals p
    SET selected_count = p.selected_count + counts.selected_count,
        virtual_pass = p.virtual_pass + counts.selected_count,
        last_selected_at = clock_timestamp()
    FROM principal_counts counts
    WHERE p.benchmark_id = counts.benchmark_id
      AND p.principal_key = counts.principal_key
    RETURNING p.benchmark_id, p.principal_key
),
updated_threads AS (
    UPDATE b3_fair_threads t
    SET queued_count = t.queued_count - 1,
        in_flight = true,
        next_dispatch_sequence = t.next_dispatch_sequence + 1,
        virtual_pass = t.virtual_pass + 1,
        selected_count = t.selected_count + 1,
        last_selected_at = clock_timestamp()
    FROM chosen_slots c
    WHERE t.benchmark_id = c.benchmark_id
      AND t.principal_key = c.principal_key
      AND t.thread_key = c.thread_key
      AND t.queued_count > 0 AND NOT t.in_flight
    RETURNING t.benchmark_id, t.principal_key, t.thread_key
),
selected_outbox AS (
    UPDATE b3_outbox o
    SET fair_selected_at = clock_timestamp()
    FROM chosen_slots c
    WHERE o.benchmark_id = c.benchmark_id
      AND o.principal_key = c.principal_key
      AND o.thread_key = c.thread_key
      AND o.thread_sequence = c.next_dispatch_sequence
      AND o.fair_selected_at IS NULL
    RETURNING o.sequence, o.stripe_sequence, o.benchmark_id, o.ordinal,
              o.agent_run_id, o.principal_key, o.thread_key, o.thread_sequence,
              o.delivery_id, o.ordering_key, o.shard, o.sequence_stripe,
              o.ready_at, o.fair_selected_at, o.fair_published_at
),
created_publication_tasks AS (
    INSERT INTO b3_fair_publication_tasks
        (benchmark_id, agent_run_id, outbox_sequence)
    SELECT benchmark_id, agent_run_id, sequence
    FROM selected_outbox
    ON CONFLICT (benchmark_id, agent_run_id) DO NOTHING
    RETURNING benchmark_id, agent_run_id
),
updated_permits AS (
    UPDATE b3_fair_dispatch_permits p
    SET agent_run_id = selected.agent_run_id,
        selected_at = selected.fair_selected_at
    FROM selected_outbox selected
    JOIN chosen_slots c
      ON c.benchmark_id = selected.benchmark_id
     AND c.principal_key = selected.principal_key
     AND c.thread_key = selected.thread_key
    WHERE p.slot = c.slot AND p.agent_run_id IS NULL
    RETURNING p.slot
),
updated_budget AS (
    UPDATE b3_fair_dispatch_budget b
    SET virtual_time = summary.max_dispatch_pass,
        updated_at = clock_timestamp()
    FROM (
        SELECT max(c.dispatch_pass) AS max_dispatch_pass
        FROM chosen_slots c
    ) summary
    WHERE b.singleton AND summary.max_dispatch_pass IS NOT NULL
    RETURNING b.singleton
)
SELECT o.sequence, o.stripe_sequence, o.benchmark_id, o.ordinal,
       o.agent_run_id, o.principal_key, o.thread_key, o.thread_sequence,
       o.delivery_id, o.ordering_key, o.shard, o.sequence_stripe,
       o.ready_at, o.fair_selected_at, o.fair_published_at
FROM selected_outbox o
JOIN chosen_slots c ON c.benchmark_id = o.benchmark_id
                   AND c.principal_key = o.principal_key
                   AND c.thread_key = o.thread_key
CROSS JOIN (SELECT count(*) FROM updated_principals) principal_updates
CROSS JOIN (SELECT count(*) FROM updated_threads) thread_updates
CROSS JOIN (SELECT count(*) FROM created_publication_tasks) publication_task_updates
CROSS JOIN (SELECT count(*) FROM updated_permits) permit_updates
CROSS JOIN (SELECT count(*) FROM updated_budget) budget_updates
ORDER BY c.dispatch_pass, c.benchmark_id, c.principal_key, c.principal_rank
$function$;

CREATE INDEX b3_attempts_benchmark ON b3_attempt_evidence (benchmark_id, ordinal, attempt);
CREATE INDEX b3_publications_benchmark ON b3_publish_evidence (benchmark_id, agent_run_id);
CREATE INDEX b3_publications_outbox_sequence ON b3_publish_evidence (outbox_sequence)
WHERE provider_confirmed_at IS NOT NULL;

-- Candidate logic reads only b3_outbox and b3_relay_progress. The admissions,
-- AgentRun, attempt, publication, and delivery tables are audit evidence only.
