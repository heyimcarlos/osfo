# Thread event type-definition comparables

Accessed: 2026-07-31

## Executive judgment

Osfo's settled semantic split is strong:

```text
ThreadEventId   stable fact identity
ThreadPosition  canonical order inside one Thread
ThreadCursor    opaque client replay checkpoint
```

The illustrative Rust is directionally correct, but it is not yet a safe
persistence contract. I recommend these changes before implementation:

1. Split caller-created `ProposedThreadEvent` from store-created
   `ThreadEvent`. Only the store assigns position and commit time.
2. Let callers assign a stable `ThreadEventId` before append so uncertain
   writes can be retried with the same identity.
3. Back `ThreadPosition` with checked nonnegative `i64`, matching PostgreSQL
   `BIGINT`, and serialize it to JSON as a decimal string.
4. Allocate contiguous per-Thread positions transactionally. Never use a
   PostgreSQL sequence, because rolled-back `nextval` calls create gaps.
5. Keep `ThreadCursor` opaque and separate from `ThreadPosition`.
6. Persist an open envelope with event type, payload-local versio
7.
8.
9. n, and raw
   JSON. Decode known events into Rust enums separately and preserve unknown
   future events.
10. Replace ambiguous `schema_version` with payload-local versioning.
11. Use database-assigned `recorded_at` for persistence time. PostgreSQL cannot
   atomically stamp the literal commit instant into the row, so
   `committed_at` would overstate the guarantee.
12. Never use timestamp, provider sequence, or UUID ordering as Thread order.
13. Keep the three settled output events, but add a normalized completion
    reason and use an open, safe interruption-cause code.

The strongest new evidence is KurrentDB and Marten for durable streams, Matrix
and XMPP for identity versus cursor semantics, and AG-UI, A2A, Anthropic, and
Vercel for partial-output lifecycles.

## Decision frame

- **Target**: Osfo's provider-neutral, durable Thread event contract.
- **Stack**: Rust, PostgreSQL, shared AgentRun workers, Temporal for work with
  an independent durable lifecycle.
- **Scale**: one order per Thread, many Threads in parallel, multiple devices,
  reconnect and replay, persisted partial output.
- **Hard constraints**: immutable canonical history,
  `persist -> commit -> deliver`, at-least-once replay, apply-once clients, and
  no raw provider or retry noise in the Thread log.

This report emphasizes new comparables. OpenAI, LangGraph, Temporal, OpenPoke,
Rig, and graph-flow were already covered elsewhere and do not drive the ranking.

## Ranked comparables

Each criterion is scored from 0 to 5: domain fit (`D`), Rust or target-stack
fit (`R`), maturity (`M`), architecture clarity (`A`), operational relevance
(`O`), testing and quality (`Q`), and documentation (`Docs`).

| Rank | Comparable | D | R | M | A | O | Q | Docs | Total | Best use |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | KurrentDB plus Rust client | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **33/35** | Stream revision, expected head, raw envelope |
| 2 | Marten 9 | 5 | 3 | 5 | 4 | 5 | 5 | 5 | **32/35** | PostgreSQL event schema and upcasting |
| 3 | NATS JetStream | 4 | 2 | 5 | 4 | 5 | 5 | 5 | **30/35** | Stored versus delivery sequences and dedupe |
| 4 | Apache Kafka | 4 | 1 | 5 | 4 | 5 | 5 | 5 | **29/35** | Partition order and checkpoints |
| 5 | CloudEvents 1.0.2 | 3 | 5 | 5 | 4 | 3 | 4 | 5 | **29/35** | Envelope and payload-version separation |
| 6 | A2A 1.0 | 4 | 4 | 3 | 5 | 4 | 4 | 4 | **28/35** | Append-style artifacts and protocol versions |
| 7 | Axon Framework 5 | 4 | 1 | 5 | 4 | 4 | 5 | 5 | **28/35** | Causality, event versions, checkpoints |
| 8 | Vercel AI SDK 7 | 4 | 2 | 5 | 4 | 3 | 5 | 4 | **27/35** | Start/delta/end, finish, abort |
| 9 | Matrix client-server API | 4 | 1 | 5 | 4 | 4 | 3 | 5 | **26/35** | Opaque sync tokens and open event types |
| 10 | Anthropic Messages API | 4 | 2 | 5 | 4 | 2 | 4 | 5 | **26/35** | Indexed deltas and stop reasons |
| 11 | AG-UI 0.0.57 | 5 | 3 | 3 | 4 | 2 | 3 | 4 | **24/35** | Agent UI text lifecycle |
| 12 | XMPP MAM, RSM, stanza IDs | 4 | 1 | 4 | 4 | 3 | 2 | 4 | **22/35** | Stable IDs and opaque paging |

