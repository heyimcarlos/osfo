package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/b3"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("command required: migrate, prepare, admit, inject-worker-crash, relay-once, drain, backlog, audit, retention-plan, or matrix")
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	budgetCapacityDefault, err := positiveEnvironmentInt("B3_INFLIGHT_AGENT_RUNS", 1024)
	if err != nil {
		return err
	}
	budgetStripesDefault, err := positiveEnvironmentInt("B3_INFLIGHT_BUDGET_STRIPES", store.B3DefaultBudgetStripes)
	if err != nil {
		return err
	}
	dsn := flags.String("database-url", os.Getenv("DATABASE_URL"), "PostgreSQL connection URL")
	project := flags.String("project", os.Getenv("GCP_PROJECT_ID"), "GCP project ID")
	topic := flags.String("topic", os.Getenv("PUBSUB_TOPIC_ID"), "Pub/Sub topic ID")
	benchmarkText := flags.String("benchmark", "", "benchmark UUID")
	agentRunText := flags.String("agent-run", "", "AgentRun UUID")
	lane := flags.String("lane", "", "lane name")
	expected := flags.Int("expected-incoming", 0, "expected incoming messages")
	ordinal := flags.Int("ordinal", 0, "incoming-message ordinal")
	attempt := flags.Int("attempt", 1, "caller attempt number")
	fault := flags.String("fault", b3.NoFault, "injected admission or relay fault")
	idempotency := flags.String("idempotency-key", "", "stable request idempotency key")
	requestHash := flags.String("request-hash", "", "stable request hash")
	hardCrash := flags.Bool("hard-crash", false, "terminate at the injected boundary")
	batchSize := flags.Int("batch-size", 128, "bounded relay batch size")
	sequenceStripes := flags.Int("sequence-stripes", store.B3DefaultSequenceStripes, "commit-order sequence stripes")
	budgetCapacity := flags.Int("inflight-agent-runs", budgetCapacityDefault, "global durable in-flight AgentRun capacity")
	budgetStripes := flags.Int("budget-stripes", budgetStripesDefault, "durable in-flight budget stripes")
	repetitions := flags.Int("repetitions", 100, "fault repetitions")
	seeds := flags.Int("seeds", 3, "independently named seeds")
	replayWindow := flags.Duration("replay-window", 7*24*time.Hour, "outbox replay safety window")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if err := b3.ValidateSequenceStripes(*sequenceStripes); err != nil {
		return err
	}
	if *dsn == "" {
		return fmt.Errorf("--database-url or DATABASE_URL is required")
	}
	database, err := store.Open(ctx, *dsn, "b3-harness", 16)
	if err != nil {
		return err
	}
	defer database.Close()
	if command == "migrate" {
		for _, name := range []string{"schema.sql", "b3-schema.sql"} {
			schema, err := os.ReadFile(name)
			if err != nil {
				return err
			}
			if err := database.Migrate(ctx, string(schema)); err != nil {
				return fmt.Errorf("apply %s: %w", name, err)
			}
		}
		return nil
	}
	if err := database.ConfigureB3InFlightBudget(ctx, *budgetCapacity, *budgetStripes); err != nil {
		return err
	}
	if command == "retention-plan" {
		candidates, err := database.B3RetentionCandidates(ctx, *replayWindow)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{
			"replay_window": replayWindow.String(), "drop_candidates": candidates,
			"method": "drop whole daily partition only after replay window and relay high-water proof",
		})
	}
	if command == "backlog" {
		count, age, err := database.B3Backlog(ctx)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"records": count, "oldest_age_ms": age.Milliseconds()})
	}
	if command == "matrix" {
		if *project == "" || *topic == "" {
			return fmt.Errorf("--project and --topic are required")
		}
		return runMatrix(ctx, database, *project, *topic, *repetitions, *seeds, *batchSize, *sequenceStripes, *budgetStripes)
	}
	benchmarkID, err := uuid.Parse(*benchmarkText)
	if err != nil {
		return fmt.Errorf("valid --benchmark is required: %w", err)
	}
	switch command {
	case "prepare":
		if *lane == "" || *expected <= 0 {
			return fmt.Errorf("--lane and positive --expected-incoming are required")
		}
		return database.PrepareB3(ctx, benchmarkID, "b3-transactional-outbox", *lane, *expected)
	case "admit":
		request := requestFor(benchmarkID, *ordinal, *attempt, *fault)
		if *idempotency != "" {
			request.Idempotency = *idempotency
		}
		if *requestHash != "" {
			request.RequestHash = *requestHash
		}
		request.HardCrash = *hardCrash
		result, err := b3.Admit(ctx, database, request, *sequenceStripes, *budgetStripes)
		_ = json.NewEncoder(os.Stdout).Encode(result)
		return err
	case "inject-worker-crash":
		agentRunID, err := uuid.Parse(*agentRunText)
		if err != nil {
			return fmt.Errorf("valid --agent-run is required: %w", err)
		}
		return database.InjectB3WorkerCrash(ctx, benchmarkID, agentRunID)
	case "relay-once", "drain":
		if *project == "" || *topic == "" {
			return fmt.Errorf("--project and --topic are required")
		}
		publisher, err := b3.NewPublisher(ctx, *project, *topic)
		if err != nil {
			return err
		}
		defer publisher.Close()
		relay := &b3.Relay{Store: database, Publisher: publisher, Owner: "b3-harness", BatchSize: *batchSize, SequenceStripes: *sequenceStripes, Fault: *fault, HardCrash: *hardCrash}
		if command == "relay-once" {
			count, err := relay.RunAllOnce(ctx)
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"processed": count, "fault": *fault})
			return err
		}
		return drain(ctx, database, relay, benchmarkID, 5*time.Minute)
	case "audit":
		audit, err := database.AuditB3(ctx, benchmarkID, *expected)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(audit)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func positiveEnvironmentInt(name string, fallback int) (int, error) {
	text := os.Getenv(name)
	if text == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(text)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func requestFor(benchmarkID uuid.UUID, ordinal, attempt int, fault string) store.B3Request {
	identity := fmt.Sprintf("%s/%d", benchmarkID, ordinal)
	return store.B3Request{
		BenchmarkID: benchmarkID, Ordinal: ordinal, Attempt: attempt,
		Idempotency: "b3/" + identity, RequestHash: "sha256:b3/" + identity, Fault: fault,
	}
}

func drain(ctx context.Context, database *store.Store, relay *b3.Relay, benchmarkID uuid.UUID, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		count, _, err := database.B3Backlog(ctx)
		if err != nil {
			return err
		}
		remaining, err := database.Remaining(ctx, benchmarkID)
		if err != nil {
			return err
		}
		if count == 0 && remaining == 0 {
			return nil
		}
		processed, err := relay.RunAllOnce(ctx)
		if err != nil {
			return err
		}
		if processed == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	return fmt.Errorf("outbox did not drain before %s", timeout)
}

func runMatrix(ctx context.Context, database *store.Store, project, topic string, repetitions, seeds, batchSize, sequenceStripes, budgetStripes int) error {
	if repetitions < 100 || seeds < 3 {
		return fmt.Errorf("frozen manifest requires at least 100 repetitions and three seeds")
	}
	publisher, err := b3.NewPublisher(ctx, project, topic)
	if err != nil {
		return err
	}
	defer publisher.Close()
	relay := &b3.Relay{Store: database, Publisher: publisher, Owner: "b3-matrix", BatchSize: batchSize, SequenceStripes: sequenceStripes}
	encoder := json.NewEncoder(os.Stdout)
	admissionFaults := []string{b3.BeforeAdmissionCommit, b3.AfterAdmissionCommit, b3.CommitUncertainSucceeded, b3.CommitUncertainFailed}
	for seed := 1; seed <= seeds; seed++ {
		for _, fault := range admissionFaults {
			benchmarkID := uuid.New()
			lane := fmt.Sprintf("cut/%d/admission/%s", seed, fault)
			if err := database.PrepareB3(ctx, benchmarkID, "b3-transactional-outbox", lane, repetitions); err != nil {
				return err
			}
			if err := admitMany(ctx, database, benchmarkID, repetitions, fault, true, sequenceStripes, budgetStripes); err != nil {
				return err
			}
			if err := drain(ctx, database, relay, benchmarkID, 5*time.Minute); err != nil {
				return err
			}
			audit, err := database.AuditB3(ctx, benchmarkID, repetitions)
			if err != nil {
				return err
			}
			if err := encoder.Encode(audit); err != nil {
				return err
			}
		}
	}
	relayFaults := []string{b3.BeforeRelayRead, b3.BeforePublish, b3.AmbiguousAfterConfirmation, b3.AfterConfirmationBeforeSave}
	for seed := 1; seed <= seeds; seed++ {
		for _, fault := range relayFaults {
			benchmarkID := uuid.New()
			lane := fmt.Sprintf("cut/%d/relay/%s", seed, fault)
			if err := database.PrepareB3(ctx, benchmarkID, "b3-transactional-outbox", lane, repetitions); err != nil {
				return err
			}
			if err := admitMany(ctx, database, benchmarkID, repetitions, b3.NoFault, false, sequenceStripes, budgetStripes); err != nil {
				return err
			}
			relay.Fault = fault
			_, injected := relay.RunAllOnce(ctx)
			if !errors.Is(injected, b3.ErrInjectedCut) {
				return fmt.Errorf("lane %s did not inject the expected cut: %v", lane, injected)
			}
			relay.Fault = b3.NoFault
			if err := drain(ctx, database, relay, benchmarkID, 5*time.Minute); err != nil {
				return err
			}
			audit, err := database.AuditB3(ctx, benchmarkID, repetitions)
			if err != nil {
				return err
			}
			if err := encoder.Encode(audit); err != nil {
				return err
			}
		}
	}
	return nil
}

func admitMany(ctx context.Context, database *store.Store, benchmarkID uuid.UUID, count int, fault string, retryUnknown bool, sequenceStripes, budgetStripes int) error {
	semaphore := make(chan struct{}, 32)
	errorsFound := make(chan error, count)
	var wait sync.WaitGroup
	for ordinal := 0; ordinal < count; ordinal++ {
		semaphore <- struct{}{}
		wait.Add(1)
		go func(ordinal int) {
			defer wait.Done()
			defer func() { <-semaphore }()
			request := requestFor(benchmarkID, ordinal, 1, fault)
			_, err := b3.Admit(ctx, database, request, sequenceStripes, budgetStripes)
			if err != nil && !errors.Is(err, b3.ErrInjectedCut) {
				errorsFound <- err
				return
			}
			if retryUnknown {
				retry := requestFor(benchmarkID, ordinal, 2, b3.NoFault)
				if _, err := b3.Admit(ctx, database, retry, sequenceStripes, budgetStripes); err != nil {
					errorsFound <- err
				}
			}
		}(ordinal)
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		return err
	}
	return nil
}
