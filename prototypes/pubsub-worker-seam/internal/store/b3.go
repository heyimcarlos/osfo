package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	B3RelayShards            = 4
	B3DefaultSequenceStripes = 4
	B3MaxSequenceStripes     = 64
)

type B3Request struct {
	BenchmarkID uuid.UUID `json:"benchmark_id"`
	Ordinal     int       `json:"ordinal"`
	Attempt     int       `json:"attempt"`
	Idempotency string    `json:"idempotency_key"`
	RequestHash string    `json:"request_hash"`
	Fault       string    `json:"fault"`
	HardCrash   bool      `json:"hard_crash"`
}

type B3Receipt struct {
	BenchmarkID      uuid.UUID   `json:"benchmark_id"`
	Ordinal          int         `json:"ordinal"`
	RootAgentRunID   uuid.UUID   `json:"root_agent_run_id"`
	AgentRunIDs      []uuid.UUID `json:"agent_run_ids"`
	AcceptedAt       time.Time   `json:"accepted_at"`
	IdempotentReplay bool        `json:"idempotent_replay"`
}

type B3Result struct {
	Receipt       *B3Receipt `json:"receipt,omitempty"`
	CallerOutcome string     `json:"caller_outcome"`
	ErrorClass    string     `json:"error_class,omitempty"`
}

type B3OutboxRecord struct {
	Sequence       int64
	StripeSequence int64
	BenchmarkID    uuid.UUID
	Ordinal        int
	AgentRunID     uuid.UUID
	DeliveryID     string
	OrderingKey    string
	Shard          int
	SequenceStripe int
	ReadyAt        time.Time
}

type B3Publication struct {
	Record      B3OutboxRecord
	RequestedAt time.Time
	ConfirmedAt *time.Time
	MessageID   string
	Outcome     string
}

type B3Audit struct {
	BenchmarkID              uuid.UUID        `json:"benchmark_id"`
	Candidate                string           `json:"candidate"`
	Lane                     string           `json:"lane"`
	ExpectedIncoming         int64            `json:"expected_incoming"`
	ExpectedAgentRuns        int64            `json:"expected_agent_runs"`
	AcceptedIncoming         int64            `json:"accepted_incoming"`
	AuthoritativeAgentRuns   int64            `json:"authoritative_agent_runs"`
	SucceededAgentRuns       int64            `json:"succeeded_agent_runs"`
	NonterminalAgentRuns     int64            `json:"nonterminal_agent_runs"`
	OutboxRecords            int64            `json:"outbox_records"`
	UnpublishedOutboxRecords int64            `json:"unpublished_outbox_records"`
	StrandedAcceptedRuns     int64            `json:"stranded_accepted_runs"`
	GhostDeliveryAttempts    int64            `json:"ghost_delivery_attempts"`
	DuplicatePublications    int64            `json:"duplicate_publications"`
	DuplicateTerminalCommits int64            `json:"duplicate_terminal_commits"`
	UnknownCallerOutcomes    int64            `json:"unknown_caller_outcomes"`
	PublishAttempts          int64            `json:"publish_attempts"`
	ConfirmedPublications    int64            `json:"confirmed_publications"`
	DeliveryAttempts         int64            `json:"delivery_attempts"`
	DeliveryAttemptOutcomes  map[string]int64 `json:"delivery_attempt_outcomes"`
	RelayProgress            map[int]int64    `json:"relay_progress"`
	CallerToReceiptMS        map[string]any   `json:"caller_to_receipt_ms"`
	ReadyToPublishMS         map[string]any   `json:"outbox_ready_to_publish_confirmation_ms"`
	PublishToClaimMS         map[string]any   `json:"publish_to_point_claim_ms"`
	ClaimToTerminalMS        map[string]any   `json:"claim_to_terminal_ms"`
	OutboxTableBytes         int64            `json:"outbox_table_bytes"`
	OutboxIndexBytes         int64            `json:"outbox_index_bytes"`
	OutboxDeadTuples         int64            `json:"outbox_dead_tuples"`
	RelayGateDeadTuples      int64            `json:"relay_gate_dead_tuples"`
	Verdict                  string           `json:"verdict"`
}

func B3AgentRunIDs(benchmarkID uuid.UUID, ordinal int) []uuid.UUID {
	namespace := uuid.NewSHA1(uuid.NameSpaceURL, []byte("osfo-b3/"+benchmarkID.String()))
	count := 1
	if ordinal%2 == 1 {
		count = 2
	}
	ids := make([]uuid.UUID, 0, count)
	for run := 0; run < count; run++ {
		ids = append(ids, uuid.NewSHA1(namespace, []byte(fmt.Sprintf("%d/%d", ordinal, run))))
	}
	return ids
}

