package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/heyimcarlos/osfo/prototypes/pubsub-worker-seam/internal/store"
)

type sample struct {
	Ordinal       int       `json:"ordinal"`
	Principal     string    `json:"principal_key,omitempty"`
	Thread        string    `json:"thread_key,omitempty"`
	ScheduledAt   time.Time `json:"scheduled_at"`
	OfferedAt     time.Time `json:"offered_at"`
	CompletedAt   time.Time `json:"completed_at"`
	Status        int       `json:"status"`
	LatencyMS     float64   `json:"latency_ms"`
	CallerOutcome string    `json:"caller_outcome"`
	ErrorClass    string    `json:"error_class,omitempty"`
	RetryAfterMS  int       `json:"retry_after_ms,omitempty"`
	HTTPAttempts  int       `json:"http_attempts"`
}

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	flags := flag.NewFlagSet("b3-load", flag.ContinueOnError)
	url := flags.String("url", "", "authenticated B3 ingress URL")
	benchmarkText := flags.String("benchmark", "", "benchmark UUID")
	rate := flags.Float64("rate", 0, "constant incoming messages per second")
	endRate := flags.Float64("end-rate", 0, "optional final rate for a linear ramp")
	duration := flags.Duration("duration", 0, "offer duration")
	count := flags.Int("count", 0, "exact count, derived from rate and duration when omitted")
	accessToken := flags.String("access-token", os.Getenv("GCP_IDENTITY_TOKEN"), "Cloud Run identity token")
	maxInFlight := flags.Int("max-in-flight", 4096, "bounded local request concurrency")
	requestTimeout := flags.Duration("request-timeout", 60*time.Second, "per-request timeout")
	principal := flags.String("principal", "", "optional Principal identity for the fairness lane")
	principalCount := flags.Int("principal-count", 0, "number of generated Principals for a production-shaped lane")
	threadPrefix := flags.String("thread-prefix", "thread", "Thread identity prefix for the fairness lane")
	threadCount := flags.Int("thread-count", 1, "number of Threads used by each Principal")
	ordinalOffset := flags.Int("ordinal-offset", 0, "ordinal offset for concurrent Principal streams")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return err
	}
	benchmarkID, err := uuid.Parse(*benchmarkText)
	if err != nil {
		return fmt.Errorf("valid --benchmark is required: %w", err)
	}
	if *url == "" || *rate <= 0 || *duration <= 0 || *maxInFlight <= 0 || *threadCount <= 0 {
		return fmt.Errorf("--url, positive --rate, --duration, and --max-in-flight are required")
	}
	if *principalCount < 0 || *principal != "" && *principalCount > 0 {
		return fmt.Errorf("--principal-count must be non-negative and cannot be combined with --principal")
	}
	if *endRate <= 0 {
		*endRate = *rate
	}
	if *count <= 0 {
		*count = int(((*rate + *endRate) / 2) * duration.Seconds())
	}
	client := &http.Client{Timeout: *requestTimeout, Transport: &http.Transport{
		MaxIdleConns: 2048, MaxIdleConnsPerHost: 2048, MaxConnsPerHost: *maxInFlight,
		IdleConnTimeout: 90 * time.Second,
	}}
	semaphore := make(chan struct{}, *maxInFlight)
	samples := make(chan sample, *maxInFlight)
	var wait sync.WaitGroup
	var encoded atomic.Int64
	encodeDone := make(chan error, 1)
	go func() {
		encoder := json.NewEncoder(os.Stdout)
		for value := range samples {
			if err := encoder.Encode(value); err != nil {
				encodeDone <- err
				return
			}
			encoded.Add(1)
		}
		encodeDone <- nil
	}()
	started := time.Now()
	for streamOrdinal := 0; streamOrdinal < *count; streamOrdinal++ {
		targetOffset := scheduledOffset(streamOrdinal, *count, *duration, *rate, *endRate)
		scheduledAt := started.Add(targetOffset)
		if delay := time.Until(scheduledAt); delay > 0 {
			time.Sleep(delay)
		}
		semaphore <- struct{}{}
		wait.Add(1)
		go func(streamOrdinal int, scheduledAt time.Time) {
			defer wait.Done()
			defer func() { <-semaphore }()
			ordinal := *ordinalOffset + streamOrdinal
			principalIdentity, thread := loadIdentity(streamOrdinal, *principal, *principalCount, *threadPrefix, *threadCount)
			samples <- offer(ctx, client, *url, *accessToken, benchmarkID, ordinal, scheduledAt, principalIdentity, thread)
		}(streamOrdinal, scheduledAt)
	}
	wait.Wait()
	close(samples)
	if err := <-encodeDone; err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "offered=%d encoded=%d elapsed=%s\n", *count, encoded.Load(), time.Since(started))
	return nil
}

