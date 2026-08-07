# Osfo v1 architecture and Oz reference journey

Status: implementation baseline, production qualification incomplete

Source map: GitHub issue #1

Architecture ticket: GitHub issue #55

## Purpose

Osfo v1 is a reusable semantic foundation for building reliable agent systems.
Oz is the first long-lived Reference Agent Application built from Osfo. Oz
selects policies, execution profiles, Model Adapters, tools, workflows,
transport configuration, and deployment inputs without making those choices
part of Osfo's reusable domain.

The v1 destination is a fully working Oz application deployed on the approved
production topology. A successful development demonstration is useful evidence,
but it is not the product boundary and does not qualify production.

This specification freezes the contracts implementation tickets must preserve.
It reconciles the selected StreamingPull delivery seam, the approved `us-east4`
GCP structure, and the operator-owned database administration boundary. Numeric
production values remain candidates until their required evidence passes.

## Architectural thesis

Osfo separates five kinds of authority:

1. The Agent Application selects product policy and concrete Adapters.
2. The Agent Runtime proposes one semantic next step without performing it.
3. The durable AgentRun driver records intent, owns retries and uncertainty,
   and authorizes executors under a current fence.
4. Concrete executors translate committed operations into external protocols.
5. PostgreSQL owns canonical Thread and AgentRun truth.

The central execution loop is:

```text
recorded AgentRun state
  -> Agent Runtime proposes one typed next step
  -> durable driver validates the current fence
  -> PostgreSQL commits operation intent
  -> selected executor performs the committed operation
  -> PostgreSQL commits normalized observations and outcome
  -> Agent Runtime receives reconstructed recorded state
```

No model SDK, tool library, workflow engine, transport connection, worker
process, or in-memory agent object may become recovery authority.

## Product and module boundary

### Osfo owns

- closed, versioned ThreadEvent and ThreadSnapshot semantics;
- deterministic projection and conformance fixtures;
- Acceptance Receipts, idempotent command semantics, and cursor contracts;
- AgentRun lifecycle, claims, leases, epochs, cancellation, and recovery;
- the authority-free Agent Runtime proposal protocol;
- ModelCall, ToolCall, Action, Child AgentRun, ChildJoin, WorkflowInstance, and
  RunCode semantic lifecycles as their vertical slices enter v1;
- executor interfaces and normalized outcomes;
- durable ordering, uncertainty, retry, and fencing policy;
- reusable Native Thread Transport server and client behavior;
- conformance kits for every public seam.

### An Agent Application owns

- concrete Execution Profiles and their compatibility policy;
- selected Model Adapters and provider bindings;
- prompts, tool definitions, Action policy, and authorization;
- workflow definitions and completion policy;
- credentials and secret references;
- product authentication and Principal mapping;
- deployment configuration and resource candidates;
- product UI and any future Messaging Adapters.

### Oz owns

Oz is the initial Agent Application. Oz composes the standard Osfo Agent
Runtime, Native Thread Transport, PostgreSQL repositories, the selected
delivery processes, and its concrete Adapter set. OpenRouter may be the selected
Model Adapter for one Oz Execution Profile. It is not the Osfo model layer and
must remain replaceable through the same Osfo-owned executor contract.

The deterministic ModelCall executor is a conformance and fault-injection
fixture. It is not the deployed Oz default and cannot qualify a live provider.

## Deep modules and dependency direction

The initial reusable package graph is:

```text
@osfo/session
  canonical client-safe schemas, constructors, folds, fixtures

@osfo/agent-runtime
  recorded-state input and typed next-step proposals

@osfo/agent-run
  durable lifecycle ports, fences, drivers, executor interfaces
      -> depends on @osfo/agent-runtime

@osfo/api
  Native Thread Transport schemas, client, handlers, domain ports
      -> depends on @osfo/session

@osfo/db
  Drizzle schema and migrations, PostgreSQL connections, repositories
      -> implements ports exposed by session, API, and AgentRun modules

@osfo/ui
  reusable React DOM components and browser utilities

apps/ingress
  Oz transport and web composition root

apps/outbox-relay
  confirmed-publication composition root

apps/agent-run-worker
  Oz AgentRun driver, Runtime, and Model Adapter composition root

apps/web
  Oz browser client
```

