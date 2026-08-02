# Osfo v1 overload safety controls

Research date: 2026-08-02.

## Decision

Osfo v1 should start with a small set of static, configurable safety controls.
Their purpose is to keep overload local, bound amplification, and preserve
control-plane recovery. They are not a generic budgeting system.

Every implementation cycle should revisit the controls after load and failure
tests reveal the next real resource boundary. New limits are added only when
observed behavior justifies them.

Queue topology remains a separate decision. These controls apply whether
workers discover runnable `AgentRun`s in PostgreSQL or receive dispatch
notifications through an external queue.

## Lessons from Google SRE

Google's *Addressing Cascading Failures* recommends testing capacity limits and
overload failure modes before relying on capacity planning. A healthy system
should reject excess work while continuing to complete admitted work, rather
than collapse after its breaking point.

The chapter identifies four directly applicable controls:

1. Bound queued and in-flight work because queues consume resources and extend
   latency.
2. Reject excess work early and cheaply before it consumes scarce resources.
3. Bound retries, use randomized exponential backoff, and avoid retrying at
   every layer because retries multiply load.
4. Test gradual load, sudden bursts, failure beyond the breaking point, and
   recovery after load falls.

Google's *Handling Overload* warns that request counts are imperfect resource
proxies because the cost of requests changes. Osfo should therefore begin with
simple count and size limits for safety, while measuring the resources those
limits protect. It should not treat one request count as a universal work unit.

The same guidance warns that complex degradation mechanisms can create their
own failures when rarely exercised. Osfo v1 should prefer explicit static
limits and typed outcomes over adaptive controllers.

## Required v1 controls

| Control | Scope | Protects | Saturated outcome |
|---|---|---|---|
| Command and payload size | Request | API memory, database connections, WAL, storage | Reject before acceptance |
| Non-terminal `AgentRun` count | Global | Durable obligation and recovery capacity | Retryable rejection before acceptance |
| Non-terminal `AgentRun` count | Principal | Fair access and per-user backlog growth | Typed policy rejection before acceptance |
| Model calls | `AgentRun` | Runaway agent loops and provider demand | Fail the run with a typed limit result |
| Child admissions | Root `AgentRun` | Durable fan-out and backlog amplification | Reject the child admission |
| Delegation depth | Oz v1 | Recursive amplification | Fixed to one level, children cannot delegate |
| Concurrent provider operations | Provider and deployment | Provider quotas, sockets, memory, and worker capacity | Keep admitted work pending |
| Attempt timeout and retry count | Operation | Stuck capacity and retry amplification | Retry with bounded backoff or terminal failure |
| Live SSE buffer | Client connection | API memory and slow-consumer amplification | Disconnect and resume from `ThreadCursor` |

Exact values are Agent Application configuration. Initial values must be
conservative and exercised by tests. They are not stable Osfo-wide constants.

## Required observations

Measure both offered and accepted work:

- command count and bytes;
- accepted and rejected admissions by reason;
- global and per-Principal non-terminal runs;
- pending age and pending reason;
- model calls and child admissions per root run;
- provider concurrency, throttling, latency, and errors;
- attempts, retries, retry delay, and exhausted retries;
- database connection, transaction, WAL, and storage pressure;
- SSE buffered events or bytes and slow-consumer disconnects.

These observations answer the next review question: which real resource is
approaching failure, and does it need a new limit, a changed value, or more
capacity?

## Evidence loop

For each vertical slice:

1. Identify its amplification paths and finite resources.
2. Configure the smallest protective controls.
3. Increase offered load gradually and with bursts until a boundary saturates.
4. Confirm excess work receives the intended typed outcome while admitted work
   continues progressing.
5. Remove capacity or fail a dependency and verify recovery.
6. Review measurements and adjust controls or add one newly justified control.

## Deferred

- adaptive concurrency and automatic limit tuning;
- universal weighted work units;
- generic budget or allowance expressions;
- recursive delegation and subtree accounting;
- monetary reservation systems;
- quantitative service tiers and preemption;
- queue or broker selection.

## Primary sources

- Google SRE, [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/).
- Google SRE, [Handling Overload](https://sre.google/sre-book/handling-overload/).
