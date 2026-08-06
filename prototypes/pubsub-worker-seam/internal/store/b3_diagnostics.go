package store

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type B3RelationDiagnostic struct {
	Relation        string     `json:"relation"`
	TotalBytes      int64      `json:"total_bytes"`
	TableBytes      int64      `json:"table_bytes"`
	IndexBytes      int64      `json:"index_bytes"`
	LiveTuples      int64      `json:"live_tuples"`
	DeadTuples      int64      `json:"dead_tuples"`
	SequentialScans int64      `json:"sequential_scans"`
	IndexScans      int64      `json:"index_scans"`
	LastAutovacuum  *time.Time `json:"last_autovacuum,omitempty"`
	LastAutoanalyze *time.Time `json:"last_autoanalyze,omitempty"`
}

type B3DatabaseDiagnostic struct {
	DatabaseBytes  int64 `json:"database_bytes"`
	Backends       int64 `json:"backends"`
	Transactions   int64 `json:"transactions"`
	BlocksRead     int64 `json:"blocks_read"`
	BlocksHit      int64 `json:"blocks_hit"`
	TuplesReturned int64 `json:"tuples_returned"`
	TuplesFetched  int64 `json:"tuples_fetched"`
	TuplesInserted int64 `json:"tuples_inserted"`
	TuplesUpdated  int64 `json:"tuples_updated"`
	TuplesDeleted  int64 `json:"tuples_deleted"`
	TemporaryFiles int64 `json:"temporary_files"`
	TemporaryBytes int64 `json:"temporary_bytes"`
	Deadlocks      int64 `json:"deadlocks"`
	ReadTimeMS     int64 `json:"read_time_ms"`
	WriteTimeMS    int64 `json:"write_time_ms"`
	WALRecords     int64 `json:"wal_records"`
	WALBytes       int64 `json:"wal_bytes"`
}

type B3DiagnosticSnapshot struct {
	CapturedAt      time.Time              `json:"captured_at"`
	BenchmarkID     uuid.UUID              `json:"benchmark_id"`
	Database        B3DatabaseDiagnostic   `json:"database"`
	Relations       []B3RelationDiagnostic `json:"relations"`
	Settings        map[string]string      `json:"settings"`
	PointClaimPlan  json.RawMessage        `json:"point_claim_plan,omitempty"`
	PredecessorPlan json.RawMessage        `json:"predecessor_plan,omitempty"`
}

type B3TailSample struct {
	AgentRunID             uuid.UUID `json:"agent_run_id"`
	BrokerAttempt          int       `json:"broker_attempt"`
	PublishToPushArrivalMS *float64  `json:"publish_to_push_arrival_ms,omitempty"`
	PushArrivalToSlotMS    *float64  `json:"push_arrival_to_handler_slot_ms,omitempty"`
	DatabasePoolWaitMS     *float64  `json:"database_pool_wait_ms,omitempty"`
	ClaimTransactionMS     *float64  `json:"claim_transaction_ms,omitempty"`
	PushArrivalToClaimMS   *float64  `json:"push_arrival_to_claim_completion_ms,omitempty"`
	TerminalTransactionMS  *float64  `json:"terminal_transaction_to_evidence_ms,omitempty"`
}

type B3PublicationSample struct {
	OutboxSequence      int64      `json:"outbox_sequence"`
	AgentRunID          uuid.UUID  `json:"agent_run_id"`
	RelayOwner          string     `json:"relay_owner"`
	PublicationEpoch    *int64     `json:"publication_epoch,omitempty"`
	LeaseAcquiredAt     *time.Time `json:"lease_acquired_at,omitempty"`
	LeaseExpiresAt      *time.Time `json:"lease_expires_at,omitempty"`
	RequestedAt         time.Time  `json:"requested_at"`
	ProviderConfirmedAt *time.Time `json:"provider_confirmed_at,omitempty"`
	Outcome             string     `json:"outcome"`
	ReadyToSelectedMS   *float64   `json:"ready_to_selected_ms,omitempty"`
	SelectedToRequestMS *float64   `json:"selected_to_publish_request_ms,omitempty"`
	ProviderConfirmMS   *float64   `json:"provider_confirmation_ms,omitempty"`
}

