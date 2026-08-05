package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/delivery"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

type Run struct {
	ID                  uuid.UUID
	BenchmarkID         uuid.UUID
	Ordinal             int
	ExecutionProfileRef string
	Workload            time.Duration
	ClaimEpoch          int64
	CrashInjected       bool
}

type CommittedModelCallAttempt struct {
	ID             uuid.UUID
	ModelCallID    uuid.UUID
	AgentRunID     uuid.UUID
	ClaimEpoch     int64
	BindingRef     string
	IdempotencyKey string
}

type DeliveryAttemptEvidence struct {
	Protocol      string
	MessageID     string
	BrokerAttempt int
	Outcome       string
}

type ClaimResult struct {
	Action delivery.Action
	Run    *Run
}

type PreparedRun struct {
	ID             uuid.UUID
	BenchmarkID    uuid.UUID
	Ordinal        int
	ThreadKey      string
	ThreadSequence int
	WorkloadMS     int
	State          delivery.State
	CrashOnce      bool
}

type Audit struct {
	BenchmarkID          uuid.UUID        `json:"benchmark_id"`
	Candidate            string           `json:"candidate"`
	Lane                 string           `json:"lane"`
	Expected             int64            `json:"expected"`
	Total                int64            `json:"total"`
	Succeeded            int64            `json:"succeeded"`
	Canceled             int64            `json:"canceled"`
	Nonterminal          int64            `json:"nonterminal"`
	DuplicateTerminals   int64            `json:"duplicate_terminals"`
	CrashInjections      int64            `json:"crash_injections"`
	Attempts             int64            `json:"attempts"`
	DistinctMessages     int64            `json:"distinct_messages"`
	AttemptOutcomes      map[string]int64 `json:"attempt_outcomes"`
	DeliveryToClaimMS    map[string]any   `json:"delivery_to_claim_ms"`
	DeliveryToCompleteMS map[string]any   `json:"delivery_to_complete_ms"`
	OfferStartedAt       *time.Time       `json:"offer_started_at"`
	OfferEndedAt         *time.Time       `json:"offer_ended_at"`
	LastCompletedAt      *time.Time       `json:"last_completed_at"`
}

func Open(ctx context.Context, dsn, applicationName string, maxConnections int32) (*Store, error) {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database configuration: %w", err)
	}
	config.MaxConns = maxConnections
	config.MinConns = 0
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Migrate(ctx context.Context, schema string) error {
	_, err := s.pool.Exec(ctx, schema)
	return err
}