Popularity did not determine the ranking. AG-UI is semantically close, but it
lacks durable ordering and replay. KurrentDB and Marten lead because their
relevant subsystem closely matches the proposed log.

## Findings

### 1. Proposed facts and committed facts are different types

Kafka separates `ProducerRecord` from `ConsumerRecord`. KurrentDB separates new
event data from `RecordedEvent`. Durable location and persistence time appear
only after storage accepts the record.

```text
ProposedThreadEvent
  event_id, context, typed payload
          |
          v
append transaction
  validate expected head, assign position and recorded_at
          |
          v
ThreadEvent
  immutable committed envelope
```

A public constructor must not accept position or commit time. The repository
returns the committed event.

### 2. Event ID handles identity and append retry

CloudEvents uses `source + id`. Matrix separates a client transaction ID from
the resulting canonical `event_id`. XMPP separates origin IDs from
authority-assigned stanza IDs. KurrentDB accepts caller-assigned event IDs.

Osfo should generate `ThreadEventId` before append and retry an uncertain write
with the same ID and identical content. Enforce `UNIQUE(event_id)` and
`UNIQUE(thread_id, position)`. An identical repeated ID returns the original
event. A repeated ID with different content is a hard conflict. Keep inbound
message idempotency in another typed key.

NATS's time-bounded `Nats-Msg-Id` dedupe is not strong enough for canonical
history.

### 3. Position is per Thread and allocated in the append transaction

KurrentDB stream revision, Marten stream version, Kafka partition offset, and
JetStream stream sequence are scoped coordinates. Store-wide positions serve
other consumers and remain different types.

```text
canonical address = (ThreadId, ThreadPosition)
global reference  = ThreadEventId
delivery progress = ThreadCursor
```

Use a private nonnegative `i64` newtype. An empty Thread head is `None`; the
first event is position 0. Encode position as a decimal JSON string because JavaScript
cannot exactly represent every 64-bit integer.

Do not allocate per-Thread positions with a PostgreSQL sequence. Lock or
atomically update the Thread head in the same transaction as event insertion.
A batch receives one contiguous range. Rollback restores the prior head.

Never order by timestamp, UUIDv7, ULID, provider sequence, or delivery attempt.
UUIDv7 may improve database index locality, but that is its only role here.

### 4. Cursor is an opaque delivery boundary

Matrix sync tokens and XMPP paging IDs are opaque. Kafka and JetStream show why
inclusive versus exclusive checkpoint semantics must be explicit.

```text
cursor = applied through position P
replay_after(cursor) = events where position > P
```

`ThreadCursor` needs a private string field. If self-contained, encode cursor
version, Thread ID, and last-applied position, then protect it with a MAC.
Base64 alone is not integrity protection. Authorize Thread access separately.

Replay should return explicit `next_cursor` and `has_more`. The client advances
only after applying the page. A delivery wrapper can carry `cursor_after` per
event, but cursor data is not part of canonical history. Malformed,
unsupported-version, wrong-Thread, and future retention-floor failures must be
distinct. No cursor means before the first event.

### 5. Store an open envelope and decode known payloads separately

KurrentDB stores type plus bytes. Marten stores a stable type alias plus JSONB.
CloudEvents separates context from `data`. Matrix event types are open strings.

A closed Serde enum is useful inside current code, but unsafe as the only
durable decoder. Rust `#[non_exhaustive]` gives source compatibility only. It
does not make Serde accept unknown variants. `#[serde(other)]` cannot preserve
an unknown tag and payload.

Load an open envelope first, then decode known `(event_type, payload_version)`
pairs. Preserve unknown type, version, and data. Pass-through clients may
advance past unknown events. Projections requiring full semantics must fail
loudly. Use adjacent tagging for known DTOs and avoid untagged canonical enums.

### 6. Version each payload family

