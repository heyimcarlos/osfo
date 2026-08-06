package store

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	B3RelayShards            = 4
	B3DefaultSequenceStripes = 4
	B3MaxSequenceStripes     = 64
	B3DefaultBudgetStripes   = 16
	B3PrincipalBudgetStripes = 16
	B3ExecutionProfileRef    = "benchmark/standard-runtime-v1"
)

var ErrB3InFlightBudgetExhausted = errors.New("AgentRun in-flight budget exhausted")
var ErrB3FairDispatchUnavailable = errors.New("Principal-first dispatch window is not configured")
var ErrB3PrincipalBudgetExhausted = errors.New("Principal durable-obligation budget exhausted")

type B3Request struct {
	BenchmarkID uuid.UUID `json:"benchmark_id"`
	Ordinal     int       `json:"ordinal"`
	Attempt     int       `json:"attempt"`
	Idempotency string    `json:"idempotency_key"`
	RequestHash string    `json:"request_hash"`
	Fault       string    `json:"fault"`
	HardCrash   bool      `json:"hard_crash"`
	Principal   string    `json:"principal_key,omitempty"`
	Thread      string    `json:"thread_key,omitempty"`
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
	RetryAfterMS  int        `json:"retry_after_ms,omitempty"`
}

type B3OutboxRecord struct {
	Sequence         int64
	StripeSequence   int64
	BenchmarkID      uuid.UUID
	Ordinal          int
	AgentRunID       uuid.UUID
	Principal        string
	Thread           string
	ThreadSequence   int
	DeliveryID       string
	OrderingKey      string
	Shard            int
	SequenceStripe   int
	ReadyAt          time.Time
	FairSelectedAt   *time.Time
	FairPublishedAt  *time.Time
	PublicationOwner string
	PublicationEpoch int64
	LeaseAcquiredAt  *time.Time
	LeaseExpiresAt   *time.Time
}

type B3FairPrincipalSnapshot struct {
	Principal      string  `json:"principal_key"`
	Queued         int64   `json:"queued"`
	InFlight       int64   `json:"in_flight"`
	Succeeded      int64   `json:"succeeded"`
	OldestQueuedMS float64 `json:"oldest_queued_ms"`
	SelectedCount  int64   `json:"selected_count"`
}

type B3FairSnapshot struct {
	CapturedAt       time.Time                 `json:"captured_at"`
	BenchmarkID      uuid.UUID                 `json:"benchmark_id"`
	PermitCapacity   int64                     `json:"permit_capacity"`
	PermitsInUse     int64                     `json:"permits_in_use"`
	QueuedPrincipals int64                     `json:"queued_principals"`
	ActiveThreads    int64                     `json:"active_threads"`
	Principals       []B3FairPrincipalSnapshot `json:"principals"`
}

type B3Publication struct {
	Record      B3OutboxRecord
	RequestedAt time.Time
	ConfirmedAt *time.Time
	MessageID   string
	Outcome     string
}

