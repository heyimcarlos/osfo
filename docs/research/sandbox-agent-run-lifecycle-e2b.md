# E2B Sandbox and AgentRun Lifecycle

> **Status: superseded for Osfo v1.** V1 now uses one disposable E2B Sandbox
> per RunCode ToolCall: create, execute, export, commit, and kill. It does not
> persist SandboxRefs, connect, pause, resume, snapshot, or reuse workspaces.
> This note remains evidence for a later slice only if a concrete Oz journey
> proves that a workspace must survive a durable wait.

All sources were accessed on 2026-08-05. This note resolves one question for
[Define the Sandbox Provider and artifact-export contract](https://github.com/heyimcarlos/osfo/issues/54):
the exact v1 lifecycle ordering around Osfo's concrete E2B module.

## Accepted constraints

- One sandbox belongs to one AgentRun. Child AgentRuns receive their own
  sandboxes.
- PostgreSQL AgentRun records and claim epochs are authority. `SandboxRef` and
  all E2B state are disposable acceleration.
- Every authoritative commit validates the current claim epoch. Waiting runs
  have no active attempt or lease, and cancellation invalidates current
  execution authority
  ([AgentRun recovery contract](https://github.com/heyimcarlos/osfo/issues/12#issuecomment-5161404377)).
- Provider execution begins only after Osfo records its semantic intent. Claim
  loss stops execution, forces reconstruction under a new attempt, and makes
  late observations non-authoritative
  ([Agent Runtime contract](https://github.com/heyimcarlos/osfo/issues/43#issuecomment-5194875760)).
- Sandbox lifecycle, attempts, claims, and `SandboxRef` do not enter the Native
  Thread projection. Only normalized semantic outcomes and verified content do
  ([Thread projection contract](https://github.com/heyimcarlos/osfo/issues/52#issuecomment-5198388884)).

## Provider facts that constrain the design

E2B's useful lifecycle is deliberately small: create starts a running sandbox,
`pause()` preserves filesystem and memory by default, `connect()` accepts either
a running or paused sandbox and resumes the latter, and `kill()` permanently
deletes either state. Pause disconnects services and clients, which must
reconnect after resume
([persistence](https://e2b.dev/docs/sandbox/persistence)). The current API makes
`connect` the preferred resume operation, while the distinct resume endpoint is
deprecated
([OpenAPI at reviewed commit](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/spec/openapi.yml#L2569-L2722)).

E2B auto-resume is triggered by SDK file or command operations and tunneled HTTP
traffic, not by an Osfo AgentRun transition. A kill is the only documented way
to make a sandbox permanently non-resumable
([auto-resume](https://e2b.dev/docs/sandbox/auto-resume)). Osfo must therefore
configure `onTimeout: "pause"`, `autoResume: false`, and use explicit
`connect()` only after a new AgentRun claim. Provider timeout is a cost and
retention control, never an AgentRun timer.

Secure access authenticates SDK-to-controller traffic with an access token
returned by create, but E2B documents no operation that rotates or revokes that
token for one client or one attempt
([secured access](https://e2b.dev/docs/sandbox/secured-access)). Review of the
current SDK and OpenAPI found create, connect, pause, timeout, and kill, but no
claim token, compare-and-swap generation, client revocation, or per-attempt
fence
([SDK lifecycle source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/index.ts#L261-L385),
[API source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/sandboxApi.ts#L751-L1064)).
An old trusted worker can still hold an SDK object and team API credentials.
Pause is resource suspension, not authority revocation.

This matches Effective AI's useful ordering: first stop the agent loop, then
pause E2B, and on a durable completion event resume E2B before continuing. Its
durable wait and event delivery are runtime features around E2B, not E2B
features
([Effective AI runtime](https://effectiveailabs.com/blog/multi-agent-runtime)).
The OpenAI Agents SDK likewise separates reconnecting one backend session from
creating a replacement and hydrating it from durable workspace state
([client contract](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/sandbox/session/sandbox_client.py#L129-L174),
[E2B implementation](https://github.com/openai/openai-agents-python/blob/0068ce4329d0af7dd5398c3f300ab178c986495e/src/agents/extensions/sandbox/e2b/sandbox.py#L1767-L1818)).

## Use E2B lifecycle directly

Do not invent an `acquire` and `release` provider interface. The concrete module
uses the official SDK's `create`, `connect`, `pause`, and `kill` operations
directly. AgentRun orchestration invokes that module under the Osfo lifecycle
ledger and claim checks described below. E2B auto-resume remains disabled, and
snapshots remain deferred acceleration rather than a v1 recovery primitive.

`connect` may reuse a compatible SandboxRef after a confirmed cooperative
pause. Otherwise `create` uses the exact pinned template build and cold
reconstructs from authoritative inputs and committed ArtifactRefs. `pause`
follows a durable wait commit. `kill` follows supersession, cancellation, or
terminal completion.

Yield belongs to AgentRun: it durably declares a wait. Wake belongs to the
durable wake condition. Neither operation is caused by E2B.

## Durable control state

Persist an Osfo control ledger, not a mirror of E2B's running/paused state:

```text
none
  -> acquiring(g, claim_epoch, lifecycle_op_id)
  -> active(g, claim_epoch)
  -> releasing(g, lifecycle_op_id)
  -> retained(g)
  -> active(g, later_claim_epoch)

any non-retired generation
  -> superseded(g, cleanup_pending)
  -> retired(g)
```

`generation` is monotonic per AgentRun. `active` means only that a current
attempt may use that generation. `retained` means a pause was confirmed and a
later claimed attempt may connect to it. Neither asserts present provider state.
Every E2B module call and observation carries `(AgentRunId, generation, claim_epoch,
lifecycle_op_id or operation_attempt_id)`.

Only one lifecycle operation may be open for a generation. A result changes the
ledger only through compare-and-swap on its exact generation, operation ID, and
expected state. This prevents a late pause from suspending a sandbox after a
wake has begun.

## Exact ordering

### First create and cold reconstruction

1. Claim the AgentRun and durably allocate generation `g` plus a create intent.
2. Call E2B create with the exact profile and metadata containing the run,
   generation, and lifecycle operation identities. Do not dispatch workload yet.
3. Validate the returned sandbox, stage immutable inputs, and reconstruct only
   from authoritative records and ArtifactRefs.
4. Atomically activate the opaque ref only if the same claim epoch and
   generation remain current. If that check fails, enqueue the observed sandbox
   for kill and return no session.

E2B create exposes no idempotency key. An uncertain create therefore remains an
open lifecycle operation. Reconcile by its unique metadata. Before any workload
dispatch, adopt at most one matching sandbox and kill duplicates. If existence
cannot be established, supersede `g`, retain cleanup debt for any late match,
and allocate `g + 1`.

### Durable wait, pause, wake, and restore

1. Finish or quiesce the current semantic operation. Commit every result and
   verified artifact needed before the wait.
2. In one PostgreSQL transaction, commit `WaitDeclared`, move the AgentRun to
   waiting, end its claim, move generation `g` to `releasing`, and enqueue
   an E2B pause operation.
3. Only after that commit may the E2B module call `pause()`.
4. A confirmed pause moves `g` to `retained`. An uncertain pause quarantines
   `g`; it is never reattached to a later attempt.
5. The wake condition atomically resolves the wait and makes the AgentRun
   pending. A worker then claims it. Provider activity never wakes the run.
6. Connect waits for any earlier pause operation to settle. If `g` is
   retained, call `connect()`, validate compatibility, and activate it under the
   new claim. Missing, incompatible, or uncertain connect causes `g` to be
   superseded and cold reconstruction into `g + 1`.

This ordering handles a wake racing pause: connect cannot overtake the recorded
pause. It either follows confirmed pause or replaces the generation.

### Claim takeover and stale-attempt fencing

A cooperative wait handoff may reuse its confirmed retained generation. Lease
expiry, process loss, or any other takeover with possible overlap may not.

The takeover transaction advances the AgentRun claim epoch, supersedes the old
generation, creates cleanup debt, and allocates a new generation. The new
attempt cancels old client work, revokes Osfo-issued short-lived workload
credentials, best-effort kills the old E2B sandbox, and cold-reconstructs into
the new generation. It never connects to the old sandbox. The old sandbox may
still run while kill is uncertain, but it cannot contaminate the new sandbox or
commit through the old claim epoch.

Database claim checks are the authoritative fence. E2B supplies no
provider-level fence, so safe same-ID reuse is limited to cooperative, confirmed
release with no possible concurrent attempt. This is a non-Byzantine worker
contract, not protection from a compromised worker holding the team API key.

### Cancellation, terminal cleanup, and late observations

Cancellation first commits the winning AgentRun cancellation, invalidates the
claim, supersedes its generation, and creates cleanup debt. Afterward the E2B
module interrupts commands, revokes workload credentials, and calls kill. A
timeout or transport error from kill is `cleanup_pending`, not proof of
deletion. Retry until kill succeeds or E2B reports missing. AgentRun terminality
does not wait for cleanup.

For success or failure, export declared files before their semantic outcome:
bounded E2B read, Osfo-owned storage upload, digest and length verification,
immutable ArtifactRef commit under the current claim, then outcome and AgentRun
terminal commitment. That terminal transaction supersedes the generation and
enqueues destroy. A sandbox path or late export never becomes authority.

Execution or export uncertainty remains on the committed logical operation,
not on the sandbox lifecycle. A provider observation may commit semantic state
only while its claim epoch, generation, and operation attempt are current. A
late observation from a superseded generation is telemetry only. The sole
exception is a matching late lifecycle result that may advance its own cleanup
record to `retired`; it can never reactivate a generation, settle an operation,
or reopen an AgentRun.

## Recommendation to put to the user

Use E2B `create`, `connect`, `pause`, and `kill` directly through one concrete
module, with no provider interface in v1. Disable E2B auto-resume. Reuse one
sandbox identity only after a durable AgentRun wait and confirmed cooperative
pause; every lease takeover, uncertain overlap, missing ref, or incompatible
ref creates a new monotonic generation and cold reconstructs. PostgreSQL claim
epochs fence authority because E2B has no per-attempt revocation primitive.

```text
durable claim -> E2B module create/connect -> execute
                                           |
                         commit wait ------+
                              |
                              v
                         E2B module pause
                              |
durable wake -> new claim -> E2B module connect

takeover/cancel/terminal -> supersede generation -> E2B module kill
                                      `-> new generation when work continues
```
