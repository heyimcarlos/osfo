DROP SCHEMA IF EXISTS dispatch_prototype CASCADE;
CREATE SCHEMA dispatch_prototype;
SET search_path TO dispatch_prototype, public;

CREATE TABLE settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    global_limit bigint NOT NULL,
    per_principal_limit bigint NOT NULL,
    last_reconciled_at timestamptz NOT NULL DEFAULT '-infinity'
);

CREATE TABLE global_capacity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    non_terminal bigint NOT NULL DEFAULT 0 CHECK (non_terminal >= 0)
);

CREATE TABLE principals (
    id bigint PRIMARY KEY,
    non_terminal bigint NOT NULL DEFAULT 0 CHECK (non_terminal >= 0),
    last_dispatch_order bigint NOT NULL DEFAULT 0,
    ready_count bigint NOT NULL DEFAULT 0 CHECK (ready_count >= 0)
);

CREATE INDEX principals_fair_dispatch_idx
    ON principals (last_dispatch_order, id)
    WHERE ready_count > 0;

CREATE SEQUENCE dispatch_order_seq;

CREATE TABLE threads (
    id bigint PRIMARY KEY,
    principal_id bigint NOT NULL REFERENCES principals(id),
    next_run_sequence bigint NOT NULL DEFAULT 1,
    next_dispatch_sequence bigint NOT NULL DEFAULT 1,
    next_event_position bigint NOT NULL DEFAULT 1
);

CREATE TABLE agent_runs (
    id bigserial PRIMARY KEY,
    principal_id bigint NOT NULL REFERENCES principals(id),
    thread_id bigint NOT NULL REFERENCES threads(id),
    run_sequence bigint NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
    claim_epoch bigint NOT NULL DEFAULT 0,
    owner text,
    lease_until timestamptz,
    attempt integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    first_claimed_at timestamptz,
    claimed_at timestamptz,
    completed_at timestamptz,
    UNIQUE (thread_id, run_sequence)
);

CREATE INDEX agent_runs_dispatch_idx
    ON agent_runs (principal_id, state, created_at, id)
    WHERE state IN ('pending', 'running');
CREATE INDEX agent_runs_thread_sequence_idx
    ON agent_runs (thread_id, run_sequence, state);
CREATE INDEX agent_runs_lease_idx
    ON agent_runs (lease_until)
    WHERE state = 'running';

CREATE TABLE thread_events (
    id bigserial PRIMARY KEY,
    thread_id bigint NOT NULL REFERENCES threads(id),
    position bigint NOT NULL,
    run_id bigint REFERENCES agent_runs(id),
    kind text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (thread_id, position)
);

CREATE TABLE admission_receipts (
    principal_id bigint NOT NULL REFERENCES principals(id),
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    run_id bigint NOT NULL REFERENCES agent_runs(id),
    thread_id bigint NOT NULL REFERENCES threads(id),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, idempotency_key)
);