func (s *Store) PrepareB3(ctx context.Context, id uuid.UUID, candidate, lane string, expectedIncoming int) error {
	expectedRuns := expectedIncoming + expectedIncoming/2
	_, err := s.pool.Exec(ctx, `
		INSERT INTO benchmarks (id, candidate, lane, expected_runs)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING`, id, candidate, lane, expectedRuns)
	return err
}

func (s *Store) BeginB3Attempt(ctx context.Context, request B3Request) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO b3_attempt_evidence (benchmark_id, ordinal, attempt, fault)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (benchmark_id, ordinal, attempt) DO NOTHING`,
		request.BenchmarkID, request.Ordinal, request.Attempt, request.Fault)
	return err
}

func (s *Store) FinishB3Attempt(ctx context.Context, request B3Request, outcome, errorClass string, authorityCommitted, responded bool) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE b3_attempt_evidence
		SET authority_committed_at = CASE WHEN $4 THEN COALESCE(authority_committed_at, clock_timestamp()) ELSE authority_committed_at END,
		    response_completed_at = CASE WHEN $5 THEN clock_timestamp() ELSE response_completed_at END,
		    caller_outcome = $6,
		    error_class = NULLIF($7, '')
		WHERE benchmark_id = $1 AND ordinal = $2 AND attempt = $3`,
		request.BenchmarkID, request.Ordinal, request.Attempt, authorityCommitted, responded, outcome, errorClass)
	return err
}