CloudEvents versions its envelope separately from application data. Kafka
separates record, wire, and payload versions. A2A negotiates a protocol version.
Axon and Marten evolve event kinds independently.

One `schema_version` is ambiguous. Prefer stable `event_type` plus
`payload_version`. Give the cursor its own format version. Add an envelope or
transport version only when that contract actually changes. Upcasters may
transform type/version/data, but never event ID, Thread ID, position,
`recorded_at`, or causal context. Lock explicit persisted names with golden
fixtures rather than relying on Rust variant names or `rename_all`.

### 7. Record time and causal fields need precise semantics

CloudEvents `time` means occurrence time. Axon uses generation time. Marten can
use database persistence time. Use `recorded_at` for the time assigned by the
authoritative store during append. Do not call it `committed_at`: ordinary
PostgreSQL row timestamps are assigned before the literal commit instant. A
later `occurred_at` belongs in a specific payload. None of these timestamps
orders events.

Axon and Marten support correlation and causation, but naked UUIDs remain weak.
Correlation means the root chain; causation means the immediate parent. Use
typed `CorrelationId`, `ThreadEventId`, `AgentRunId`, and
`WorkflowInstanceId`. If a cause may reference several entity kinds, define a
tagged `CauseRef` rather than one UUID with several meanings.

### 8. The three output events are sound

```text
AG-UI       TEXT_MESSAGE_START -> CONTENT* -> END
Anthropic   message_start -> block_start -> delta* -> block_stop -> stop
Vercel      text-start -> text-delta* -> text-end, plus finish/abort/error
A2A         artifact update with append=true, then task status
```

A2A validates `Appended` as the operation. Its `lastChunk` flag is weaker for a
durable log because data and termination share one record. Keep:

```text
AssistantOutputAppended*
    +-> AssistantOutputCompleted
    `-> AssistantOutputInterrupted { cause }
```

Output completion, provider-response completion, and AgentRun completion remain
different. Anthropic can stop a provider response for tool use while the run
continues. Vercel separately models step finish and overall finish.

### 9. No durable start event or output-local offset yet

Wire protocols need start events to introduce role, block index, or part state.
Osfo fixes the role as assistant and the first committed append introduces the
output ID. The first `AssistantOutputAppended` can establish existence. This
also preserves the settled rule that failure before the first fragment records
only AgentRun failure.

Defer `AssistantOutputStarted` until empty output or pre-content metadata becomes
a durable fact. For now, terminal events require at least one prior append.
Consequently, a successful run with zero client-visible content has no
AssistantOutput, only its AgentRun terminal event. If empty output itself must
be observable, add `Started` or permit `Completed` as the first output event.

Filtering one Thread by `output_id` and sorting by `ThreadPosition` reconstructs
that output. Do not add a second append offset unless fragments move to another
store or outputs become independently consumable.

Part identity is different from order. A flat `text` field works only if Osfo
permanently flattens all visible output. A reusable agent foundation will likely
need files, citations, structured content, or several text parts. A typed
fragment plus optional `part_id` avoids that future break.

### 10. Terminal reasons should be normalized and open

Anthropic reports natural end, token limit, refusal, and tool use. Vercel keeps
normalized and raw provider finish reasons separate. Add a provider-neutral
completion reason so `Completed` does not lose truncation or refusal.

Append `Interrupted` only when the identified output cannot continue. Use an
open code newtype with known values such as `cancelled`,
`provider_stream_lost`, `worker_lost`, `deadline_exceeded`, and `internal`.
Do not persist provider exceptions, secrets, or retry diagnostics as the cause.

## Recommended Rust shape

This is an abbreviated implementation sketch.

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ThreadId(Uuid);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ThreadEventId(Uuid);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AssistantOutputId(Uuid);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ThreadPosition(i64);

impl ThreadPosition {
    pub const FIRST: Self = Self(0);

    pub fn new(value: i64) -> Result<Self, InvalidThreadPosition> {
        (value >= 0).then_some(Self(value)).ok_or(InvalidThreadPosition)
    }

    pub fn get(self) -> i64 { self.0 }
    pub fn checked_next(self) -> Option<Self> { self.0.checked_add(1).map(Self) }
}

// Serialize ThreadPosition as a decimal string in JSON.
// Encode it as checked BIGINT in the PostgreSQL adapter.

pub struct ProposedThreadEvent {
    pub event_id: ThreadEventId,
    pub context: ThreadEventContext,
    pub payload: NewThreadEventPayload,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ThreadEventContext {
    pub correlation_id: Option<CorrelationId>,
    pub caused_by_event_id: Option<ThreadEventId>,
    pub agent_run_id: Option<AgentRunId>,
}

pub struct ThreadEventEnvelope<T> {
    pub event_id: ThreadEventId,
    pub thread_id: ThreadId,
    pub position: ThreadPosition,
    pub recorded_at: DateTime<Utc>,
    pub context: ThreadEventContext,
    pub payload: T,
}

pub type StoredThreadEvent = ThreadEventEnvelope<StoredThreadEventPayload>;
pub type ThreadEvent = ThreadEventEnvelope<DecodedThreadEventPayload>;

pub struct StoredThreadEventPayload {
    pub event_type: ThreadEventType,
    pub payload_version: u16,
    pub data: serde_json::Value,
}

pub enum DecodedThreadEventPayload {
    Known(KnownThreadEventPayload),
    Unknown(StoredThreadEventPayload),
}

pub enum KnownThreadEventPayload {
    AssistantOutputAppended(AssistantOutputAppendedV1),
    AssistantOutputCompleted(AssistantOutputCompletedV1),
    AssistantOutputInterrupted(AssistantOutputInterruptedV1),
}

pub struct AssistantOutputAppendedV1 {
    pub output_id: AssistantOutputId,
    pub part_id: Option<AssistantOutputPartId>,
    pub fragment: AssistantOutputFragmentV1,
}

#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum AssistantOutputFragmentV1 {
    Text { text: String },
}

pub struct AssistantOutputCompletedV1 {
    pub output_id: AssistantOutputId,
    pub reason: AssistantOutputCompletionReason,
}

pub struct AssistantOutputInterruptedV1 {
    pub output_id: AssistantOutputId,
    pub cause: AssistantOutputInterruptionCause,
    pub public_error_code: Option<String>,
}

#[serde(transparent)]
pub struct AssistantOutputCompletionReason(String);

#[serde(transparent)]
pub struct AssistantOutputInterruptionCause(String);

pub struct ThreadCursor(String);

pub enum ExpectedThreadHead {
    Empty,
    At(ThreadPosition),
}
```

