# Flue as an Agent Runtime comparable

Research date: 2026-08-05.

Repository: [withastro/flue](https://github.com/withastro/flue) at
[`bf86b8726f5ba189844185fdbeca0e194344ded1`](https://github.com/withastro/flue/tree/bf86b8726f5ba189844185fdbeca0e194344ded1),
tagged `v2.0.3`. The exact source is also available locally at
`.reference/flue`.

## Decision frame

Osfo needs three independently testable interfaces:

1. A durable AgentRun host that owns authorization, claims, recording,
   recovery, and continuation.
2. An Agent Runtime that maps reconstructed AgentRun state to one proposed
   next step without performing it.
3. A model-call execution seam that translates one committed ModelCall into
   normalized observations.

The question is whether Flue can implement the second interface without
bringing its own durability, canonical conversation, model dispatch, and tool
execution authority into Osfo.

Hard constraints include PostgreSQL authority, record-before-execution,
persist-before-delivery output, fenced attempts, reconstruction without a
private checkpoint, independently durable Child AgentRuns and WorkflowInstances,
Effect-native public interfaces, and no provider or framework types in durable
Osfo records.

## Comparable score

This is an addendum to the existing agent-runtime comparable survey, so it
scores the one newly requested candidate rather than reranking unrelated
repositories.

| Source | Score | Best match | Critical mismatch | Use for |
| --- | ---: | --- | --- | --- |
| [Flue](https://github.com/withastro/flue) | 22/35 | Durable accepted submissions, canonical streamed conversation records, recovery classification, tools, subagents, and a concise Agent Application surface | Its Pi-based loop performs model and tool work internally and its canonical records import Pi types; it exposes no pure next-step proposal interface or durable ModelCall intent | Recovery patterns, record-before-publication streaming, tool uncertainty, durable step memos, and Agent Application ergonomics |

Scores: domain fit 4/5, target stack fit 3/5, production maturity 2/5,
architecture clarity 4/5, infrastructure and operations relevance 3/5,
testing quality 1/5, and documentation and maintainability signal 5/5.

The low testing score is evidence-specific: this revision contains three
exported contract-test utility files but no tracked `*.test.*`, `*.spec.*`, or
`test/` files. Its package manifests define Vitest commands and its docs refer
to tests, but those are not an independently inspectable suite in the cloned
revision.

## Architecture extract

### Durable host

Flue now solves substantially more durability than its older descriptions
suggest. Its accepted submission is stored before model work and promises one
durable `completed`, `failed`, or `aborted` settlement. Node processing uses
leases and attempts; a canonical append-only conversation stream preserves
partial assistant output; recovery closes interrupted output and classifies
the next action from durable evidence. See the
[durability contract](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/durability.md)
and [`AgentSubmissionStore`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/agent-execution-store.ts).

The canonical writer fences producers, sequences append batches, retries one
unknown append, and maintains a rebuildable fold checkpoint. Streamed deltas
are buffered for up to one second and become observable only after their
canonical append resolves. See
[`ConversationRecordWriter`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/conversation-writer.ts#L27-L214).

These are close comparables for the Osfo durable host, even though Flue's
identity and lifecycle model is not Osfo's AgentRun model.

### Agent loop and provider dispatch

Flue constructs `@earendil-works/pi-agent-core`'s `Agent` inside `Session`,
injecting a provider `streamFn` and executable tools. The Pi Agent owns the
model and tool loop. See
[`new Agent(...)`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/session.ts#L2211-L2237).

At the model seam, Flue emits an in-process telemetry event and immediately
calls Pi's `streamSimple()` provider operation. There is no durable ModelCall
intent between those actions. See
[`emitTurnRequestAndStream`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/session.ts#L823-L836)
and the telemetry-only
[`emitTurnRequest`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/session.ts#L2089-L2122).

Flue provider registration is a real provider seam, but it is a Pi seam, not
an authority-free Osfo ModelCall seam. `Session` consumes Pi `Model`,
`AgentMessage`, and `AgentTool` types directly. Flue's public and canonical
types also import Pi message types. See
[`providers.ts`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/runtime/providers.ts),
[`types.ts`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/types.ts#L1-L15),
and
[`conversation-records.ts`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/conversation-records.ts#L1-L12).

### Tool execution

Flue records complete model-requested tool calls and tool outcomes in its
canonical stream, preserves already-recorded results, and uses explicit
unknown-outcome results for interrupted ordinary tools. Durable tools can use
stable `step.do` memos so completed steps replay from records while unfinished
steps run again. This is strong evidence for Osfo's ToolCall and later
external-effect work.

The current implementation still hands executable wrapped tools to Pi. Pi
decides when to invoke them and Flue's wrapper performs the tool operation.
See
[`wrapModelTool`](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/session.ts#L3674-L3742).
The integrated Flue host can enforce its ordering around that loop, but there
is no exported proposal and committed-feedback protocol that Osfo can adopt.

### Recovery and deployment limits

Flue reconstructs conversation state from canonical records and does not make
the live Pi Agent object a recovery authority. Missing in-process state is
therefore safe. This is a meaningful positive result.

Its Node target nevertheless requires one live process owner per conversation.
A shared database supports replacement and recovery, not active-active
ownership or round-robin routing. See the
[database guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/database.md#L112-L123)
and
[Node target guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/node-target.md#L37-L45).
Osfo's fenced AgentRunAttempt model is intended to permit replacement without
requiring long-lived conversation affinity.

The runtime implementation is also highly concentrated: `session.ts` is 5,820
lines and the runtime source is about 41,000 TypeScript lines at this revision.
That concentration is understandable for Flue's integrated product, but it
makes extracting only an authority-free agent loop a large and unstable
integration surface.

## Qualification against the Osfo Agent Runtime seam

| Requirement | Result | Evidence |
| --- | --- | --- |
| Decide one next step without performing it | Fail | Pi's `Agent.prompt()` and `continue()` drive model calls and executable tools inside the loop. |
| Accept the committed result afterward | Fail | No public proposal and committed-feedback protocol exists. Results flow back through Pi's live loop. |
| Reconstruct from Osfo's recorded history | Partial pass | Flue reconstructs its own Pi-shaped conversation projection from canonical records, but not the complete Osfo AgentRun interaction contract. |
| Avoid owning authoritative conversation or session state | Fail | Flue deliberately owns its canonical conversation stream, session, submission lifecycle, and recovery policy. |
| Disable hidden model and tool retries | Partial fail | Flue owns model error retry, compaction retry, attempt retry, and durable tool re-execution policies. These are documented but not delegated to an enclosing Osfo host. |
| Never execute tools before durable intent | Partial pass | The integrated Flue host records complete tool requests before execution and repairs unresolved batches, but this invariant is not exposed as an Adapter interface Osfo can enforce. |
| Work without a private runtime checkpoint | Pass | Flue reconstructs from its canonical records; the live Pi object is disposable. |
| Map into stable Osfo types without leakage | Partial fail | An Adapter could translate the types, but Pi types currently appear throughout runtime, public, and canonical record shapes. |

Flue also fails an additional Osfo requirement: a model request is not durably
identified and recorded before provider dispatch. Its `turn_request` is
telemetry, not recovery authority.

## Performance implications

Flue is useful evidence that persist-before-publication does not require one
database round trip per provider token. It coalesces streaming deltas, performs
one append per batch, and publishes the batch only after that append succeeds.
Osfo should preserve this shape while moving the authorization cut earlier:

```text
reconstructed state
  -> propose one ModelCall
  -> commit ModelCall intent once
  -> dispatch provider request
  -> coalesce provider fragments
  -> append and publish each durable fragment batch
  -> commit one terminal ModelCall outcome
  -> propose the next semantic step
```

The Agent Runtime does not need to be reconstructed from PostgreSQL for every
fragment. A live fenced attempt can maintain a derived in-memory fold while
PostgreSQL remains authoritative; full reconstruction is required on a new
attempt or compatibility check. `proposeNextStep` runs at semantic boundaries,
not token boundaries.

This architecture is compatible with a responsive agent, but architecture
alone cannot guarantee the user experience. The selected coalescing window,
same-region commit latency, write amplification, first-fragment latency, and
failure recovery must pass the Production Workload Envelope and user-outcome
SLOs. Flue's fixed one-second window is evidence for batching, not a value Osfo
should copy without measurement.

## What to emulate

- Accepted-work settlement as an explicit durable obligation.
- Canonical partial-output records that are published only after append.
- Producer fencing and duplicate-safe append reconciliation.
- Recovery classification from durable evidence rather than process state.
- Explicit unknown outcomes for interrupted ordinary tools.
- Stable per-tool step memos for resumable, idempotent work.
- A concise Agent Application definition surface that hides the lower-level
  runtime proposal protocol.
- Public conformance-kit functions for every Adapter seam.

## What to avoid

- Importing `@flue/runtime` or Pi types into Osfo packages or durable records.
- Replacing Osfo's AgentRun, Thread, Child AgentRun, or WorkflowInstance
  authority with Flue submissions and sessions.
- Letting an agent-loop library invoke providers or tools before Osfo records
  the operation intent.
- Adopting Flue's retry, compaction, affinity, or durability policies as
  implicit Agent Application behavior.
- Forking Flue's large integrated `Session` to extract a small steppable loop.
- Treating documentation or exported test utilities as proof without a tracked
  executable conformance and fault-injection suite.

## Options

| Option | Points | When to choose | Main risk | First slice |
| --- | ---: | --- | --- | --- |
| Adopt Flue as Osfo's durable runtime | 3/10 | Only if Osfo gives up its distinct lifecycle and Thread contracts | Competing authority, no durable ModelCall intent, and incompatible types | Not recommended |
| Build a Flue AgentRuntime Adapter | 4/10 | Only after Flue exposes a pure step and committed-feedback protocol | Large coupling to Pi, Flue sessions, and recovery policy | Run the Osfo conformance corpus against the proposed public seam |
| Emulate selected Flue patterns in the Osfo host and standard runtime | 9/10 | Current recommendation | Osfo must still implement and validate its narrow unique contracts | Durable ModelCall intent, deterministic standard loop, and coalesced persist-before-publish output |

## Recommendation

Do not use Flue as an Osfo dependency or Agent Runtime Adapter in v1.

Keep the accepted three-interface design and the small Osfo-owned standard
agent loop. Treat Flue as a strong comparable for durable host mechanics and
Agent Application ergonomics. Revisit an Adapter only if Flue exposes an
interface that produces one typed action without performing it, accepts the
committed result on a later call, disables internal retries, and reconstructs
without owning the canonical conversation.

## Sources

Accessed 2026-08-05:

- [Flue repository](https://github.com/withastro/flue)
- [Flue revision `bf86b87`](https://github.com/withastro/flue/tree/bf86b8726f5ba189844185fdbeca0e194344ded1)
- [Flue durability guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/durability.md)
- [Flue database guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/database.md)
- [Flue Node target guide](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/apps/docs/src/content/docs/guide/node-target.md)
- [Flue runtime package](https://github.com/withastro/flue/tree/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime)
- [Flue session implementation](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/session.ts)
- [Flue canonical writer](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/conversation-writer.ts)
- [Flue persistence Adapter surface](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/adapter.ts)
- [Flue provider registry](https://github.com/withastro/flue/blob/bf86b8726f5ba189844185fdbeca0e194344ded1/packages/runtime/src/runtime/providers.ts)