func loadIdentity(streamOrdinal int, fixedPrincipal string, principalCount int, threadPrefix string, threadsPerPrincipal int) (string, string) {
	if fixedPrincipal != "" {
		return fixedPrincipal, fmt.Sprintf("%s-%04d", threadPrefix, streamOrdinal%threadsPerPrincipal)
	}
	if principalCount <= 0 {
		return "", ""
	}
	principalOrdinal := streamOrdinal % principalCount
	threadOrdinal := (streamOrdinal / principalCount) % threadsPerPrincipal
	principal := fmt.Sprintf("principal-%06d", principalOrdinal)
	thread := fmt.Sprintf("%s-%06d-%04d", threadPrefix, principalOrdinal, threadOrdinal)
	return principal, thread
}

func scheduledOffset(ordinal, count int, duration time.Duration, startRate, endRate float64) time.Duration {
	if startRate == endRate {
		return time.Duration(float64(time.Second) * float64(ordinal) / startRate)
	}
	// For linear rate r(t) = r0 + kt, solve ordinal = r0*t + k*t^2/2.
	k := (endRate - startRate) / duration.Seconds()
	n := float64(ordinal)
	seconds := (-startRate + math.Sqrt(startRate*startRate+2*k*n)) / k
	if seconds < 0 || ordinal == count-1 && seconds > duration.Seconds() {
		seconds = duration.Seconds() * float64(ordinal) / float64(count)
	}
	return time.Duration(seconds * float64(time.Second))
}

func offer(ctx context.Context, client *http.Client, url, accessToken string, benchmarkID uuid.UUID, ordinal int, scheduledAt time.Time, principal, thread string) sample {
	offeredAt := time.Now().UTC()
	identity := fmt.Sprintf("%s/%d", benchmarkID, ordinal)
	requestBody := store.B3Request{
		BenchmarkID: benchmarkID, Ordinal: ordinal, Attempt: 1,
		Idempotency: "b3/" + identity, RequestHash: "sha256:b3/" + identity,
		Fault: "none", Principal: principal, Thread: thread,
	}
	body, _ := json.Marshal(requestBody)
	const attempts = 3
	var last sample
	for attempt := 1; attempt <= attempts; attempt++ {
		last = offerOnce(ctx, client, url, accessToken, body, ordinal, scheduledAt, offeredAt, principal, thread, attempt)
		if last.Status < http.StatusInternalServerError && last.Status != 0 {
			return last
		}
		if attempt < attempts {
			timer := time.NewTimer(time.Duration(attempt*50) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return last
			case <-timer.C:
			}
		}
	}
	return last
}

func offerOnce(
	ctx context.Context,
	client *http.Client,
	url, accessToken string,
	body []byte,
	ordinal int,
	scheduledAt, offeredAt time.Time,
	principal, thread string,
	attempt int,
) sample {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url+"/v1/admissions", bytes.NewReader(body))
	if err != nil {
		return failedSample(ordinal, scheduledAt, offeredAt, 0, attempt, "request_build", err)
	}
	request.Header.Set("content-type", "application/json")
	if accessToken != "" {
		request.Header.Set("authorization", "Bearer "+accessToken)
	}
	response, err := client.Do(request)
	if err != nil {
		return failedSample(ordinal, scheduledAt, offeredAt, 0, attempt, "transport", err)
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if readErr != nil {
		return failedSample(ordinal, scheduledAt, offeredAt, response.StatusCode, attempt, "response_read", readErr)
	}
	completedAt := time.Now().UTC()
	var result store.B3Result
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return failedSample(ordinal, scheduledAt, offeredAt, response.StatusCode, attempt, "response_decode", err)
	}
	if result.CallerOutcome == "" {
		result.CallerOutcome = "unknown"
		result.ErrorClass = "empty_caller_outcome"
	}
	return sample{
		Ordinal: ordinal, Principal: principal, Thread: thread,
		ScheduledAt: scheduledAt.UTC(), OfferedAt: offeredAt,
		CompletedAt: completedAt, Status: response.StatusCode,
		LatencyMS:     float64(completedAt.Sub(offeredAt).Microseconds()) / 1000,
		CallerOutcome: result.CallerOutcome, ErrorClass: result.ErrorClass,
		RetryAfterMS: result.RetryAfterMS,
		HTTPAttempts: attempt,
	}
}

func failedSample(ordinal int, scheduledAt, offeredAt time.Time, status, attempt int, class string, err error) sample {
	completedAt := time.Now().UTC()
	return sample{
		Ordinal: ordinal, ScheduledAt: scheduledAt.UTC(), OfferedAt: offeredAt,
		CompletedAt: completedAt, Status: status,
		LatencyMS:     float64(completedAt.Sub(offeredAt).Microseconds()) / 1000,
		CallerOutcome: "unknown", ErrorClass: class + ": " + err.Error(),
		HTTPAttempts: attempt,
	}
}