func (s *Store) Prepare(ctx context.Context, benchmarkID uuid.UUID, candidate, lane string, runs []PreparedRun) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO benchmarks (id, candidate, lane, expected_runs) VALUES ($1, $2, $3, $4)`, benchmarkID, candidate, lane, len(runs)); err != nil {
		return err
	}
	rows := make([][]any, 0, len(runs))
	for _, run := range runs {
		var completedAt *time.Time
		if run.State == delivery.Canceled {
			now := time.Now().UTC()
			completedAt = &now
		}
		rows = append(rows, []any{run.ID, run.BenchmarkID, run.Ordinal, run.ThreadKey, run.ThreadSequence, run.WorkloadMS, run.State, completedAt, run.CrashOnce})
	}
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"agent_runs"}, []string{
		"id", "benchmark_id", "ordinal", "thread_key", "thread_sequence", "workload_ms", "state", "completed_at", "crash_once",
	}, pgx.CopyFromRows(rows))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) MarkOffer(ctx context.Context, benchmarkID uuid.UUID, start bool) error {
	column := "offer_ended_at"
	if start {
		column = "offer_started_at"
	}
	_, err := s.pool.Exec(ctx, `UPDATE benchmarks SET `+column+` = clock_timestamp() WHERE id = $1`, benchmarkID)
	return err
}

func (s *Store) TryClaim(ctx context.Context, runID, benchmarkID uuid.UUID, owner string, publishedAt time.Time, lease time.Duration) (ClaimResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ClaimResult{}, err
	}
	defer tx.Rollback(ctx)

	var state delivery.State
	var leaseExpiresAt *time.Time
	var ordinal, threadSequence, workloadMS int
	var threadKey, executionProfileRef string
	var claimEpoch int64
	var crashOnce, crashInjected bool
	err = tx.QueryRow(ctx, `
		SELECT state, lease_expires_at, ordinal, thread_key, thread_sequence,
		       workload_ms, execution_profile_ref, claim_epoch, crash_once, crash_injected
		FROM agent_runs
		WHERE id = $1 AND benchmark_id = $2
		FOR UPDATE`, runID, benchmarkID).Scan(
		&state, &leaseExpiresAt, &ordinal, &threadKey, &threadSequence,
		&workloadMS, &executionProfileRef, &claimEpoch, &crashOnce, &crashInjected,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ClaimResult{Action: delivery.Acknowledge}, tx.Commit(ctx)
	}
	if err != nil {
		return ClaimResult{}, err
	}

	action := delivery.Decide(state, leaseExpiresAt, time.Now())
	if action != delivery.Claim {
		return ClaimResult{Action: action}, tx.Commit(ctx)
	}
	var predecessorOpen bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM agent_runs
			WHERE benchmark_id = $1 AND thread_key = $2 AND thread_sequence < $3
			  AND state NOT IN ('succeeded', 'canceled')
		)`, benchmarkID, threadKey, threadSequence).Scan(&predecessorOpen); err != nil {
		return ClaimResult{}, err
	}
	if predecessorOpen {
		return ClaimResult{Action: delivery.Retry}, tx.Commit(ctx)
	}
	claimEpoch++
	crashNow := crashOnce && !crashInjected
	if _, err := tx.Exec(ctx, `
		UPDATE model_call_attempts
		SET dispatch_evidence = 'not_dispatched', outcome = 'superseded_after_lease',
		    usage_status = 'unknown', completed_at = clock_timestamp()
		WHERE agent_run_id = $1 AND completed_at IS NULL`, runID); err != nil {
		return ClaimResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_run_attempts
		SET completed_at = clock_timestamp(), outcome = 'lease_expired'
		WHERE agent_run_id = $1 AND completed_at IS NULL`, runID); err != nil {
		return ClaimResult{}, err
	}
	_, err = tx.Exec(ctx, `
		UPDATE agent_runs
		SET state = 'running', claim_epoch = $2, lease_owner = $3,
		    lease_expires_at = clock_timestamp() + $4::interval,
		    first_published_at = COALESCE(first_published_at, $5),
		    first_claimed_at = COALESCE(first_claimed_at, clock_timestamp()),
		    crash_injected = crash_injected OR $6
		WHERE id = $1`, runID, claimEpoch, owner, interval(lease), publishedAt, crashNow)
	if err != nil {
		return ClaimResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_run_attempts
			(agent_run_id, claim_epoch, benchmark_id, lease_owner)
		VALUES ($1, $2, $3, $4)`, runID, claimEpoch, benchmarkID, owner); err != nil {
		return ClaimResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ClaimResult{}, err
	}
	return ClaimResult{Action: delivery.Claim, Run: &Run{
		ID: runID, BenchmarkID: benchmarkID, Ordinal: ordinal,
		ExecutionProfileRef: executionProfileRef,
		Workload:            time.Duration(workloadMS) * time.Millisecond,
		ClaimEpoch:          claimEpoch, CrashInjected: crashNow,
	}}, nil
}