func (s *Store) AcceptB3(ctx context.Context, request B3Request, sequenceStripes int) (B3Receipt, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return B3Receipt{}, err
	}
	defer tx.Rollback(ctx)

	var existing B3Receipt
	var existingHash string
	err = tx.QueryRow(ctx, `
		SELECT benchmark_id, ordinal, root_agent_run_id, agent_run_ids, accepted_at, request_hash
		FROM b3_admissions WHERE idempotency_key = $1 FOR UPDATE`, request.Idempotency).Scan(
		&existing.BenchmarkID, &existing.Ordinal, &existing.RootAgentRunID,
		&existing.AgentRunIDs, &existing.AcceptedAt, &existingHash,
	)
	if err == nil {
		if existingHash != request.RequestHash || existing.BenchmarkID != request.BenchmarkID || existing.Ordinal != request.Ordinal {
			return B3Receipt{}, fmt.Errorf("idempotency key reused with different input")
		}
		existing.IdempotentReplay = true
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return B3Receipt{}, err
	}

	ids := B3AgentRunIDs(request.BenchmarkID, request.Ordinal)
	var acceptedAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO b3_admissions
			(benchmark_id, ordinal, idempotency_key, request_hash, root_agent_run_id, agent_run_ids)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING accepted_at`, request.BenchmarkID, request.Ordinal, request.Idempotency,
		request.RequestHash, ids[0], ids).Scan(&acceptedAt)
	if err != nil {
		return B3Receipt{}, err
	}
	threadKey := fmt.Sprintf("thread-%04d", request.Ordinal%1024)
	sequenceStripe := request.Ordinal % sequenceStripes
	shard := sequenceStripe % B3RelayShards
	var lastStripeSequence int64
	if err := tx.QueryRow(ctx, `
		UPDATE b3_outbox_sequence_gate
		SET next_sequence = next_sequence + $2
		WHERE sequence_stripe = $1
		RETURNING next_sequence`, sequenceStripe, len(ids)).Scan(&lastStripeSequence); err != nil {
		return B3Receipt{}, err
	}
	firstStripeSequence := lastStripeSequence - int64(len(ids)) + 1
	var firstThreadSequence int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(thread_sequence), -1) + 1
		FROM agent_runs
		WHERE benchmark_id = $1 AND thread_key = $2`, request.BenchmarkID, threadKey).Scan(&firstThreadSequence); err != nil {
		return B3Receipt{}, err
	}
	for runOrdinal, id := range ids {
		if _, err = tx.Exec(ctx, `
			INSERT INTO agent_runs
				(id, benchmark_id, ordinal, thread_key, thread_sequence, workload_ms)
			VALUES ($1, $2, $3, $4, $5, 15)`,
			id, request.BenchmarkID, request.Ordinal*2+runOrdinal,
			threadKey, firstThreadSequence+runOrdinal); err != nil {
			return B3Receipt{}, err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO b3_outbox
				(benchmark_id, ordinal, agent_run_id, delivery_id, ordering_key, shard, sequence_stripe, stripe_sequence)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, request.BenchmarkID, request.Ordinal,
			id, fmt.Sprintf("%s/%d/%d", request.BenchmarkID, request.Ordinal, runOrdinal),
			fmt.Sprintf("%s/%s", request.BenchmarkID, threadKey), shard, sequenceStripe,
			firstStripeSequence+int64(runOrdinal)); err != nil {
			return B3Receipt{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return B3Receipt{}, err
	}
	return B3Receipt{
		BenchmarkID: request.BenchmarkID, Ordinal: request.Ordinal,
		RootAgentRunID: ids[0], AgentRunIDs: ids, AcceptedAt: acceptedAt,
	}, nil
}

func (s *Store) TryOwnB3Shard(ctx context.Context, shard int) (*pgxpool.Conn, bool, error) {
	connection, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var owned bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock(380038, $1)`, shard).Scan(&owned); err != nil {
		connection.Release()
		return nil, false, err
	}
	if !owned {
		connection.Release()
		return nil, false, nil
	}
	return connection, true, nil
}

func (s *Store) ReleaseB3Shard(ctx context.Context, connection *pgxpool.Conn, shard int) {
	_, _ = connection.Exec(ctx, `SELECT pg_advisory_unlock(380038, $1)`, shard)
	connection.Release()
}

func (s *Store) ReadB3Batch(ctx context.Context, connection *pgxpool.Conn, shard, sequenceStripes, limit int) ([]B3OutboxRecord, error) {
	stripesPerOwner := sequenceStripes / B3RelayShards
	quotaPerStripe := (limit + stripesPerOwner - 1) / stripesPerOwner
	rows, err := connection.Query(ctx, `
		WITH active_stripes AS (
			SELECT generate_series($1::integer, $2::integer - 1, $3::integer)::smallint AS sequence_stripe
		), pending AS (
			SELECT o.sequence, o.stripe_sequence, o.benchmark_id, o.ordinal, o.agent_run_id,
			       o.delivery_id, o.ordering_key, o.shard, o.sequence_stripe, o.ready_at
			FROM active_stripes s
			JOIN b3_relay_progress p USING (sequence_stripe)
			CROSS JOIN LATERAL (
				SELECT o.*
				FROM b3_outbox o
				WHERE o.sequence_stripe = s.sequence_stripe
				  AND o.stripe_sequence > p.last_sequence
				ORDER BY o.stripe_sequence
				LIMIT $4
			) o
		)
		SELECT sequence, stripe_sequence, benchmark_id, ordinal, agent_run_id,
		       delivery_id, ordering_key, shard, sequence_stripe, ready_at
		FROM pending
		ORDER BY stripe_sequence, sequence_stripe
		LIMIT $5`, shard, sequenceStripes, B3RelayShards, quotaPerStripe, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []B3OutboxRecord
	for rows.Next() {
		var record B3OutboxRecord
		if err := rows.Scan(&record.Sequence, &record.StripeSequence, &record.BenchmarkID, &record.Ordinal, &record.AgentRunID,
			&record.DeliveryID, &record.OrderingKey, &record.Shard, &record.SequenceStripe, &record.ReadyAt); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *Store) RecordB3Publications(ctx context.Context, connection *pgxpool.Conn, owner string, publications []B3Publication) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, publication := range publications {
		if _, err := tx.Exec(ctx, `
			INSERT INTO b3_publish_evidence
				(outbox_sequence, benchmark_id, agent_run_id, delivery_id, relay_owner,
				 requested_at, provider_message_id, provider_confirmed_at, observed_outcome)
			VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8, $9)`,
			publication.Record.Sequence, publication.Record.BenchmarkID, publication.Record.AgentRunID,
			publication.Record.DeliveryID, owner, publication.RequestedAt, publication.MessageID,
			publication.ConfirmedAt, publication.Outcome); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) AdvanceB3Progress(ctx context.Context, connection *pgxpool.Conn, records []B3OutboxRecord) error {
	highWater := make(map[int]int64)
	for _, record := range records {
		if record.StripeSequence > highWater[record.SequenceStripe] {
			highWater[record.SequenceStripe] = record.StripeSequence
		}
	}
	tx, err := connection.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for sequenceStripe, sequence := range highWater {
		command, err := tx.Exec(ctx, `
			UPDATE b3_relay_progress
			SET last_sequence = $2, advanced_at = clock_timestamp()
			WHERE sequence_stripe = $1 AND last_sequence < $2`, sequenceStripe, sequence)
		if err != nil {
			return err
		}
		if command.RowsAffected() > 1 {
			return fmt.Errorf("advanced more than one relay cursor")
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) B3Backlog(ctx context.Context) (int64, time.Duration, error) {
	var count int64
	var oldest *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT count(*), min(o.ready_at)
		FROM b3_outbox o
		JOIN b3_relay_progress p USING (sequence_stripe)
		WHERE o.stripe_sequence > p.last_sequence`).Scan(&count, &oldest)
	if err != nil || oldest == nil {
		return count, 0, err
	}
	return count, time.Since(*oldest), nil
}