Dependencies point from application composition roots toward public package
exports. Reusable packages do not import application code. Cross-package
relative imports are prohibited. Generic `core`, `common`, `shared`, `types`,
`config`, and `utils` packages are prohibited.

A new package is earned only when it hides substantial behavior behind a small
interface, serves multiple consumers, protects a security or deployment
authority, supports demonstrated provider variation, or needs independent
release and conformance. One hypothetical future implementation does not earn
an abstraction. Two concrete implementations make a seam real.

Large composition files must be decomposed along these authority boundaries,
not by moving unrelated helpers into shallow files. Public interfaces are the
primary test surfaces.

## Agent Runtime contract

The Agent Runtime accepts a derived, recorded view of one AgentRun and proposes
exactly one typed next step. It performs no I/O and has no repository,
credential, provider, tool executor, clock, scheduler, or transport authority.

The standard v1 proposal set grows through permanent vertical slices:

- start or continue one ModelCall;
- start or settle one stable ToolCall batch;
- start a Child AgentRun set and wait on one ChildJoin;
- start or await one WorkflowInstance;
- enter a declared durable wait;
- succeed or fail the AgentRun.

The Runtime never calls an executor. The driver records each logical operation
before execution and supplies only committed outcomes through reconstructed
state. Provider tokens and private executor attempts are not Runtime state.

General routing languages, speculative planning graphs, private runtime
checkpoints, and implicit recursive agents are outside v1. They may be added
only after evidence shows the standard proposal algebra is insufficient.

## Model Adapter contract

`ModelCallExecutor` is the Osfo-owned seam. A Model Adapter:

- accepts one committed ModelCallAttempt;
- sends exactly the protocol operation permitted by the pinned Execution
  Profile;
- disables hidden SDK logical-request retries;
- exposes confirmed, not-dispatched, or uncertain dispatch evidence;
- emits bounded normalized observations;
- reports normalized terminal outcome and Reported, Estimated, or Unknown
  usage;
- implements bounded cancellation and termination behavior;
- prevents provider payloads, credentials, hidden reasoning text, and provider
  types from entering canonical Thread or AgentRun state.

Osfo owns attempt identity, deadlines, retry budgets, backoff, uncertainty, and
whether another attempt is legal. Dispatch uncertainty never silently selects
another provider. An Agent Application selects one immutable model binding in
each Execution Profile. V1 has no general fallback router.

Every production Model Adapter requires a provider-independent conformance
suite and a focused live-provider qualification. A deterministic executor
passes the reusable conformance suite but supplies no live-provider evidence.

## Tool, Action, workflow, and sandbox boundaries

A ToolCall is one durable logical operation with stable identity and one final
semantic outcome. Complete parallel batch membership is recorded before any
member executes. Private attempts do not create duplicate conversational facts.

An Action is an effectful ToolCall with the same identity. Application policy
has precedence over Runtime-requested approval. The exact intent, immutable
presentation, success boundary, approval decision, and fenced attempt are
recorded before external contact. An unknown external outcome is never retried
blindly. Its ActionReceipt reports applied, not applied, or unresolved.

Independently durable work is a WorkflowInstance. Temporal owns workflow
execution history. Osfo owns identity, start intent, correlation, typed outcome,
and canonical promotion. Temporal cannot write AgentRun state or ThreadEvents
directly. TypeScript workflow definitions use only deterministic Temporal SDK
primitives and must pass stored-history replay before deployment.

RunCode is a bounded Python-first ToolCall using E2B directly in v1. Each
attempt uses a fresh disposable sandbox with deny-all network egress, no public
ingress, no workload credentials, no runtime package installation, supervised
process execution, explicit bounded export, digest and length verification,
and mandatory destruction. E2B identifiers, paths, and signed URLs never cross
the Osfo boundary.

