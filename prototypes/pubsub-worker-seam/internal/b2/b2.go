package b2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"cloud.google.com/go/pubsub/v2"
	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/worker"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

type Ordering string

const (
	DatabaseFirst Ordering = "database_first"
	PublishFirst  Ordering = "publish_first"
	Concurrent    Ordering = "concurrent"
)

type Fault string

const (
	NoFault                  Fault = "none"
	AfterDatabaseCommit      Fault = "after_database_commit"
	AfterPublishConfirmation Fault = "after_publish_confirmation"
	AfterBothBeforeResponse  Fault = "after_both_before_response"
	AmbiguousPublishResponse Fault = "ambiguous_publish_response"
	PublishDeadline          Fault = "publish_deadline"
	PublishUnavailable       Fault = "publish_unavailable"
	PublishThrottled         Fault = "publish_throttled"
	CommitUncertainSucceeded Fault = "commit_uncertain_succeeded"
	CommitUncertainFailed    Fault = "commit_uncertain_failed"
)

var ErrInjectedCut = errors.New("injected boundary cut")

type Request struct {
	BenchmarkID   uuid.UUID     `json:"benchmark_id"`
	Ordinal       int           `json:"ordinal"`
	Attempt       int           `json:"attempt"`
	Idempotency   string        `json:"idempotency_key"`
	RequestHash   string        `json:"request_hash"`
	Ordering      Ordering      `json:"ordering"`
	Fault         Fault         `json:"fault"`
	RetryExpected bool          `json:"retry_expected"`
	HardCrash     bool          `json:"hard_crash"`
	DatabaseDelay time.Duration `json:"-"`
	PublishDelay  time.Duration `json:"-"`
}

type Receipt struct {
	BenchmarkID      uuid.UUID   `json:"benchmark_id"`
	Ordinal          int         `json:"ordinal"`
	RootAgentRunID   uuid.UUID   `json:"root_agent_run_id"`
	AgentRunIDs      []uuid.UUID `json:"agent_run_ids"`
	AcceptedAt       time.Time   `json:"accepted_at"`
	IdempotentReplay bool        `json:"idempotent_replay"`
}

type Result struct {
	Receipt            *Receipt `json:"receipt,omitempty"`
	ProviderMessageIDs []string `json:"provider_message_ids,omitempty"`
	CallerOutcome      string   `json:"caller_outcome"`
	ErrorClass         string   `json:"error_class,omitempty"`
}

type Audit struct {
	BenchmarkID              uuid.UUID        `json:"benchmark_id"`
	Candidate                string           `json:"candidate"`
	Lane                     string           `json:"lane"`
	ExpectedIncoming         int64            `json:"expected_incoming"`
	ExpectedAgentRuns        int64            `json:"expected_agent_runs"`
	AcceptedIncoming         int64            `json:"accepted_incoming"`
	AuthoritativeAgentRuns   int64            `json:"authoritative_agent_runs"`
	SucceededAgentRuns       int64            `json:"succeeded_agent_runs"`
	NonterminalAcceptedRuns  int64            `json:"nonterminal_accepted_agent_runs"`
	PublishedNonterminalRuns int64            `json:"published_nonterminal_agent_runs"`
	StrandedAcceptedRuns     int64            `json:"stranded_accepted_agent_runs"`
	GhostDeliveryAttempts    int64            `json:"ghost_delivery_attempts"`
	DuplicatePublications    int64            `json:"duplicate_publications"`
	DuplicateTerminalCommits int64            `json:"duplicate_terminal_commits"`
	UnknownCallerOutcomes    int64            `json:"unknown_caller_outcomes"`
	IrreconcilableUnknowns   int64            `json:"irreconcilable_unknown_outcomes"`
	PublishAttempts          int64            `json:"publish_attempts"`
	ConfirmedPublications    int64            `json:"confirmed_publications"`
	DeliveryAttempts         int64            `json:"delivery_attempts"`
	DeliveryAttemptOutcomes  map[string]int64 `json:"delivery_attempt_outcomes"`
	CallerToReceiptMS        map[string]any   `json:"caller_to_receipt_ms"`
	CommitToPublishMS        map[string]any   `json:"commit_to_publish_confirmation_ms"`
	PublishToClaimMS         map[string]any   `json:"publish_to_point_claim_ms"`
	ClaimToTerminalMS        map[string]any   `json:"claim_to_terminal_ms"`
	Verdict                  string           `json:"verdict"`
}

