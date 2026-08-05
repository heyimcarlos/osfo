package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

func TestAdmitWithRetryRecoversTransientFailure(t *testing.T) {
	attempts := 0
	retries := 0
	want := store.B3Result{CallerOutcome: "accepted"}
	got, err := admitWithRetry(context.Background(), func(context.Context) (store.B3Result, error) {
		attempts++
		if attempts < 3 {
			return store.B3Result{}, errors.New("transient database failure")
		}
		return want, nil
	}, func(int, error) {
		retries++
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.CallerOutcome != want.CallerOutcome || attempts != 3 || retries != 2 {
		t.Fatalf("result = %#v, attempts = %d, retries = %d", got, attempts, retries)
	}
}

func TestTryAcquireRejectsWhenAdmissionSlotsAreFull(t *testing.T) {
	slots := make(chan struct{}, 1)
	if !tryAcquire(slots) {
		t.Fatal("first admission slot was not acquired")
	}
	if tryAcquire(slots) {
		t.Fatal("full admission slots accepted more work")
	}
}

func TestWriteOverloadedReturnsTypedRejection(t *testing.T) {
	response := httptest.NewRecorder()
	writeOverloaded(response)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusTooManyRequests)
	}
	if response.Header().Get("content-type") != "application/json" {
		t.Fatalf("content-type = %q", response.Header().Get("content-type"))
	}
	var result store.B3Result
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.CallerOutcome != "rejected" || result.ErrorClass != "overloaded" {
		t.Fatalf("result = %#v", result)
	}
}

func TestBinaryFlag(t *testing.T) {
	for _, test := range []struct {
		text     string
		fallback bool
		want     bool
	}{
		{text: "", fallback: true, want: true},
		{text: "", fallback: false, want: false},
		{text: "0", fallback: true, want: false},
		{text: "1", fallback: false, want: true},
	} {
		got, err := binaryFlag(test.text, test.fallback)
		if err != nil || got != test.want {
			t.Fatalf("binaryFlag(%q, %t) = %t, %v, want %t", test.text, test.fallback, got, err, test.want)
		}
	}
	if _, err := binaryFlag("true", false); err == nil {
		t.Fatal("binaryFlag accepted a non-binary value")
	}
}
