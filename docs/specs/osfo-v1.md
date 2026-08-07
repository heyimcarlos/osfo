# Osfo v1 architecture and Oz reference journey

Status: architecture synthesis for review, production qualification incomplete

Authority precedence:

1. [`CONTEXT.md`](../../CONTEXT.md) owns product language and domain truth.
2. [`docs/adr/`](../adr/) owns accepted durable architecture decisions.
3. GitHub issues own active work, evidence status, and gate ownership.
4. This document connects those authorities into one implementation journey.

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

This specification is a navigable synthesis of contracts implementation
tickets must preserve. If it conflicts with the authorities above, those
sources win and issue #55 must reconcile this document. It connects the selected
StreamingPull delivery seam, the approved `us-east4` GCP structure, and the
operator-owned database administration boundary. Numeric production values
remain candidates until their required evidence passes.

## Architectural thesis

Osfo separates five kinds of authority:

1. The Agent Application selects product policy and concrete Adapters.
2. The Agent Runtime proposes one semantic next step without performing it.
3. The durable AgentRun driver records intent, owns retries and uncertainty,
   and authorizes executors under a current fence.
4. Concrete executors translate committed operations into external protocols.
5. PostgreSQL owns canonical Thread and AgentRun truth.

ADR 0002 owns this separation. The central execution loop is:

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

### Oz authentication and single-Thread bootstrap

Authentication lifecycle is an Oz product boundary, not part of the Native
Thread Transport. Oz v1 uses one configured OpenID Connect issuer with
Authorization Code and PKCE. The browser never receives an Osfo bearer for
manual copying. After the external identity response is validated against the
pinned issuer, audience, redirect URI, nonce, and PKCE verifier, Oz performs one
transaction that:

- resolves `(issuer, subject)` to one immutable Principal;
- creates the Principal on first login when product policy permits;
- creates exactly one canonical Thread for a new Principal or returns the
  existing Thread;
- creates one independently revocable Authentication Session;
- stores only a hash of the opaque Osfo session credential;
- returns the established ThreadId, the bounded session expiry, and the opaque
  Osfo bearer exactly once.

The product bootstrap surface is separate from the four Osfo transport routes:

```text
POST   /v1/oz/session/exchange
GET    /v1/oz/bootstrap
DELETE /v1/oz/session
```

The exchange response is `Cache-Control: private, no-store`. The browser keeps
the Osfo bearer in memory only and supplies the required `Authorization` header;
it does not display it as a configuration value or persist it in local or
session storage. External tokens, authorization codes, session credentials, and
raw identity claims never enter URLs, logs, Terraform, canonical ThreadEvents,
or evidence. Logout revokes the current Authentication Session. A page reload
or another device performs a new OIDC exchange, resolves the same Principal and
Thread, and receives a separate Authentication Session and cursor state.

The current development access-code bootstrap remains available only until this
flow is deployed and browser-proven. It is then removed from application code,
runtime configuration, and Secret Manager under a focused cleanup ticket.

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

The Native Thread Transport exposes exactly four resource endpoints:

```text
POST /v1/threads/{thread_id}/messages
POST /v1/agent-runs/{agent_run_id}/cancel
GET  /v1/threads/{thread_id}/snapshot
GET  /v1/threads/{thread_id}/events
```

It does not create, list, discover, share, transfer, or delete Threads. Oz
bootstrap supplies the authorized established ThreadId. Each endpoint resolves
the current Authentication Session and Principal. Unknown and unauthorized
resources return indistinguishable `404` responses.

The protocol provides:

- authenticated HTTP commands with stable idempotency keys;
- immutable Acceptance Receipts;
- a bounded complete ThreadSnapshot;
- finite keyset-paginated canonical history;
- cursor-based SSE replay followed by a fixed replay-to-live cut.

Message and cancellation admission require `Idempotency-Key`. An identical
retry returns the original immutable receipt even during overload. Conflicting
reuse returns `409 idempotency_conflict`. A transaction whose commit remains
uncertain after reconciliation returns `503 commit_outcome_unknown` and can be
retried only as the exact same stable operation.

Message input is a closed JSON object containing one ordered, non-empty
`content` array. Text is the only v1 block type. The server preserves decoded
text and block order exactly and rejects unknown fields, empty text, unsupported
blocks, invalid Unicode, and oversized input. The request contains no role,
model, provider options, arbitrary metadata, cursor, or client timestamp.
Cancellation accepts no body and records `user_requested`. Its immutable receipt
means the cancellation request won, not that physical cleanup completed.

A message Acceptance Receipt identifies the receipt, Thread, UserMessage,
UserMessageAppended event and position, AgentRun, and acceptance time. It never
contains a ThreadCursor because HTTP receipt does not prove client application.
Receipt replay returns the same body and may add `Idempotency-Replayed: true`.

`GET /events` uses `Accept: application/json` for finite position-paginated
history and `Accept: text/event-stream` for cursor replay and live delivery.
History freezes one `through_position` across every page. SSE requires the last
successfully applied cursor and performs this cut:

```text
validate retained cursor A
  -> capture committed head C
  -> offer every event where A < position <= C
  -> caught_up(C)
  -> offer committed events after C as live delivery
```