func (s *Store) CommitModelCallAttempt(ctx context.Context, run Run, normalizedIntent string) (CommittedModelCallAttempt, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CommittedModelCallAttempt{}, err
	}
	defer tx.Rollback(ctx)
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM agent_runs
			WHERE id = $1 AND benchmark_id = $2 AND state = 'running' AND claim_epoch = $3
		)`, run.ID, run.BenchmarkID, run.ClaimEpoch).Scan(&active); err != nil {
		return CommittedModelCallAttempt{}, err
	}
	if !active {
		return CommittedModelCallAttempt{}, fmt.Errorf("AgentRun claim is no longer active")
	}
	modelCallID := uuid.NewSHA1(run.ID, []byte("model-call/0"))
	attemptID := uuid.NewSHA1(run.ID, []byte(fmt.Sprintf("model-call/0/attempt/%d", run.ClaimEpoch)))
	idempotencyKey := fmt.Sprintf("model-call/%s/%d", modelCallID, run.ClaimEpoch)
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_calls (id, agent_run_id, call_ordinal, normalized_intent)
		VALUES ($1, $2, 0, $3)
		ON CONFLICT (id) DO NOTHING`, modelCallID, run.ID, normalizedIntent); err != nil {
		return CommittedModelCallAttempt{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO model_call_attempts
			(id, model_call_id, agent_run_id, claim_epoch, attempt_ordinal, binding_ref,
			 adapter_compatibility_identity, idempotency_key)
		VALUES ($1, $2, $3, $4, $5, 'benchmark/deterministic-binding-v1',
		        'deterministic-go/v1', $6)
		ON CONFLICT (id) DO NOTHING`, attemptID, modelCallID, run.ID, run.ClaimEpoch,
		int(run.ClaimEpoch), idempotencyKey); err != nil {
		return CommittedModelCallAttempt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommittedModelCallAttempt{}, err
	}
	return CommittedModelCallAttempt{
		ID: attemptID, ModelCallID: modelCallID, AgentRunID: run.ID,
		ClaimEpoch: run.ClaimEpoch, BindingRef: "benchmark/deterministic-binding-v1",
		IdempotencyKey: idempotencyKey,
	}, nil
}

func (s *Store) CompleteModelCallAndRun(
	ctx context.Context,
	run Run,
	attempt CommittedModelCallAttempt,
	normalizedOutcome string,
	deliveryAttempt *DeliveryAttemptEvidence,
) (bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var budgetStripe *int16
	err = tx.QueryRow(ctx, `
		SELECT budget_stripe
		FROM agent_runs
		WHERE id = $1 AND benchmark_id = $2 AND state = 'running' AND claim_epoch = $3
		FOR UPDATE`, run.ID, run.BenchmarkID, run.ClaimEpoch).Scan(&budgetStripe)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE model_call_attempts
		SET dispatch_evidence = 'terminal_observed', outcome = 'succeeded',
		    usage_status = 'unknown', completed_at = clock_timestamp()
		WHERE id = $1 AND agent_run_id = $2 AND claim_epoch = $3 AND completed_at IS NULL`,
		attempt.ID, run.ID, run.ClaimEpoch)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, fmt.Errorf("committed ModelCallAttempt is missing or already terminal")
	}
	command, err = tx.Exec(ctx, `
		UPDATE model_calls
		SET logical_status = 'succeeded', final_outcome = $2, completed_at = clock_timestamp()
		WHERE id = $1 AND logical_status = 'pending'`, attempt.ModelCallID, normalizedOutcome)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, fmt.Errorf("logical ModelCall is missing or already terminal")
	}
	command, err = tx.Exec(ctx, `
		UPDATE agent_run_attempts
		SET completed_at = clock_timestamp(), outcome = 'succeeded'
		WHERE agent_run_id = $1 AND claim_epoch = $2 AND completed_at IS NULL`, run.ID, run.ClaimEpoch)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, fmt.Errorf("AgentRunAttempt is missing or already terminal")
	}
	command, err = tx.Exec(ctx, `
		UPDATE agent_runs
		SET state = 'succeeded', completed_at = clock_timestamp(), terminal_commits = terminal_commits + 1,
		    lease_owner = NULL, lease_expires_at = NULL
		WHERE id = $1 AND benchmark_id = $2 AND state = 'running' AND claim_epoch = $3`,
		run.ID, run.BenchmarkID, run.ClaimEpoch)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, fmt.Errorf("AgentRun claim is no longer active")
	}
	if budgetStripe != nil {
		command, err = tx.Exec(ctx, `
			UPDATE b3_inflight_budget
			SET in_use = in_use - 1, updated_at = clock_timestamp()
			WHERE budget_stripe = $1 AND in_use > 0`, *budgetStripe)
		if err != nil {
			return false, err
		}
		if command.RowsAffected() != 1 {
			return false, fmt.Errorf("durable AgentRun budget obligation is missing")
		}
	}
	if deliveryAttempt != nil {
		if _, err = tx.Exec(ctx, `
			INSERT INTO delivery_attempts
				(benchmark_id, agent_run_id, protocol, message_id, broker_attempt, outcome)
			VALUES ($1, $2, $3, $4, $5, $6)`, run.BenchmarkID, run.ID,
			deliveryAttempt.Protocol, deliveryAttempt.MessageID,
			deliveryAttempt.BrokerAttempt, deliveryAttempt.Outcome); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Complete(ctx context.Context, run Run) (bool, error) {
	result, err := s.pool.Exec(ctx, `
		UPDATE agent_runs
		SET state = 'succeeded', completed_at = clock_timestamp(), terminal_commits = terminal_commits + 1,
		    lease_owner = NULL, lease_expires_at = NULL
		WHERE id = $1 AND benchmark_id = $2 AND state = 'running' AND claim_epoch = $3`, run.ID, run.BenchmarkID, run.ClaimEpoch)
	return err == nil && result.RowsAffected() == 1, err
}

func (s *Store) RecordAttempt(ctx context.Context, benchmarkID, runID uuid.UUID, protocol, messageID string, brokerAttempt int, outcome string) {
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO delivery_attempts (benchmark_id, agent_run_id, protocol, message_id, broker_attempt, outcome)
		VALUES ($1, $2, $3, $4, $5, $6)`, benchmarkID, runID, protocol, messageID, brokerAttempt, outcome)
}

func (s *Store) Remaining(ctx context.Context, benchmarkID uuid.UUID) (int64, error) {
	var count int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM agent_runs WHERE benchmark_id = $1 AND state NOT IN ('succeeded', 'canceled')`, benchmarkID).Scan(&count)
	return count, err
}