type Store struct {
	pool *pgxpool.Pool
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

func (s *Store) PrepareBenchmark(ctx context.Context, id uuid.UUID, candidate, lane string, expectedIncoming int) error {
	expectedRuns := expectedIncoming + expectedIncoming/2
	_, err := s.pool.Exec(ctx, `
		INSERT INTO benchmarks (id, candidate, lane, expected_runs)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING`, id, candidate, lane, expectedRuns)
	return err
}

func (s *Store) BeginAttempt(ctx context.Context, request Request) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO b2_attempt_evidence
			(benchmark_id, ordinal, attempt, ordering, fault, retry_expected, started_at, caller_outcome)
		VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), 'in_flight')
		ON CONFLICT (benchmark_id, ordinal, attempt) DO NOTHING`,
		request.BenchmarkID, request.Ordinal, request.Attempt, request.Ordering, request.Fault, request.RetryExpected)
	return err
}

func (s *Store) mark(ctx context.Context, request Request, assignment string, args ...any) error {
	values := []any{request.BenchmarkID, request.Ordinal, request.Attempt}
	values = append(values, args...)
	_, err := s.pool.Exec(ctx, `UPDATE b2_attempt_evidence SET `+assignment+` WHERE benchmark_id = $1 AND ordinal = $2 AND attempt = $3`, values...)
	return err
}

func (s *Store) MarkAuthorityCommitted(ctx context.Context, request Request) error {
	return s.mark(ctx, request, "authority_committed_at = clock_timestamp()")
}

func (s *Store) MarkPublishRequested(ctx context.Context, request Request) error {
	return s.mark(ctx, request, "publish_requested_at = clock_timestamp()")
}

func (s *Store) MarkPublishConfirmed(ctx context.Context, request Request, messageIDs []string) error {
	return s.mark(ctx, request, "publish_confirmed_at = clock_timestamp(), provider_message_ids = $4", messageIDs)
}

func (s *Store) FinishAttempt(ctx context.Context, request Request, outcome, errorClass string, responded bool) error {
	response := "NULL"
	if responded {
		response = "clock_timestamp()"
	}
	return s.mark(ctx, request, "caller_outcome = $4, error_class = NULLIF($5, ''), response_completed_at = "+response, outcome, errorClass)
}

func AgentRunIDs(benchmarkID uuid.UUID, ordinal int) []uuid.UUID {
	namespace := uuid.NewSHA1(uuid.NameSpaceURL, []byte("osfo-b2/"+benchmarkID.String()))
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

func (s *Store) Accept(ctx context.Context, request Request) (Receipt, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Receipt{}, err
	}
	defer tx.Rollback(ctx)

	var existing Receipt
	var existingHash string
	err = tx.QueryRow(ctx, `
		SELECT benchmark_id, ordinal, root_agent_run_id, agent_run_ids, accepted_at, request_hash
		FROM b2_admissions WHERE idempotency_key = $1 FOR UPDATE`, request.Idempotency).Scan(
		&existing.BenchmarkID, &existing.Ordinal, &existing.RootAgentRunID,
		&existing.AgentRunIDs, &existing.AcceptedAt, &existingHash,
	)
	if err == nil {
		if existingHash != request.RequestHash || existing.BenchmarkID != request.BenchmarkID || existing.Ordinal != request.Ordinal {
			return Receipt{}, fmt.Errorf("idempotency key reused with different input")
		}
		existing.IdempotentReplay = true
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Receipt{}, err
	}

	ids := AgentRunIDs(request.BenchmarkID, request.Ordinal)
	var acceptedAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO b2_admissions
			(benchmark_id, ordinal, idempotency_key, request_hash, ordering, root_agent_run_id, agent_run_ids)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING accepted_at`, request.BenchmarkID, request.Ordinal, request.Idempotency,
		request.RequestHash, request.Ordering, ids[0], ids).Scan(&acceptedAt)
	if err != nil {
		return Receipt{}, err
	}
	for runOrdinal, id := range ids {
		_, err = tx.Exec(ctx, `
			INSERT INTO agent_runs
				(id, benchmark_id, ordinal, thread_key, thread_sequence, workload_ms)
			VALUES ($1, $2, $3, $4, $5, 15)`,
			id, request.BenchmarkID, request.Ordinal*2+runOrdinal,
			fmt.Sprintf("thread-%04d", request.Ordinal%1024), request.Ordinal/1024*2+runOrdinal)
		if err != nil {
			return Receipt{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, err
	}
	return Receipt{
		BenchmarkID: request.BenchmarkID, Ordinal: request.Ordinal,
		RootAgentRunID: ids[0], AgentRunIDs: ids, AcceptedAt: acceptedAt,
	}, nil
}

func (s *Store) RecordPublication(ctx context.Context, request Request, runID uuid.UUID, deliveryID string, requestedAt time.Time, messageID, outcome string, confirmedAt *time.Time) {
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO b2_publish_evidence
			(benchmark_id, ordinal, attempt, agent_run_id, delivery_id, requested_at, provider_message_id, provider_confirmed_at, observed_outcome)
		VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8, $9)`,
		request.BenchmarkID, request.Ordinal, request.Attempt, runID, deliveryID,
		requestedAt, messageID, confirmedAt, outcome)
}

func (s *Store) Remaining(ctx context.Context, benchmarkID uuid.UUID) (int64, error) {
	var count int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM agent_runs WHERE benchmark_id = $1 AND state NOT IN ('succeeded', 'canceled')`, benchmarkID).Scan(&count)
	return count, err
}

