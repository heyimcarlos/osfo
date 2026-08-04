# ADR 0001: Retain Cloud SQL direct AgentRun dispatch

Date: 2026-08-04

Status: Accepted for the v1 target, with overload shedding and Temporal capacity follow-ups

## Context

Osfo must durably admit a modeled peak of 232 incoming messages per second.
Live `openai/gpt-5.6-luna` reasoning measured 1.5 AgentRuns and 0.357
Temporal workflows per message. PostgreSQL remains the lifecycle authority.
Temporal Cloud owns only workflow execution history.

Candidate A claims runnable AgentRuns directly from Cloud SQL with bounded
workers, connection pools, leases, and fencing. Candidate B would add an
outbox and Pub/Sub wake hint, but workers would still claim and fence in Cloud
SQL.

The first Candidate A target run exposed a mixed claim index and query that
searched both immediately runnable work and expired leases. Splitting those
paths reduced claim-query database execution time from about 357 seconds to
about 10.5 seconds in comparable 232 messages/s windows.

## Decision

Retain Candidate A for Osfo v1. Do not add Pub/Sub to the current architecture.

Use separate partial indexes and query paths for immediately claimable work and
expired running leases. Check expired leases only when no normal work is
claimable. Keep worker counts and database pools bounded.

Add Pub/Sub only if a future identical-trace comparison shows that runnable
discovery or polling limits useful completion, recovery, or cost after the
remaining database queries and overload controls are addressed.

## Evidence

The final 232 messages/s Luna replay accepted and reconciled all 13,920
messages. Authoritative completion was 231.33/s, drain was 1.10 seconds,
database terminal p95 was 430 ms, and Cloud SQL CPU peaked at 27.9 percent.

Before the query split, the same target completed 221/s, drained in 3.76
seconds, had a 2.41 second database terminal p95, and reached 62.0 percent
Cloud SQL CPU.

The post-fix 464 messages/s run characterized the fixed-fleet boundary. It had
no caller drops, reached 283.83 authoritative completions/s during offer, but
did not pass correctness. Admission p95 was 30.8 seconds and drain was 90.7
seconds. Query Insights then showed child lookup and ChildJoin settlement
queries ahead of the claim query. Adding Pub/Sub would not remove those
authoritative database operations.

## Consequences

The v1 path has fewer moving parts and preserves atomic admission without a
database and broker dual-write. The current fixed topology has credible
headroom at 232 messages/s, but it is not a production overload confirmation.

Two focused gaps remain:

1. Ingress must reject overload early with a typed, bounded response before
   dependency queues and client latency grow.
2. The Temporal Cloud namespace is capped at 500 actions/s while the measured
   target workload demands about 664 actions/s. Either reduce workflow action
   amplification or provision at least 1,000 actions/s before claiming full
   peak capacity.

Candidate A is therefore the topology decision, not a claim that every
production reliability control is complete.
