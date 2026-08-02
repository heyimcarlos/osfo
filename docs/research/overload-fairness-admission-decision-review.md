# Overload, fairness, and admission decision review

Access date for web sources: 2026-08-01.

## Executive judgment

[Wayfinder ticket 5](https://github.com/heyimcarlos/osfo/issues/5) is
directionally strong, but its resolution should not remain settled as written.
The review found eleven separate decisions inside one answer, plus the broader
question of whether TLA+ is appropriate evidence. None should be discarded
wholesale, but the eleven contract decisions need narrowing or revision before
they become stable Osfo contracts.

The most important corrections are:

1. Safety, liveness, and fairness are a way to classify correctness claims.
   They do not select an admission policy, a budget model, or a scheduler.
2. Formal fairness and product resource fairness are related but different.
   Starvation resistance is a liveness property. It is not an invariant and it
   does not by itself provide noisy-neighbor isolation.
3. `global -> Principal -> Thread -> parent AgentRun -> child work` combines
   relationships that mature systems keep separate: identity, ownership,
   conversational ordering, causal lineage, accounting, and resource pools.
4. Durable admission must itself be bounded. Execution concurrency does not
   prevent one Principal from filling PostgreSQL with accepted obligations.
5. Per-parent child count and per-run model-call count are circuit breakers,
   not resource budgets. They do not bound recursive depth, total descendants,
   tokens, cost, time, effects, or stored backlog.
6. A cancellation request, stopping execution, and terminal cancellation are
   distinct facts for a running `AgentRun`.
7. A lease permits takeover. Only a checked fencing generation prevents stale
   authoritative writes. Neither mechanism prevents duplicate remote effects.
8. TLA+ is justified for one small protocol model. It is not a project-wide
   requirement, a source of product policy, or proof of the Rust implementation.

Overall recommendation: reopen ticket 5 or create blocking correction tickets
before the Osfo v1 architecture specification treats this area as resolved.

## Decision frame

- Target: reusable Osfo semantics and the Oz v1 Reference Agent Application.
- Runtime direction: Rust, PostgreSQL authority, ordinary HTTP commands, and
  resumable SSE ThreadEvent delivery.
- Scale cases: one Account causing high fan-out, and many Accounts and Threads
  active concurrently.
- Hard constraints: durable accepted work, canonical per-Thread order,
  transport-neutral semantics, no silent loss, and application-selected policy.
- Review method: one skeptical comparable study per core decision, emphasizing
  job systems, schedulers, operating systems, cloud control planes, protocols,
  and formal-method sources rather than only agent SDKs.

## What the Lamport source does and does not say

The likely source is Leslie Lamport's 2019 essay
[Safety, Liveness, and Fairness](https://lamport.org/tla/safety-liveness.pdf),
later expanded as chapter 4 of
[A Science of Concurrent Programs](https://lamport.org/tla/science.pdf). Ticket
5 itself does not cite a paper. A 1994 paper by A. P. Sistla has a similar title,
but its subject is the syntactic classification of temporal formulas and it is a
less likely source for this discussion.

The plain-language map is:

```text
safety
  a bad result can be demonstrated by a finite execution prefix
  example: two terminal outcomes commit for one AgentRun

liveness
  a good result must eventually occur over an ongoing behavior
  example: an eligible accepted AgentRun eventually reaches a terminal outcome

formal fairness
  an assumption or property governing which enabled actions eventually occur
  example: a continuously enabled scheduler action eventually runs
```

Lamport distinguishes weak fairness from strong fairness:

- Weak fairness applies when an action remains continuously enabled.
- Strong fairness applies when an action is enabled infinitely often, even if
  it is repeatedly disabled in between.

That distinction matters because compatible provider capacity can flicker.
Weak fairness does not stop a noisy Account from taking every newly available
slot unless the queue discipline makes the quiet Account's selection action
remain enabled.

The source does not define:

- what Osfo should admit;
- which resource dimensions need limits;
- how Accounts should share capacity;
- whether a finite `AgentRun` may wait forever;
- which queue or scheduler to implement;
- what exact limit values should be.

Admission and saturation are product and system policies. Safety and liveness
are useful lenses for stating their consequences. Fairness is not a third
independent product requirement that supplies the missing policy.

```text
Osfo policy or mechanism          Formal classification
------------------------------    -------------------------------
atomic accepted state             safety invariants
bounded backlog                   safety and operability limits
eventual terminalization          conditional liveness
Account selection discipline      scheduler mechanism
starvation resistance             scheduler liveness property
minimum share or interference cap quantitative isolation policy
```

## Core decision inventory

| ID | Decision in ticket 5 | Verdict | Main correction |
|---|---|---|---|
| D1 | Atomic durable admission and idempotency | Revise | Add indeterminate commit outcome, complete idempotency semantics, and make a physical outbox conditional on the dispatch seam. |
| D2 | PostgreSQL authority, finite ownership, and fencing | Revise | Separate lease, atomic claim, fencing generation, attempt number, and downstream effect idempotency. |
| D3 | Acceptance and conditional execution liveness | Revise | Accepted work consumes obligation capacity. Finite runs need explicit terminalization policy rather than healthy pending forever. |
| D4 | One global-to-child scope hierarchy | Reopen | Replace one tree with typed identity, ownership, order, lineage, resource, and policy axes. |
| D5 | One transition at a time per Thread | Revise | Require linearizable authoritative commit batches, not sequential computation or one in-flight worker. |
| D6 | Model-call and child limits, no generic budget engine | Revise | Keep typed controls, add subtree, depth, backlog, time, context, retry, rate, and effect boundaries. |
| D7 | Fairness invariant and noisy-neighbor isolation | Reopen | Fairness is liveness, not an invariant. Define eligibility, scheduler mechanism, assumptions, and a narrower promise. |
| D8 | Five lifecycle states and progress observation | Revise | Make eligibility, stable reasons, transition time, cancellation request, and attempt semantics observable. |
| D9 | Durable cancellation and propagation | Revise | Split requested, stopping, and canceled; define race, child-wait, cleanup, capacity, and effect uncertainty rules. |
| D10 | Reject before acceptance, defer after acceptance | Revise | Bound the durable backlog and distinguish transient deferral from permanent failure or intervention. |
| D11 | Exact limits derived from measurement and product policy | Revise | Osfo still owns safe taxonomy, startup defaults, hard bounds, measurement rules, and controller safeguards. |
| D12 | TLA+ as design evidence | Targeted use | Model the protocol now, add scheduler fairness only after a candidate scheduler exists, and require separate implementation evidence. |

## D1: Atomic durable admission

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | River 0.42 | 31/35 | PostgreSQL transaction inserts durable work with application state | Unique jobs deduplicate insertion, not execution or full request semantics. |
| 2 | Oban 2.23 | 30/35 | Application mutations and jobs share one transaction | Uniqueness is pruning-dependent and can return only a conflict marker. |
| 3 | Graphile Worker | 29/35 | `add_job` runs inside the caller's transaction | `job_key` may replace work and is not an immutable acceptance receipt. |
| 4 | Stripe idempotent APIs | 23/35 | Request fingerprints, result replay, and ambiguous network outcomes | Implementation is closed and the published retention horizon is too short for Osfo. |

Concrete evidence includes River's
[`Client.InsertTx`](https://github.com/riverqueue/river/blob/9c5240d7430c96a5246b541a6097aeee8f476418/client.go#L1834-L1857),
Oban's [`Oban.insert/5`](https://github.com/oban-bg/oban/blob/9a0b729d7ede663612ba4c88b94b8c7fe1e4134f/lib/oban.ex#L709-L731),
and Graphile Worker's
[`add_job` SQL](https://github.com/graphile/worker/blob/abfb4cff30747ad423046d117dfb88470f03ae00/sql/000016.sql).

The atomic semantic is correct, but the physical record shape is too early.
All three PostgreSQL job systems can discover durable work from the job row and
use notifications only as hints. Osfo should require atomic durable dispatch
discoverability. It should require a separate `OutboxRecord` only when a broker
or other external dispatch seam exists.

The failure result is three-way, not two-way:

```text
definite commit       -> Accepted(original receipt)
definite abort        -> RejectedBeforeAcceptance
commit result unknown -> AdmissionOutcomeUnknown, retry same idempotency key
```

A connection can fail while PostgreSQL commits. Osfo cannot truthfully claim
that every persistence error produced no records. The idempotency mapping needs
a Principal and operation scope, canonical command fingerprint and version,
concurrent in-flight behavior, retention policy, database uniqueness, and an
immutable acceptance receipt. Replaying an already committed receipt must occur
before applying limits for new admission.

The revised invariant is:

> The accepted ThreadEvent, pending AgentRun, immutable idempotency receipt,
> obligation reservation, and durable dispatch discoverability become visible
> atomically, or none become visible. An indeterminate commit is reconciled by a
> retry with the same key.

Supporting standards: [RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2),
[AWS retries and idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/),
and Pat Helland's [Life Beyond Distributed Transactions](https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf).

## D2: Authority, claims, leases, and fencing

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Temporal | 33/35 | Authoritative persisted history, derivative task delivery, attempt token, and guarded completion | A full workflow platform is larger than Osfo needs. |
| 2 | Oban | 32/35 | Atomic PostgreSQL claim and abandoned-job rescue | Basic completion by job ID demonstrates the stale-owner hole. |
| 3 | Kubernetes leader election | 29/35 | Lease and optimistic update semantics | Its own source warns that leader election is not fencing. |

Temporal validates guarded attempt completion in
[`respondactivitytaskcompleted/api.go`](https://github.com/temporalio/temporal/blob/ce1e067e41facf31e588f65da3b5eacd324e8fa3/service/history/api/respondactivitytaskcompleted/api.go#L49-L130).
Oban's claim and rescue paths are in
[`basic.ex`](https://github.com/oban-bg/oban/blob/9a0b729d7ede663612ba4c88b94b8c7fe1e4134f/lib/oban/engines/basic.ex#L104-L140).
Kubernetes documents the limitation directly in
[`leaderelection.go`](https://github.com/kubernetes/client-go/blob/49f0a7b40101510e445c516af9670f1d4a36ec58/tools/leaderelection/leaderelection.go#L17-L48).

The contract must separate:

| Mechanism | What it establishes | What it does not establish |
|---|---|---|
| Lease expiry | Another attempt may take over | The earlier worker stopped. |
| Atomic claim | One claimant won the database transition | No earlier worker is still executing. |
| Fencing generation | A checked store can reject an older owner | A remote provider checks the generation. |
| Idempotency key | One logical effect can be deduplicated by a cooperating destination | General ordering or physical single execution. |
| Local transaction | PostgreSQL facts commit together | Atomicity with a model provider or external tool. |

Use separate `owner_id`, monotonic `claim_epoch`, database-clock
`lease_expires_at`, and product `attempt_no`. Every authoritative mutation must
check the current run state and epoch, including output appends, child admission,
usage records, and terminal transitions.

The correct promise is:

> A stale attempt cannot advance PostgreSQL-authoritative Osfo state. Remote
> execution remains at least once unless the destination enforces an Osfo
> idempotency key or fencing token.

Canonical sources: [The Chubby Lock Service, section 2.4](https://research.google.com/archive/chubby-osdi06.pdf)
and [Leases: An Efficient Fault-Tolerant Mechanism](https://web.stanford.edu/class/cs240/readings/leases.pdf).

## D3: Acceptance and liveness

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Temporal Workflow Execution | 29/30 | Durable identity with optional infinite technical lifetime | Workflows may intentionally wait for years; ordinary AgentRuns are finite jobs. |
| 2 | GitHub Actions jobs | 29/30 | Queued work without compatible capacity ends in visible failure after a bound | Fixed 24-hour policy is product-specific. |
| 3 | Kubernetes Jobs | 27/30 | Optional deadline creates visible `DeadlineExceeded` failure | Job and Pod lifecycles are not conversation semantics. |

The specialized score uses durable identity, admission separation, terminal
accountability, deadline clarity, stuck-work observability, and finite-run fit.

Acceptance does not reserve a worker or provider slot. It does consume durable
obligation, storage, backlog, and operator-recovery capacity. MQTT QoS 1 is the
better protocol analogy: acknowledgement follows ownership transfer before
onward delivery is complete. HTTP 202 is weaker and explicitly allows work never
to be acted on. See [MQTT 5.0 section 4.3.2](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_QoS_1:_At)
and [RFC 9110 section 15.3.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3).

The phrase "until exactly one terminal outcome" merges two properties:

```text
safety:   terminal_count(run) <= 1
liveness: accepted(run) eventually leads to terminal(run)
```

Pending forever is defensible only for a class explicitly intended to wait
indefinitely, such as an independently durable `WorkflowInstance`. It is not a
sound default for a finite conversational `AgentRun`. Permanent incompatibility,
deadline expiry, and exhausted retries should create a visible terminal failure
or a deliberately modeled intervention state. They should not delete work.

Recommended contract:

> Acceptance durably owns one AgentRun and consumes outstanding-obligation
> allowance. Every accepted nonterminal run remains queryable and reaches at
> most one immutable terminal result. Each Agent Application declares the
> pending and lifecycle policy for each run class. Finite runs terminalize on
> permanent unroutability, deadline expiry, or exhausted retries. Explicitly
> unbounded waiting is limited to run classes designed for it.

## D4: Identity, ownership, ordering, lineage, and resource scope

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Slurm | 32/35 | Separate account hierarchy, user, partition, QOS, and job | Its precedence matrix is too complex for v1. |
| 2 | YARN CapacityScheduler | 30/35 | Policy queues, users, applications, rejection, and accepted waiting | A Thread should not automatically become a YARN-like queue. |
| 3 | Kubernetes | 30/35 | Users, namespaces, quota, priority, and fair flows remain typed | Cluster concepts should not be copied as Osfo domain nouns. |

Slurm's model is documented in [Resource Limits](https://slurm.schedmd.com/resource_limits.html).
YARN separates `maximum-applications` rejection from `max-parallel-apps`
waiting in [CapacityScheduler](https://hadoop.apache.org/docs/current/hadoop-yarn/hadoop-yarn-site/CapacityScheduler.html).
Kubernetes separates [authentication](https://kubernetes.io/docs/reference/access-authn-authz/authentication/),
[ResourceQuota](https://kubernetes.io/docs/concepts/policy/resource-quotas/), and
[API Priority and Fairness](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/).

The safer v1 model is orthogonal:

```text
Actor
  authenticates and requests

Account
  owns B2C resources and is the top-level fairness key
  v1 may map one Actor to one Account

Thread(account_id)
  defines canonical conversational order

AgentRun(thread_id, requested_by_actor_id, parent_run_id?)
  defines durable work and causal lineage

ResourcePoolKey
  provider + quota owner + region + model/resource class + operation

PolicyClass
  priority, entitlement, or product-specific service policy
```

A schedulable operation carries the axes it needs:

```text
(account_id, thread_id, parent_run_id?, resource_pool_key, workload_kind, policy_class)
```

Eligibility is an intersection, not a single tree walk:

```text
global headroom
AND Account allowance and scheduler eligibility
AND Thread ordering
AND root-run subtree allowance
AND compatible ResourcePool capacity
AND PolicyClass rules
```

Defer arbitrary tenant hierarchies and generic scope paths. Do not defer the
distinction between authenticated Actor and durable Account. Provider quota
ownership must also remain explicit.

## D5: Per-Thread order and cross-Thread concurrency

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Temporal History Service | 33/35 | Linear history per workflow with concurrent workflows | It has much more infrastructure than Osfo needs. |
| 2 | KurrentDB stream concurrency | 32/35 | Expected-revision append, atomic batches, and retry | A specialized event database is not required. |
| 3 | PostgreSQL concurrency control | 31/35 | Concurrent calculation with serial authoritative effects | It supplies primitives, not Osfo semantics. |

Temporal's concrete architecture is in
[`docs/architecture/history-service.md`](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md).
KurrentDB documents [expected-revision consistency checks](https://docs.kurrent.io/clients/python/v1.3/appending-events#consistency-checks).
PostgreSQL documents [Serializable isolation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-SERIALIZABLE)
and [row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

The right requirement is linearizable commit, not sequential execution:

> Every authoritative Thread mutation is an atomic transition batch evaluated
> against an expected durable Thread revision. At most one conflicting batch
> derived from the same revision commits. A stale batch is re-evaluated or
> receives a typed conflict. Computation, provider calls, observation, and
> transitions on other Threads may overlap. Attempt commits also check the
> current `claim_epoch` and nonterminal run state.

Never hold a database transaction or Thread row lock across a provider or tool
call. Define whether a transition can append multiple ThreadEvents, the ordering
of simultaneous device commands, and the response to a stale computed result.

## D6: Allowances and budgets

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Linux cgroup v2 | 33/35 | Ancestor containment plus descendant and depth controls | Local operating-system resources are easier to account for. |
| 2 | Kubernetes ResourceQuota and APF | 33/35 | Independent object, storage, compute, and concurrency dimensions | Declared cluster requests are more predictable than agent work. |
| 3 | Google SRE overload guidance | 33/35 | Explains why request count is a drifting cost proxy | Primarily addresses RPC serving. |
| 4 | Amazon Bedrock quotas | 31/35 | Reserve estimated tokens, then reconcile actual use | Covers model inference, not tools or effects. |

The decision to reject one universal weighted work unit is correct.
[Dominant Resource Fairness](https://people.eecs.berkeley.edu/~matei/papers/2011/nsdi_drf.pdf)
uses resource vectors because fixed slots poorly represent heterogeneous work.
Google's [Handling Overload](https://sre.google/sre-book/handling-overload/#the-pitfalls-of-queries-per-second)
also recommends direct resource measurement and separate protection for
resources that cannot safely be overprovisioned.

The current typed limits are too weak:

```text
per-parent child cap = C

root
  -> C children
       -> each creates C children
            -> ...

total through depth D = 1 + C + C^2 + ... + C^D
```

Even a direct-child limit of one allows an unbounded chain. Linux cgroup v2 is
instructive because it combines hierarchical containment with explicit
[`cgroup.max.descendants` and `cgroup.max.depth`](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

Minimum v1 controls:

- maximum model calls per run, explicitly a circuit breaker;
- maximum descendants per root run;
- maximum delegation depth;
- nonterminal run count and serialized backlog bytes per Account and globally;
- provider input/context and output bounds;
- provider and tool timeouts;
- bounded retries;
- provider/model rate and concurrency limits;
- effect-specific admission for irreversible operations;
- optional native-unit or monetary reservation where an Agent Application
  promises a hard usage or spend boundary.

Do not build a generic budget expression engine. Use explicit typed controls and
reserve worst credible usage before a provider or tool call when overshoot would
violate a hard promise. Reconcile actual use afterward.

## D7: Scheduler fairness

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Kubernetes API Priority and Fairness | 31/35 | Flow keys, shares, seats, bounded queues, sharding, and metrics | Shuffle-sharding isolation is probabilistic, not absolute. |
| 2 | Kubernetes Kueue | 30/35 | Durable workloads, resource compatibility, fair shares, and preemption | Strict FIFO and best-effort FIFO have different starvation risks. |
| 3 | YARN CapacityScheduler | 29/35 | Quantitative shares, limits, hierarchy, and preemption | Its configuration surface is too large for Oz v1. |
| 4 | Linux EEVDF and cgroup v2 | 27/35 | Eligibility, virtual deadlines, lag, and weights | CPU tasks are more homogeneous and preemptible. |

The current sentence fails as a conformance requirement:

- `eligible`, `opportunity`, and `compatible capacity` are undefined;
- repeated consideration without dispatch could count as an opportunity;
- a flat parent scheduler lets an Account with 100 parents receive roughly 100
  times the selection chances of an Account with one parent;
- dispatch fairness cannot help if one Account occupies every non-preemptive
  slot indefinitely;
- `cannot monopolize` is false when no competitor is eligible;
- no finite load test proves starvation freedom over infinite behaviors.

Starvation resistance and noisy-neighbor isolation must be separated:

```text
starvation resistance
  every qualifying fixed work item eventually receives service

noisy-neighbor isolation
  interference from another Account is quantitatively bounded
```

The latter requires a cap, share, reservation, preemption rule, or SLO. Ticket 5
explicitly disclaims all of those, so it can promise only scheduler-controlled
starvation resistance.

Recommended shape:

1. Define `Eligible(run)` from durable pending state, Thread order, due time,
   cancellation, and policy.
2. Define `Dispatchable(run, resource_class)` as eligible work fitting currently
   available compatible capacity.
3. Select hierarchically by Account before Thread or parent so fan-out does not
   multiply top-level selection chances.
4. State work conservation for each compatible resource class.
5. State assumptions: acquired leases eventually release or expire, supported
   capacity recurs, each contender has positive policy weight, and the active
   contender set at each choice is finite.
6. Promise liveness for continuously dispatchable work. If intermittent
   dispatchability is covered, name the stronger fairness condition.
7. Replace `noisy-neighbor isolation` with `starvation isolation for
   scheduler-controlled capacity` until a quantitative bound exists.

## D8: Lifecycle and progress observation

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Temporal | 33/35 | Attempt, pending reason, retry, heartbeat, schedule, and terminal detail | Exposes more engine detail than every Osfo client needs. |
| 2 | Kubernetes Jobs | 31/35 | Conditions, reasons, transition times, and terminating work | Pod counters should not become AgentRun states. |
| 3 | AWS Batch | 30/35 | Separates blocked `PENDING` from eligible `RUNNABLE` | Batch initialization states are not direct domain matches. |

Google long-running operations and Azure support a deliberately small public
phase plus extensible metadata. See
[`google/longrunning/operations.proto`](https://github.com/googleapis/googleapis/blob/master/google/longrunning/operations.proto)
and the Azure [status monitor resource](https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md#the-status-monitor-resource).

Keep the public phases:

```text
pending | running | succeeded | failed | canceled
```

Add a contractually derivable pending class:

```text
pending.class:
  not_ready | ready | intervention_required

pending fields:
  code
  reason_since
  next_eligible_at?
```

Without observable readiness, the fairness claim cannot be measured. Pending
age currently mixes Thread ordering, scheduled time, retry backoff, capacity
wait, fairness wait, and operationally stuck work.

Define `attempt_count` precisely. Replace vague contract-level
`last_progress_at` with durable `phase_changed_at`, plus telemetry-only worker
heartbeat. Add `cancel_requested_at`, a monotonic revision, stable terminal
reason codes, and explicit legal transitions. Do not promise exact queue position
or completion ETA.

## D9: Cancellation

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Temporal | 33/35 | Durable request, cooperative delivery, wait policy, and child policy | A complete workflow engine has more policies than v1 needs. |
| 2 | Oban | 31/35 | PostgreSQL cancellation race and process signal | Its success-versus-cancel race is weaker than the proposed Osfo fence. |
| 3 | Tokio | 30/35 | Abort request versus joined task completion | Process-local cancellation is not durable authority. |
| 4 | Kubernetes Jobs and Pods | 30/35 | Deletion intent, grace, physical termination, and replacement | Cluster deletion semantics are not AgentRun semantics. |

The contract needs this transition:

```text
pending
  cancel wins claim race
    -> canceled

running
  cancellation request commits
    -> canceling condition
       normal progress and success are fenced
       signal is delivered and reconciled
       bounded cleanup persists output and effect receipts
    -> canceled
       after local ownership stops or is safely revoked
```

`canceling` may be a phase or a required condition on `running`. It cannot be
omitted from observation. Tokio explicitly says `abort()` returns before a task
has stopped. See [Tokio cancellation](https://docs.rs/tokio/latest/tokio/task/index.html#cancellation).

The cancellation and success writes must race through one PostgreSQL
linearization rule. If success commits first, later cancellation observes the
actual terminal outcome. If cancellation commits first, it invalidates the
attempt epoch and normal completion cannot commit.

Parent propagation needs an atomic child-admission gate. Closing child admission
and recording the parent request must occur before enumerating existing children,
otherwise a new child can appear after the canceler scans. Oz v1 should choose
and name `request_and_wait`, `request_only`, or `detach`. `WorkflowInstance`
keeps an explicit independent policy.

Capacity releases at different times:

| Capacity | Safe release point |
|---|---|
| Pending obligation slot | Atomic pending-to-canceled transition |
| AgentRun execution slot | Worker stop acknowledgment or safe ownership revocation |
| Provider concurrency | Provider return, acknowledged remote cancellation, or explicit uncertainty policy |
| External resource | Confirmed termination or application-specific reconciliation |

Cancellation does not undo effects. Use durable receipts with states such as
`started`, `cancel_requested`, `canceled`, `succeeded`, `failed`,
`outcome_unknown`, and explicit compensation states. The canonical compensation
source is [SAGAS](https://www.cs.princeton.edu/techreports/1987/070.pdf).

## D10: Saturation outcomes

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | RabbitMQ | 31/35 | Explicit queue count/byte bounds, rejection, and publisher flow control | Drop-head would violate Osfo's accepted-work contract. |
| 2 | Apache Kafka | 31/35 | Separate producer buffer, broker quota, and durable retention bounds | Retention deletion cannot be copied for authoritative AgentRuns. |
| 3 | Kubernetes APF | 29/35 | Bounded queues with classified rejection reasons | Its HTTP serving work is not durably accepted product work. |
| 4 | Envoy Overload Manager | 28/35 | Early load shedding before expensive work | It has no durable obligation model. |

The reject-before and defer-after distinction is correct. The missing boundary
is the durable backlog itself. RabbitMQ's [queue limits](https://www.rabbitmq.com/docs/maxlength),
Kafka's [producer bounds](https://kafka.apache.org/26/configuration/producer-configs/),
and Kubernetes [APF queue limits](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/)
all show that execution limits alone are not sufficient.

Admission must reserve finite headroom atomically:

```text
accept only if:
  global nonterminal obligations are within count and byte limits
  AND Account obligations are within count and byte limits
  AND ResourcePool backlog is within its limit
  AND outbox and retry-backlog headroom exists
  AND control-plane headroom remains for cancel, status, and terminal commits
```

Do not count only AgentRun rows. ThreadEvents, payload bytes, indexes, outbox
records, retries, and WAL also grow.

Revised outcome map:

```text
before commit
  invalid command             -> typed nonretryable rejection
  Account or admission limit  -> quota-style typed rejection
  global or storage overload  -> unavailable-style retryable rejection
  indeterminate commit        -> outcome unknown, same-key reconciliation

after commit
  transient local capacity    -> pending.ready(capacity)
  transient provider throttle -> pending.not_ready(backoff, retry_at)
  permanent incompatibility   -> failed or intervention_required by policy
  exhausted retries/deadline  -> visible terminal failure
  never silently evict accepted work
```

Slow SSE disconnection is sound only with explicit live-buffer count or byte
bounds, disconnect reason, replay retention, `cursor_expired`, authorized
snapshot or full-resync behavior, and reconnect backoff.

## D11: How limit values are derived

### Ranked comparables

| Rank | Source | Score | Best match | Mismatch and copying risk |
|---:|---|---:|---|---|
| 1 | Envoy adaptive concurrency | 32/35 | Measurements constrained by configured floors, ceilings, and buffers | Request latency is only one of Osfo's pressure signals. |
| 2 | Kubernetes HPA | 32/35 | Product maximums plus stabilization and missing-metric behavior | Replica control differs from admission and provider control. |
| 3 | Google Autopilot | 31/35 | Historical estimation with bounds, smoothing, dry runs, and rollout | Large-scale Google infrastructure is not a v1 baseline. |
| 4 | Netflix concurrency-limits | 27/35 | Initial, minimum, maximum, smoothing, and tolerance values | Library algorithms should not become stable Osfo policy. |

Exact product values should remain Agent Application policy. The sentence is too
absolute because observed capacity still needs safe bootstrapping and control
rules. See [Envoy adaptive concurrency](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/adaptive_concurrency_filter.html),
[Kubernetes HPA](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/),
and [Google Autopilot](https://www.john.e-wilkes.com/papers/2020-EuroSys-Autopilot.pdf).

Osfo owns:

- the limit taxonomy and enforcement outcomes;
- finite infrastructure safety envelopes;
- conservative cold-start and missing-metric behavior;
- hard provider and deployment ceilings;
- the observations required to justify a value;
- hysteresis, cooldown, bounded rate of change, and fallback behavior for any
  adaptive controller.

Measure offered demand, not only admitted or completed work. Include rejection,
queueing, timeout, cancellation, retry, provider throttle, storage, connection
pool, and database pressure. Otherwise a low cap hides demand and
completion-only latency hides overload. Multiple adaptive controllers can also
oscillate unless their ownership and timescales are explicit.

Recommended wording:

> Exact product-policy values are selected by the Agent Application and
> justified by objectives, provider contracts, and tests. Osfo owns the limit
> taxonomy, finite safety envelopes, conservative startup behavior, measurement
> requirements, controller safeguards, and observable failure modes. Adaptive
> limits operate only within configured hard bounds.

## D12: Should Osfo use TLA+?

### Plain-language answer

TLA+ describes possible system states and allowed transitions. TLC explores all
transition orderings within a chosen finite model. When a property fails, it
returns a concrete counterexample trace.

It checks the model. It does not prove:

- that the Rust implementation matches the model;
- that PostgreSQL or a provider behaves as abstracted;
- production throughput or latency;
- the right token, cost, or concurrency values;
- that the model contains the right assumptions.

### Ranked approaches

| Approach | Score | Recommendation | Main reason |
|---|---:|---|---|
| Direct TLA+/TLC | 26/35 | Use for temporal properties | Strongest fit for safety, liveness, and action-level fairness. |
| PlusCal with TLA+ properties | 25/35 | Optional authoring aid | Easier pseudocode, but fairness properties still need direct TLA+. |
| P | 25/35 | Defer | Strong communicating state machines, weak fit before Osfo chooses that architecture. |
| Stateright | 25/35 | Reconsider for safety later | Rust-native, but its documented eventual-property limitation is material for starvation. |
| Alloy 6 | 23/35 | Defer | Strong relational modeling, less direct enabled-action fairness. |
| Spin/Promela | 23/35 | Reject for this task | Capable and mature, but lower-level and offers no Osfo-specific advantage. |
| Rust state-machine testing | 23/35 | Require during implementation | Strong conformance evidence, unable to prove infinite-behavior fairness. |

The scoring criteria are ticket fit, learning cost, liveness and fairness,
systematic exploration, Rust fit, maturity, and maintainability.

The industrial case is credible. AWS reports that TLA+ found distributed design
errors missed by normal review and testing in
[How Amazon Web Services Uses Formal Methods](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf).
The same paper stresses that a checked design model does not prove its
implementation.

The formal-method agents reached two timing recommendations:

1. Defer all TLA+ until a concrete scheduler exists, because adding fairness to
   an abstract `Claim(run)` action could simply assume the desired result.
2. Model the already concrete admission, duplicate dispatch, ownership, fencing,
   retry, cancellation, and terminal races now, then add fairness only after a
   scheduler exists.

The second is the better fit. It gains safety evidence now without pretending
the unresolved fairness policy has been verified.

Smallest useful model:

```text
Principals: noisy, quiet
Threads: one per Principal
Runs: noisy n1, noisy n2, quiet q1
Workers: two potential claimants
Execution capacity: one slot

State:
  admission facts
  run lifecycle and readiness
  dispatch delivery
  owner and claim epoch
  Thread revision
  capacity ownership
  cancellation request

Actions:
  AdmitAtomically
  RejectBeforeAdmission
  DeliverOrDuplicateDispatch
  Claim
  Finish
  RequestCancel
  StopCanceled
  LeaseExpires
  Requeue
  StaleFinish
```

Check safety now:

- acceptance facts are all present or all absent;
- accepted work never disappears;
- terminal outcomes are unique and immutable;
- capacity and root-subtree allowances are not exceeded;
- Thread order is preserved;
- stale epochs cannot commit;
- cancellation defeats late normal completion;
- duplicate dispatch cannot create another run or valid owner.

After a scheduler rule is proposed, check:

- the initial unfair model can repeatedly select `noisy` while `quiet` waits;
- the candidate rule eliminates that trace under explicit progress assumptions;
- fairness is placed only on environmental actions that may reasonably be
  assumed to progress, not on every per-run claim action.

Do not model 500 operations, real tokens, prices, provider latency, or production
limit values. Those need load, failure, and operational tests.

## Recommended revised architecture

```text
Native Thread Transport command
  -> authenticate Actor and resolve Account
  -> resolve idempotency key and immutable receipt
  -> admission transaction
       -> reserve Account, root-run, ResourcePool, and global obligations
       -> append accepted UserMessage ThreadEvent
       -> create pending AgentRun
       -> persist dispatch discoverability
  -> Account-level fair scheduler
       -> Thread ordering
       -> root-run allowance
       -> ResourcePool compatibility and capacity
  -> claim with owner, epoch, lease, and attempt
  -> execute without holding Thread transaction locks
  -> fenced authoritative commit
       -> output and ThreadEvent batch
       -> usage and effect receipts
       -> one terminal outcome
```

The reusable Osfo contract should define the types, state transitions,
invariants, and typed outcomes. Oz should select concrete initial policy, limits,
scheduler behavior, deployment topology, and observations.

## Required evidence before settlement

### Model evidence

- Small TLA+/TLC protocol model for D1, D2, D5, and D9.
- Scheduler extension after `Eligible`, `Dispatchable`, and Account selection are
  concrete.
- Deliberately verify that an unfair scheduler produces the expected quiet-run
  starvation trace before adding a fair candidate.

### Database and concurrency evidence

- Connection loss before, during, and after admission commit.
- Same-key identical and conflicting concurrent admission.
- Duplicate and missing dispatch signals plus reconciliation.
- Lease expiry, takeover, and both stale/new completion orders.
- Thread revision conflict without locks across provider calls.
- Cancellation racing claim, success, output completion, child admission, and
  worker loss.

### Capacity and overload evidence

- One noisy Account and one light Account.
- Many Accounts with heterogeneous resource needs.
- Root-run depth and descendant boundary tests.
- Durable backlog count, bytes, oldest age, outbox age, and retry storm.
- Reserved control-plane headroom during overload.
- Transient provider throttle versus permanent incompatibility.
- Slow SSE reader, reconnect storm, expired cursor, and full resynchronization.

### Implementation conformance

- Pure Rust transition model or reference state machine.
- Property and state-machine tests against the persistence implementation.
- Fault injection across commit, dispatch, claim, renewal, completion, and
  cancellation boundaries.
- Open-loop load tests that measure offered demand, including rejects and
  timeouts, rather than only completed throughput.

## What to keep, defer, and reopen

### Keep

- atomic visibility of accepted conversation state and durable work;
- acknowledgement after known durable commit;
- PostgreSQL-authoritative lifecycle state;
- at-least-once dispatch with fenced authoritative commits;
- per-Thread canonical commit order with cross-Thread concurrency;
- typed rejection before acceptance and no retroactive loss afterward;
- no universal weighted work unit;
- no exact queue position or ETA;
- explicit effect uncertainty after cancellation.

### Defer

- arbitrary tenant or quota-scope trees;
- a generic budget expression engine;
- a universal monetary or token unit;
- a specific external broker;
- a global fixed lifecycle deadline;
- exact production limit values;
- project-wide formal verification or TLAPS proofs.

### Reopen before specification approval

1. The typed Account, Actor, Thread, lineage, ResourcePool, and PolicyClass model.
2. Finite durable-backlog, root-subtree, depth, time, retry, and effect bounds.
3. Finite-run terminalization and intervention semantics.
4. Running cancellation, child propagation, and capacity-release semantics.
5. Eligibility and the Oz v1 Account-level scheduler rule.
6. The exact boundary between starvation resistance and quantitative
   noisy-neighbor isolation.

## Sources

Primary sources are linked next to each finding. The most central are:

- Leslie Lamport, [Safety, Liveness, and Fairness](https://lamport.org/tla/safety-liveness.pdf).
- Leslie Lamport, [A Science of Concurrent Programs](https://lamport.org/tla/science.pdf).
- Alpern and Schneider, [Defining Liveness](https://decomposition.al/CSE232-2020-10/readings/liveness.pdf).
- Newcombe et al., [How Amazon Web Services Uses Formal Methods](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf).
- Herlihy and Wing, [Linearizability](https://doi.org/10.1145/78969.78972).
- Burrows, [The Chubby Lock Service](https://research.google.com/archive/chubby-osdi06.pdf).
- Gray and Cheriton, [Leases](https://web.stanford.edu/class/cs240/readings/leases.pdf).
- Ghodsi et al., [Dominant Resource Fairness](https://people.eecs.berkeley.edu/~matei/papers/2011/nsdi_drf.pdf).
- Verma et al., [Borg](https://research.google.com/pubs/archive/43438.pdf).
- Google SRE, [Handling Overload](https://sre.google/sre-book/handling-overload/).
- Garcia-Molina and Salem, [SAGAS](https://www.cs.princeton.edu/techreports/1987/070.pdf).
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html),
  [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html), and
  [MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html).

## Final recommendation

Do not replace the current design with an agent SDK architecture. The strongest
comparables are schedulers, workflow engines, database job systems, operating
system controllers, messaging protocols, and formal-method literature because
ticket 5 is primarily about durable distributed work and scarce-resource
governance.

Keep the core direction, reopen the underspecified contracts, and use a small
TLA+/TLC model as one evidence layer. The priority is not learning TLA+ for its
own sake. The priority is making the state machine, resource axes, scheduler
assumptions, and user-visible failure outcomes precise enough that any tool can
check the claims.