## Canonical Thread and Native Thread Transport

PostgreSQL retains complete immutable canonical Thread history and receipts for
live v1 Threads. ThreadPosition defines order. ThreadCursor is an opaque replay
coordinate and never a history pagination token.

The Native Thread Transport provides:

- authenticated HTTP commands with stable idempotency keys;
- immutable Acceptance Receipts;
- a bounded complete ThreadSnapshot;
- finite keyset-paginated canonical history;
- cursor-based SSE replay followed by a fixed replay-to-live cut.

The protocol is closed and versioned. Unsupported fields, versions, event
families, gaps, and conflicting identities fail closed. Unknown and unauthorized
resources use indistinguishable typed not-found behavior. Identifiers are never
credentials.

Each browser tab or device owns a separate crash-consistent cursor and local
projection. It advances the cursor only with application of the corresponding
event. Slow and disconnected clients have bounded buffers and cannot hold
canonical progress or command-admission capacity.

The Osfo API is the default direct client boundary. It is not a Messaging
Adapter. Future Messaging Adapters translate external protocols through
explicit `(AdapterId, ConversationKey) -> ThreadId` bindings without owning the
Thread.

## Durable admission and AgentRun delivery

One PostgreSQL transaction commits:

- the Acceptance Receipt;
- canonical input facts and Thread positions;
- AgentRuns and bounded capacity reservations;
- one append-oriented outbox obligation per AgentRun.

Direct PostgreSQL and Pub/Sub dual-write is prohibited. Caller retry is not a
durable reconciliation mechanism.

The selected delivery flow is:

```text
authenticated command
  -> PostgreSQL admission transaction
  -> fixed-one confirmed-publication relay
  -> Pub/Sub topic and one ordered pull subscription
  -> fixed StreamingPull AgentRun worker fleet
  -> point-addressed PostgreSQL claim with finite lease and monotonic epoch
  -> fenced AgentRun execution and authoritative outcome
  -> Pub/Sub acknowledgement after durable terminal result or durable no-op
```

The relay uses PostgreSQL `LISTEN/NOTIFY` only as a wake hint and retains a
one-second safety drain. One Principal-first selector creates bounded durable
publication ownership. Four recoverable publishers are the current selected
structure. PostgreSQL remains publication and lifecycle authority.

Pub/Sub ordering does not replace PostgreSQL per-Thread sequencing. Duplicate,
out-of-order, and redelivered identities are expected. Workers point-claim
authority and never scan PostgreSQL for runnable work. Every authoritative
write checks the active fence. Lease loss requires reconstruction under a new
attempt and prevents stale commits.

The current deployment candidate uses one ordered subscription, six fixed
workers, four streams per worker, 32 execution slots per worker, and a maximum
database pool of eight per worker. These are reviewed qualification inputs, not
production-qualified promises. Metric-driven worker autoscaling remains absent.

## PostgreSQL and database administration boundary

`packages/db` owns Drizzle schema, reviewed generated SQL migrations,
connection logic, repositories, and integration-test support. Production never
uses schema synchronization. It applies only reviewed generated SQL migrations
through `bun run db:migrate`.

Database administration is not an application and is not deployed as Cloud Run
Jobs. `apps/database-jobs` and the database bootstrap, migration, seed, and
reconciliation Cloud Run Jobs are not part of the architecture.

The deployment sequence is:

1. Terraform provisions Cloud SQL and non-secret infrastructure.
2. An operator establishes the approved private database connection.
3. `scripts/db/bootstrap-access.ts` grants one-time PostgreSQL IAM access.
4. `bun run db:migrate` applies reviewed generated SQL under the dedicated
   migration authority and advisory lock.
5. `scripts/db/seed-demo.ts` may create explicit development reference
   authority only. Production onboarding is a product flow, not a seed.