All newtype fields stay private. IDs need checked parsing and no `Default`.
Avoid deriving `Ord` for IDs. The repository codec, not callers, maps typed
payloads to explicit durable type/version pairs.

The Thread remains small:

```rust
pub struct Thread {
    pub id: ThreadId,
    pub head_position: Option<ThreadPosition>,
    pub opened_at: DateTime<Utc>,
}
```

`head_position` is a transactional cache and concurrency boundary. Add an
owning-agent field only when that typed ownership contract is settled.

## Recommended persisted JSON

```json
{
  "event_id": "019fbad2-70f8-7aa1-bbb6-bba7af607934",
  "thread_id": "019fbad0-87d0-7550-aace-56553b9dc993",
  "position": "42",
  "recorded_at": "2026-07-31T20:41:12Z",
  "context": {
    "correlation_id": "019fbad1-5661-7554-9a82-b1889681cbb7",
    "caused_by_event_id": "019fbad1-2311-7003-b292-f36357519d96",
    "agent_run_id": "019fbad1-91ce-71f6-9e8f-f801f56dcc4e"
  },
  "event": {
    "type": "assistant_output_appended",
    "version": 1,
    "data": {
      "output_id": "019fbad2-2b53-70bc-82a2-cd101043edbd",
      "part_id": "019fbad2-4d10-7d6e-a26e-58b16b571c9f",
      "fragment": {
        "kind": "text",
        "data": { "text": "Here is the first committed fragment." }
      }
    }
  }
}
```

The nested event object keeps type, version, and raw data together for unknown
event preservation. Do not flatten the known enum directly into the durable
envelope.

## Append and replay shape

```rust
async fn append_thread_events(
    thread_id: ThreadId,
    expected: ExpectedThreadHead,
    proposed: Vec<ProposedThreadEvent>,
) -> Result<Vec<ThreadEvent>, AppendThreadEventsError>;

pub struct ReplayPage {
    pub events: Vec<DeliveredThreadEvent>,
    pub next_cursor: ThreadCursor,
    pub has_more: bool,
}

pub struct DeliveredThreadEvent {
    pub event: ThreadEvent,
    pub cursor_after: ThreadCursor,
}
```

