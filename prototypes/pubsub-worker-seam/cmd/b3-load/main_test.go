package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

func TestOfferRetriesServerFailureWithSameLogicalRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(store.B3Result{CallerOutcome: "accepted"})
	}))
	defer server.Close()

	result := offer(context.Background(), server.Client(), server.URL, "", uuid.New(), 1, time.Now())
	if result.CallerOutcome != "accepted" || result.HTTPAttempts != 2 || requests.Load() != 2 {
		t.Fatalf("result = %#v, requests = %d", result, requests.Load())
	}
}

func TestOfferDoesNotRetryTypedOverload(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(store.B3Result{CallerOutcome: "rejected", ErrorClass: "overloaded"})
	}))
	defer server.Close()

	result := offer(context.Background(), server.Client(), server.URL, "", uuid.New(), 1, time.Now())
	if result.CallerOutcome != "rejected" || result.HTTPAttempts != 1 || requests.Load() != 1 {
		t.Fatalf("result = %#v, requests = %d", result, requests.Load())
	}
}