6. `scripts/db/check-readiness.ts` verifies the expected migration version.
7. Serving runtime is deployed or enabled.
8. `scripts/qualification/reconcile-agent-run.ts` runs separately as evidence,
   never as database administration or runtime authority.

Schema changes use expand-contract compatibility. Material migrations take a
recovery checkpoint. Code rollback is allowed only while schema-compatible.
Database repair is forward-only through corrective migrations.

## Deployment contract

Development and production run in separate GCP projects in `us-east4`.
Production Cloud SQL is regional HA. Development is zonal. V1 does not claim
cross-region continuity.

Cloud Run contains only product runtime processes:

- one public Native Thread Transport service behind an external HTTPS load
  balancer and Cloud Armor;
- one fixed relay worker pool;
- one fixed AgentRun StreamingPull worker pool;
- a separate Temporal worker pool when WorkflowInstances enter v1;
- later product runtime processes only when a deep operational boundary earns
  them.

Only the load balancer is public. Application authentication is mandatory.
Cloud SQL uses private connectivity and IAM database authentication. Each
runtime role has a separate service account, database budget, secret access,
release responsibility, and failure boundary. Provider traffic uses controlled
egress. Default service accounts and service-account keys are prohibited.

Terraform uses exact versions and separate foundation, development platform,
development runtime, production platform, and production runtime roots. State
is separated and versioned in protected GCS buckets. Production uses a fresh
saved plan bound to source, image digests, inputs, tool versions, lock files,
and state lineage. Daily drift detection is read-only. Production destruction
is prohibited.

Images are immutable and deployed by digest. Production promotion uses the
same qualified digest, protected approval, provenance, SBOM, vulnerability
scanning, and Binary Authorization. Secret payloads never enter Terraform
state, saved plans, source, images, browser assets, logs, or evidence bundles.

## Oz reference journey

The highest acceptance boundary is:

> Submit commands through the Native Thread Transport, observe results through
> independently resumed clients, and reconcile all externally visible results
> against durable PostgreSQL authority.

The minimum complete deployed journey is:

1. Chrome tab A authenticates and submits one stable command.
2. Oz returns an Acceptance Receipt only after durable admission.
3. PostgreSQL contains the UserMessage, AgentRun, reservation, and outbox
   obligation atomically.
4. The relay publishes one minimal identity.
5. A worker claims under a finite lease and epoch.
6. The Osfo Runtime proposes a ModelCall.
7. The driver records its intent before the selected Oz Model Adapter runs.
8. Durable assistant fragments and the normalized outcome commit under the
   active fence before delivery.
9. Tabs A, B, and C replay and follow live delivery using independent cursors.
10. A disconnect, duplicate delivery, worker replacement, and deployment drain
    preserve one canonical outcome.
11. Every client projection reconciles with canonical PostgreSQL history.

Final reconciliation proves one receipt per accepted operation, one expected
AgentRun per accepted message, complete ThreadPositions, no stale commits, no
duplicate terminal outcomes, no ghost work, no unfinished attempts, converged
client projections, and returned capacity accounting.

## Testing and evidence obligations

Every reusable capability must pass the applicable gates:

- semantic conformance through its public interface;
- real PostgreSQL integration for atomicity, ordering, claims, fencing, and
  reconstruction;
- deterministic fault cuts before and after every durable or external boundary;
- security and secret-exposure checks;
- production-shaped load and retained-corpus behavior;
- deployed browser and operational verification;
- exact final authority reconciliation.

Tests use Effect Vitest. In-memory storage does not certify PostgreSQL behavior.
Model tests combine deterministic conformance with focused live-provider
qualification. Temporal tests include stored-history replay and intentional
nondeterminism controls. User-visible web changes require a production build and
browser inspection in the development instance.

Evidence reports every required gate as PASS, FAIL, or MISSING. A higher-level
pass cannot compensate for a lower-level correctness failure. Historical,
prototype, local, development, and contextual evidence retains its real scope
and can never promote production qualification.

## Production workload and gates

