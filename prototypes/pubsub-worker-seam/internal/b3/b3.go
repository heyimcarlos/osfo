package b3

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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

func Admit(ctx context.Context, database *store.Store, request store.B3Request) (store.B3Result, error) {
	if err := database.BeginB3Attempt(ctx, request); err != nil {
		return store.B3Result{}, err
	}
	if request.Fault == BeforeAdmissionCommit || request.Fault == CommitUncertainFailed {
		_ = database.FinishB3Attempt(context.Background(), request, "unknown", request.Fault, false, !request.HardCrash)
		cut(request)
		return store.B3Result{CallerOutcome: "unknown", ErrorClass: request.Fault}, ErrInjectedCut
	}
	receipt, err := database.AcceptB3(ctx, request)
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
			return publications, err
		}
		confirmedAt := time.Now().UTC()
		publications[index].MessageID = messageID
		publications[index].ConfirmedAt = &confirmedAt
		publications[index].Outcome = "confirmed"
	}
	return publications, nil
}

type Relay struct {
	Store     *store.Store
	Publisher *Publisher
	Owner     string
	BatchSize int
	Fault     string
	HardCrash bool
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
	records, err := r.Store.ReadB3Batch(ctx, connection, shard, r.BatchSize)
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
	if err := r.Store.RecordB3Publications(context.Background(), r.Owner, publications); err != nil {
		return 0, err
	}
	if publishErr != nil {
		return 0, publishErr
	}
	if r.Fault == AmbiguousAfterConfirmation || r.Fault == AfterConfirmationBeforeSave {
		r.cut()
		return len(records), ErrInjectedCut
	}
	if err := r.Store.AdvanceB3Progress(ctx, connection, shard, records[len(records)-1].Sequence); err != nil {
		return 0, err
	}
	return len(records), nil
}

func (r *Relay) RunAllOnce(ctx context.Context) (int, error) {
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
	for {
		count, err := r.RunAllOnce(ctx)
		if err != nil && !errors.Is(err, ErrInjectedCut) {
			return err
		}
		if count == 0 {
			timer := time.NewTimer(idleDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
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