```text
BEGIN
  lock Thread head
  resolve exact idempotent retry, or reject conflicting duplicate ID
  verify expected head
  assign 0 through N-1 if empty, otherwise head+1 through head+N
  insert events and update head
COMMIT
deliver committed envelopes
```

## Tests that should lock the contract

- Same event ID and identical content returns the original event.
- Same event ID and different content conflicts.
- Two appends against one expected head produce one success and one conflict.
- Batch append is atomic and rollback consumes no position.
- JSON position remains exact above `2^53 - 1`.
- No cursor starts at the beginning; cursor replay is strictly after its event.
- Wrong-Thread and malformed cursors fail explicitly.
- Unknown event type and version round-trip without data loss.
- Upcasting cannot change envelope identity or order.
- Output append is nonempty and bounded.
- Exactly one terminal event follows one or more appends.
- Append after completion or interruption is rejected.
- Retry creates a new `AssistantOutputId`.
- Failure before first append creates no output terminal event.
- Unknown completion and interruption codes remain representable.
- Provider errors and hidden reasoning never enter canonical payloads.

## Final recommendation

Keep the settled event names. Implement three layers:

```text
typed proposal
  ProposedThreadEvent
        |
        v
open committed storage
  StoredThreadEvent { type, version, raw data }
        |
        v
typed decode
  Known payload | Unknown preserved payload
```

Implement private newtypes, the proposed/committed split, payload codecs,
expected-head append, permanent event-ID idempotency, output state-machine
tests, and cursor replay tests first.

Defer global order, `AssistantOutputStarted`, output-local offsets, CloudEvents
export, a separate `osfo-protocol`, and transport envelope versioning.

## Primary sources

All sources were accessed 2026-07-31. Only official specs, docs, and source
repositories were used.

