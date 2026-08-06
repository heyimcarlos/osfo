package store

import (
	"context"
	"errors"
	"fmt"
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
		publishedAt := time.Now().UTC().Add(-20 * time.Millisecond)
		receivedAt := publishedAt.Add(5 * time.Millisecond)
		slotAcquiredAt := receivedAt.Add(time.Millisecond)
		claim, timing, err := database.TryClaimTimed(ctx, runID, benchmarkID, "integration-worker", publishedAt, 10*time.Second)
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
				BrokerAttempt: 1, PublishedAt: publishedAt, ReceivedAt: receivedAt,
				SlotAcquiredAt:           slotAcquiredAt,
				DatabaseAcquireStartedAt: timing.DatabaseAcquireStartedAt,
				DatabaseAcquiredAt:       timing.DatabaseAcquiredAt,
				ClaimCompletedAt:         timing.ClaimCompletedAt,
				TerminalStartedAt:        time.Now().UTC(), Outcome: "completed",
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
	var segmentedDeliveries int
	if err := database.pool.QueryRow(ctx, `
		SELECT count(*) FROM delivery_attempts
		WHERE benchmark_id = $1 AND outcome = 'completed'
		  AND published_at IS NOT NULL AND received_at IS NOT NULL
		  AND slot_acquired_at IS NOT NULL
		  AND database_acquire_started_at IS NOT NULL
		  AND database_acquired_at IS NOT NULL
		  AND claim_completed_at IS NOT NULL
		  AND terminal_started_at IS NOT NULL
		  AND terminal_evidence_at IS NOT NULL`, benchmarkID).Scan(&segmentedDeliveries); err != nil {
		t.Fatal(err)
	}
	if segmentedDeliveries != len(receipt.AgentRunIDs) {
		t.Fatalf("segmented deliveries = %d, want %d", segmentedDeliveries, len(receipt.AgentRunIDs))
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
	var principalBudgetRows int
	if err := database.pool.QueryRow(ctx, `
		SELECT count(*) FROM b3_fair_principal_budget WHERE benchmark_id = $1`, benchmarkID).Scan(&principalBudgetRows); err != nil {
		t.Fatal(err)
	}
	if principalBudgetRows > len(requests) {
		t.Fatalf("eager Principal budget rows = %d, want at most %d", principalBudgetRows, len(requests))
	}
	for round := 0; round < 2; round++ {
		connection, owned, err := database.TryOwnB3FairSelector(ctx)
		if err != nil || !owned {
			t.Fatalf("own selector = %t, %v", owned, err)
		}
		selected, err := database.SelectB3FairBatch(ctx, connection, 8)
		database.ReleaseB3FairSelector(ctx, connection)
		if err != nil {
			t.Fatal(err)
		}
		if len(selected) != 2 {
			t.Fatalf("round %d selected %d records, want 2", round, len(selected))
		}
		publicationOwner := fmt.Sprintf("fair-integration-relay/%d", round)
		records, err := database.ClaimB3FairPublicationBatch(ctx, publicationOwner, 8, 10*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if len(records) != len(selected) {
			t.Fatalf("round %d claimed %d publication tasks, want %d", round, len(records), len(selected))
		}
		snapshot, err := database.B3FairSnapshot(ctx, benchmarkID)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.PermitsInUse != 2 {
			t.Fatalf("round %d active permits = %d, want 2", round, snapshot.PermitsInUse)
		}
		confirmedAt := time.Now().UTC()
		publications := make([]B3Publication, 0, len(records))
		for _, record := range records {
			publications = append(publications, B3Publication{
				Record: record, RequestedAt: confirmedAt, ConfirmedAt: &confirmedAt,
				MessageID: "integration-message", Outcome: "confirmed",
			})
		}
		var publicationErr error
		if round == 0 {
			publicationErr = database.RecordB3FairPublications(ctx, publicationOwner, publications)
		} else {
			publicationErr = database.RecordAndConfirmB3FairPublications(
				ctx, publicationOwner, publications,
			)
		}
		if publicationErr != nil {
			t.Fatal(publicationErr)
		}
		var publicationEvidence int
		if err := database.pool.QueryRow(ctx, `
			SELECT count(*) FROM b3_publish_evidence WHERE benchmark_id = $1`, benchmarkID).Scan(&publicationEvidence); err != nil {
			t.Fatal(err)
		}
		if publicationEvidence != (round+1)*len(records) {
			t.Fatalf("round %d publication evidence = %d, want %d", round, publicationEvidence, (round+1)*len(records))
		}
		if round == 0 {
			if err := database.ConfirmB3FairPublications(ctx, publications); err != nil {
				t.Fatal(err)
			}
		}
		publishedSnapshot, err := database.B3FairSnapshot(ctx, benchmarkID)
		if err != nil {
			t.Fatal(err)
		}
		var publishedThreads int64
		for _, principal := range publishedSnapshot.Principals {
			publishedThreads += principal.InFlight
		}
		if publishedSnapshot.PermitsInUse != 0 || publishedThreads != 2 {
			t.Fatalf("round %d post-publication snapshot = %#v", round, publishedSnapshot)
		}
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
	partialBenchmarkID := uuid.New()
	if err := database.PrepareB3(ctx, partialBenchmarkID, "b3-integration", "partial-fair-batch", 1); err != nil {
		t.Fatal(err)
	}
	request := fairIntegrationRequest(partialBenchmarkID, 0, "partial", "partial-thread")
	receipt, err := database.AcceptB3(ctx, request, B3DefaultSequenceStripes, budgetStripes)
	if err != nil {
		t.Fatal(err)
	}
	connection, owned, err := database.TryOwnB3FairSelector(ctx)
	if err != nil || !owned {
		t.Fatalf("own partial selector = %t, %v", owned, err)
	}
	records, err := database.SelectB3FairBatch(ctx, connection, 8)
	database.ReleaseB3FairSelector(ctx, connection)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != len(receipt.AgentRunIDs) {
		t.Fatalf("partial batch selected %d records, want %d", len(records), len(receipt.AgentRunIDs))
	}
	firstClaims, err := database.ClaimB3FairPublicationBatch(ctx, "expired-owner", 8, time.Millisecond)
	if err != nil || len(firstClaims) != len(records) {
		t.Fatalf("first publication claims = %d, %v", len(firstClaims), err)
	}
	time.Sleep(5 * time.Millisecond)
	secondClaims, err := database.ClaimB3FairPublicationBatch(ctx, "recovery-owner", 8, time.Second)
	if err != nil || len(secondClaims) != len(records) {
		t.Fatalf("recovered publication claims = %d, %v", len(secondClaims), err)
	}
	for index := range secondClaims {
		if secondClaims[index].PublicationEpoch != firstClaims[index].PublicationEpoch+1 {
			t.Fatalf("recovered epoch = %d, want %d", secondClaims[index].PublicationEpoch, firstClaims[index].PublicationEpoch+1)
		}
	}
	confirmedAt := time.Now().UTC()
	stalePublications := integrationPublications(firstClaims, confirmedAt)
	if err := database.ConfirmB3FairPublications(ctx, stalePublications); err != nil {
		t.Fatal(err)
	}
	var activeRecoveryTasks int
	if err := database.pool.QueryRow(ctx, `
		SELECT count(*) FROM b3_fair_publication_tasks
		WHERE benchmark_id = $1 AND owner = 'recovery-owner'`, partialBenchmarkID).Scan(&activeRecoveryTasks); err != nil {
		t.Fatal(err)
	}
	if activeRecoveryTasks != len(records) {
		t.Fatalf("stale confirmation left %d recovery tasks, want %d", activeRecoveryTasks, len(records))
	}
	if err := database.ConfirmB3FairPublications(ctx, integrationPublications(secondClaims, confirmedAt)); err != nil {
		t.Fatal(err)
	}
}

func integrationPublications(records []B3OutboxRecord, confirmedAt time.Time) []B3Publication {
	publications := make([]B3Publication, 0, len(records))
	for _, record := range records {
		publications = append(publications, B3Publication{
			Record: record, RequestedAt: confirmedAt, ConfirmedAt: &confirmedAt,
			MessageID: "integration-message", Outcome: "confirmed",
		})
	}
	return publications
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