func (s *Store) AuditB3(ctx context.Context, benchmarkID uuid.UUID, expectedIncoming int) (B3Audit, error) {
	a := B3Audit{
		BenchmarkID: benchmarkID, ExpectedIncoming: int64(expectedIncoming),
		ExpectedAgentRuns:       int64(expectedIncoming + expectedIncoming/2),
		DeliveryAttemptOutcomes: make(map[string]int64), RelayProgress: make(map[int]int64),
	}
	if err := s.pool.QueryRow(ctx, `SELECT candidate, lane FROM benchmarks WHERE id = $1`, benchmarkID).Scan(&a.Candidate, &a.Lane); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM b3_admissions WHERE benchmark_id = $1`, benchmarkID).Scan(&a.AcceptedIncoming); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE state = 'succeeded'),
		       count(*) FILTER (WHERE state NOT IN ('succeeded', 'canceled')),
		       count(*) FILTER (WHERE terminal_commits > 1)
		FROM agent_runs WHERE benchmark_id = $1`, benchmarkID).Scan(
		&a.AuthoritativeAgentRuns, &a.SucceededAgentRuns,
		&a.NonterminalAgentRuns, &a.DuplicateTerminalCommits); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
			SELECT 1 FROM b3_publish_evidence e
			WHERE e.outbox_sequence = o.sequence AND e.provider_confirmed_at IS NOT NULL
		))
		FROM b3_outbox o
		WHERE o.benchmark_id = $1`, benchmarkID).Scan(&a.OutboxRecords, &a.UnpublishedOutboxRecords); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM agent_runs r
		WHERE r.benchmark_id = $1 AND NOT EXISTS (
			SELECT 1 FROM b3_outbox o WHERE o.benchmark_id = r.benchmark_id AND o.agent_run_id = r.id
		)`, benchmarkID).Scan(&a.StrandedAcceptedRuns); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM delivery_attempts d
		LEFT JOIN agent_runs r ON r.benchmark_id = d.benchmark_id AND r.id = d.agent_run_id
		WHERE d.benchmark_id = $1 AND r.id IS NULL`, benchmarkID).Scan(&a.GhostDeliveryAttempts); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE provider_confirmed_at IS NOT NULL)
		FROM b3_publish_evidence WHERE benchmark_id = $1`, benchmarkID).Scan(&a.PublishAttempts, &a.ConfirmedPublications); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(extra), 0) FROM (
			SELECT greatest(count(*) FILTER (WHERE provider_confirmed_at IS NOT NULL) - 1, 0) AS extra
			FROM b3_publish_evidence WHERE benchmark_id = $1 GROUP BY agent_run_id
		) counts`, benchmarkID).Scan(&a.DuplicatePublications); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM delivery_attempts WHERE benchmark_id = $1`, benchmarkID).Scan(&a.DeliveryAttempts); err != nil {
		return B3Audit{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT outcome, count(*) FROM delivery_attempts WHERE benchmark_id = $1 GROUP BY outcome`, benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	for rows.Next() {
		var outcome string
		var count int64
		if err := rows.Scan(&outcome, &count); err != nil {
			rows.Close()
			return B3Audit{}, err
		}
		a.DeliveryAttemptOutcomes[outcome] = count
	}
	rows.Close()
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM b3_attempt_evidence WHERE benchmark_id = $1 AND caller_outcome IN ('in_flight', 'unknown')`, benchmarkID).Scan(&a.UnknownCallerOutcomes); err != nil {
		return B3Audit{}, err
	}
	rows, err = s.pool.Query(ctx, `SELECT sequence_stripe, last_sequence FROM b3_relay_progress ORDER BY sequence_stripe`)
	if err != nil {
		return B3Audit{}, err
	}
	for rows.Next() {
		var shard int
		var sequence int64
		if err := rows.Scan(&shard, &sequence); err != nil {
			rows.Close()
			return B3Audit{}, err
		}
		a.RelayProgress[shard] = sequence
	}
	rows.Close()
	a.CallerToReceiptMS, err = s.b3Percentiles(ctx, "b3_attempt_evidence", "response_completed_at - started_at", "benchmark_id = $1 AND response_completed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.ReadyToPublishMS, err = s.b3Percentiles(ctx, "b3_publish_evidence p JOIN b3_outbox o ON o.sequence = p.outbox_sequence", "p.provider_confirmed_at - o.ready_at", "p.benchmark_id = $1 AND p.provider_confirmed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.PublishToClaimMS, err = s.b3Percentiles(ctx, "agent_runs", "first_claimed_at - first_published_at", "benchmark_id = $1 AND first_claimed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.ClaimToTerminalMS, err = s.b3Percentiles(ctx, "agent_runs", "completed_at - first_claimed_at", "benchmark_id = $1 AND completed_at IS NOT NULL AND first_claimed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(pg_total_relation_size(i.inhrelid)), 0),
		       COALESCE(sum(pg_indexes_size(i.inhrelid)), 0),
		       COALESCE((SELECT sum(n_dead_tup)::bigint FROM pg_stat_user_tables WHERE relname ~ '^b3_outbox_[0-9]{8}$'), 0),
		       COALESCE((SELECT n_dead_tup::bigint FROM pg_stat_user_tables WHERE relname = 'b3_outbox_sequence_gate'), 0)
		FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
		WHERE p.relname = 'b3_outbox'`).Scan(
		&a.OutboxTableBytes, &a.OutboxIndexBytes, &a.OutboxDeadTuples, &a.RelayGateDeadTuples); err != nil {
		return B3Audit{}, err
	}
	a.Verdict = "PASS"
	if a.AcceptedIncoming == 0 && a.OutboxRecords == 0 {
		a.Verdict = "MISSING"
	}
	if a.AcceptedIncoming > a.ExpectedIncoming || a.StrandedAcceptedRuns > 0 ||
		a.GhostDeliveryAttempts > 0 || a.DuplicateTerminalCommits > 0 ||
		a.UnpublishedOutboxRecords > 0 || a.NonterminalAgentRuns > 0 {
		a.Verdict = "FAIL"
	}
	return a, nil
}

func (s *Store) b3Percentiles(ctx context.Context, table, expression, where string, benchmarkID uuid.UUID) (map[string]any, error) {
	var count int64
	var p50, p90, p95, p99, maximum *float64
	query := `SELECT count(*),
		percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (` + expression + `)) * 1000),
		percentile_cont(0.90) WITHIN GROUP (ORDER BY extract(epoch FROM (` + expression + `)) * 1000),
		percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (` + expression + `)) * 1000),
		percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (` + expression + `)) * 1000),
		max(extract(epoch FROM (` + expression + `)) * 1000)
		FROM ` + table + ` WHERE ` + where
	err := s.pool.QueryRow(ctx, query, benchmarkID).Scan(&count, &p50, &p90, &p95, &p99, &maximum)
	return map[string]any{"count": count, "p50": p50, "p90": p90, "p95": p95, "p99": p99, "max": maximum}, err
}

func (s *Store) B3RetentionCandidates(ctx context.Context, replayWindow time.Duration) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT child.relname
		FROM pg_inherits
		JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
		JOIN pg_class child ON pg_inherits.inhrelid = child.oid
		WHERE parent.relname = 'b3_outbox'
		  AND child.relname ~ '^b3_outbox_[0-9]{8}$'
		  AND to_date(right(child.relname, 8), 'YYYYMMDD') < current_date - $1::int
		ORDER BY child.relname`, int(replayWindow.Hours()/24))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var oldPartitions []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		oldPartitions = append(oldPartitions, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	safe := make([]string, 0)
	for _, name := range oldPartitions {
		var fullyPublished bool
		query := `SELECT NOT EXISTS (
			SELECT 1 FROM ` + (pgx.Identifier{name}).Sanitize() + ` o
			JOIN b3_relay_progress p USING (sequence_stripe)
			WHERE o.stripe_sequence > p.last_sequence
		)`
		if err := s.pool.QueryRow(ctx, query).Scan(&fullyPublished); err != nil {
			return nil, err
		}
		if fullyPublished {
			safe = append(safe, name)
		}
	}
	return safe, nil
}
