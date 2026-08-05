package store

import (
	"context"
	"errors"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestB3DurableBudgetReservationAndTerminalRelease(t *testing.T) {
	dsn := os.Getenv("B3_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("B3_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	database, err := Open(ctx, dsn, "b3-budget-integration", 8)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	for _, path := range []string{"../../schema.sql", "../../b3-schema.sql"} {
		schema, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := database.Migrate(ctx, string(schema)); err != nil {
			t.Fatalf("migrate %s: %v", path, err)
		}
	}
	const budgetStripes = 4
	if err := database.ConfigureB3InFlightBudget(ctx, 8, budgetStripes); err != nil {
		t.Fatal(err)
	}
	benchmarkID := uuid.New()
	if err := database.PrepareB3(ctx, benchmarkID, "b3-integration", "durable-budget", 2); err != nil {
		t.Fatal(err)
	}
	first := integrationRequest(benchmarkID, 1)
	receipt, err := database.AcceptB3(ctx, first, B3DefaultSequenceStripes, budgetStripes)
	if err != nil {
		t.Fatal(err)
	}
	if len(receipt.AgentRunIDs) != 2 {
		t.Fatalf("reserved AgentRuns = %d, want 2", len(receipt.AgentRunIDs))
	}
	replay, err := database.AcceptB3(ctx, first, B3DefaultSequenceStripes, budgetStripes)
	if err != nil || !replay.IdempotentReplay {
		t.Fatalf("idempotent replay = %#v, %v", replay, err)
	}
	second := firstRequestOnStripe(benchmarkID, B3BudgetStripe(first.Idempotency, budgetStripes), first.Ordinal+1, budgetStripes)
	if _, err := database.AcceptB3(ctx, second, B3DefaultSequenceStripes, budgetStripes); !errors.Is(err, ErrB3InFlightBudgetExhausted) {
		t.Fatalf("capacity error = %v, want %v", err, ErrB3InFlightBudgetExhausted)
	}
	for index, runID := range receipt.AgentRunIDs {
		claim, err := database.TryClaim(ctx, runID, benchmarkID, "integration-worker", time.Now().UTC(), 10*time.Second)
		if err != nil || claim.Run == nil {
			t.Fatalf("claim %d = %#v, %v", index, claim, err)
		}
		attempt, err := database.CommitModelCallAttempt(ctx, *claim.Run, "produce_assistant_response")
		if err != nil {
			t.Fatal(err)
		}
		committed, err := database.CompleteModelCallAndRun(ctx, *claim.Run, attempt, "assistant_response_completed",
			&DeliveryAttemptEvidence{
				Protocol: "integration", MessageID: runID.String(),
				BrokerAttempt: 1, Outcome: "completed",
			})
		if err != nil || !committed {
			t.Fatalf("complete %d = %t, %v", index, committed, err)
		}
	}
	if _, err := database.AcceptB3(ctx, second, B3DefaultSequenceStripes, budgetStripes); err != nil {
		t.Fatalf("admission after terminal release: %v", err)
	}
	var used, obligations int
	if err := database.pool.QueryRow(ctx, `
		SELECT sum(in_use),
		       (SELECT count(*) FROM agent_runs WHERE budget_stripe IS NOT NULL AND state NOT IN ('succeeded', 'canceled'))
		FROM b3_inflight_budget`).Scan(&used, &obligations); err != nil {
		t.Fatal(err)
	}
	if used != obligations {
		t.Fatalf("budget used = %d, authoritative obligations = %d", used, obligations)
	}
	var completedDeliveries int
	if err := database.pool.QueryRow(ctx, `
		SELECT count(*) FROM delivery_attempts
		WHERE benchmark_id = $1 AND outcome = 'completed'`, benchmarkID).Scan(&completedDeliveries); err != nil {
		t.Fatal(err)
	}
	if completedDeliveries != len(receipt.AgentRunIDs) {
		t.Fatalf("completed deliveries = %d, want %d", completedDeliveries, len(receipt.AgentRunIDs))
	}
	exercisePrincipalFirstDispatch(t, ctx, database, budgetStripes)
}

func exercisePrincipalFirstDispatch(t *testing.T, ctx context.Context, database *Store, budgetStripes int) {
	t.Helper()
	if err := database.ConfigureB3InFlightBudget(ctx, 64, budgetStripes); err != nil {
		t.Fatal(err)
	}
	if err := database.ConfigureB3FairDispatch(ctx, 2, 32); err != nil {
		t.Fatal(err)
	}
	benchmarkID := uuid.New()
	if err := database.PrepareB3(ctx, benchmarkID, "b3-integration", "principal-first", 3); err != nil {
		t.Fatal(err)
	}
	requests := []B3Request{
		fairIntegrationRequest(benchmarkID, 0, "noisy", "noisy-thread-a"),
		fairIntegrationRequest(benchmarkID, 2, "noisy", "noisy-thread-b"),
		fairIntegrationRequest(benchmarkID, 1, "quiet", "quiet-thread"),
	}
	for _, request := range requests {
		if _, err := database.AcceptB3(ctx, request, B3DefaultSequenceStripes, budgetStripes); err != nil {
			t.Fatal(err)
		}
	}
	for round := 0; round < 2; round++ {
		connection, owned, err := database.TryOwnB3FairSelector(ctx)
		if err != nil || !owned {
			t.Fatalf("own selector = %t, %v", owned, err)
		}
		records, err := database.ReadOrSelectB3FairBatch(ctx, connection, 8)
		if err != nil {
			database.ReleaseB3FairSelector(ctx, connection)
			t.Fatal(err)
		}
		if len(records) != 2 {
			database.ReleaseB3FairSelector(ctx, connection)
			t.Fatalf("round %d selected %d records, want 2", round, len(records))
		}
		confirmedAt := time.Now().UTC()
		publications := make([]B3Publication, 0, len(records))
		for _, record := range records {
			publications = append(publications, B3Publication{Record: record, ConfirmedAt: &confirmedAt})
		}
		if err := database.ConfirmB3FairPublications(ctx, connection, publications); err != nil {
			database.ReleaseB3FairSelector(ctx, connection)
			t.Fatal(err)
		}
		database.ReleaseB3FairSelector(ctx, connection)
		selectedPrincipals := map[string]bool{}
		for _, record := range records {
			selectedPrincipals[record.Principal] = true
			claim, err := database.TryClaim(ctx, record.AgentRunID, benchmarkID, "fair-integration-worker", time.Now().UTC(), 10*time.Second)
			if err != nil || claim.Run == nil {
				t.Fatalf("fair claim = %#v, %v", claim, err)
			}
			attempt, err := database.CommitModelCallAttempt(ctx, *claim.Run, "produce_assistant_response")
			if err != nil {
				t.Fatal(err)
			}
			committed, err := database.CompleteModelCallAndRun(ctx, *claim.Run, attempt, "assistant_response_completed", nil)
			if err != nil || !committed {
				t.Fatalf("fair complete = %t, %v", committed, err)
			}
		}
		if !selectedPrincipals["noisy"] || !selectedPrincipals["quiet"] {
			t.Fatalf("round %d selected Principals = %v, want noisy and quiet", round, selectedPrincipals)
		}
	}
	snapshot, err := database.B3FairSnapshot(ctx, benchmarkID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.PermitsInUse != 0 || snapshot.QueuedPrincipals != 0 {
		t.Fatalf("final fair snapshot = %#v", snapshot)
	}
}

func fairIntegrationRequest(benchmarkID uuid.UUID, ordinal int, principal, thread string) B3Request {
	request := integrationRequest(benchmarkID, ordinal)
	request.Principal = principal
	request.Thread = thread
	return request
}

func integrationRequest(benchmarkID uuid.UUID, ordinal int) B3Request {
	identity := benchmarkID.String() + "/" + strconv.Itoa(ordinal)
	return B3Request{
		BenchmarkID: benchmarkID,
		Ordinal:     ordinal,
		Attempt:     1,
		Idempotency: "integration/" + identity,
		RequestHash: "sha256:integration/" + identity,
		Fault:       "none",
	}
}

func firstRequestOnStripe(benchmarkID uuid.UUID, stripe, start, stripes int) B3Request {
	for ordinal := start; ; ordinal++ {
		request := integrationRequest(benchmarkID, ordinal)
		if B3BudgetStripe(request.Idempotency, stripes) == stripe {
			return request
		}
	}
}
