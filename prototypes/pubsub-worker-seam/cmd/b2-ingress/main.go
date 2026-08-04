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

	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/b2"
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
	poolSize, err := positiveInt(os.Getenv("DB_POOL_SIZE"), 8)
	if err != nil {
		return err
	}
	store, err := b2.Open(ctx, required("DATABASE_URL"), "b2-ingress/"+os.Getenv("HOSTNAME"), int32(poolSize))
	if err != nil {
		return err
	}
	defer store.Close()
	publisher, err := b2.NewPublisher(ctx, required("GCP_PROJECT_ID"), required("PUBSUB_TOPIC_ID"), store)
	if err != nil {
		return err
	}
	defer publisher.Close()
	admitter := &b2.Admitter{Store: store, Publisher: publisher}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("POST /v1/admissions", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var request b2.Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&request); err != nil {
			http.Error(w, "invalid admission", http.StatusBadRequest)
			return
		}
		if request.Idempotency == "" || request.RequestHash == "" {
			http.Error(w, "idempotency_key and request_hash are required", http.StatusBadRequest)
			return
		}
		result, err := admitter.Admit(r.Context(), request)
		w.Header().Set("content-type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusCreated)
		}
		_ = json.NewEncoder(w).Encode(result)
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

func positiveInt(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("expected positive integer, got %q", value)
	}
	return parsed, nil
}
