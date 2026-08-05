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
	budgetCapacity, err := positiveInt(os.Getenv("B3_INFLIGHT_AGENT_RUNS"), 1024)
	if err != nil {
		return err
	}
	budgetStripes, err := positiveInt(os.Getenv("B3_INFLIGHT_BUDGET_STRIPES"), store.B3DefaultBudgetStripes)
	if err != nil {
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
	admissionSlotCount, err := nonNegativeInt(os.Getenv("ADMISSION_SLOTS"), 0)
	if err != nil {
		return err
	}
	captureAttemptEvidence, err := binaryFlag(os.Getenv("CAPTURE_ATTEMPT_EVIDENCE"), true)
	if err != nil {
		return err
	}
	var admissionSlots chan struct{}
	if admissionSlotCount > 0 {
		admissionSlots = make(chan struct{}, admissionSlotCount)
	}
	database, err := store.Open(ctx, required("DATABASE_URL"), "b3-ingress/"+os.Getenv("HOSTNAME"), int32(poolSize))
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.ConfigureB3InFlightBudget(ctx, budgetCapacity, budgetStripes); err != nil {
		return fmt.Errorf("configure in-flight AgentRun budget: %w", err)
	}
	if fairDispatchWindow > 0 {
		if err := database.ConfigureB3FairDispatch(ctx, fairDispatchWindow, fairPrincipalCapacity); err != nil {
			return fmt.Errorf("configure fair dispatch window: %w", err)
		}
	}
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
		if admissionSlots != nil {
			if tryAcquire(admissionSlots) {
				defer func() { <-admissionSlots }()
			} else {
				writeOverloaded(w)
				return
			}
		}
		result, err := admitWithRetry(request.Context(), func(ctx context.Context) (store.B3Result, error) {
			if !captureAttemptEvidence {
				return b3.AdmitAuthorityOnly(ctx, database, admission, sequenceStripes, budgetStripes)
			}
			return b3.Admit(ctx, database, admission, sequenceStripes, budgetStripes)
		}, func(attempt int, err error) {
			logger.Warn("admission retry", "attempt", attempt, "error", err)
		})
		w.Header().Set("content-type", "application/json")
		status := admissionHTTPStatus(result, err)
		if status == http.StatusServiceUnavailable {
			logger.Error("admission failed", "error", err)
		} else if status == http.StatusTooManyRequests {
			w.Header().Set("retry-after", "1")
		}
		w.WriteHeader(status)
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

func admissionHTTPStatus(result store.B3Result, err error) int {
	if err != nil {
		return http.StatusServiceUnavailable
	}
	if result.CallerOutcome == "rejected" && result.ErrorClass == "overloaded" {
		return http.StatusTooManyRequests
	}
	return http.StatusCreated
}

func admitWithRetry(
	ctx context.Context,
	admit func(context.Context) (store.B3Result, error),
	onRetry func(int, error),
) (store.B3Result, error) {
	const attempts = 3
	var result store.B3Result
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		result, err = admit(ctx)
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

func tryAcquire(slots chan struct{}) bool {
	select {
	case slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func writeOverloaded(w http.ResponseWriter) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("retry-after", "1")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(store.B3Result{CallerOutcome: "rejected", ErrorClass: "overloaded", RetryAfterMS: 250})
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

func binaryFlag(text string, fallback bool) (bool, error) {
	if text == "" {
		return fallback, nil
	}
	switch text {
	case "0":
		return false, nil
	case "1":
		return true, nil
	default:
		return false, fmt.Errorf("expected 0 or 1, got %q", text)
	}
}