Malformed, foreign-Thread, or future cursors return `400 invalid_cursor`. A
cursor outside retention returns `410 cursor_outside_retention` and requires a
fresh snapshot. Lost notification, replica replacement, and stream reconnect
reconcile from canonical PostgreSQL position. A server closes instead of
dropping, merging, or reordering an event.

Typed errors use `application/problem+json` with stable status, Osfo code, and
retry semantics. The closed error set distinguishes invalid requests and
cursors, authentication, indistinguishable not-found, representation and media
type errors, idempotency conflict, terminal AgentRun cancellation, retention,
payload bounds, overload, uncertain commit, snapshot unavailability, and
sanitized internal failure. Retryable `429` and `503` responses provide bounded
guidance and create no Acceptance Receipt before durable acceptance.

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
one-second safety drain. One fixed relay process runs one Principal-first
selector and four recoverable publisher fibers. The selector creates bounded
durable publication ownership. PostgreSQL remains publication and lifecycle
authority.

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

The GCP boundary uses three projects: `osfo-foundation`, `osfo-development`, and
`osfo-production`. Development and production run in `us-east4`, colocated with
Temporal Cloud `gcp-us-east4` through same-region Private Service Connect.
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

ThreadEvent live delivery uses PostgreSQL authority plus `LISTEN/NOTIFY` wake
hints to transport replicas. It does not use Pub/Sub. Each transport instance
holds one dedicated listener connection. SSE buffers, connection count, memory,
and database use are bounded so streams cannot consume the capacity reserved for
command admission. Lost hints are repaired by durable position checks.

Terraform uses exact versions and three one-way ownership layers:

```text
foundation -> platform -> runtime
```

There are no reverse dependencies and no `terraform_remote_state`. Foundation,
development, and production use separate protected, versioned GCS state buckets
with native locking and GitHub concurrency. Development and production each
have independent platform and runtime roots. Production uses a fresh saved plan
bound to source, image digests, inputs, tool versions, lock files, and state
lineage. Daily drift detection is read-only. Production destruction is
prohibited.

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

## Production workload and qualification ownership

The Production Workload Envelope is 232 incoming messages per second sustained.
The 464 incoming-message per second lane characterizes stress and safe overload.
Capacity is evaluated through Good Root Outcomes, Good Root Outcome Ratio,
Goodput, admission availability, First Meaningful ThreadEvent, resume and live
delivery freshness, durable wake freshness, bounded overload, automatic
recovery, resource limits, and complete cost.

Production correctness has zero tolerance for lost or ghost AgentRuns, stale
commits, duplicate terminal outcomes, ordering gaps, unfinished attempts, or
capacity-accounting mismatch.

ADR 0001 owns the selected transactional-outbox and StreamingPull architecture.
Architecture selection is not production qualification. GitHub owns the live
status of each evidence gate:

| Required evidence                                                | Live owner |
| ---------------------------------------------------------------- | ---------- |
| `us-east4` target admission, healthy ceiling, and breaking point | #79        |
| 400,000-AgentRun outage reserve and full drain                   | #80        |
| Retained corpora and complete cost                               | #81        |
| Complete deployed Oz composition                                 | #78        |
| Protected production promotion                                   | #92        |
| Final production acceptance                                      | #76        |

At review time, the complete production result is not PASS. Implementers must
read the linked issues for current PASS, FAIL, or MISSING evidence rather than
copying a status from this synthesis. No runtime, dashboard, demonstration, or
historical result may promote production without the owned qualification.

## Implementation ticket graph

Settled feature slices and production qualification are parallel lanes.
Qualification failures block production approval, not unrelated semantic
implementation. A ticket may run concurrently only when it does not edit the
same authority boundary or depend on unsettled output.

```text
#55 architecture synthesis
  -> #147 Oz OIDC login and single-Thread bootstrap
  -> #67 bounded ToolCalls
       -> #68 external Actions
       -> #69 Child AgentRuns and ChildJoin
       -> #70 awaited WorkflowInstances
            -> #71 detached WorkflowInstances
            -> #72 RunCode and artifacts
  -> #73 snapshots and hot replay
       -> #74 context compaction

#79 target and overload qualification
#80 recovery and teardown qualification
#81 retained corpora and complete cost
#100 deployed SSE qualification
  -> #76 production acceptance

feature slices + qualification prerequisites
  -> #78 complete deployed Oz composition
  -> #91 Workflow and RunCode deployment
  -> #92 protected production promotion
```

The live GitHub dependency edges and issue state are authoritative. This graph
records intended direction, not current completion. Before production approval,
#76 must reconcile the complete composed journey, and #92 must promote the same
qualified digest through the protected path.

Each PR remains focused, reviewed for specification fit and standards, verified
proportionately, and merged before its actual dependants are unblocked. A
production load failure creates or updates a qualification or capacity ticket;
it does not silently weaken a semantic contract.

## Development-only mechanisms

Development bootstrap, reference seeds, qualification controls, and evidence
presentation remain explicitly development-only. They cannot enter production
composition or qualify production. A temporary mechanism is removed only after
its product replacement is deployed and verified, so rollback never deletes a
working safety boundary before the correct owner exists.

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
