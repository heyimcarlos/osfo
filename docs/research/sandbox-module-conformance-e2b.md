# E2B Sandbox Module and Conformance Contract

All sources were accessed on 2026-08-05. This note resolves the final module
and verification question for [Define the Sandbox Provider and artifact-export
contract](https://github.com/heyimcarlos/osfo/issues/54). It assumes the
accepted disposable E2B RunCode ToolCall, resource profile, security and
artifact contracts, and four-case private failure policy.

## Decision

Keep the implementation as one **internal deep module** in
`apps/oz-agent-worker`, behind the ToolCall dispatcher. Do not publish an
`@osfo/sandbox` package, define `SandboxProvider`, or build a fake provider.
The official `e2b@2.38.0` SDK and exact template build are the only production
implementation.

The module earns an internal seam because deleting it would spread input
staging, the fixed helper protocol, E2B error normalization, race-safe export,
object finalization, cancellation, cleanup debt, and orphan reconciliation
through the ToolCall executor. A provider-neutral interface fails the deletion
test: deleting it removes forwarding types and configuration, while no second
caller or implementation has to recover shared behavior. This follows the
Oz-first extraction rule in [the accepted vertical-slice
strategy](https://github.com/heyimcarlos/osfo/issues/40#issuecomment-5186858593)
and its TypeScript, Effect 4, Node 24 package policy in [the runtime
decision](https://github.com/heyimcarlos/osfo/issues/41#issuecomment-5191627546).

```text
AgentRun driver
  owns claim, cancellation, retry budget, durable ToolCall intent
        |
        v
ToolCall dispatcher
        |
        v
internal executeRunCodeToolCall(attempt)
  E2B create -> stage -> bounded helper -> select/freeze/export
  -> fenced outcome commit -> kill
        |                         |
        v                         v
official E2B SDK          content + ToolCall authority modules
```

## Small caller-facing interface

The internal module exports one operation, plus its request, committed result,
and already-accepted private failure value:

```ts
executeRunCodeToolCall(
  attempt: ClaimedSandboxToolCallAttempt
): Effect.Effect<
  CommittedToolCallOutcome,
  SandboxAttemptFailureV1,
  ClientContentStore | ToolCallOutcomeCommit
>
```

`ClaimedSandboxToolCallAttempt` contains the already-durable ToolCall identity,
private attempt identity, AgentRun claim epoch, exact Python source, ordered
logically named immutable content inputs, the accepted fixed profile identity,
and bounded export capability. It does not contain an E2B command, provider
path, environment variable, timeout override, network override, credential, or
provider identifier.

`CommittedToolCallOutcome` means the one visibility transaction has already
revalidated the claim and attempt, made verified content ready, stored ordered
`ArtifactRefV1` values, and committed the existing ToolCall outcome and
ThreadEvent. The module must not return an uncommitted success for its caller to
assemble. `ToolCallOutcomeCommit` retains PostgreSQL authority; the sandbox
module invokes it but cannot weaken its fence or choose AgentRun state.

The interface hides E2B classes, sandbox IDs, metadata syntax, shell strings,
PIDs, helper status, filesystem paths, request tokens, retry headers, metrics,
object staging generations, cleanup debt, and the exact way a regular file is
frozen. It also hides pause, resume, connect, snapshots, workspaces, PTYs,
background jobs, package installation, and public URLs because v1 does not
offer them.

### Ownership

- The AgentRun driver owns claim validity, cancellation ordering, operation
  retry budget, and whether another ToolCall attempt may begin. Late module
  observations have no authority.
- The ToolCall executor owns dispatch by the committed operation type and maps
  an exhausted private result into the existing public ToolCall failure union.
- The internal E2B module owns the fixed profile validation, disposable
  lifecycle, staging, helper protocol, phase-aware E2B normalization, dynamic
  export selection, race-safe snapshot request, streaming verification, and
  cleanup scheduling.
- The Client Content module owns immutable byte identity, object-store
  finalization, authorization, retrieval integrity, and `ClientContentRefV1`.
- The AgentRun or ToolCall persistence module owns the fenced visibility
  transaction. E2B state never becomes recovery authority.
- A separate private reconciler uses the same E2B SDK functions to retire
  durable cleanup debt and metadata-discovered orphans. It never adopts a
  sandbox for execution.

This preserves the accepted AgentRun and Runtime rules: intent precedes
external dispatch, every semantic commit is claim-fenced, and provider state
does not own recovery ([AgentRun recovery](https://github.com/heyimcarlos/osfo/issues/12#issuecomment-5161404377),
[Agent Runtime](https://github.com/heyimcarlos/osfo/issues/43#issuecomment-5194875760)).

## Internal E2B SDK seam

Construct the module with private E2B-specific function hooks whose production
values are direct references to `Sandbox.create`, `Sandbox.list`, static
`Sandbox.kill`, and the returned sandbox's `files`, `commands`, and `kill`
methods. Type these hooks with narrow `Pick` values from the exact SDK types and
keep them unexported. This is an internal test seam, not a provider interface.
Tests substitute structural E2B handles and streams, not a `SandboxProvider`
implementation.

This is consistent with primary comparable evidence:

- E2B's own live fixture creates a real sandbox with unique metadata and kills
  it in `finally`, while its SDK unit tests use request interception for abort
  and configuration behavior ([fixture](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/setup.ts#L70-L105),
  [abort tests](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/sandbox/abortSignal.test.ts)).
- E2B tests show that killing during an active command is observed as a
  `TimeoutError`, reinforcing phase-aware Osfo classification rather than
  treating SDK classes as domain truth ([live command-kill
  test](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/sandbox/commands/sandboxKilledDuringRun.test.ts)).
- OpenAI's E2B comparable replaces the E2B factory with fake SDK-shaped
  objects and independently varies command wait, file, kill, and create
  behavior in tests. It does not require another real provider to test E2B
  integration ([fake handles](https://github.com/openai/openai-agents-python/blob/0f4acc1cb9b8e36698ce0421fd3e6afa809aac3a/tests/extensions/sandbox/test_e2b.py#L224-L474),
  [factory replacement](https://github.com/openai/openai-agents-python/blob/0f4acc1cb9b8e36698ce0421fd3e6afa809aac3a/tests/extensions/sandbox/test_e2b.py#L1081-L1145)).
- OpenAI can justify a provider-neutral client because it has Docker, local,
  E2B, and several hosted implementations. Its sandbox feature is also beta.
  That is evidence for deferring, not copying, its public abstraction
  ([client matrix](https://openai.github.io/openai-agents-python/sandbox/clients/)).

## Deterministic verification

Use `@effect/vitest` on the exact Node 24 runtime with deterministic clocks,
randomness, interruption, and bounded streams. Tests call the module's one
operation. They replace only the internal E2B SDK hooks and use real
Client Content and ToolCall authority implementations where the behavior under
test belongs to PostgreSQL or object storage.

### Unit and property tests

- Assert the exact template build, ten-minute `onTimeout: "kill"`, explicit
  deny-by-default network policy, disabled public traffic, one opaque random
  cleanup nonce plus environment marker in metadata, fixed helper command,
  non-root user, closed stdin, fixed paths, and absence of workload
  credentials on every create and command. Metadata contains no Principal,
  Thread, AgentRun, or ToolCall identity.
- Generate arbitrary path components, Unicode, repeated selections, media
  declarations, file sizes, and stream chunk boundaries. Prove escape,
  symlink, non-regular, duplicate, count, and byte violations fail closed.
- Prove digest, length, media validation, and result are invariant under stream
  chunking. Truncation, extra bytes, corruption, and limit crossing expose no
  `ClientContentRefV1`.
- Generate interleavings of success, cancellation, claim loss, late terminal
  output, ambiguous commit, and retry. Prove at most one terminal ToolCall
  outcome, no stale commit, one ContentId per logical selection ordinal, no
  client reference to pending content, and no reuse across unrelated equal
  bytes.
- Verify the four private result cases and exact public mapping. Raw E2B
  exceptions, IDs, text, tokens, paths, metrics, and retry data never cross the
  module interface or enter ThreadEvents.
- Split staged immutable inputs into arbitrary upload chunks and prove the module's own
  AbortSignal, byte counter, and sandbox lifetime bound E2B's streamed
  `files.write`; the SDK provides no request timeout for that stream
  ([E2B write source](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/src/sandbox/filesystem/index.ts#L648-L744)).

### Fault injection manifest

Every external call and durable write gets the same three cut points:

```text
before dispatch
remote effect may have happened but response is lost
after observation, before the next durable transition
```

Apply them to profile validation, create, every input write, command start,
command wait, helper status, export selection commit, file freeze, file info,
each read-stream chunk, staging upload, immutable finalization, object metadata
verification, visibility transaction, sandbox kill, metadata list pagination,
and reconciler completion. Also inject stream stalls, duplicate and late
callbacks, cancellation at each phase, worker loss, process-group escape
attempts, and `kill` returning true, false, timeout, or transport failure.

The fault oracle is durable state, never whether a Promise rejected: an
accepted attempt is terminal or retry-ready, stale authority cannot commit,
ready content has exactly one verified immutable object generation, pending
content is invisible, and every possibly created sandbox is either confirmed
absent or represented by bounded cleanup debt.

## Production E2B certification

Certification runs against the exact production E2B project, SDK version, and
immutable template build. Its manifest records the Osfo revision, Node image
digest, `e2b` package and lockfile hash, E2B project and tier, template and
build ID, helper and Python dependency digests, profile values, network policy,
workload seed, UTC window, and teardown inventory.

The live corpus proves what mocks cannot:

- exact-build creation, SDK compatibility, cleanup-nonce discovery, idempotent
  kill, and confirmed absence;
- 2 vCPU and 1 GiB allocation, non-root execution, immutable input and program
  trees, 64-process/thread enforcement, bounded stdout and stderr, five-minute
  command deadline, descendant reaping, and ten-minute provider auto-kill;
- no outbound network, no usable public ingress, and no sandbox-visible
  control or workload credential;
- empty and dynamic ordered export selection, path escape, symlink, hard-link,
  source mutation, directory/device/FIFO rejection, oversized, truncated, and
  corrupt streams, plus missing or corrupt committed-object retrieval;
- cancellation and claim takeover during command and export, late observation
  rejection, create-response loss followed by metadata cleanup, kill
  uncertainty, and orphan reconciliation.

E2B metrics are retained for diagnosis but never substitute for an
enforcement test. E2B itself treats create, command, filesystem, timeout, and
kill behavior as live sandbox tests, so Osfo must certify its exact composed
profile rather than infer behavior from SDK unit tests ([E2B test
fixture](https://github.com/e2b-dev/E2B/blob/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/setup.ts),
[command tests](https://github.com/e2b-dev/E2B/tree/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/sandbox/commands),
[filesystem tests](https://github.com/e2b-dev/E2B/tree/998e560a1abb85f0e5d2c6346b5c033f81f17736/packages/js-sdk/tests/sandbox/files)).

## Workload and retained corpora

Do not choose a sandbox concurrency number in this ticket. Add the CSV journey
to the Reference Workload Trace and measure:

```text
s = sandbox ToolCalls per accepted incoming message
W = sandbox ToolCall service-time distribution
λs,target = 232 * s
λs,stress = 464 * s
observed mean in-flight = λs * mean(W)
```

Use open arrivals. Set the production concurrency and quota only after the
target, stress, ramp, and recovery lanes reveal queue age, Goodput knee,
provider rate limits, and the headroom required to drain. A missing `s`, task
size distribution, or `W` is **MISSING**, not permission to guess. Any material
change to the journey, helper, libraries, E2B latency, or retry amplification
requires remeasurement.

Run two separate but joined acceptance lanes:

1. A live E2B lane runs the exact journey distribution at the derived sandbox
   rate. The sustained target is three clean 30-minute repetitions and stress
   is three 15-minute repetitions, with the accepted ramp and recovery lanes.
   This proves provider quota, latency, Good Root Outcomes, bounded resources,
   safe overload, and recovery. It is not part of database-only capacity
   measurement.
2. A persistence lane uses deterministic mocked E2B streams through the same
   module interface, with real PostgreSQL and the selected production object
   store behavior. It proves claim fencing, content identity, immutable object
   finalization, visibility, retrieval, cleanup debt, and reconciliation at
   corpus scale without buying one E2B sandbox per retained row.

Until the production object store is selected and its create-only generation,
checksum, and retrieval semantics are certified, the production persistence
gate is MISSING. An emulator-only pass is insufficient.

The hard Production Acceptance Corpus contains 60 million incoming messages.
The twelve-month target and one-month growth corpora contain 720 million and
600 million respectively. Each must materialize sandbox ToolCall attempts,
export rows, ToolCall outcomes, Content rows, and one distinct immutable object
per logical artifact according to the measured journey coefficient and size
distribution. Equal bytes remain distinct objects. If those coefficients are
not yet measured, sandbox corpus acceptance is MISSING.

For every corpus, perform a complete database-to-object inventory: every ready
ContentId resolves to the committed object generation and metadata, no public
reference targets pending content, no pending export or cleanup debt exceeds
its declared bound, and no unowned object or sandbox remains. Every upload is
checksum-verified on creation. Re-read and SHA-256 a frozen stratified sample
of stored bytes, and run missing, corrupt, wrong-generation, and unauthorized
retrieval challenge lanes. The growth corpora retain zero-tolerance
correctness, while their absolute latency and cost remain evidence-only as
required by [the workload contract](https://github.com/heyimcarlos/osfo/issues/42#issuecomment-5193263225).

Hot attempt, pending-export, and cleanup structures must scale with active
obligations, not total retained history. Report their size and oldest age,
object count and bytes, storage operations, E2B operations, retries, orphans,
cleanup attempts, unit cost, and full teardown inventory.

## Release gates, canaries, and invalidation

Every gate reports **PASS**, **FAIL**, or **MISSING**. MISSING never becomes
PASS. A production release is blocked unless deterministic, real persistence,
live profile, journey load, security, and cleanup gates all PASS.

- Pull requests run unit, property, state-machine, and exhaustive fault-cut
  tests without E2B credentials.
- Changes touching PostgreSQL, content storage, visibility transactions, or
  retrieval run real persistence integration and corruption challenge tests.
- Changes touching the E2B SDK, lockfile, Node runtime, template/build, helper,
  Python dependencies, profile, network policy, failure mapping, or cleanup
  logic rerun the complete live certification.
- Changes to the journey mix, input/output size distribution, duration,
  retries, E2B project/tier/quota, or production topology invalidate workload
  certification and concurrency sizing.
- E2B behavior drift, a security advisory, provider incident, canary failure,
  orphan audit failure, or an unclassified SDK error invalidates the affected
  gate until recertified.

Before traffic promotion, a production canary executes one tiny immutable CSV,
verifies its summary and optional artifact through normal retrieval, confirms
the fenced outcome, kills the sandbox, and verifies no metadata match or
cleanup debt remains. A low-rate scheduled canary repeats this path and the
deny-network probe. Canary failure stops promotion or triggers rollback and an
orphan audit. The periodic audit lists sandboxes by the Osfo deployment and
cleanup-nonce metadata namespace, joins them to open durable attempts, kills
every unowned match, and records the exact remaining inventory.

## Compact test matrix

| Layer | E2B | PostgreSQL/object store | Required evidence | Cadence |
|---|---|---|---|---|
| Unit/property | Mocked SDK hooks | Deterministic ports | Profile, bounds, paths, chunking, normalization, redaction | Every PR |
| Fault/state machine | Mocked SDK hooks | Real state transitions where authoritative | Every cut point, stale commit rejection, stable export identity, cleanup debt | Every PR |
| Persistence integration | Mocked deterministic streams | Real PostgreSQL and production-equivalent object semantics | Visibility transaction, preconditions, retry, retrieval, corruption, reconciliation | Every relevant PR and release |
| Exact-profile certification | Live exact E2B build | Focused real persistence | Isolation, limits, helper, export races, cancellation, kill, orphan cleanup | Every invalidating change |
| Target/stress/recovery | Live E2B at measured `s` and `W` | Separate full-slice evidence | Goodput, Good Root Outcome, quota, safe overload, recovery, cost | Release acceptance, three required repetitions |
| Retained corpora | No live E2B per row | Full real cardinality and object inventory | 60M, 720M, 600M data shape, zero correctness violations, bounded hot state | Acceptance and storage-schema changes |
| Production canary/audit | Live E2B | Normal production path | End-to-end success, retrieval, kill, zero unowned sandboxes | Before promotion and scheduled |

## Recommendation

Freeze one internal `executeRunCodeToolCall` deep module in `oz-agent-worker`. Let
it use the official E2B SDK directly, hide every provider and cleanup detail,
and return only a claim-fenced committed ToolCall outcome or the accepted
private failure. Test it exhaustively through private SDK hooks, certify the
exact E2B SDK and template live, derive concurrency from the measured CSV
journey, and exercise real PostgreSQL and immutable object behavior across all
retained corpora without creating an E2B sandbox for every retained row.
