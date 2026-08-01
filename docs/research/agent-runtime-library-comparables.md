# Agent runtime library comparables

Research date: 2026-07-31. Repository revisions and linked documentation were
current on that date.

## Decision frame

- **Target**: a Rust agent runtime feeding a transport-neutral, durable,
  per-Thread event log for 100,000 DAU and multi-device mid-response replay.
- **Hard constraint**: PostgreSQL remains Osfo's initial durable authority;
  provider or framework state cannot be the only copy of accepted conversation
  output.
- **Question**: which existing library can own the agent loop, streaming
  assembly, and durable Thread ordering/cursor contract?

## Ranked comparables

| Rank | Source | Score | Best match | Critical mismatch | Use for |
| --- | --- | ---: | --- | --- | --- |
| 1 | [Rig](https://github.com/0xPlaygrounds/rig) | 29/35 | Rust-native provider, tool, streaming, and serializable run machinery | No durable Thread sequence, replay cursor, or stable persisted run format | Osfo's model/tool loop and AgentEvent source |
| 2 | [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | 27/35 | Mature distinction between raw deltas, completed run items, and session history | Python/TypeScript and provider-oriented; session output is persisted after the turn | Event taxonomy and behavioral reference |
| 3 | [graph-flow](https://github.com/a-agmon/rs-graph-llm) | 23/35 | Rust graph execution, pause/resume, optimistic session saves | Snapshot workflow state, not an append-only conversation log or client replay protocol | Optional application workflow graphs, if later justified |

Scores cover domain fit, Rust fit, maturity, architecture clarity,
infrastructure relevance, testing quality, and documentation.

## Repository architecture extracts

### Rig 0.41

Relevant paths at revision
[`6cfae6d`](https://github.com/0xPlaygrounds/rig/tree/6cfae6d829da21f9dc9e775e065fee157b264f7e):

- `crates/rig-core/src/memory.rs` defines provider-neutral ordered
  `ConversationMemory`, loaded before a run and appended after a successful
  turn.
- `crates/rig-agent/src/agent/run/mod.rs` defines a sans-I/O, serializable,
  step-driven `AgentRun` for model calls and tool calls.
- `crates/rig-agent/src/agent/run/streamed.rs` assembles provider deltas into a
  canonical completed model turn while exposing deltas to the caller.
- `crates/rig-agent/src/agent/hook.rs` exposes typed hooks, including text
  deltas, tool calls, tool results, and completed model turns.
- Provider tests use recorded cassettes and include run stepping, streaming,
  resume, tool, and hook cases.

The seam is useful but narrower than Osfo's session contract. `AgentRun` owns
agent-loop decisions and can be serialized between model/tool steps. Its own
documentation states that the representation embeds the accumulated
conversation and has no cross-version stability guarantee. `ConversationMemory`
appends completed turn messages; it does not provide partial-output durability,
per-Thread sequence allocation, multi-device cursors, or replay delivery.

**Emulate**: provider adapters, streamed-turn assembly, typed hooks, tool loop,
and fake/provider conformance tests.

**Avoid**: persisting Rig's serialized `AgentRun` as Osfo's canonical
conversation or exposing Rig types as Osfo's public stable contract.

### OpenAI Agents SDK and Conversations API

The SDK exposes raw model deltas separately from completed run-item events, and
its sessions load prior history before a run and persist new user/model items
after the run. The Conversations API can hold ordered heterogeneous items.

This is strong evidence for Osfo's `AgentEvent` versus `ThreadEvent` split, but
not a replacement for Osfo's authority. The TypeScript session documentation
states that streamed outputs are appended when the turn completes, so it does
not provide Osfo's required persist-before-delivery partial replay. OpenAI
stream event sequence numbers are scoped to a provider response rather than to
Osfo's complete Thread.

**Emulate**: raw delta versus completed semantic item taxonomy.

**Avoid**: making an OpenAI conversation ID or provider event sequence the
canonical Osfo Thread/cursor; that would sacrifice transport and provider
neutrality.

### graph-flow 0.6

Relevant paths at revision
[`f18bf6a`](https://github.com/a-agmon/rs-graph-llm/tree/f18bf6a197fda9ee47f2ad21a625e985740e0cbb):

- `graph-flow/src/storage.rs` defines a versioned `Session` and optimistic
  `SessionStorage`.
- `graph-flow/src/storage_postgres.rs` stores the entire serialized context in
  one `sessions.context JSONB` row and rejects stale saves.
- `graph-flow/src/runner.rs` performs load, execute one graph step, then save.
- `graph-flow/src/context.rs` holds typed state plus a bounded chat-history ring
  buffer; old messages are removed after the configured cap.

This is workflow snapshot persistence. It can resume graph position after a
process restart, but it has no immutable event history, per-Thread event
sequence, partial output persistence, replay-after-cursor query, or
persist-before-fan-out rule. Concurrent saves fail with a version conflict and
must rerun; they do not create a canonical ordered conversation event.

**Emulate**: explicit state machine, optimistic conflict detection, and
step-driven execution.

**Avoid**: adopting its mutable JSON snapshot or bounded chat history as the
canonical Osfo conversation. Temporal already owns Osfo's independently durable
workflow role.

## Architecture guidance

- [OpenAI Agents SDK streaming](https://openai.github.io/openai-agents-python/streaming/)
  separates raw token deltas from completed message/tool items.
- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
  separates run streaming from history persistence and allows custom stores.
- [OpenAI Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming)
  provide response-scoped event sequence numbers, useful as adapter metadata
  but not as a cross-provider Thread cursor.
- [Temporal Event History](https://docs.temporal.io/workflow-execution/event)
  demonstrates the durable-history rule: persist semantic transitions needed
  for replay, not every runtime occurrence.

## Recommended shape

```text
Rig provider/tool/AgentRun machinery
                |
                v
Osfo adapter emits AgentEvents
                |
       explicit promotion policy
                |
                v
Osfo session appends ThreadEvents in PostgreSQL
                |
                +--> replay after opaque Thread cursor
                +--> build compacted context for the next run
```

Use Rig behind an Osfo-owned interface if a focused integration spike confirms
that its model/tool semantics fit. Osfo must still own:

- Thread identity and authoritative sequence allocation;
- durable output chunking and persist-before-delivery;
- event IDs, idempotency, causation, and schema versioning;
- replay after a client cursor and duplicate-safe application;
- compaction as a rebuildable projection over the immutable log.

## Options

| Option | Points | When to choose | Main risk | First slice |
| --- | ---: | --- | --- | --- |
| Rig behind Osfo session semantics | 9/10 | Default | Rig API/serialization churn leaks through the seam | Map Rig text/tool hooks into Osfo AgentEvents with fake-model tests |
| Build the full agent loop and session contract | 6/10 | Only if Rig blocks required semantics | Reimplements mature provider/tool machinery | Prove one provider stream and tool round trip |
| Make graph-flow the runtime authority | 4/10 | Only for a graph-centric product workflow | Mutable snapshots cannot satisfy Thread replay | Prototype one flow without treating it as the Thread store |
| Make OpenAI Conversations canonical | 3/10 | Only for an OpenAI-only product | Vendor authority and no Osfo-owned partial replay | Server-managed conversation prototype |

## Final recommendation

Adopt rather than invent where the behavior is generic: evaluate Rig for the
model/tool loop, provider streaming, and resumable run machinery. Keep Osfo's
small durable Thread interface because it is the product-independent stable
contract no candidate supplies. Do not adopt graph-flow for this role; its
resume means workflow-snapshot resume, not multi-device output replay.
