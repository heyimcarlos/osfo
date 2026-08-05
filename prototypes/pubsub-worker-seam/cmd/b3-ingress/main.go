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
	poolSize, err := positiveInt(os.Getenv("DB_POOL_SIZE"), 8)
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
	database, err := store.Open(ctx, required("DATABASE_URL"), "b3-ingress/"+os.Getenv("HOSTNAME"), int32(poolSize))
	if err != nil {
		return err
	}
	defer database.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("POST /v1/admissions", func(w http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var admission store.B3Request
		if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, 64<<10)).Decode(&admission); err != nil {
			http.Error(w, "invalid admission", http.StatusBadRequest)
			return
		}
		if admission.Idempotency == "" || admission.RequestHash == "" {
			http.Error(w, "idempotency_key and request_hash are required", http.StatusBadRequest)
			return
		}
		result, err := b3.Admit(request.Context(), database, admission, sequenceStripes)
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
