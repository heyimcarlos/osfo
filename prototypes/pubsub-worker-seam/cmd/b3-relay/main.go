package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/b3"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	poolSize, err := positiveInt(os.Getenv("DB_POOL_SIZE"), 4)
	if err != nil {
		return err
	}
	batchSize, err := positiveInt(os.Getenv("RELAY_BATCH_SIZE"), 128)
	if err != nil {
		return err
	}
	publisherWorkers, err := positiveInt(os.Getenv("RELAY_PUBLISHER_WORKERS"), 4)
	if err != nil {
		return err
	}
	publicationLeaseSeconds, err := positiveInt(os.Getenv("RELAY_PUBLICATION_LEASE_SECONDS"), 30)
	if err != nil {
		return err
	}
	sequenceStripes, err := positiveInt(os.Getenv("B3_SEQUENCE_STRIPES"), store.B3DefaultSequenceStripes)
	if err != nil {
		return err
	}
	if err := b3.ValidateSequenceStripes(sequenceStripes); err != nil {
		return err
	}
	fairDispatchWindow, err := nonNegativeInt(os.Getenv("B3_FAIR_DISPATCH_WINDOW"), 0)
	if err != nil {
		return err
	}
	fairPrincipalCapacity, err := positiveInt(os.Getenv("B3_FAIR_PRINCIPAL_CAPACITY"), 4096)
	if err != nil {
		return err
	}
	database, err := store.Open(ctx, required("DATABASE_URL"), "b3-relay/"+os.Getenv("HOSTNAME"), int32(poolSize))
	if err != nil {
		return err
	}
	defer database.Close()
	if fairDispatchWindow > 0 {
		if err := database.ConfigureB3FairDispatch(ctx, fairDispatchWindow, fairPrincipalCapacity); err != nil {
			return fmt.Errorf("configure fair dispatch window: %w", err)
		}
	}
	publisher, err := b3.NewPublisher(ctx, required("GCP_PROJECT_ID"), required("PUBSUB_TOPIC_ID"))
	if err != nil {
		return err
	}
	defer publisher.Close()
	relay := &b3.Relay{
		Store: database, Publisher: publisher, Owner: value("HOSTNAME", "b3-relay"),
		BatchSize: batchSize, SequenceStripes: sequenceStripes, Fault: b3.NoFault,
		FairDispatch:     fairDispatchWindow > 0,
		PublisherWorkers: publisherWorkers,
		PublicationLease: time.Duration(publicationLeaseSeconds) * time.Second,
	}
	go func() {
		for ctx.Err() == nil {
			if err := relay.Run(ctx, 25*time.Millisecond); err != nil && ctx.Err() == nil {
				logger.Error("relay loop failed", "error", err)
				time.Sleep(time.Second)
			}
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /v1/backlog", func(w http.ResponseWriter, request *http.Request) {
		count, age, err := database.B3Backlog(request.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"records": count, "oldest_age_ms": age.Milliseconds()})
	})
	server := &http.Server{Addr: ":" + value("PORT", "8080"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	err = server.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		panic("missing required environment variable " + name)
	}
	return value
}

func value(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func positiveInt(text string, fallback int) (int, error) {
	if text == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(text)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("expected positive integer, got %q", text)
	}
	return parsed, nil
}

func nonNegativeInt(text string, fallback int) (int, error) {
	if text == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(text)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("expected non-negative integer, got %q", text)
	}
	return parsed, nil
}