CREATE TABLE stale_commit_rejections (
    id bigserial PRIMARY KEY,
    run_id bigint NOT NULL,
    attempted_epoch bigint NOT NULL,
    current_epoch bigint,
    attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO settings (global_limit, per_principal_limit) VALUES (1000000, 1000);
INSERT INTO global_capacity DEFAULT VALUES;

CREATE OR REPLACE FUNCTION admit_run(
    p_principal_id bigint,
    p_thread_id bigint,
    p_idempotency_key text,
    p_request_hash text,
    p_notification_count integer DEFAULT 1
) RETURNS TABLE(status text, run_id bigint, accepted_at timestamptz)
LANGUAGE plpgsql
SET search_path TO dispatch_prototype, public
AS $$
DECLARE
    existing admission_receipts%ROWTYPE;
    global_used bigint;
    principal_used bigint;
    configured_global_limit bigint;
    configured_principal_limit bigint;
    allocated_sequence bigint;
    allocated_position bigint;
    dispatch_sequence bigint;
    inserted_run_id bigint;
    inserted_at timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_principal_id::text || ':' || p_idempotency_key, 0));

    SELECT * INTO existing
    FROM admission_receipts
    WHERE principal_id = p_principal_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF existing.request_hash = p_request_hash THEN
            RETURN QUERY SELECT 'idempotent_replay'::text, existing.run_id, existing.accepted_at;
        ELSE
            RETURN QUERY SELECT 'idempotency_conflict'::text, NULL::bigint, NULL::timestamptz;
        END IF;
        RETURN;
    END IF;

    SELECT global_limit, per_principal_limit
    INTO configured_global_limit, configured_principal_limit
    FROM settings WHERE singleton = true;

    SELECT non_terminal INTO global_used
    FROM global_capacity WHERE singleton = true FOR UPDATE;

    SELECT non_terminal INTO principal_used
    FROM principals WHERE id = p_principal_id FOR UPDATE;

    IF global_used >= configured_global_limit THEN
        RETURN QUERY SELECT 'rejected_global_saturation'::text, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;

    IF principal_used >= configured_principal_limit THEN
        RETURN QUERY SELECT 'rejected_principal_saturation'::text, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;

    UPDATE threads
    SET next_run_sequence = next_run_sequence + 1,
        next_event_position = next_event_position + 1
    WHERE id = p_thread_id AND principal_id = p_principal_id
    RETURNING next_run_sequence - 1, next_event_position - 1, next_dispatch_sequence
    INTO allocated_sequence, allocated_position, dispatch_sequence;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'thread % does not belong to principal %', p_thread_id, p_principal_id;
    END IF;

    INSERT INTO agent_runs (principal_id, thread_id, run_sequence, state)
    VALUES (p_principal_id, p_thread_id, allocated_sequence, 'pending')
    RETURNING id, created_at INTO inserted_run_id, inserted_at;

    INSERT INTO thread_events (thread_id, position, run_id, kind)
    VALUES (p_thread_id, allocated_position, inserted_run_id, 'UserMessageAccepted');

    INSERT INTO admission_receipts (
        principal_id, idempotency_key, request_hash, run_id, thread_id, accepted_at
    ) VALUES (
        p_principal_id, p_idempotency_key, p_request_hash, inserted_run_id, p_thread_id, inserted_at
    );

    UPDATE global_capacity SET non_terminal = non_terminal + 1 WHERE singleton = true;
    UPDATE principals
    SET non_terminal = non_terminal + 1,
        ready_count = ready_count + CASE WHEN allocated_sequence = dispatch_sequence THEN 1 ELSE 0 END
    WHERE id = p_principal_id;

    IF p_notification_count > 0 THEN
        FOR notification_index IN 1..p_notification_count LOOP
            PERFORM pg_notify('run_ready', inserted_run_id::text);
        END LOOP;
    END IF;

    RETURN QUERY SELECT 'accepted'::text, inserted_run_id, inserted_at;
END;
$$;

CREATE OR REPLACE FUNCTION claim_next_run(
    p_owner text,
    p_lease_ms bigint
) RETURNS TABLE(
    run_id bigint,
    principal_id bigint,
    thread_id bigint,
    run_sequence bigint,
    claim_epoch bigint,
    created_at timestamptz,
    claimed_at timestamptz
)
LANGUAGE plpgsql
SET search_path TO dispatch_prototype, public
AS $$
DECLARE
    selected_principal bigint;
    selected_run bigint;
BEGIN
    SELECT p.id INTO selected_principal
    FROM principals p
    WHERE p.ready_count > 0
    ORDER BY p.last_dispatch_order, p.id
    FOR UPDATE OF p SKIP LOCKED
    LIMIT 1;

    IF selected_principal IS NULL THEN
        RETURN;
    END IF;

    UPDATE principals
    SET last_dispatch_order = nextval('dispatch_order_seq'),
        ready_count = ready_count - 1
    WHERE id = selected_principal;

    SELECT r.id INTO selected_run
    FROM agent_runs r
    JOIN threads t ON t.id = r.thread_id
    WHERE r.principal_id = selected_principal
      AND r.run_sequence = t.next_dispatch_sequence
      AND r.state = 'pending'
    ORDER BY r.created_at, r.id
    FOR UPDATE OF r SKIP LOCKED
    LIMIT 1;

    IF selected_run IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE agent_runs r
    SET state = 'running',
        owner = p_owner,
        claim_epoch = r.claim_epoch + 1,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0),
        attempt = r.attempt + 1,
        first_claimed_at = COALESCE(r.first_claimed_at, clock_timestamp()),
        claimed_at = clock_timestamp()
    WHERE r.id = selected_run
    RETURNING r.id, r.principal_id, r.thread_id, r.run_sequence,
              r.claim_epoch, r.created_at, r.claimed_at;