func (s *Store) Audit(ctx context.Context, benchmarkID uuid.UUID, expectedIncoming int) (Audit, error) {
	a := Audit{BenchmarkID: benchmarkID, ExpectedIncoming: int64(expectedIncoming), ExpectedAgentRuns: int64(expectedIncoming + expectedIncoming/2)}
	err := s.pool.QueryRow(ctx, `
		SELECT candidate, lane FROM benchmarks WHERE id = $1`, benchmarkID).Scan(&a.Candidate, &a.Lane)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM b2_admissions WHERE benchmark_id = $1`, benchmarkID).Scan(&a.AcceptedIncoming)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE state = 'succeeded'),
		       count(*) FILTER (WHERE state NOT IN ('succeeded', 'canceled')),
		       count(*) FILTER (WHERE terminal_commits > 1)
		FROM agent_runs WHERE benchmark_id = $1`, benchmarkID).Scan(
		&a.AuthoritativeAgentRuns, &a.SucceededAgentRuns,
		&a.NonterminalAcceptedRuns, &a.DuplicateTerminalCommits)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE EXISTS (
				SELECT 1 FROM b2_publish_evidence p
				WHERE p.benchmark_id = r.benchmark_id AND p.agent_run_id = r.id
				  AND p.provider_confirmed_at IS NOT NULL
			)),
			count(*) FILTER (WHERE
				NOT EXISTS (
					SELECT 1 FROM b2_publish_evidence p
					WHERE p.benchmark_id = r.benchmark_id AND p.agent_run_id = r.id
					  AND p.provider_confirmed_at IS NOT NULL
				)
				OR (
					EXISTS (
						SELECT 1 FROM delivery_attempts d
						WHERE d.benchmark_id = r.benchmark_id AND d.agent_run_id = r.id
						  AND d.received_at < a.accepted_at
					)
					AND NOT EXISTS (
						SELECT 1 FROM delivery_attempts d
						WHERE d.benchmark_id = r.benchmark_id AND d.agent_run_id = r.id
						  AND d.received_at >= a.accepted_at
					)
				)
			)
		FROM agent_runs r
		JOIN (
			SELECT accepted_at, unnest(agent_run_ids) AS agent_run_id
			FROM b2_admissions WHERE benchmark_id = $1
		) a ON a.agent_run_id = r.id
		WHERE r.benchmark_id = $1 AND r.state NOT IN ('succeeded', 'canceled')`, benchmarkID).Scan(
		&a.PublishedNonterminalRuns, &a.StrandedAcceptedRuns)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `
		WITH admission_runs AS (
			SELECT accepted_at, unnest(agent_run_ids) AS agent_run_id
			FROM b2_admissions WHERE benchmark_id = $1
		)
		SELECT count(*) FROM delivery_attempts d
		LEFT JOIN agent_runs r ON r.benchmark_id = d.benchmark_id AND r.id = d.agent_run_id
		LEFT JOIN admission_runs a ON a.agent_run_id = d.agent_run_id
		WHERE d.benchmark_id = $1 AND (r.id IS NULL OR a.accepted_at IS NULL OR d.received_at < a.accepted_at)`, benchmarkID).Scan(&a.GhostDeliveryAttempts)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE provider_confirmed_at IS NOT NULL)
		FROM b2_publish_evidence WHERE benchmark_id = $1`, benchmarkID).Scan(&a.PublishAttempts, &a.ConfirmedPublications)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(extra), 0) FROM (
			SELECT greatest(count(*) FILTER (WHERE provider_confirmed_at IS NOT NULL) - 1, 0) AS extra
			FROM b2_publish_evidence WHERE benchmark_id = $1 GROUP BY agent_run_id
		) counts`, benchmarkID).Scan(&a.DuplicatePublications)
	if err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM delivery_attempts WHERE benchmark_id = $1`, benchmarkID).Scan(&a.DeliveryAttempts)
	if err != nil {
		return Audit{}, err
	}
	a.DeliveryAttemptOutcomes = make(map[string]int64)
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
		a.DeliveryAttemptOutcomes[outcome] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Audit{}, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE caller_outcome IN ('in_flight', 'unknown')),
		       count(DISTINCT ordinal) FILTER (
			WHERE caller_outcome IN ('in_flight', 'unknown')
			  AND NOT EXISTS (
				SELECT 1 FROM b2_attempt_evidence resolved
				WHERE resolved.benchmark_id = e.benchmark_id AND resolved.ordinal = e.ordinal
				  AND resolved.response_completed_at IS NOT NULL
				  AND resolved.caller_outcome IN ('accepted', 'rejected')
			  )
		   )
		FROM b2_attempt_evidence e WHERE benchmark_id = $1`, benchmarkID).Scan(&a.UnknownCallerOutcomes, &a.IrreconcilableUnknowns)
	if err != nil {
		return Audit{}, err
	}
	for column, destination := range map[string]*map[string]any{
		"response_completed_at - started_at":            &a.CallerToReceiptMS,
		"publish_confirmed_at - authority_committed_at": &a.CommitToPublishMS,
	} {
		*destination, err = s.percentiles(ctx, `b2_attempt_evidence`, column, "benchmark_id = $1 AND "+column+" IS NOT NULL", benchmarkID)
		if err != nil {
			return Audit{}, err
		}
	}
	a.PublishToClaimMS, err = s.percentiles(ctx, `agent_runs`, "first_claimed_at - first_published_at", "benchmark_id = $1 AND first_claimed_at IS NOT NULL AND first_published_at IS NOT NULL", benchmarkID)
	if err != nil {
		return Audit{}, err
	}
	a.ClaimToTerminalMS, err = s.percentiles(ctx, `agent_runs`, "completed_at - first_claimed_at", "benchmark_id = $1 AND completed_at IS NOT NULL AND first_claimed_at IS NOT NULL", benchmarkID)
	if err != nil {
		return Audit{}, err
	}
	a.Verdict = "PASS"
	if a.PublishAttempts == 0 && a.UnknownCallerOutcomes == 0 && a.AcceptedIncoming == 0 {
		a.Verdict = "MISSING"
	}
	if a.StrandedAcceptedRuns > 0 || a.GhostDeliveryAttempts > 0 || a.IrreconcilableUnknowns > 0 || a.DuplicateTerminalCommits > 0 || a.AcceptedIncoming > a.ExpectedIncoming {
		a.Verdict = "FAIL"
	}
	return a, nil
}

func (s *Store) percentiles(ctx context.Context, table, expression, where string, benchmarkID uuid.UUID) (map[string]any, error) {
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

type Publisher struct {
	client *pubsub.Client
	topic  *pubsub.Publisher
	store  *Store
}

func NewPublisher(ctx context.Context, projectID, topicID string, store *Store, options ...option.ClientOption) (*Publisher, error) {
	client, err := pubsub.NewClient(ctx, projectID, options...)
	if err != nil {
		return nil, err
	}
	topic := client.Publisher(topicID)
	topic.EnableMessageOrdering = true
	return &Publisher{client: client, topic: topic, store: store}, nil
}

func (p *Publisher) Close() error {
	p.topic.Stop()
	return p.client.Close()
}

func (p *Publisher) Publish(ctx context.Context, request Request) ([]string, error) {
	if request.Fault == PublishDeadline || request.Fault == PublishUnavailable || request.Fault == PublishThrottled {
		outcome := string(request.Fault)
		for runIndex, runID := range AgentRunIDs(request.BenchmarkID, request.Ordinal) {
			requestedAt := time.Now().UTC()
			p.store.RecordPublication(ctx, request, runID, deliveryID(request, runIndex), requestedAt, "", outcome, nil)
		}
		return nil, fmt.Errorf("injected %s before provider dispatch", request.Fault)
	}
	ids := AgentRunIDs(request.BenchmarkID, request.Ordinal)
	results := make([]*pubsub.PublishResult, 0, len(ids))
	requested := make([]time.Time, 0, len(ids))
	for runIndex, runID := range ids {
		envelope := worker.Envelope{
			AgentRunID: runID, BenchmarkID: request.BenchmarkID,
			DeliveryID: deliveryID(request, runIndex), PublishedAt: time.Now().UTC(),
		}
		data, _ := json.Marshal(envelope)
		message := &pubsub.Message{
			Data:        data,
			OrderingKey: fmt.Sprintf("%s/thread-%04d", request.BenchmarkID, request.Ordinal%1024),
		}
		requested = append(requested, time.Now().UTC())
		results = append(results, p.topic.Publish(ctx, message))
	}
	messageIDs := make([]string, 0, len(results))
	for runIndex, result := range results {
		messageID, err := result.Get(ctx)
		confirmedAt := time.Now().UTC()
		if err != nil {
			p.store.RecordPublication(ctx, request, ids[runIndex], deliveryID(request, runIndex), requested[runIndex], "", "provider_error", nil)
			return messageIDs, err
		}
		outcome := "confirmed"
		if request.Fault == AmbiguousPublishResponse {
			outcome = "ambiguous_after_confirmation"
		}
		p.store.RecordPublication(ctx, request, ids[runIndex], deliveryID(request, runIndex), requested[runIndex], messageID, outcome, &confirmedAt)
		messageIDs = append(messageIDs, messageID)
	}
	if request.Fault == AmbiguousPublishResponse {
		return messageIDs, fmt.Errorf("injected ambiguous publish response after broker confirmation")
	}
	return messageIDs, nil
}

func deliveryID(request Request, runIndex int) string {
	return fmt.Sprintf("%s/%d/%d", request.BenchmarkID, request.Ordinal, runIndex)
}

type Admitter struct {
	Store     *Store
	Publisher *Publisher
}

func (a *Admitter) Admit(ctx context.Context, request Request) (Result, error) {
	if err := a.Store.BeginAttempt(ctx, request); err != nil {
		return Result{}, err
	}
	if request.DatabaseDelay > 0 && request.Ordering != Concurrent {
		time.Sleep(request.DatabaseDelay)
	}
	var receipt Receipt
	var messageIDs []string
	var receiptErr, publishErr error

	accept := func() {
		if request.Fault == CommitUncertainFailed {
			receiptErr = fmt.Errorf("injected failed database commit with uncertain client outcome")
			return
		}
		receipt, receiptErr = a.Store.Accept(ctx, request)
		if receiptErr == nil {
			_ = a.Store.MarkAuthorityCommitted(context.Background(), request)
			if request.Fault == AfterDatabaseCommit || request.Fault == CommitUncertainSucceeded {
				a.cut(request, "database_commit")
				receiptErr = ErrInjectedCut
			}
		}
	}
	publish := func() {
		_ = a.Store.MarkPublishRequested(context.Background(), request)
		messageIDs, publishErr = a.Publisher.Publish(ctx, request)
		if len(messageIDs) > 0 {
			_ = a.Store.MarkPublishConfirmed(context.Background(), request, messageIDs)
		}
		if publishErr == nil && request.Fault == AfterPublishConfirmation {
			a.cut(request, "publish_confirmation")
			publishErr = ErrInjectedCut
		}
	}

	switch request.Ordering {
	case DatabaseFirst:
		accept()
		if receiptErr == nil {
			publish()
		}
	case PublishFirst:
		publish()
		if publishErr == nil {
			accept()
		}
	case Concurrent:
		// Deterministic precedence lanes represent both possible winners of a
		// concurrent race. A boundary cut stops the process before the delayed
		// side starts, matching an actual process loss at that durable edge.
		if request.PublishDelay > 0 && (request.Fault == AfterDatabaseCommit || request.Fault == CommitUncertainSucceeded) {
			accept()
			break
		}
		if request.DatabaseDelay > 0 && request.Fault == AfterPublishConfirmation {
			publish()
			break
		}
		if request.DatabaseDelay > 0 && request.Fault == CommitUncertainFailed {
			publish()
			if publishErr == nil {
				accept()
			}
			break
		}
		var wait sync.WaitGroup
		wait.Add(2)
		go func() {
			defer wait.Done()
			if request.DatabaseDelay > 0 {
				time.Sleep(request.DatabaseDelay)
			}
			accept()
		}()
		go func() {
			defer wait.Done()
			if request.PublishDelay > 0 {
				time.Sleep(request.PublishDelay)
			}
			publish()
		}()
		wait.Wait()
	default:
		return Result{}, fmt.Errorf("unsupported ordering %q", request.Ordering)
	}

	if receiptErr != nil || publishErr != nil {
		errorClass := firstError(receiptErr, publishErr)
		_ = a.Store.FinishAttempt(context.Background(), request, "unknown", errorClass, !errors.Is(receiptErr, ErrInjectedCut) && !errors.Is(publishErr, ErrInjectedCut))
		return Result{Receipt: optionalReceipt(receipt), ProviderMessageIDs: messageIDs, CallerOutcome: "unknown", ErrorClass: errorClass}, firstNonNil(receiptErr, publishErr)
	}
	if request.Fault == AfterBothBeforeResponse {
		a.cut(request, "before_caller_response")
		_ = a.Store.FinishAttempt(context.Background(), request, "unknown", "after_both_before_response", false)
		return Result{Receipt: &receipt, ProviderMessageIDs: messageIDs, CallerOutcome: "unknown", ErrorClass: "after_both_before_response"}, ErrInjectedCut
	}
	_ = a.Store.FinishAttempt(context.Background(), request, "accepted", "", true)
	return Result{Receipt: &receipt, ProviderMessageIDs: messageIDs, CallerOutcome: "accepted"}, nil
}

func (a *Admitter) cut(request Request, phase string) {
	_ = a.Store.FinishAttempt(context.Background(), request, "unknown", "cut_after_"+phase, false)
	if request.HardCrash {
		os.Exit(86)
	}
}

func optionalReceipt(receipt Receipt) *Receipt {
	if receipt.RootAgentRunID == uuid.Nil {
		return nil
	}
	return &receipt
}

func firstNonNil(values ...error) error {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstError(values ...error) string {
	if err := firstNonNil(values...); err != nil {
		return err.Error()
	}
	return ""
}
