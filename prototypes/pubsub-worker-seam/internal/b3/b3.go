package b3

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"cloud.google.com/go/pubsub/v2"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/worker"
)

const (
	NoFault                     = "none"
	BeforeAdmissionCommit       = "before_admission_commit"
	AfterAdmissionCommit        = "after_admission_commit"
	CommitUncertainSucceeded    = "commit_uncertain_succeeded"
	CommitUncertainFailed       = "commit_uncertain_failed"
	BeforeRelayRead             = "before_relay_read"
	BeforePublish               = "before_publish"
	AmbiguousAfterConfirmation  = "ambiguous_after_confirmation"
	AfterConfirmationBeforeSave = "after_confirmation_before_progress"
)

var ErrInjectedCut = errors.New("injected boundary cut")

func Admit(ctx context.Context, database *store.Store, request store.B3Request, sequenceStripes, budgetStripes int) (store.B3Result, error) {
	if err := database.BeginB3Attempt(ctx, request); err != nil {
		return store.B3Result{}, err
	}
	if request.Fault == BeforeAdmissionCommit || request.Fault == CommitUncertainFailed {
		_ = database.FinishB3Attempt(context.Background(), request, "unknown", request.Fault, false, !request.HardCrash)
		cut(request)
		return store.B3Result{CallerOutcome: "unknown", ErrorClass: request.Fault}, ErrInjectedCut
	}
	receipt, err := database.AcceptB3(ctx, request, sequenceStripes, budgetStripes)
	if errors.Is(err, store.ErrB3InFlightBudgetExhausted) || errors.Is(err, store.ErrB3PrincipalBudgetExhausted) {
		_ = database.FinishB3Attempt(context.Background(), request, "rejected", "overloaded", false, true)
		return overloadedResult(), nil
	}
	if err != nil {
		_ = database.FinishB3Attempt(context.Background(), request, "unknown", err.Error(), false, true)
		return store.B3Result{CallerOutcome: "unknown", ErrorClass: err.Error()}, err
	}
	if request.Fault == AfterAdmissionCommit || request.Fault == CommitUncertainSucceeded {
		_ = database.FinishB3Attempt(context.Background(), request, "unknown", request.Fault, true, !request.HardCrash)
		cut(request)
		return store.B3Result{Receipt: &receipt, CallerOutcome: "unknown", ErrorClass: request.Fault}, ErrInjectedCut
	}
	_ = database.FinishB3Attempt(context.Background(), request, "accepted", "", true, true)
	return store.B3Result{Receipt: &receipt, CallerOutcome: "accepted"}, nil
}

func AdmitAuthorityOnly(ctx context.Context, database *store.Store, request store.B3Request, sequenceStripes, budgetStripes int) (store.B3Result, error) {
	if request.Fault != "" && request.Fault != NoFault {
		return store.B3Result{CallerOutcome: "unknown", ErrorClass: "fault_requires_attempt_evidence"},
			fmt.Errorf("fault %q requires attempt evidence", request.Fault)
	}
	receipt, err := database.AcceptB3(ctx, request, sequenceStripes, budgetStripes)
	if errors.Is(err, store.ErrB3InFlightBudgetExhausted) || errors.Is(err, store.ErrB3PrincipalBudgetExhausted) {
		return overloadedResult(), nil
	}
	if err != nil {
		return store.B3Result{CallerOutcome: "unknown", ErrorClass: err.Error()}, err
	}
	return store.B3Result{Receipt: &receipt, CallerOutcome: "accepted"}, nil
}

func overloadedResult() store.B3Result {
	return store.B3Result{CallerOutcome: "rejected", ErrorClass: "overloaded", RetryAfterMS: 250}
}

func cut(request store.B3Request) {
	if request.HardCrash {
		os.Exit(86)
	}
}

type Publisher struct {
	client *pubsub.Client
	topic  *pubsub.Publisher
}

func NewPublisher(ctx context.Context, projectID, topicID string) (*Publisher, error) {
	client, err := pubsub.NewClient(ctx, projectID)
	if err != nil {
		return nil, err
	}
	topic := client.Publisher(topicID)
	topic.EnableMessageOrdering = true
	return &Publisher{client: client, topic: topic}, nil
}

func (p *Publisher) Close() error {
	p.topic.Stop()
	return p.client.Close()
}