- **CloudEvents**: [spec v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md), [JSON format](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/formats/json-format.md), [primer](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/primer.md), [`sdk-rust/src/event/format.rs` at `54b39e2`](https://github.com/cloudevents/sdk-rust/blob/54b39e25e80bbbd618faeb918ed0973b2daec256/src/event/format.rs).
- **KurrentDB**: [Rust client guide](https://docs.kurrent.io/clients/rust/), [reading events](https://docs.kurrent.io/clients/rust/legacy/v4.0/reading-events), [persistent subscriptions](https://docs.kurrent.io/server/v25.1/features/persistent-subscriptions), [`kurrentdb/src/types.rs` at `d76e58b`](https://github.com/kurrent-io/KurrentDB-Client-Rust/blob/d76e58ba464b2dc77c196ffefbca330ce9df938d/kurrentdb/src/types.rs), [`docs/api/appending-events.md` at `5dbc42e`](https://github.com/kurrent-io/KurrentDB-Client-Go/blob/5dbc42e1681f5f9d851980607b958fd7dcd2a2f1/docs/api/appending-events.md).
- **Kafka**: [consumer API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html), [design](https://kafka.apache.org/43/design/design/), [`ProducerRecord.java` at `e7cba22`](https://github.com/apache/kafka/blob/e7cba22471f0d2833b850e2b0085c1cfff2efed5/clients/src/main/java/org/apache/kafka/clients/producer/ProducerRecord.java), [`ConsumerRecord.java`](https://github.com/apache/kafka/blob/e7cba22471f0d2833b850e2b0085c1cfff2efed5/clients/src/main/java/org/apache/kafka/clients/consumer/ConsumerRecord.java).
- **NATS JetStream**: [model](https://docs.nats.io/nats-concepts/jetstream), [consumers](https://docs.nats.io/nats-concepts/jetstream/consumers), [dedupe and acknowledgments](https://docs.nats.io/using-nats/developer/develop_jetstream/model_deep_dive), [`server/store.go` at `ccd898e`](https://github.com/nats-io/nats-server/blob/ccd898ea86accf40861f1dd651df8e7fb9c0e5f3/server/store.go), [`async-nats` consumer types at `97ebb23`](https://github.com/nats-io/nats.rs/blob/97ebb236d325a8b4750a85d15960befa70ca4054/async-nats/src/jetstream/consumer/mod.rs).
- **Matrix**: [client-server API](https://spec.matrix.org/latest/client-server-api/), [`sync.yaml` at `d0ba2aa`](https://github.com/matrix-org/matrix-spec/blob/d0ba2aaef801e0134a4e5c6054a2c2f41bb55531/data/api/client-server/sync.yaml), [`event.yaml`](https://github.com/matrix-org/matrix-spec/blob/d0ba2aaef801e0134a4e5c6054a2c2f41bb55531/data/event-schemas/schema/core-event-schema/event.yaml).
- **XMPP**: [XEP-0313 MAM](https://xmpp.org/extensions/xep-0313.html), [XEP-0059 RSM](https://xmpp.org/extensions/xep-0059.html), [XEP-0359 stable stanza IDs](https://xmpp.org/extensions/xep-0359.html), [`xep-0313.xml` at `e2ece70`](https://github.com/xsf/xeps/blob/e2ece70a8185fdac4dc29105f4ed59c106d7fb57/xep-0313.xml).
- **Axon**: [message anatomy](https://docs.axoniq.io/axon-framework-reference/5.1/messaging-concepts/anatomy-message/), [correlation](https://docs.axoniq.io/axon-framework-reference/5.1/messaging-concepts/message-correlation/), [event versioning](https://docs.axoniq.io/axon-framework-reference/5.1/events/event-versioning/), [`EventMessage.java` at `3e70e75`](https://github.com/AxonFramework/AxonFramework/blob/3e70e750efc64f0c2c7cbf3c77303e6d31d6c2be/messaging/src/main/java/org/axonframework/messaging/eventhandling/EventMessage.java).
- **Marten**: [event schema](https://martendb.io/events/storage), [metadata](https://martendb.io/events/metadata), [appending](https://martendb.io/events/appending), [`EventsTable.cs` at `7dc60aa`](https://github.com/JasperFx/marten/blob/7dc60aa00e687f77a05ba0a94d8691119b70a07f/src/Marten/Events/Schema/EventsTable.cs), [`EventUpcaster.cs`](https://github.com/JasperFx/marten/blob/7dc60aa00e687f77a05ba0a94d8691119b70a07f/src/Marten/Services/Json/Transformations/EventUpcaster.cs).
- **AG-UI**: [event docs](https://docs.ag-ui.com/concepts/events), [`events.ts` at `bb1c2af`](https://github.com/ag-ui-protocol/ag-ui/blob/bb1c2afddb4880309879b9564cfb3a635a5da4eb/sdks/typescript/packages/core/src/events.ts), [Rust event types](https://github.com/ag-ui-protocol/ag-ui/blob/bb1c2afddb4880309879b9564cfb3a635a5da4eb/sdks/community/rust/crates/ag-ui-core/src/event.rs).
- **A2A**: [1.0 specification](https://a2a-protocol.org/v1.0.0/specification/), [streaming](https://a2a-protocol.org/latest/topics/streaming-and-async/), [`a2a.proto` at `2cdf197`](https://github.com/a2aproject/A2A/blob/2cdf197805cf3eb780714f730cdfd24bce1c9998/specification/a2a.proto), [Rust events at `515f6ea`](https://github.com/a2aproject/a2a-rs/blob/515f6eacf2b4b9b17bd3910e93ac47027afaaf90/a2a/src/event.rs).
- **Anthropic**: [streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), [versioning](https://platform.claude.com/docs/en/api/versioning), [Managed Agents events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming), [`messages.ts` at `3b45cd3`](https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts).
- **Vercel AI SDK**: [stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), [resuming streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams), [`ui-message-chunks.ts` at `e84b8bc`](https://github.com/vercel/ai/blob/e84b8bc8154030cdb7469b0e0b8cd8b9354f19a0/packages/ai/src/ui-message-stream/ui-message-chunks.ts), [`stream-text-result.ts`](https://github.com/vercel/ai/blob/e84b8bc8154030cdb7469b0e0b8cd8b9354f19a0/packages/ai/src/generate-text/stream-text-result.ts).
- **Rust guidance**: [Serde enum representations](https://serde.rs/enum-representations.html), [Serde `other`](https://serde.rs/variant-attrs.html#other), [Rust `non_exhaustive`](https://doc.rust-lang.org/reference/attributes/type_system.html#the-non_exhaustive-attribute), [UUIDv7 RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7).
