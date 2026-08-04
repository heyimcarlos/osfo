package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/b2"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("command required: migrate, prepare, admit, audit, or matrix")
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	dsn := flags.String("database-url", os.Getenv("DATABASE_URL"), "PostgreSQL connection URL")
	project := flags.String("project", os.Getenv("GCP_PROJECT_ID"), "GCP project ID")
	topic := flags.String("topic", os.Getenv("PUBSUB_TOPIC_ID"), "Pub/Sub topic ID")
	benchmarkText := flags.String("benchmark", "", "benchmark UUID")
	candidate := flags.String("candidate", "b2-direct-dual-write", "candidate name")
	lane := flags.String("lane", "", "lane name")
	expected := flags.Int("expected-incoming", 0, "expected incoming messages")
	ordinal := flags.Int("ordinal", 0, "incoming-message ordinal")
	attempt := flags.Int("attempt", 1, "caller attempt number")
	orderingText := flags.String("ordering", string(b2.DatabaseFirst), "database_first, publish_first, or concurrent")
	faultText := flags.String("fault", string(b2.NoFault), "fault injected at the dual-write boundary")
	idempotency := flags.String("idempotency-key", "", "stable request idempotency key")
	requestHash := flags.String("request-hash", "", "stable request hash")
	retryExpected := flags.Bool("retry-expected", false, "whether the controller will retry an unknown outcome")
	hardCrash := flags.Bool("hard-crash", false, "terminate the process at the injected cut")
	databaseDelay := flags.Duration("database-delay", 0, "delay database side of a concurrent ordering")
	publishDelay := flags.Duration("publish-delay", 0, "delay publish side of a concurrent ordering")
	repetitions := flags.Int("repetitions", 100, "cut repetitions per ordering and fault")
	seedCount := flags.Int("seeds", 3, "independently named cut-matrix seeds")
	drain := flags.Duration("drain", 30*time.Second, "observation-only drain delay before audit")
	input := flags.String("input", "", "JSONL audits to reconcile again with current audit definitions")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if *dsn == "" {
		return fmt.Errorf("--database-url or DATABASE_URL is required")
	}
	store, err := b2.Open(ctx, *dsn, "b2-harness", 16)
	if err != nil {
		return err
	}
	defer store.Close()
	if command == "migrate" {
		for _, name := range []string{"schema.sql", "b2-schema.sql"} {
			schema, readErr := os.ReadFile(name)
			if readErr != nil {
				return readErr
			}
			if err := store.Migrate(ctx, string(schema)); err != nil {
				return fmt.Errorf("apply %s: %w", name, err)
			}
		}
		return nil
	}
	if command == "reaudit" {
		return reaudit(ctx, store, *input)
	}
	benchmarkID, err := uuid.Parse(*benchmarkText)
	if err != nil && command != "matrix" {
		return fmt.Errorf("valid --benchmark is required: %w", err)
	}
	switch command {
	case "prepare":
		if *lane == "" || *expected <= 0 {
			return fmt.Errorf("--lane and positive --expected-incoming are required")
		}
		return store.PrepareBenchmark(ctx, benchmarkID, *candidate, *lane, *expected)
	case "admit":
		publisher, err := publisher(ctx, *project, *topic, store)
		if err != nil {
			return err
		}
		defer publisher.Close()
		request := requestFor(benchmarkID, *ordinal, *attempt, b2.Ordering(*orderingText), b2.Fault(*faultText), *retryExpected)
		if *idempotency != "" {
			request.Idempotency = *idempotency
		}
		if *requestHash != "" {
			request.RequestHash = *requestHash
		}
		request.HardCrash = *hardCrash
		request.DatabaseDelay = *databaseDelay
		request.PublishDelay = *publishDelay
		result, err := (&b2.Admitter{Store: store, Publisher: publisher}).Admit(ctx, request)
		_ = json.NewEncoder(os.Stdout).Encode(result)
		return err
	case "audit":
		audit, err := store.Audit(ctx, benchmarkID, *expected)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(audit)
	case "matrix":
		if *project == "" || *topic == "" {
			return fmt.Errorf("--project and --topic are required")
		}
		return runMatrix(ctx, store, *project, *topic, *repetitions, *seedCount, *drain)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func reaudit(ctx context.Context, store *b2.Store, input string) error {
	if input == "" {
		return fmt.Errorf("--input is required")
	}
	file, err := os.Open(input)
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var previous b2.Audit
		if err := json.Unmarshal(scanner.Bytes(), &previous); err != nil {
			return err
		}
		audit, err := store.Audit(ctx, previous.BenchmarkID, int(previous.ExpectedIncoming))
		if err != nil {
			return err
		}
		if err := encoder.Encode(audit); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func publisher(ctx context.Context, project, topic string, store *b2.Store) (*b2.Publisher, error) {
	if project == "" || topic == "" {
		return nil, fmt.Errorf("--project and --topic are required")
	}
	return b2.NewPublisher(ctx, project, topic, store)
}

func requestFor(benchmarkID uuid.UUID, ordinal, attempt int, ordering b2.Ordering, fault b2.Fault, retryExpected bool) b2.Request {
	identity := fmt.Sprintf("%s/%d", benchmarkID, ordinal)
	return b2.Request{
		BenchmarkID: benchmarkID, Ordinal: ordinal, Attempt: attempt,
		Idempotency: "b2/" + identity, RequestHash: "sha256:b2/" + identity,
		Ordering: ordering, Fault: fault, RetryExpected: retryExpected,
	}
}

type matrixLane struct {
	BenchmarkID uuid.UUID
	Lane        string
	Expected    int
	Ordering    b2.Ordering
	Fault       b2.Fault
	Retry       bool
	Seed        int
}

func runMatrix(ctx context.Context, store *b2.Store, project, topic string, repetitions, seedCount int, drain time.Duration) error {
	if repetitions < 100 {
		return fmt.Errorf("the frozen manifest requires at least 100 repetitions per deterministic cut")
	}
	if seedCount < 3 {
		return fmt.Errorf("the frozen manifest requires at least three independently named seeds")
	}
	publisher, err := b2.NewPublisher(ctx, project, topic, store)
	if err != nil {
		return err
	}
	defer publisher.Close()
	admitter := &b2.Admitter{Store: store, Publisher: publisher}
	orderings := []b2.Ordering{b2.DatabaseFirst, b2.PublishFirst, b2.Concurrent}
	faults := []b2.Fault{
		b2.AfterDatabaseCommit,
		b2.AfterPublishConfirmation,
		b2.AfterBothBeforeResponse,
		b2.AmbiguousPublishResponse,
		b2.PublishDeadline,
		b2.PublishUnavailable,
		b2.PublishThrottled,
		b2.CommitUncertainSucceeded,
		b2.CommitUncertainFailed,
	}
	lanes := make([]matrixLane, 0, len(orderings)*len(faults)*seedCount*2)
	for seed := 1; seed <= seedCount; seed++ {
		for _, ordering := range orderings {
			for _, fault := range faults {
				for _, retry := range []bool{false, true} {
					name := strings.Join([]string{"cut", strconv.Itoa(seed), string(ordering), string(fault), map[bool]string{false: "no-retry", true: "retry-once"}[retry]}, "/")
					benchmarkID := uuid.New()
					if err := store.PrepareBenchmark(ctx, benchmarkID, "b2-direct-dual-write", name, repetitions); err != nil {
						return err
					}
					lane := matrixLane{BenchmarkID: benchmarkID, Lane: name, Expected: repetitions, Ordering: ordering, Fault: fault, Retry: retry, Seed: seed}
					lanes = append(lanes, lane)
					var wait sync.WaitGroup
					var unexpected atomic.Int64
					semaphore := make(chan struct{}, 32)
					for ordinal := 0; ordinal < repetitions; ordinal++ {
						semaphore <- struct{}{}
						wait.Add(1)
						go func(ordinal int) {
							defer wait.Done()
							defer func() { <-semaphore }()
							request := requestFor(benchmarkID, ordinal, 1, ordering, fault, retry)
							applyConcurrentPrecedence(&request)
							if _, err := admitter.Admit(ctx, request); err == nil {
								unexpected.Add(1)
							}
							if retry {
								retryRequest := requestFor(benchmarkID, ordinal, 2, ordering, b2.NoFault, false)
								if _, err := admitter.Admit(ctx, retryRequest); err != nil {
									unexpected.Add(1)
								}
							}
						}(ordinal)
					}
					wait.Wait()
					if count := unexpected.Load(); count > 0 {
						return fmt.Errorf("lane %s observed %d unexpected candidate outcomes", name, count)
					}
					fmt.Fprintf(os.Stderr, "completed offer window %s\n", name)
				}
			}
		}
	}
	// This is a fixed observation delay, not a repair loop or runnable-work scan.
	time.Sleep(drain)
	encoder := json.NewEncoder(os.Stdout)
	for _, lane := range lanes {
		audit, err := store.Audit(ctx, lane.BenchmarkID, lane.Expected)
		if err != nil {
			return fmt.Errorf("audit %s: %w", lane.Lane, err)
		}
		if err := encoder.Encode(audit); err != nil {
			return err
		}
	}
	return nil
}

func applyConcurrentPrecedence(request *b2.Request) {
	if request.Ordering != b2.Concurrent {
		return
	}
	switch request.Fault {
	case b2.AfterDatabaseCommit, b2.CommitUncertainSucceeded:
		request.PublishDelay = 250 * time.Millisecond
	case b2.AfterPublishConfirmation, b2.CommitUncertainFailed:
		request.DatabaseDelay = 250 * time.Millisecond
	}
}