func (p *Publisher) PublishBatch(ctx context.Context, records []store.B3OutboxRecord) ([]store.B3Publication, error) {
	results := make([]*pubsub.PublishResult, 0, len(records))
	publications := make([]store.B3Publication, 0, len(records))
	var publishErrors []error
	for _, record := range records {
		envelope := worker.Envelope{
			AgentRunID: record.AgentRunID, BenchmarkID: record.BenchmarkID,
			DeliveryID: record.DeliveryID, PublishedAt: time.Now().UTC(),
		}
		data, err := json.Marshal(envelope)
		if err != nil {
			return publications, err
		}
		requestedAt := time.Now().UTC()
		results = append(results, p.topic.Publish(ctx, &pubsub.Message{Data: data, OrderingKey: record.OrderingKey}))
		publications = append(publications, store.B3Publication{
			Record: record, RequestedAt: requestedAt, Outcome: "requested",
		})
	}
	for index, result := range results {
		messageID, err := result.Get(ctx)
		if err != nil {
			publications[index].Outcome = "provider_error"
			publishErrors = append(publishErrors, fmt.Errorf("publish record %d: %w", index, err))
			continue
		}
		confirmedAt := time.Now().UTC()
		publications[index].MessageID = messageID
		publications[index].ConfirmedAt = &confirmedAt
		publications[index].Outcome = "confirmed"
	}
	return publications, errors.Join(publishErrors...)
}

type Relay struct {
	Store            *store.Store
	Publisher        *Publisher
	Owner            string
	BatchSize        int
	SequenceStripes  int
	Fault            string
	HardCrash        bool
	FairDispatch     bool
	PublisherWorkers int
	PublicationLease time.Duration
}

func (r *Relay) RunFairSelectionOnce(ctx context.Context) (int, error) {
	if r.Fault == BeforeRelayRead {
		r.cut()
		return 0, ErrInjectedCut
	}
	connection, owned, err := r.Store.TryOwnB3FairSelector(ctx)
	if err != nil || !owned {
		return 0, err
	}
	records, err := r.Store.SelectB3FairBatch(ctx, connection, r.BatchSize)
	r.Store.ReleaseB3FairSelector(context.Background(), connection)
	return len(records), err
}

func (r *Relay) RunFairPublicationOnce(ctx context.Context) (int, error) {
	lease := r.PublicationLease
	if lease <= 0 {
		lease = 30 * time.Second
	}
	records, err := r.Store.ClaimB3FairPublicationBatch(ctx, r.Owner, r.BatchSize, lease)
	if err != nil || len(records) == 0 {
		return 0, err
	}
	if r.Fault == BeforePublish {
		r.cut()
		return 0, ErrInjectedCut
	}
	publications, publishErr := r.Publisher.PublishBatch(ctx, records)
	if r.Fault == AmbiguousAfterConfirmation && publishErr == nil {
		for index := range publications {
			publications[index].Outcome = "ambiguous_after_confirmation"
		}
	}
	if publishErr != nil {
		if err := r.Store.RecordAndConfirmB3FairPublications(context.Background(), r.Owner, publications); err != nil {
			return 0, err
		}
		return 0, publishErr
	}
	if r.Fault == AmbiguousAfterConfirmation || r.Fault == AfterConfirmationBeforeSave {
		if err := r.Store.RecordB3FairPublications(context.Background(), r.Owner, publications); err != nil {
			return 0, err
		}
		r.cut()
		return len(records), ErrInjectedCut
	}
	if err := r.Store.RecordAndConfirmB3FairPublications(
		context.Background(), r.Owner, publications,
	); err != nil {
		return 0, err
	}
	return len(records), nil
}

func (r *Relay) RunFairOnce(ctx context.Context) (int, error) {
	selected, err := r.RunFairSelectionOnce(ctx)
	if err != nil {
		return 0, err
	}
	published, err := r.RunFairPublicationOnce(ctx)
	if published > selected {
		selected = published
	}
	return selected, err
}

func (r *Relay) RunShardOnce(ctx context.Context, shard int) (int, error) {
	if r.Fault == BeforeRelayRead {
		r.cut()
		return 0, ErrInjectedCut
	}
	connection, owned, err := r.Store.TryOwnB3Shard(ctx, shard)
	if err != nil || !owned {
		return 0, err
	}
	defer r.Store.ReleaseB3Shard(context.Background(), connection, shard)
	records, err := r.Store.ReadB3Batch(ctx, connection, shard, r.SequenceStripes, r.BatchSize)
	if err != nil || len(records) == 0 {
		return 0, err
	}
	if r.Fault == BeforePublish {
		r.cut()
		return 0, ErrInjectedCut
	}
	publications, publishErr := r.Publisher.PublishBatch(ctx, records)
	if r.Fault == AmbiguousAfterConfirmation && publishErr == nil {
		for index := range publications {
			publications[index].Outcome = "ambiguous_after_confirmation"
		}
	}
	if err := r.Store.RecordB3Publications(context.Background(), connection, r.Owner, publications); err != nil {
		return 0, err
	}
	if publishErr != nil {
		return 0, publishErr
	}
	if r.Fault == AmbiguousAfterConfirmation || r.Fault == AfterConfirmationBeforeSave {
		r.cut()
		return len(records), ErrInjectedCut
	}
	if err := r.Store.AdvanceB3Progress(ctx, connection, records); err != nil {
		return 0, err
	}
	return len(records), nil
}