The Production Workload Envelope is 232 incoming messages per second sustained.
The 464 incoming-message per second lane characterizes stress and safe overload.
Capacity is evaluated through Good Root Outcomes, Good Root Outcome Ratio,
Goodput, admission availability, First Meaningful ThreadEvent, resume and live
delivery freshness, durable wake freshness, bounded overload, automatic
recovery, resource limits, and complete cost.

Production correctness has zero tolerance for lost or ghost AgentRuns, stale
commits, duplicate terminal outcomes, ordering gaps, unfinished attempts, or
capacity-accounting mismatch.

The latest `us-east4` A/B/C/D matrix reconciled accepted work exactly but failed
complete admission and the one-second receipt gate in every cell. Retained
history amplification is supported. WAL tuning reduced checkpoint pressure but
did not qualify admission. Therefore:

| Gate                                           | Current status             | Owner            |
| ---------------------------------------------- | -------------------------- | ---------------- |
| Selected StreamingPull seam                    | PASS as architecture       | #87 and ADR 0001 |
| Fixed six-worker candidate                     | PASS as measured candidate | #87              |
| `us-east4` target admission                    | FAIL                       | #79              |
| Current healthy ceiling                        | MISSING                    | #79              |
| Current breaking point                         | MISSING                    | #79              |
| 400,000-AgentRun outage reserve and full drain | MISSING                    | #80              |
| Retained corpora and complete cost             | MISSING                    | #81              |
| Protected production promotion                 | MISSING                    | #92              |
| Complete deployed Oz composition               | MISSING                    | #78              |
| Production acceptance                          | MISSING                    | #76              |

No runtime, dashboard, demo, or historical result may convert these statuses to
PASS without the owned qualification.

## Implementation order

Implementation continues as dependency-ordered permanent vertical slices:

1. Reconcile this specification and package boundaries.
2. Repair target admission scaling against exact retained history.
3. Complete the bounded ToolCall integration without provider-specific durable
   types.
4. Complete Action external-effect integration and uncertainty recovery.
5. Add Child AgentRuns and ChildJoin.
6. Add awaited and detached WorkflowInstances behind Temporal interfaces.
7. Add RunCode and immutable artifacts.
8. Add snapshots and context compaction without changing canonical authority.
9. Qualify target, overload, recovery, retained corpora, cost, and SSE.
10. Deploy the complete Oz composition, exercise the Reference Journey, and
    promote the same qualified digest through the protected production path.

Independent tickets may run concurrently only when they do not edit the same
authority boundary or depend on unsettled output. Each PR remains focused,
reviewed for specification fit and standards, verified proportionately, and
merged before its dependants are unblocked.

## Demo shortcut disposition

Demo work is not reverted wholesale. Each shortcut receives one explicit
disposition:

- retain reusable durable semantics, conformance tests, development deployment,
  and honest evidence tooling;
- migrate development-only bootstrap and seed behavior behind explicit
  environment authority;
- replace access-code session minting with the real Oz authentication and
  onboarding flow before removing it;
- keep demo evidence as historical development evidence, never product truth;
- remove manual secrets, fixed demo bindings, and demo-only UI only after their
  production replacement is deployed and verified;
- preserve unfinished worktrees until their changes are either migrated into a
  reviewed ticket or explicitly discarded.

Rollback means replacing temporary authority with the correct owner. It never
means deleting a working safety boundary before its replacement exists.

## Deferred scope

The following are outside Osfo v1 unless a production blocker proves otherwise:

- Telegram, WhatsApp, SMS, iMessage, and OpenAI-compatible Adapters;
- cross-Adapter Thread browsing and automatic account merging;
- universal provider fallback routing;
- custom workflow or sandbox infrastructure;
- persistent interactive sandboxes;
- speculative recursive-agent frameworks;
- multi-region continuity promises;
- Oz billing, entitlements, and broad productization beyond the deployed
  reference journey.

These exclusions do not weaken the requirement that Oz v1 be a fully working,
secure, deployed application.