func (s *Store) Audit(ctx context.Context, benchmarkID uuid.UUID) (Audit, error) {
	var a Audit
	a.BenchmarkID = benchmarkID
	err := s.pool.QueryRow(ctx, `
		SELECT b.candidate, b.lane, b.expected_runs, b.offer_started_at, b.offer_ended_at,
		       count(*), count(*) FILTER (WHERE r.state = 'succeeded'),
		       count(*) FILTER (WHERE r.state = 'canceled'),
		       count(*) FILTER (WHERE r.state NOT IN ('succeeded', 'canceled')),
		       count(*) FILTER (WHERE r.terminal_commits > 1),
		       count(*) FILTER (WHERE r.crash_injected), max(r.completed_at)
		FROM benchmarks b JOIN agent_runs r ON r.benchmark_id = b.id
		WHERE b.id = $1
		GROUP BY b.id`, benchmarkID).Scan(
		&a.Candidate, &a.Lane, &a.Expected, &a.OfferStartedAt, &a.OfferEndedAt,
		&a.Total, &a.Succeeded, &a.Canceled, &a.Nonterminal, &a.DuplicateTerminals,
		&a.CrashInjections, &a.LastCompletedAt,
	)
	if err != nil {
		return Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(DISTINCT message_id) FROM delivery_attempts WHERE benchmark_id = $1`, benchmarkID).Scan(&a.Attempts, &a.DistinctMessages); err != nil {
		return Audit{}, err
	}
	a.AttemptOutcomes = make(map[string]int64)
	rows, err := s.pool.Query(ctx, `SELECT outcome, count(*) FROM delivery_attempts WHERE benchmark_id = $1 GROUP BY outcome`, benchmarkID)
	if err != nil {
		return Audit{}, err
	}
	for rows.Next() {
		var outcome string
		var count int64
		if err := rows.Scan(&outcome, &count); err != nil {
			rows.Close()
			return Audit{}, err
		}
		a.AttemptOutcomes[outcome] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Audit{}, err
	}
	a.DeliveryToClaimMS, err = s.percentiles(ctx, benchmarkID, "first_claimed_at")
	if err != nil {
		return Audit{}, err
	}
	a.DeliveryToCompleteMS, err = s.percentiles(ctx, benchmarkID, "completed_at")
	return a, err
}

func (s *Store) percentiles(ctx context.Context, benchmarkID uuid.UUID, column string) (map[string]any, error) {
	var count int64
	var p50, p95, p99, maximum *float64
	err := s.pool.QueryRow(ctx, `
		SELECT count(`+column+`),
		       percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (`+column+` - first_published_at)) * 1000),
		       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (`+column+` - first_published_at)) * 1000),
		       percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (`+column+` - first_published_at)) * 1000),
		       max(extract(epoch FROM (`+column+` - first_published_at)) * 1000)
		FROM agent_runs WHERE benchmark_id = $1 AND first_published_at IS NOT NULL`, benchmarkID).Scan(&count, &p50, &p95, &p99, &maximum)
	return map[string]any{"count": count, "p50": p50, "p95": p95, "p99": p99, "max": maximum}, err
}

func interval(value time.Duration) string {
	return fmt.Sprintf("%f seconds", value.Seconds())
}