func (r *Relay) RunAllOnce(ctx context.Context) (int, error) {
	if r.Fault != NoFault {
		return r.runAllSerial(ctx)
	}
	type result struct {
		count int
		err   error
	}
	results := make(chan result, store.B3RelayShards)
	var wait sync.WaitGroup
	for shard := 0; shard < store.B3RelayShards; shard++ {
		wait.Add(1)
		go func(shard int) {
			defer wait.Done()
			count, err := r.RunShardOnce(ctx, shard)
			results <- result{count: count, err: err}
		}(shard)
	}
	wait.Wait()
	close(results)
	total := 0
	var failures []error
	for result := range results {
		total += result.count
		if result.err != nil {
			failures = append(failures, result.err)
		}
	}
	return total, errors.Join(failures...)
}

func (r *Relay) runAllSerial(ctx context.Context) (int, error) {
	total := 0
	for shard := 0; shard < store.B3RelayShards; shard++ {
		count, err := r.RunShardOnce(ctx, shard)
		total += count
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func (r *Relay) Run(ctx context.Context, idleDelay time.Duration) error {
	if r.FairDispatch {
		if r.Fault == NoFault {
			return r.runFairConcurrent(ctx, idleDelay)
		}
		for {
			count, err := r.RunFairOnce(ctx)
			if err != nil {
				return err
			}
			if count == 0 && !waitForRelayPoll(ctx, idleDelay) {
				return ctx.Err()
			}
		}
	}
	if r.Fault == NoFault {
		return r.runIndependentShards(ctx, idleDelay)
	}
	for {
		count, err := r.RunAllOnce(ctx)
		if err != nil && !errors.Is(err, ErrInjectedCut) {
			return err
		}
		if count == 0 && !waitForRelayPoll(ctx, idleDelay) {
			return ctx.Err()
		}
	}
}

func (r *Relay) runFairConcurrent(ctx context.Context, idleDelay time.Duration) error {
	workers := r.PublisherWorkers
	if workers <= 0 {
		workers = 4
	}
	fairContext, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, workers+1)
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		for {
			count, err := r.RunFairSelectionOnce(fairContext)
			if err != nil {
				results <- err
				return
			}
			if count == 0 && !waitForRelayPoll(fairContext, idleDelay) {
				results <- fairContext.Err()
				return
			}
		}
	}()
	for workerIndex := 0; workerIndex < workers; workerIndex++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for {
				count, err := r.RunFairPublicationOnce(fairContext)
				if err != nil {
					results <- err
					return
				}
				if count == 0 && !waitForRelayPoll(fairContext, idleDelay) {
					results <- fairContext.Err()
					return
				}
			}
		}()
	}
	err := <-results
	cancel()
	wait.Wait()
	return err
}

func (r *Relay) runIndependentShards(ctx context.Context, idleDelay time.Duration) error {
	shardContext, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make(chan error, store.B3RelayShards)
	var wait sync.WaitGroup
	for shard := 0; shard < store.B3RelayShards; shard++ {
		wait.Add(1)
		go func(shard int) {
			defer wait.Done()
			results <- r.runShard(shardContext, shard, idleDelay)
		}(shard)
	}

	err := <-results
	cancel()
	wait.Wait()
	return err
}

func (r *Relay) runShard(ctx context.Context, shard int, idleDelay time.Duration) error {
	for {
		count, err := r.RunShardOnce(ctx, shard)
		if err != nil {
			return err
		}
		if count == 0 && !waitForRelayPoll(ctx, idleDelay) {
			return ctx.Err()
		}
	}
}

func waitForRelayPoll(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (r *Relay) cut() {
	if r.HardCrash {
		os.Exit(86)
	}
}

func ValidateFault(value string) error {
	switch value {
	case NoFault, BeforeAdmissionCommit, AfterAdmissionCommit, CommitUncertainSucceeded,
		CommitUncertainFailed, BeforeRelayRead, BeforePublish, AmbiguousAfterConfirmation,
		AfterConfirmationBeforeSave:
		return nil
	default:
		return fmt.Errorf("unsupported fault %q", value)
	}
}

func ValidateSequenceStripes(value int) error {
	switch value {
	case 4, 16, 64:
		return nil
	default:
		return fmt.Errorf("sequence stripes must be 4, 16, or 64, got %d", value)
	}
}
