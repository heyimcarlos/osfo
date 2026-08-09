package store

import (
	"fmt"
	"testing"

	"github.com/google/uuid"
)

func TestB3BudgetStripeIsStableAndBounded(t *testing.T) {
	const stripes = 64
	key := "b3/benchmark/42"
	want := B3BudgetStripe(key, stripes)
	for iteration := 0; iteration < 10; iteration++ {
		got := B3BudgetStripe(key, stripes)
		if got != want || got < 0 || got >= stripes {
			t.Fatalf("stripe = %d, want stable value %d in [0, %d)", got, want, stripes)
		}
	}
}

func TestB3BudgetStripeDistributesAgentRunObligations(t *testing.T) {
	const (
		stripes  = 64
		messages = 10000
	)
	benchmarkID := uuid.MustParse("7b6019a3-bf9c-4b40-b39a-acde50fa07f8")
	counts := make([]int, stripes)
	total := 0
	for ordinal := 0; ordinal < messages; ordinal++ {
		key := fmt.Sprintf("b3/%s/%d", benchmarkID, ordinal)
		obligations := len(B3AgentRunIDs(benchmarkID, ordinal))
		counts[B3BudgetStripe(key, stripes)] += obligations
		total += obligations
	}
	mean := float64(total) / stripes
	for stripe, count := range counts {
		deviation := float64(count)/mean - 1
		if deviation < -0.20 || deviation > 0.20 {
			t.Fatalf("stripe %d has %d obligations, mean %.1f", stripe, count, mean)
		}
	}
}

func TestB3AgentRunIDsForCountSupportsMatchedModelLoad(t *testing.T) {
	benchmarkID := uuid.MustParse("7b6019a3-bf9c-4b40-b39a-acde50fa07f8")
	ids := B3AgentRunIDsForCount(benchmarkID, 7, 1)
	if len(ids) != 1 {
		t.Fatalf("AgentRun IDs = %d, want 1", len(ids))
	}
	if ids[0] != B3AgentRunIDsForCount(benchmarkID, 7, 1)[0] {
		t.Fatal("matched AgentRun ID is not deterministic")
	}
}