func (s *Store) B3DiagnosticSnapshot(ctx context.Context, benchmarkID uuid.UUID) (B3DiagnosticSnapshot, error) {
	snapshot := B3DiagnosticSnapshot{
		CapturedAt: time.Now().UTC(), BenchmarkID: benchmarkID, Settings: make(map[string]string),
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT pg_database_size(current_database()), numbackends,
		       xact_commit + xact_rollback, blks_read, blks_hit,
		       tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
		       temp_files, temp_bytes, deadlocks,
		       round(blk_read_time)::bigint, round(blk_write_time)::bigint
		FROM pg_stat_database WHERE datname = current_database()`).Scan(
		&snapshot.Database.DatabaseBytes, &snapshot.Database.Backends,
		&snapshot.Database.Transactions, &snapshot.Database.BlocksRead,
		&snapshot.Database.BlocksHit, &snapshot.Database.TuplesReturned,
		&snapshot.Database.TuplesFetched, &snapshot.Database.TuplesInserted,
		&snapshot.Database.TuplesUpdated, &snapshot.Database.TuplesDeleted,
		&snapshot.Database.TemporaryFiles, &snapshot.Database.TemporaryBytes,
		&snapshot.Database.Deadlocks, &snapshot.Database.ReadTimeMS,
		&snapshot.Database.WriteTimeMS); err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT wal_records, round(wal_bytes)::bigint FROM pg_stat_wal`).Scan(
		&snapshot.Database.WALRecords, &snapshot.Database.WALBytes); err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT relname, pg_total_relation_size(relid), pg_relation_size(relid),
		       pg_indexes_size(relid), n_live_tup, n_dead_tup, seq_scan, idx_scan,
		       last_autovacuum, last_autoanalyze
		FROM pg_stat_user_tables
		WHERE schemaname = 'public'
		  AND (relname IN ('benchmarks', 'agent_runs', 'agent_run_attempts',
		       'model_calls', 'model_call_attempts', 'delivery_attempts')
		       OR relname LIKE 'b3_%')
		ORDER BY pg_total_relation_size(relid) DESC, relname`)
	if err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	for rows.Next() {
		var relation B3RelationDiagnostic
		if err := rows.Scan(&relation.Relation, &relation.TotalBytes, &relation.TableBytes,
			&relation.IndexBytes, &relation.LiveTuples, &relation.DeadTuples,
			&relation.SequentialScans, &relation.IndexScans,
			&relation.LastAutovacuum, &relation.LastAutoanalyze); err != nil {
			rows.Close()
			return B3DiagnosticSnapshot{}, err
		}
		snapshot.Relations = append(snapshot.Relations, relation)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	rows, err = s.pool.Query(ctx, `
		SELECT name, setting, COALESCE(unit, '') FROM pg_settings
		WHERE name = ANY($1::text[]) ORDER BY name`, []string{
		"autovacuum", "autovacuum_analyze_scale_factor", "autovacuum_vacuum_scale_factor",
		"effective_cache_size", "maintenance_work_mem", "max_connections",
		"random_page_cost", "shared_buffers", "track_io_timing", "work_mem",
	})
	if err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	for rows.Next() {
		var name, value, unit string
		if err := rows.Scan(&name, &value, &unit); err != nil {
			rows.Close()
			return B3DiagnosticSnapshot{}, err
		}
		snapshot.Settings[name] = value + unit
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	pointPlan, predecessorPlan, err := s.b3ClaimPlans(ctx, benchmarkID)
	if err != nil {
		return B3DiagnosticSnapshot{}, err
	}
	snapshot.PointClaimPlan = pointPlan
	snapshot.PredecessorPlan = predecessorPlan
	return snapshot, nil
}

func (s *Store) b3ClaimPlans(ctx context.Context, benchmarkID uuid.UUID) (json.RawMessage, json.RawMessage, error) {
	var runID uuid.UUID
	var threadKey string
	var threadSequence int
	err := s.pool.QueryRow(ctx, `
		SELECT id, thread_key, thread_sequence
		FROM agent_runs WHERE benchmark_id = $1
		ORDER BY thread_sequence DESC LIMIT 1`, benchmarkID).Scan(&runID, &threadKey, &threadSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	var pointPlan, predecessorPlan []byte
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT state, lease_expires_at, ordinal, principal_key, thread_key,
		       thread_sequence, workload_ms, execution_profile_ref, fair_dispatch,
		       claim_epoch, crash_once, crash_injected
		FROM agent_runs WHERE id = $1 AND benchmark_id = $2 FOR UPDATE`, runID, benchmarkID).Scan(&pointPlan); err != nil {
		return nil, nil, err
	}
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT EXISTS (
			SELECT 1 FROM agent_runs
			WHERE benchmark_id = $1 AND thread_key = $2 AND thread_sequence < $3
			  AND state NOT IN ('succeeded', 'canceled')
		)`, benchmarkID, threadKey, threadSequence+1).Scan(&predecessorPlan); err != nil {
		return nil, nil, err
	}
	return json.RawMessage(pointPlan), json.RawMessage(predecessorPlan), nil
}

func (s *Store) WriteB3TailSamples(ctx context.Context, benchmarkID uuid.UUID, destination io.Writer) error {
	rows, err := s.pool.Query(ctx, `
		SELECT agent_run_id, broker_attempt,
		       extract(epoch FROM (received_at - published_at)) * 1000,
		       extract(epoch FROM (slot_acquired_at - received_at)) * 1000,
		       extract(epoch FROM (database_acquired_at - database_acquire_started_at)) * 1000,
		       extract(epoch FROM (claim_completed_at - database_acquired_at)) * 1000,
		       extract(epoch FROM (claim_completed_at - received_at)) * 1000,
		       extract(epoch FROM (terminal_evidence_at - terminal_started_at)) * 1000
		FROM delivery_attempts
		WHERE benchmark_id = $1 AND outcome = 'completed'
		ORDER BY id`, benchmarkID)
	if err != nil {
		return err
	}
	defer rows.Close()
	encoder := json.NewEncoder(destination)
	for rows.Next() {
		var sample B3TailSample
		if err := rows.Scan(&sample.AgentRunID, &sample.BrokerAttempt,
			&sample.PublishToPushArrivalMS, &sample.PushArrivalToSlotMS,
			&sample.DatabasePoolWaitMS, &sample.ClaimTransactionMS,
			&sample.PushArrivalToClaimMS, &sample.TerminalTransactionMS); err != nil {
			return err
		}
		if err := encoder.Encode(sample); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Store) WriteB3PublicationSamples(ctx context.Context, benchmarkID uuid.UUID, destination io.Writer) error {
	rows, err := s.pool.Query(ctx, `
		SELECT evidence.outbox_sequence, evidence.agent_run_id, evidence.relay_owner,
		       evidence.publication_epoch, evidence.lease_acquired_at, evidence.lease_expires_at,
		       evidence.requested_at, evidence.provider_confirmed_at, evidence.observed_outcome,
		       extract(epoch FROM (outbox.fair_selected_at - outbox.ready_at)) * 1000,
		       extract(epoch FROM (evidence.requested_at - outbox.fair_selected_at)) * 1000,
		       extract(epoch FROM (evidence.provider_confirmed_at - evidence.requested_at)) * 1000
		FROM b3_publish_evidence evidence
		JOIN b3_outbox outbox ON outbox.sequence = evidence.outbox_sequence
		WHERE evidence.benchmark_id = $1
		ORDER BY evidence.id`, benchmarkID)
	if err != nil {
		return err
	}
	defer rows.Close()
	encoder := json.NewEncoder(destination)
	for rows.Next() {
		var sample B3PublicationSample
		if err := rows.Scan(
			&sample.OutboxSequence, &sample.AgentRunID, &sample.RelayOwner,
			&sample.PublicationEpoch, &sample.LeaseAcquiredAt, &sample.LeaseExpiresAt,
			&sample.RequestedAt, &sample.ProviderConfirmedAt, &sample.Outcome,
			&sample.ReadyToSelectedMS, &sample.SelectedToRequestMS, &sample.ProviderConfirmMS,
		); err != nil {
			return err
		}
		if err := encoder.Encode(sample); err != nil {
			return err
		}
	}
	return rows.Err()
}
