package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/pubsub/v2"
	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/delivery"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/worker"
	"golang.org/x/oauth2"
	"google.golang.org/api/option"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("command required: migrate, prepare, phase, publish, wait, or audit")
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	dsn := flags.String("database-url", os.Getenv("DATABASE_URL"), "PostgreSQL connection URL")
	benchmarkText := flags.String("benchmark", "", "benchmark UUID")
	candidate := flags.String("candidate", "", "candidate name")
	lane := flags.String("lane", "", "lane name")
	count := flags.Int("count", 0, "number of AgentRuns")
	rate := flags.Int("rate", 0, "published messages per second")
	topic := flags.String("topic", "", "Pub/Sub topic ID")
	project := flags.String("project", os.Getenv("GCP_PROJECT_ID"), "GCP project ID")
	seed := flags.String("seed", "issue-39", "deterministic corpus seed")
	workload := flags.Int("workload-ms", 15, "normal workload duration")
	longEvery := flags.Int("long-every", 0, "make every Nth workload exceed the ack deadline")
	crashEvery := flags.Int("crash-every", 0, "make every Nth run kill one worker attempt")
	cancelEvery := flags.Int("cancel-every", 0, "pre-cancel every Nth run")
	duplicateEvery := flags.Int("duplicate-every", 0, "publish every Nth envelope twice")
	missingEvery := flags.Int("missing-every", 0, "publish every Nth envelope with a missing run ID")
	timeout := flags.Duration("timeout", 10*time.Minute, "drain timeout")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if command == "migrate" {
		database, err := open(ctx, *dsn)
		if err != nil {
			return err
		}
		defer database.Close()
		schema, err := os.ReadFile("schema.sql")
		if err != nil {
			return err
		}
		return database.Migrate(ctx, string(schema))
	}
	benchmarkID, err := uuid.Parse(*benchmarkText)
	if err != nil {
		return fmt.Errorf("valid --benchmark is required: %w", err)
	}
	if command == "publish" {
		return publish(ctx, *project, *topic, benchmarkID, *count, *rate, *seed, *duplicateEvery, *missingEvery)
	}
	database, err := open(ctx, *dsn)
	if err != nil {
		return err
	}
	defer database.Close()
	switch command {
	case "prepare":
		runs := corpus(benchmarkID, *count, *seed, *workload, *longEvery, *crashEvery, *cancelEvery)
		return database.Prepare(ctx, benchmarkID, *candidate, *lane, runs)
	case "phase":
		return database.MarkOffer(ctx, benchmarkID, flags.Arg(0) == "start")
	case "wait":
		deadline := time.Now().Add(*timeout)
		for time.Now().Before(deadline) {
			remaining, err := database.Remaining(ctx, benchmarkID)
			if err != nil {
				return err
			}
			if remaining == 0 {
				return nil
			}
			time.Sleep(time.Second)
		}
		return fmt.Errorf("benchmark %s did not drain before %s", benchmarkID, *timeout)
	case "audit":
		audit, err := database.Audit(ctx, benchmarkID)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(audit)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func open(ctx context.Context, dsn string) (*store.Store, error) {
	if dsn == "" {
		return nil, fmt.Errorf("--database-url or DATABASE_URL is required")
	}
	return store.Open(ctx, dsn, "harness", 8)
}

func corpus(benchmarkID uuid.UUID, count int, seed string, workloadMS, longEvery, crashEvery, cancelEvery int) []store.PreparedRun {
	namespace := uuid.NewSHA1(uuid.NameSpaceURL, []byte(seed))
	runs := make([]store.PreparedRun, 0, count)
	for ordinal := 0; ordinal < count; ordinal++ {
		state := delivery.Pending
		if cancelEvery > 0 && (ordinal+1)%cancelEvery == 0 {
			state = delivery.Canceled
		}
		ms := workloadMS
		if longEvery > 0 && (ordinal+1)%longEvery == 0 {
			ms = 15_000
		}
		runs = append(runs, store.PreparedRun{
			ID:          uuid.NewSHA1(namespace, []byte(fmt.Sprintf("%s/%d", benchmarkID, ordinal))),
			BenchmarkID: benchmarkID, Ordinal: ordinal,
			ThreadKey: fmt.Sprintf("thread-%04d", ordinal%1024), ThreadSequence: ordinal / 1024,
			WorkloadMS: ms, State: state,
			CrashOnce: crashEvery > 0 && (ordinal+1)%crashEvery == 0,
		})
	}
	return runs
}

func publish(ctx context.Context, projectID, topicID string, benchmarkID uuid.UUID, count, rate int, seed string, duplicateEvery, missingEvery int) error {
	if projectID == "" || topicID == "" || count <= 0 || rate <= 0 {
		return fmt.Errorf("--project, --topic, positive --count, and positive --rate are required")
	}
	var clientOptions []option.ClientOption
	if accessToken := os.Getenv("GCP_ACCESS_TOKEN"); accessToken != "" {
		clientOptions = append(clientOptions, option.WithTokenSource(oauth2.StaticTokenSource(&oauth2.Token{AccessToken: accessToken})))
	}
	client, err := pubsub.NewClient(ctx, projectID, clientOptions...)
	if err != nil {
		return err
	}
	defer client.Close()
	publisher := client.Publisher(topicID)
	publisher.EnableMessageOrdering = true
	defer publisher.Stop()
	namespace := uuid.NewSHA1(uuid.NameSpaceURL, []byte(seed))
	interval := time.Second / time.Duration(rate)
	started := time.Now()
	type pendingPublish struct {
		message *pubsub.Message
		result  *pubsub.PublishResult
	}
	results := make([]pendingPublish, 0, count)
	for ordinal := 0; ordinal < count; ordinal++ {
		runID := uuid.NewSHA1(namespace, []byte(fmt.Sprintf("%s/%d", benchmarkID, ordinal)))
		envelope := worker.Envelope{
			AgentRunID: runID, BenchmarkID: benchmarkID,
			DeliveryID: fmt.Sprintf("%s/%d", benchmarkID, ordinal), PublishedAt: time.Now().UTC(),
		}
		data, _ := json.Marshal(envelope)
		message := &pubsub.Message{Data: data, OrderingKey: fmt.Sprintf("%s/thread-%04d", benchmarkID, ordinal%1024)}
		results = append(results, pendingPublish{message: message, result: publisher.Publish(ctx, message)})
		if duplicateEvery > 0 && (ordinal+1)%duplicateEvery == 0 {
			duplicate := *message
			results = append(results, pendingPublish{message: &duplicate, result: publisher.Publish(ctx, &duplicate)})
		}
		if missingEvery > 0 && (ordinal+1)%missingEvery == 0 {
			missing := envelope
			missing.AgentRunID = uuid.New()
			missing.DeliveryID += "/missing"
			missingData, _ := json.Marshal(missing)
			missingMessage := &pubsub.Message{Data: missingData, OrderingKey: message.OrderingKey}
			results = append(results, pendingPublish{message: missingMessage, result: publisher.Publish(ctx, missingMessage)})
		}
		next := started.Add(time.Duration(ordinal+1) * interval)
		if delay := time.Until(next); delay > 0 {
			time.Sleep(delay)
		}
	}
	var failures []string
	for _, pending := range results {
		_, publishErr := pending.result.Get(ctx)
		for retry := 0; publishErr != nil && retry < 3; retry++ {
			time.Sleep(time.Duration(retry+1) * time.Second)
			publisher.ResumePublish(pending.message.OrderingKey)
			_, publishErr = publisher.Publish(ctx, pending.message).Get(ctx)
		}
		if publishErr != nil {
			failures = append(failures, publishErr.Error())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("%d publishes failed: %s", len(failures), strings.Join(failures[:min(len(failures), 3)], "; "))
	}
	return nil
}