type B3Audit struct {
	BenchmarkID                 uuid.UUID        `json:"benchmark_id"`
	Candidate                   string           `json:"candidate"`
	Lane                        string           `json:"lane"`
	ExpectedIncoming            int64            `json:"expected_incoming"`
	ExpectedAgentRuns           int64            `json:"expected_agent_runs"`
	AcceptedIncoming            int64            `json:"accepted_incoming"`
	AuthoritativeAgentRuns      int64            `json:"authoritative_agent_runs"`
	SucceededAgentRuns          int64            `json:"succeeded_agent_runs"`
	NonterminalAgentRuns        int64            `json:"nonterminal_agent_runs"`
	OutboxRecords               int64            `json:"outbox_records"`
	UnpublishedOutboxRecords    int64            `json:"unpublished_outbox_records"`
	StrandedAcceptedRuns        int64            `json:"stranded_accepted_runs"`
	GhostDeliveryAttempts       int64            `json:"ghost_delivery_attempts"`
	DuplicatePublications       int64            `json:"duplicate_publications"`
	DuplicateTerminalCommits    int64            `json:"duplicate_terminal_commits"`
	GoodRootOutcomes            int64            `json:"good_root_outcomes"`
	GoodRootOutcomeRatio        float64          `json:"good_root_outcome_ratio"`
	DistinctExecutionProfiles   int64            `json:"distinct_execution_profiles"`
	AgentRunAttempts            int64            `json:"agent_run_attempts"`
	UnfinishedAgentRunAttempts  int64            `json:"unfinished_agent_run_attempts"`
	ModelCalls                  int64            `json:"model_calls"`
	ModelCallAttempts           int64            `json:"model_call_attempts"`
	UnfinishedModelCallAttempts int64            `json:"unfinished_model_call_attempts"`
	InFlightBudgetCapacity      int64            `json:"inflight_agent_run_budget_capacity"`
	InFlightBudgetUsed          int64            `json:"inflight_agent_run_budget_used"`
	InFlightBudgetObligations   int64            `json:"inflight_agent_run_budget_obligations"`
	InFlightBudgetMismatch      int64            `json:"inflight_agent_run_budget_mismatch"`
	PrincipalBudgetCapacity     int64            `json:"principal_budget_capacity"`
	PrincipalBudgetUsed         int64            `json:"principal_budget_used"`
	PrincipalBudgetObligations  int64            `json:"principal_budget_obligations"`
	PrincipalBudgetMismatch     int64            `json:"principal_budget_mismatch"`
	UnknownCallerOutcomes       int64            `json:"unknown_caller_outcomes"`
	PublishAttempts             int64            `json:"publish_attempts"`
	ConfirmedPublications       int64            `json:"confirmed_publications"`
	ActivePublicationTasks      int64            `json:"active_publication_tasks"`
	ExpiredPublicationClaims    int64            `json:"expired_publication_claims"`
	MaximumPublicationEpoch     int64            `json:"maximum_publication_epoch"`
	DeliveryAttempts            int64            `json:"delivery_attempts"`
	DeliveryAttemptOutcomes     map[string]int64 `json:"delivery_attempt_outcomes"`
	RelayProgress               map[int]int64    `json:"relay_progress"`
	CallerToReceiptMS           map[string]any   `json:"caller_to_receipt_ms"`
	ReadyToPublishMS            map[string]any   `json:"outbox_ready_to_publish_confirmation_ms"`
	PublishToClaimMS            map[string]any   `json:"publish_to_point_claim_ms"`
	PublishToPushArrivalMS      map[string]any   `json:"publish_to_push_arrival_ms"`
	PushArrivalToSlotMS         map[string]any   `json:"push_arrival_to_handler_slot_ms"`
	DatabasePoolWaitMS          map[string]any   `json:"database_pool_wait_ms"`
	ClaimTransactionMS          map[string]any   `json:"claim_transaction_ms"`
	PushArrivalToClaimMS        map[string]any   `json:"push_arrival_to_claim_completion_ms"`
	ClaimToTerminalMS           map[string]any   `json:"claim_to_terminal_ms"`
	TerminalTransactionMS       map[string]any   `json:"terminal_transaction_to_evidence_ms"`
	OutboxTableBytes            int64            `json:"outbox_table_bytes"`
	OutboxIndexBytes            int64            `json:"outbox_index_bytes"`
	OutboxDeadTuples            int64            `json:"outbox_dead_tuples"`
	RelayGateDeadTuples         int64            `json:"relay_gate_dead_tuples"`
	Verdict                     string           `json:"verdict"`
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

func B3BudgetStripe(idempotencyKey string, stripes int) int {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(idempotencyKey))
	return int(hash.Sum32() % uint32(stripes))
}

func B3ThreadStripe(threadKey string, stripes int) int {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(threadKey))
	return int(hash.Sum32() % uint32(stripes))
}

