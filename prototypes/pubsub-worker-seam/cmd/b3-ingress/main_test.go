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
	if response.Header().Get("retry-after") != "1" {
		t.Fatalf("retry-after = %q", response.Header().Get("retry-after"))
	}
	var result store.B3Result
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.CallerOutcome != "rejected" || result.ErrorClass != "overloaded" || result.RetryAfterMS != 250 {
		t.Fatalf("result = %#v", result)
	}
}

func TestAdmissionHTTPStatusMapsDurableBudgetRejection(t *testing.T) {
	result := store.B3Result{CallerOutcome: "rejected", ErrorClass: "overloaded", RetryAfterMS: 250}
	if got := admissionHTTPStatus(result, nil); got != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", got, http.StatusTooManyRequests)
	}
	if got := admissionHTTPStatus(store.B3Result{}, errors.New("database unavailable")); got != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", got, http.StatusServiceUnavailable)
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

func TestNonNegativeIntAllowsDisabledAdmissionGuard(t *testing.T) {
	got, err := nonNegativeInt("0", 64)
	if err != nil || got != 0 {
		t.Fatalf("nonNegativeInt(0) = %d, %v", got, err)
	}
	if _, err := nonNegativeInt("-1", 0); err == nil {
		t.Fatal("nonNegativeInt accepted a negative value")
	}
}
