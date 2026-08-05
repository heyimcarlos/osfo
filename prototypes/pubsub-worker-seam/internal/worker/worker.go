package worker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"cloud.google.com/go/pubsub/v2"
	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/delivery"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

type Envelope struct {
	AgentRunID  uuid.UUID `json:"agent_run_id"`
	BenchmarkID uuid.UUID `json:"benchmark_id"`
	DeliveryID  string    `json:"delivery_id"`
	PublishedAt time.Time `json:"published_at"`
}

type Handler struct {
	Store    *store.Store
	Protocol string
	Owner    string
	Lease    time.Duration
	Slots    chan struct{}
	Logger   *slog.Logger
}

type Result string

const (
	Ack  Result = "ack"
	Nack Result = "nack"
)

func (h Handler) Handle(ctx context.Context, envelope Envelope, messageID string, brokerAttempt int) Result {
	h.Slots <- struct{}{}
	defer func() { <-h.Slots }()
	claim, err := claimWithRetry(ctx, func(ctx context.Context) (store.ClaimResult, error) {
		return h.Store.TryClaim(ctx, envelope.AgentRunID, envelope.BenchmarkID, h.Owner+"/"+messageID, envelope.PublishedAt, h.Lease)
	}, func(attempt int, err error) {
		h.Logger.Warn("claim retry", "run_id", envelope.AgentRunID, "attempt", attempt, "error", err)
	})
	if err != nil {
		h.Logger.Error("claim failed", "run_id", envelope.AgentRunID, "error", err)
		h.Store.RecordAttempt(ctx, envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "claim_error")
		return Nack
	}
	switch claim.Action {
	case delivery.Acknowledge:
		h.Store.RecordAttempt(ctx, envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "already_terminal_or_missing")
		return Ack
	case delivery.Retry:
		h.Store.RecordAttempt(ctx, envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "lease_or_order_retry")
		timer := time.NewTimer(250 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
		case <-timer.C:
		}
		return Nack
	}
	if claim.Run.CrashInjected {
		h.Store.RecordAttempt(context.Background(), envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "injected_process_exit")
		h.Logger.Warn("injecting process exit", "run_id", envelope.AgentRunID)
		os.Exit(86)
	}
	timer := time.NewTimer(claim.Run.Workload)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		h.Store.RecordAttempt(context.Background(), envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "context_canceled")
		return Nack
	case <-timer.C:
	}
	committed, err := h.Store.Complete(ctx, *claim.Run)
	if err != nil || !committed {
		h.Store.RecordAttempt(ctx, envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "completion_rejected")
		return Nack
	}
	h.Store.RecordAttempt(ctx, envelope.BenchmarkID, envelope.AgentRunID, h.Protocol, messageID, brokerAttempt, "completed")
	return Ack
}

func claimWithRetry(
	ctx context.Context,
	claim func(context.Context) (store.ClaimResult, error),
	onRetry func(int, error),
) (store.ClaimResult, error) {
	const attempts = 3
	var result store.ClaimResult
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		result, err = claim(ctx)
		if err == nil || ctx.Err() != nil || attempt == attempts {
			return result, err
		}
		onRetry(attempt, err)
		timer := time.NewTimer(time.Duration(attempt*50) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return result, ctx.Err()
		case <-timer.C:
		}
	}
	return result, err
}

type PushEnvelope struct {
	Message struct {
		Data        string    `json:"data"`
		MessageID   string    `json:"messageId"`
		PublishTime time.Time `json:"publishTime"`
	} `json:"message"`
	DeliveryAttempt int `json:"deliveryAttempt"`
}

func (h Handler) HTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("POST /v1/pubsub/push", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var push PushEnvelope
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&push); err != nil {
			http.Error(w, "invalid Pub/Sub envelope", http.StatusBadRequest)
			return
		}
		data, err := base64.StdEncoding.DecodeString(push.Message.Data)
		if err != nil {
			http.Error(w, "invalid Pub/Sub data", http.StatusBadRequest)
			return
		}
		var envelope Envelope
		if err := json.Unmarshal(data, &envelope); err != nil || envelope.AgentRunID == uuid.Nil || envelope.BenchmarkID == uuid.Nil {
			http.Error(w, "invalid delivery envelope", http.StatusBadRequest)
			return
		}
		if !push.Message.PublishTime.IsZero() {
			envelope.PublishedAt = push.Message.PublishTime
		}
		if h.Handle(r.Context(), envelope, push.Message.MessageID, push.DeliveryAttempt) == Ack {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, "retry", http.StatusServiceUnavailable)
	})
	return mux
}

func RunPull(ctx context.Context, projectID, subscriptionID string, handler Handler, maxOutstanding int) error {
	client, err := pubsub.NewClient(ctx, projectID)
	if err != nil {
		return err
	}
	defer client.Close()
	sub := client.Subscriber(subscriptionID)
	sub.ReceiveSettings.MaxOutstandingMessages = maxOutstanding
	sub.ReceiveSettings.MaxOutstandingBytes = 64 << 20
	sub.ReceiveSettings.NumGoroutines = 4
	sub.ReceiveSettings.EnablePerStreamFlowControl = true
	sub.ReceiveSettings.MaxExtension = 2 * time.Minute
	sub.ReceiveSettings.MinDurationPerAckExtension = 10 * time.Second
	sub.ReceiveSettings.MaxDurationPerAckExtension = 10 * time.Second
	return sub.Receive(ctx, func(messageContext context.Context, message *pubsub.Message) {
		var envelope Envelope
		if err := json.Unmarshal(message.Data, &envelope); err != nil || envelope.AgentRunID == uuid.Nil || envelope.BenchmarkID == uuid.Nil {
			message.Ack()
			return
		}
		if !message.PublishTime.IsZero() {
			envelope.PublishedAt = message.PublishTime
		}
		attempt := 0
		if message.DeliveryAttempt != nil {
			attempt = *message.DeliveryAttempt
		}
		if handler.Handle(messageContext, envelope, message.ID, attempt) == Ack {
			message.Ack()
		} else {
			message.Nack()
		}
	})
}

func PositiveInt(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("expected positive integer, got %q", value)
	}
	return parsed, nil
}

func IsServerClosed(err error) bool { return errors.Is(err, http.ErrServerClosed) }
