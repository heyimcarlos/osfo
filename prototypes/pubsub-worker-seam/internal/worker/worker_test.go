package worker

import (
	"context"
	"errors"
	"testing"

	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

func TestClaimWithRetryRecoversTransientFailure(t *testing.T) {
	attempts := 0
	retries := 0
	want := store.ClaimResult{}
	got, err := claimWithRetry(context.Background(), func(context.Context) (store.ClaimResult, error) {
		attempts++
		if attempts < 3 {
			return store.ClaimResult{}, errors.New("transient database failure")
		}
		return want, nil
	}, func(int, error) {
		retries++
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != want || attempts != 3 || retries != 2 {
		t.Fatalf("result = %#v, attempts = %d, retries = %d", got, attempts, retries)
	}
}