END;
$$;

CREATE OR REPLACE FUNCTION reconcile_expired_runs()
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO dispatch_prototype, public
AS $$
DECLARE
    reconciled bigint;
BEGIN
    UPDATE settings
    SET last_reconciled_at = clock_timestamp()
    WHERE singleton = true
      AND last_reconciled_at < clock_timestamp() - interval '1 second';

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    WITH expired AS (
        UPDATE agent_runs
        SET state = 'pending', owner = NULL, lease_until = NULL
        WHERE state = 'running' AND lease_until < clock_timestamp()
        RETURNING 1
    )
    SELECT count(*) INTO reconciled FROM expired;

    WITH authoritative_ready AS (
        SELECT p.id, count(r.id)::bigint AS ready
        FROM principals p
        LEFT JOIN threads t ON t.principal_id = p.id
        LEFT JOIN agent_runs r
          ON r.thread_id = t.id
         AND r.run_sequence = t.next_dispatch_sequence
         AND r.state = 'pending'
        GROUP BY p.id
    )
    UPDATE principals p
    SET ready_count = authoritative_ready.ready
    FROM authoritative_ready
    WHERE p.id = authoritative_ready.id
      AND p.ready_count IS DISTINCT FROM authoritative_ready.ready;

    RETURN reconciled;
END;
$$;

CREATE OR REPLACE FUNCTION complete_run(
    p_run_id bigint,
    p_claim_epoch bigint,
    p_fragment_count integer DEFAULT 5
) RETURNS boolean
LANGUAGE plpgsql
SET search_path TO dispatch_prototype, public
AS $$
DECLARE
    current_run agent_runs%ROWTYPE;
    start_position bigint;
BEGIN
    SELECT * INTO current_run FROM agent_runs WHERE id = p_run_id FOR UPDATE;

    IF NOT FOUND OR current_run.state <> 'running' OR current_run.claim_epoch <> p_claim_epoch THEN
        INSERT INTO stale_commit_rejections (run_id, attempted_epoch, current_epoch)
        VALUES (p_run_id, p_claim_epoch, CASE WHEN FOUND THEN current_run.claim_epoch ELSE NULL END);
        RETURN false;
    END IF;

    UPDATE threads
    SET next_event_position = next_event_position + p_fragment_count + 1,
        next_dispatch_sequence = next_dispatch_sequence + 1
    WHERE id = current_run.thread_id
      AND next_dispatch_sequence = current_run.run_sequence
    RETURNING next_event_position - p_fragment_count - 1 INTO start_position;

    IF NOT FOUND THEN
        INSERT INTO stale_commit_rejections (run_id, attempted_epoch, current_epoch)
        VALUES (p_run_id, p_claim_epoch, current_run.claim_epoch);
        RETURN false;
    END IF;

    INSERT INTO thread_events (thread_id, position, run_id, kind)
    SELECT current_run.thread_id,
           start_position + fragment_index - 1,
           p_run_id,
           'AssistantOutputAppended'
    FROM generate_series(1, p_fragment_count) AS fragment_index;

    INSERT INTO thread_events (thread_id, position, run_id, kind)
    VALUES (
        current_run.thread_id,
        start_position + p_fragment_count,
        p_run_id,
        'AssistantOutputCompleted'
    );

    UPDATE agent_runs
    SET state = 'succeeded', completed_at = clock_timestamp(), lease_until = NULL
    WHERE id = p_run_id;

    UPDATE global_capacity SET non_terminal = non_terminal - 1 WHERE singleton = true;
    UPDATE principals SET non_terminal = non_terminal - 1 WHERE id = current_run.principal_id;

    IF EXISTS (
        SELECT 1 FROM agent_runs
        WHERE thread_id = current_run.thread_id
          AND run_sequence = current_run.run_sequence + 1
          AND state = 'pending'
    ) THEN
        UPDATE principals SET ready_count = ready_count + 1 WHERE id = current_run.principal_id;
    END IF;
    RETURN true;
END;
$$;