func (s *Store) ConfigureB3FairDispatch(ctx context.Context, capacity, principalCapacity int) error {
	if capacity <= 0 || principalCapacity <= 0 {
		return fmt.Errorf("fair dispatch and Principal capacities must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(500050, 1)`); err != nil {
		return err
	}
	var active int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM b3_outbox
		WHERE fair_selected_at IS NOT NULL AND fair_permit_released_at IS NULL`).Scan(&active); err != nil {
		return err
	}
	if active > capacity {
		return fmt.Errorf("fair dispatch capacity %d is below %d active permits", capacity, active)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO b3_fair_dispatch_budget (singleton, capacity, principal_capacity)
		VALUES (true, $1, $2)
		ON CONFLICT (singleton) DO UPDATE
		SET capacity = EXCLUDED.capacity, principal_capacity = EXCLUDED.principal_capacity,
		    in_use = 0, updated_at = clock_timestamp()`, capacity, principalCapacity); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO b3_fair_dispatch_permits (slot)
		SELECT generate_series(1, $1)
		ON CONFLICT (slot) DO NOTHING`, capacity); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM b3_fair_dispatch_permits
		WHERE slot > $1 AND agent_run_id IS NULL`, capacity); err != nil {
		return err
	}
	var excess int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM b3_fair_dispatch_permits WHERE slot > $1`, capacity).Scan(&excess); err != nil {
		return err
	}
	if excess > 0 {
		return fmt.Errorf("fair dispatch capacity %d is below active permit slots", capacity)
	}
	return tx.Commit(ctx)
}

func (s *Store) ConfigureB3InFlightBudget(ctx context.Context, totalCapacity, stripes int) error {
	if totalCapacity <= 0 {
		return fmt.Errorf("in-flight AgentRun capacity must be positive")
	}
	if stripes <= 0 || stripes > B3MaxSequenceStripes || totalCapacity < stripes {
		return fmt.Errorf("in-flight budget stripes must be between 1 and %d and no greater than capacity", B3MaxSequenceStripes)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(380039, 1)`); err != nil {
		return err
	}
	base := totalCapacity / stripes
	remainder := totalCapacity % stripes
	for stripe := 0; stripe < B3MaxSequenceStripes; stripe++ {
		capacity := 0
		if stripe < stripes {
			capacity = base
			if stripe < remainder {
				capacity++
			}
		}
		command, err := tx.Exec(ctx, `
			UPDATE b3_inflight_budget
			SET capacity = $2, updated_at = clock_timestamp()
			WHERE budget_stripe = $1`, stripe, capacity)
		if err != nil {
			return err
		}
		if command.RowsAffected() != 1 {
			return fmt.Errorf("missing in-flight budget stripe %d", stripe)
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) PrepareB3(ctx context.Context, id uuid.UUID, candidate, lane string, expectedIncoming int) error {
	expectedRuns := expectedIncoming + expectedIncoming/2
	_, err := s.pool.Exec(ctx, `
		INSERT INTO benchmarks (id, candidate, lane, expected_runs)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING`, id, candidate, lane, expectedRuns)
	return err
}

func (s *Store) InjectB3WorkerCrash(ctx context.Context, benchmarkID, agentRunID uuid.UUID) error {
	command, err := s.pool.Exec(ctx, `
		UPDATE agent_runs
		SET crash_once = true
		WHERE id = $1 AND benchmark_id = $2 AND state = 'pending'`, agentRunID, benchmarkID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("pending AgentRun %s was not found", agentRunID)
	}
	return nil
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

func (s *Store) AcceptB3(ctx context.Context, request B3Request, sequenceStripes, budgetStripes int) (B3Receipt, error) {
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

	fairDispatch := request.Principal != "" || request.Thread != ""
	if fairDispatch && (request.Principal == "" || request.Thread == "") {
		return B3Receipt{}, fmt.Errorf("principal_key and thread_key are both required for fair dispatch")
	}
	if fairDispatch {
		var configured bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM b3_fair_dispatch_budget WHERE singleton)`).Scan(&configured); err != nil {
			return B3Receipt{}, err
		}
		if !configured {
			return B3Receipt{}, ErrB3FairDispatchUnavailable
		}
	}

	ids := B3AgentRunIDs(request.BenchmarkID, request.Ordinal)
	budgetStripe := B3BudgetStripe(request.Idempotency, budgetStripes)
	principalBudgetStripe := B3BudgetStripe(request.Idempotency, B3PrincipalBudgetStripes)
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
	threadKey := request.Thread
	if threadKey == "" {
		threadKey = fmt.Sprintf("thread-%04d", request.Ordinal%1024)
	}
	sequenceStripe := request.Ordinal % sequenceStripes
	if fairDispatch {
		sequenceStripe = B3ThreadStripe(threadKey, sequenceStripes)
	}
	shard := sequenceStripe % B3RelayShards
	var firstThreadSequence int
	if fairDispatch {
		if _, err := tx.Exec(ctx, `
			INSERT INTO b3_fair_principals (benchmark_id, principal_key, virtual_pass)
			SELECT $1, $2, virtual_time
			FROM b3_fair_dispatch_budget WHERE singleton
			ON CONFLICT (benchmark_id, principal_key) DO NOTHING`, request.BenchmarkID, request.Principal); err != nil {
			return B3Receipt{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO b3_fair_principal_budget
				(benchmark_id, principal_key, budget_stripe, capacity)
			SELECT $1, $2, $3::smallint,
			       (b.principal_capacity / $4) +
			       CASE WHEN $3::integer < (b.principal_capacity % $4) THEN 1 ELSE 0 END
			FROM b3_fair_dispatch_budget b
			WHERE b.singleton
			ON CONFLICT (benchmark_id, principal_key, budget_stripe) DO NOTHING`,
			request.BenchmarkID, request.Principal, principalBudgetStripe, B3PrincipalBudgetStripes); err != nil {
			return B3Receipt{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO b3_fair_threads (benchmark_id, principal_key, thread_key)
			VALUES ($1, $2, $3)
			ON CONFLICT (benchmark_id, principal_key, thread_key) DO NOTHING`, request.BenchmarkID, request.Principal, threadKey); err != nil {
			return B3Receipt{}, err
		}
		if err := tx.QueryRow(ctx, `
			UPDATE b3_fair_threads
			SET next_admission_sequence = next_admission_sequence + $4,
			    queued_count = queued_count + $4
			WHERE benchmark_id = $1 AND principal_key = $2 AND thread_key = $3
			RETURNING next_admission_sequence - $4`, request.BenchmarkID, request.Principal, threadKey, len(ids)).Scan(&firstThreadSequence); err != nil {
			return B3Receipt{}, err
		}
	} else if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(thread_sequence), -1) + 1
		FROM agent_runs
		WHERE benchmark_id = $1 AND thread_key = $2`, request.BenchmarkID, threadKey).Scan(&firstThreadSequence); err != nil {
		return B3Receipt{}, err
	}
	for runOrdinal, id := range ids {
		if _, err = tx.Exec(ctx, `
			INSERT INTO agent_runs
				(id, benchmark_id, ordinal, principal_key, thread_key, thread_sequence, workload_ms,
				 execution_profile_ref, budget_stripe, principal_budget_stripe, fair_dispatch)
			VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, 15, $7, $8,
			        CASE WHEN $4 = '' THEN NULL ELSE $9::smallint END, $10)`,
			id, request.BenchmarkID, request.Ordinal*2+runOrdinal,
			request.Principal, threadKey, firstThreadSequence+runOrdinal,
			B3ExecutionProfileRef, budgetStripe, principalBudgetStripe, fairDispatch); err != nil {
			return B3Receipt{}, err
		}
	}
	var lastStripeSequence int64
	if err := tx.QueryRow(ctx, `
		UPDATE b3_outbox_sequence_gate
		SET next_sequence = next_sequence + $2
		WHERE sequence_stripe = $1
		RETURNING next_sequence`, sequenceStripe, len(ids)).Scan(&lastStripeSequence); err != nil {
		return B3Receipt{}, err
	}
	firstStripeSequence := lastStripeSequence - int64(len(ids)) + 1
	for runOrdinal, id := range ids {
		if _, err = tx.Exec(ctx, `
			INSERT INTO b3_outbox
				(benchmark_id, ordinal, agent_run_id, principal_key, thread_key, thread_sequence,
				 delivery_id, ordering_key, shard, sequence_stripe, stripe_sequence)
			VALUES ($1, $2, $3, NULLIF($4, ''),
			        CASE WHEN $4 = '' THEN NULL ELSE $5::text END,
			        CASE WHEN $4 = '' THEN NULL ELSE $6::integer END,
			        $7, $8, $9, $10, $11)`,
			request.BenchmarkID, request.Ordinal, id, request.Principal, threadKey,
			firstThreadSequence+runOrdinal,
			fmt.Sprintf("%s/%d/%d", request.BenchmarkID, request.Ordinal, runOrdinal),
			fmt.Sprintf("%s/%s", request.BenchmarkID, threadKey), shard, sequenceStripe,
			firstStripeSequence+int64(runOrdinal)); err != nil {
			return B3Receipt{}, err
		}
	}
	var reserved int
	if fairDispatch {
		err = tx.QueryRow(ctx, `
			UPDATE b3_fair_principal_budget
			SET in_use = in_use + $4, updated_at = clock_timestamp()
			WHERE benchmark_id = $1 AND principal_key = $2 AND budget_stripe = $3
			  AND in_use + $4 <= capacity
			RETURNING in_use`, request.BenchmarkID, request.Principal, principalBudgetStripe, len(ids)).Scan(&reserved)
		if errors.Is(err, pgx.ErrNoRows) {
			return B3Receipt{}, ErrB3PrincipalBudgetExhausted
		}
		if err != nil {
			return B3Receipt{}, err
		}
	}
	err = tx.QueryRow(ctx, `
		UPDATE b3_inflight_budget
		SET in_use = in_use + $2, updated_at = clock_timestamp()
		WHERE budget_stripe = $1 AND in_use + $2 <= capacity
		RETURNING in_use`, budgetStripe, len(ids)).Scan(&reserved)
	if errors.Is(err, pgx.ErrNoRows) {
		return B3Receipt{}, ErrB3InFlightBudgetExhausted
	}
	if err != nil {
		return B3Receipt{}, err
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

func (s *Store) TryOwnB3FairSelector(ctx context.Context) (*pgxpool.Conn, bool, error) {
	connection, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var owned bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock(500050, 1)`).Scan(&owned); err != nil {
		connection.Release()
		return nil, false, err
	}
	if !owned {
		connection.Release()
		return nil, false, nil
	}
	return connection, true, nil
}

func (s *Store) ReleaseB3FairSelector(ctx context.Context, connection *pgxpool.Conn) {
	_, _ = connection.Exec(ctx, `SELECT pg_advisory_unlock(500050, 1)`)
	connection.Release()
}

func (s *Store) SelectB3FairBatch(ctx context.Context, connection *pgxpool.Conn, limit int) ([]B3OutboxRecord, error) {
	selectedRows, err := connection.Query(ctx, `
		SELECT sequence, stripe_sequence, benchmark_id, ordinal, agent_run_id,
		       principal_key, thread_key, thread_sequence, delivery_id, ordering_key,
		       shard, sequence_stripe, ready_at, fair_selected_at, fair_published_at
		FROM b3_select_fair_batch($1)`, limit)
	if err != nil {
		return nil, err
	}
	selected, err := scanB3FairRecords(selectedRows)
	selectedRows.Close()
	if err != nil {
		return nil, err
	}
	return selected, nil
}

func (s *Store) ClaimB3FairPublicationBatch(
	ctx context.Context,
	owner string,
	limit int,
	lease time.Duration,
) ([]B3OutboxRecord, error) {
	if owner == "" {
		return nil, fmt.Errorf("publication owner is required")
	}
	if limit <= 0 || lease <= 0 {
		return nil, fmt.Errorf("publication batch and lease must be positive")
	}
	rows, err := s.pool.Query(ctx, `
		WITH candidates AS MATERIALIZED (
			SELECT benchmark_id, agent_run_id
			FROM b3_fair_publication_tasks
			WHERE lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()
			ORDER BY created_at, outbox_sequence
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		), claimed AS (
			UPDATE b3_fair_publication_tasks task
			SET owner = $1,
			    lease_acquired_at = clock_timestamp(),
			    lease_expires_at = clock_timestamp() + $3::interval,
			    publish_epoch = task.publish_epoch + 1
			FROM candidates candidate
			WHERE task.benchmark_id = candidate.benchmark_id
			  AND task.agent_run_id = candidate.agent_run_id
			RETURNING task.benchmark_id, task.agent_run_id, task.owner,
			          task.publish_epoch, task.lease_acquired_at, task.lease_expires_at
		)
		SELECT o.sequence, o.stripe_sequence, o.benchmark_id, o.ordinal, o.agent_run_id,
		       o.principal_key, o.thread_key, o.thread_sequence, o.delivery_id, o.ordering_key,
		       o.shard, o.sequence_stripe, o.ready_at, o.fair_selected_at, o.fair_published_at,
		       claimed.owner, claimed.publish_epoch, claimed.lease_acquired_at, claimed.lease_expires_at
		FROM claimed
		JOIN b3_outbox o
		  ON o.benchmark_id = claimed.benchmark_id
		 AND o.agent_run_id = claimed.agent_run_id
		ORDER BY o.fair_selected_at, o.sequence`, owner, limit, interval(lease))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []B3OutboxRecord
	for rows.Next() {
		var record B3OutboxRecord
		if err := rows.Scan(
			&record.Sequence, &record.StripeSequence, &record.BenchmarkID, &record.Ordinal,
			&record.AgentRunID, &record.Principal, &record.Thread, &record.ThreadSequence,
			&record.DeliveryID, &record.OrderingKey, &record.Shard, &record.SequenceStripe,
			&record.ReadyAt, &record.FairSelectedAt, &record.FairPublishedAt,
			&record.PublicationOwner, &record.PublicationEpoch,
			&record.LeaseAcquiredAt, &record.LeaseExpiresAt,
		); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func scanB3FairRecords(rows pgx.Rows) ([]B3OutboxRecord, error) {
	var records []B3OutboxRecord
	for rows.Next() {
		var record B3OutboxRecord
		if err := rows.Scan(
			&record.Sequence, &record.StripeSequence, &record.BenchmarkID, &record.Ordinal,
			&record.AgentRunID, &record.Principal, &record.Thread, &record.ThreadSequence,
			&record.DeliveryID, &record.OrderingKey, &record.Shard, &record.SequenceStripe,
			&record.ReadyAt, &record.FairSelectedAt, &record.FairPublishedAt,
		); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *Store) ConfirmB3FairPublications(ctx context.Context, publications []B3Publication) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := confirmB3FairPublications(ctx, tx, publications); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func confirmB3FairPublications(ctx context.Context, tx pgx.Tx, publications []B3Publication) error {
	benchmarkIDs := make([]uuid.UUID, 0, len(publications))
	agentRunIDs := make([]uuid.UUID, 0, len(publications))
	confirmedAt := make([]time.Time, 0, len(publications))
	for _, publication := range publications {
		if publication.ConfirmedAt == nil {
			continue
		}
		benchmarkIDs = append(benchmarkIDs, publication.Record.BenchmarkID)
		agentRunIDs = append(agentRunIDs, publication.Record.AgentRunID)
		confirmedAt = append(confirmedAt, *publication.ConfirmedAt)
	}
	if len(agentRunIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			WITH confirmed AS (
				UPDATE b3_outbox o
				SET fair_published_at = COALESCE(o.fair_published_at, confirmations.confirmed_at),
				    fair_permit_released_at = COALESCE(o.fair_permit_released_at, confirmations.confirmed_at)
				FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[])
					AS confirmations(benchmark_id, agent_run_id, confirmed_at)
				WHERE o.benchmark_id = confirmations.benchmark_id
				  AND o.agent_run_id = confirmations.agent_run_id
				  AND o.fair_selected_at IS NOT NULL
				RETURNING o.agent_run_id
			)
			UPDATE b3_fair_dispatch_permits permit
			SET agent_run_id = NULL, selected_at = NULL
			FROM confirmed
			WHERE permit.agent_run_id = confirmed.agent_run_id
			`, benchmarkIDs, agentRunIDs, confirmedAt); err != nil {
			return err
		}
	}
	for _, publication := range publications {
		if publication.ConfirmedAt == nil {
			continue
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM b3_fair_publication_tasks
			WHERE benchmark_id = $1 AND agent_run_id = $2
			  AND owner = $3 AND publish_epoch = $4`,
			publication.Record.BenchmarkID, publication.Record.AgentRunID,
			publication.Record.PublicationOwner, publication.Record.PublicationEpoch); err != nil {
			return err
		}
	}
	return nil
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
	if err := recordB3Publications(ctx, tx, owner, publications); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RecordB3FairPublications(ctx context.Context, owner string, publications []B3Publication) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := recordB3Publications(ctx, tx, owner, publications); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RecordAndConfirmB3FairPublications(
	ctx context.Context,
	owner string,
	publications []B3Publication,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := recordB3Publications(ctx, tx, owner, publications); err != nil {
		return err
	}
	if err := confirmB3FairPublications(ctx, tx, publications); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func recordB3Publications(ctx context.Context, tx pgx.Tx, owner string, publications []B3Publication) error {
	rows := make([][]any, 0, len(publications))
	for _, publication := range publications {
		var messageID any
		if publication.MessageID != "" {
			messageID = publication.MessageID
		}
		rows = append(rows, []any{
			publication.Record.Sequence, publication.Record.BenchmarkID, publication.Record.AgentRunID,
			publication.Record.DeliveryID, owner, nullableEpoch(publication.Record.PublicationEpoch),
			publication.Record.LeaseAcquiredAt, publication.Record.LeaseExpiresAt, publication.RequestedAt, messageID,
			publication.ConfirmedAt, publication.Outcome,
		})
	}
	if len(rows) > 0 {
		copied, err := tx.CopyFrom(ctx, pgx.Identifier{"b3_publish_evidence"}, []string{
			"outbox_sequence", "benchmark_id", "agent_run_id", "delivery_id", "relay_owner",
			"publication_epoch", "lease_acquired_at", "lease_expires_at", "requested_at",
			"provider_message_id", "provider_confirmed_at", "observed_outcome",
		}, pgx.CopyFromRows(rows))
		if err != nil {
			return err
		}
		if copied != int64(len(rows)) {
			return fmt.Errorf("recorded %d of %d publication evidence rows", copied, len(rows))
		}
	}
	return nil
}

func nullableEpoch(epoch int64) any {
	if epoch == 0 {
		return nil
	}
	return epoch
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
		LEFT JOIN b3_relay_progress p USING (sequence_stripe)
		WHERE (o.principal_key IS NULL AND o.stripe_sequence > p.last_sequence)
		   OR (o.principal_key IS NOT NULL AND o.fair_published_at IS NULL)`).Scan(&count, &oldest)
	if err != nil || oldest == nil {
		return count, 0, err
	}
	return count, time.Since(*oldest), nil
}

func (s *Store) B3FairSnapshot(ctx context.Context, benchmarkID uuid.UUID) (B3FairSnapshot, error) {
	snapshot := B3FairSnapshot{CapturedAt: time.Now().UTC(), BenchmarkID: benchmarkID}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE agent_run_id IS NOT NULL)
		FROM b3_fair_dispatch_permits`).Scan(
		&snapshot.PermitCapacity, &snapshot.PermitsInUse); err != nil {
		return B3FairSnapshot{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM b3_fair_principals p
		        WHERE p.benchmark_id = $1 AND EXISTS (
		            SELECT 1 FROM b3_fair_threads t
		            WHERE t.benchmark_id = p.benchmark_id
		              AND t.principal_key = p.principal_key AND t.queued_count > 0)),
		       (SELECT count(*) FROM b3_fair_threads t
		        WHERE t.benchmark_id = $1 AND (t.queued_count > 0 OR t.in_flight))`, benchmarkID).Scan(
		&snapshot.QueuedPrincipals, &snapshot.ActiveThreads); err != nil {
		return B3FairSnapshot{}, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT p.principal_key,
		       COALESCE((SELECT sum(t.queued_count) FROM b3_fair_threads t
		                 WHERE t.benchmark_id = p.benchmark_id AND t.principal_key = p.principal_key), 0),
		       COALESCE((SELECT count(*) FROM b3_fair_threads t
		                 WHERE t.benchmark_id = p.benchmark_id AND t.principal_key = p.principal_key
		                   AND t.in_flight), 0),
		       p.selected_count,
		       (SELECT count(*) FROM agent_runs r
		        WHERE r.benchmark_id = p.benchmark_id AND r.principal_key = p.principal_key
		          AND r.state = 'succeeded'),
		       COALESCE((SELECT extract(epoch FROM (clock_timestamp() - min(o.ready_at))) * 1000
		                 FROM b3_outbox o
		                 WHERE o.benchmark_id = p.benchmark_id
		                   AND o.principal_key = p.principal_key
		                   AND o.fair_selected_at IS NULL), 0)
		FROM b3_fair_principals p
		WHERE p.benchmark_id = $1
		ORDER BY p.principal_key`, benchmarkID)
	if err != nil {
		return B3FairSnapshot{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var principal B3FairPrincipalSnapshot
		if err := rows.Scan(&principal.Principal, &principal.Queued, &principal.InFlight,
			&principal.SelectedCount, &principal.Succeeded, &principal.OldestQueuedMS); err != nil {
			return B3FairSnapshot{}, err
		}
		snapshot.Principals = append(snapshot.Principals, principal)
	}
	return snapshot, rows.Err()
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
		SELECT count(DISTINCT execution_profile_ref)
		FROM agent_runs WHERE benchmark_id = $1`, benchmarkID).Scan(&a.DistinctExecutionProfiles); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM b3_admissions a
		WHERE a.benchmark_id = $1 AND NOT EXISTS (
			SELECT 1
			FROM unnest(a.agent_run_ids) AS ids(run_id)
			JOIN agent_runs r ON r.id = ids.run_id
			WHERE r.state <> 'succeeded'
		)`, benchmarkID).Scan(&a.GoodRootOutcomes); err != nil {
		return B3Audit{}, err
	}
	if a.AcceptedIncoming > 0 {
		a.GoodRootOutcomeRatio = float64(a.GoodRootOutcomes) / float64(a.AcceptedIncoming)
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE completed_at IS NULL)
		FROM agent_run_attempts WHERE benchmark_id = $1`, benchmarkID).Scan(
		&a.AgentRunAttempts, &a.UnfinishedAgentRunAttempts); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*),
		       (SELECT count(*) FROM model_call_attempts a
		        JOIN agent_runs r ON r.id = a.agent_run_id
		        WHERE r.benchmark_id = $1),
		       (SELECT count(*) FROM model_call_attempts a
		        JOIN agent_runs r ON r.id = a.agent_run_id
		        WHERE r.benchmark_id = $1 AND a.completed_at IS NULL)
		FROM model_calls c
		JOIN agent_runs r ON r.id = c.agent_run_id
		WHERE r.benchmark_id = $1`, benchmarkID).Scan(
		&a.ModelCalls, &a.ModelCallAttempts, &a.UnfinishedModelCallAttempts); err != nil {
		return B3Audit{}, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(capacity), 0), COALESCE(sum(in_use), 0),
		       (SELECT count(*) FROM agent_runs
		        WHERE budget_stripe IS NOT NULL AND state NOT IN ('succeeded', 'canceled'))
		FROM b3_inflight_budget`).Scan(
		&a.InFlightBudgetCapacity, &a.InFlightBudgetUsed, &a.InFlightBudgetObligations); err != nil {
		return B3Audit{}, err
	}
	if a.InFlightBudgetUsed >= a.InFlightBudgetObligations {
		a.InFlightBudgetMismatch = a.InFlightBudgetUsed - a.InFlightBudgetObligations
	} else {
		a.InFlightBudgetMismatch = a.InFlightBudgetObligations - a.InFlightBudgetUsed
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(capacity), 0), COALESCE(sum(in_use), 0),
		       (SELECT count(*) FROM agent_runs
		        WHERE benchmark_id = $1 AND principal_budget_stripe IS NOT NULL
		          AND state NOT IN ('succeeded', 'canceled'))
		FROM b3_fair_principal_budget WHERE benchmark_id = $1`, benchmarkID).Scan(
		&a.PrincipalBudgetCapacity, &a.PrincipalBudgetUsed, &a.PrincipalBudgetObligations); err != nil {
		return B3Audit{}, err
	}
	if a.PrincipalBudgetUsed >= a.PrincipalBudgetObligations {
		a.PrincipalBudgetMismatch = a.PrincipalBudgetUsed - a.PrincipalBudgetObligations
	} else {
		a.PrincipalBudgetMismatch = a.PrincipalBudgetObligations - a.PrincipalBudgetUsed
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
		SELECT count(*),
		       count(*) FILTER (WHERE lease_expires_at <= clock_timestamp()),
		       COALESCE(max(publish_epoch), 0)
		FROM b3_fair_publication_tasks WHERE benchmark_id = $1`, benchmarkID).Scan(
		&a.ActivePublicationTasks, &a.ExpiredPublicationClaims, &a.MaximumPublicationEpoch); err != nil {
		return B3Audit{}, err
	}
	var recordedMaximumEpoch int64
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(max(publication_epoch), 0)
		FROM b3_publish_evidence WHERE benchmark_id = $1`, benchmarkID).Scan(&recordedMaximumEpoch); err != nil {
		return B3Audit{}, err
	}
	if recordedMaximumEpoch > a.MaximumPublicationEpoch {
		a.MaximumPublicationEpoch = recordedMaximumEpoch
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
	completedAttempts := "benchmark_id = $1 AND outcome = 'completed'"
	a.PublishToPushArrivalMS, err = s.b3Percentiles(ctx, "delivery_attempts", "received_at - published_at", completedAttempts+" AND published_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.PushArrivalToSlotMS, err = s.b3Percentiles(ctx, "delivery_attempts", "slot_acquired_at - received_at", completedAttempts+" AND slot_acquired_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.DatabasePoolWaitMS, err = s.b3Percentiles(ctx, "delivery_attempts", "database_acquired_at - database_acquire_started_at", completedAttempts+" AND database_acquired_at IS NOT NULL AND database_acquire_started_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.ClaimTransactionMS, err = s.b3Percentiles(ctx, "delivery_attempts", "claim_completed_at - database_acquired_at", completedAttempts+" AND claim_completed_at IS NOT NULL AND database_acquired_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.PushArrivalToClaimMS, err = s.b3Percentiles(ctx, "delivery_attempts", "claim_completed_at - received_at", completedAttempts+" AND claim_completed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.ClaimToTerminalMS, err = s.b3Percentiles(ctx, "agent_runs", "completed_at - first_claimed_at", "benchmark_id = $1 AND completed_at IS NOT NULL AND first_claimed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return B3Audit{}, err
	}
	a.TerminalTransactionMS, err = s.b3Percentiles(ctx, "delivery_attempts", "terminal_evidence_at - terminal_started_at", completedAttempts+" AND terminal_evidence_at IS NOT NULL AND terminal_started_at IS NOT NULL", benchmarkID)
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
		a.UnpublishedOutboxRecords > 0 || a.NonterminalAgentRuns > 0 ||
		a.ActivePublicationTasks > 0 ||
		a.GoodRootOutcomes != a.AcceptedIncoming ||
		(a.AcceptedIncoming > 0 && a.DistinctExecutionProfiles != 1) ||
		a.ModelCalls != a.AuthoritativeAgentRuns ||
		a.UnfinishedAgentRunAttempts > 0 || a.UnfinishedModelCallAttempts > 0 ||
		a.InFlightBudgetMismatch > 0 || a.PrincipalBudgetMismatch > 0 {
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
