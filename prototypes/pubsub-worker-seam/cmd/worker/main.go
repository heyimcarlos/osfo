package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/worker"
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
	role := required("ROLE")
	poolSize, err := worker.PositiveInt(os.Getenv("DB_POOL_SIZE"), 4)
	if err != nil {
		return err
	}
	slots, err := worker.PositiveInt(os.Getenv("WORKER_SLOTS"), 32)
	if err != nil {
		return err
	}
	leaseSeconds, err := worker.PositiveInt(os.Getenv("CLAIM_LEASE_SECONDS"), 15)
	if err != nil {
		return err
	}
	owner := role + "/" + os.Getenv("HOSTNAME")
	database, err := store.Open(ctx, required("DATABASE_URL"), owner, int32(poolSize))
	if err != nil {
		return err
	}
	defer database.Close()
	handler := worker.Handler{
		Store: database, Protocol: role, Owner: owner,
		Lease: time.Duration(leaseSeconds) * time.Second,
		Slots: make(chan struct{}, slots), Logger: logger,
	}
	switch role {
	case "push":
		server := &http.Server{Addr: ":" + value("PORT", "8080"), Handler: handler.HTTPHandler(), ReadHeaderTimeout: 5 * time.Second}
		go func() {
			<-ctx.Done()
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = server.Shutdown(shutdown)
		}()
		err := server.ListenAndServe()
		if worker.IsServerClosed(err) {
			return nil
		}
		return err
	case "pull":
		return worker.RunPull(ctx, required("GCP_PROJECT_ID"), required("PUBSUB_SUBSCRIPTION_ID"), handler, slots)
	default:
		return fmt.Errorf("invalid ROLE %q", role)
	}
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
