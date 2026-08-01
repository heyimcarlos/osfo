# Event primitive vocabulary comparables

Accessed: 2026-07-31

## Decision frame

- **Target**: Osfo's provider-neutral, durable Thread event and replay contract.
- **Stack**: Rust, PostgreSQL, shared AgentRun workers, and Temporal for work
  with an independent durable lifecycle.
- **Scale**: several devices consume one authoritative per-Thread order; output
  must be replayable after reconnect and safely redelivered.
- **Hard constraint**: raw provider stream events are not canonical. Osfo
  coalesces them, commits a durable fact, and only then delivers it.
- **Question**: should the durable partial-output event be named
  `AssistantOutputChunk`, or is a different primitive clearer?

This report compares vocabulary, not implementation completeness. A familiar
name scores poorly when its established meaning belongs to a different layer.

## Grading

Each comparable receives 0-5 points for:

1. agent/conversation domain fit;
2. Rust or target-runtime fit;
3. production maturity;
4. architecture and lifecycle clarity;
5. durable-infrastructure and operations relevance;
6. testing and quality signal;
7. documentation and maintainability signal.

Candidate Osfo names receive 0-5 points for:

1. semantic precision;
2. familiarity across comparables;
3. correctness at a durable rather than provider/wire layer;
4. lifecycle symmetry;
5. transport and provider neutrality;
6. clarity when folding events into a projection;
7. Rust enum ergonomics.

## Ranked comparables

| Rank | Comparable | Score | Best match | Important mismatch |
|---:|---|---:|---|---|
| 1 | Temporal | 31/35 | Immutable, scope-qualified, past-tense history events and explicit terminal outcomes | Workflow replay and page tokens are not client output replay |
| 2 | OpenAI Responses + Agents SDK | 30/35 | Clear raw-event versus semantic run-item layers; explicit completed/incomplete/failed response outcomes | Response sequence is provider-response scoped, not Thread scoped |
| 3 | Rig 0.41 | 29/35 | Rust `AgentRun`, model turns, tool call/result correlation, raw delta versus aggregated completion | No durable Thread position, output replay cursor, or interrupted partial-output fact |
| 4 | Anthropic Messages, Agent SDK, and Managed Agents | 29/35 | Strong separation of ephemeral deltas, assistant messages, agent-loop results, and persisted events | Managed preview deltas are not durable or replayable; no documented per-session position |
| 5 | LangGraph | 27/35 | Threads, run events, message/content-block streaming, checkpointed execution | Checkpoint replay is graph execution replay, not committed client-output replay |
| 6 | Google ADK | 26/35 | General `Event`, invocation identity, function call/response, tool confirmation | Partial events are not persisted; timestamp plus ID replaces a monotonic position |
| 7 | Vercel AI SDK | 25/35 | Explicit text start/delta/end and separate finish/abort/error wire events | `chunk` is a heterogeneous transport union; resume lacks a last-applied event cursor |
| 8 | PydanticAI | 24/35 | Text-part deltas, tool call/result events, complete/incomplete/interrupted states | `output` means a final validated run value, and deltas mutate indexed response parts |
| 9 | graph-flow 0.6 | 23/35 | Rust workflow statuses and optimistic session persistence | No assistant streaming; `Session.version` is locking metadata, not replay position |
| 10 | OpenPoke | 17/35 | Architectural ancestry and familiar message/tool terminology | Whole replies only; no durable partial-output lifecycle, position, or cursor |

Popularity did not determine the ordering. Temporal ranks highly for durable
event language even though it does not model assistant output; Rig ranks highly
for runtime language even though Osfo must supply the durability contract.

## The shared three-layer model

The strongest comparables separate at least two of these layers. Osfo requires
all three:

```text
Provider stream
  raw chunk / TextDelta / content_block_delta / response.output_text.delta
                    |
                    v
Agent runtime
  StreamedAssistantContent / raw_response_event / RunItemStreamEvent
                    |
             coalesce + promote
                    |
                    v
Canonical Thread
  immutable, committed, replayable ThreadEvent
```

The naming consequence is important:

- **delta** consistently means a provisional provider/runtime increment;
- **chunk** usually means a raw stream or transport partition;
- a durable event should name the fact that changed canonical state.

## Exact vocabulary crosswalk

| Concern | Rig | OpenAI | Anthropic | LangGraph | Google ADK | Temporal | Vercel / PydanticAI |
|---|---|---|---|---|---|---|---|
| Conversation scope | `ConversationMemory` | `Conversation` | `session` | `thread` | `Session` | `WorkflowExecution` | chat/message history |
| Bounded work | `AgentRun` | agent run / `RunResult` | SDK query/result | run | `InvocationContext` | Workflow Run | agent run |
| Raw text increment | `TextDelta`, streamed `Text` | `response.output_text.delta` | `text_delta`, `content_block_delta` | token / `content-block-delta` | partial event | no equivalent | `text-delta`, `TextPartDelta` |
| Complete assistant item | `ModelTurn`, `FinalResponse` | output message / `message_output_created` | `SDKAssistantMessage`, `agent.message` | `message-finish` | `is_final_response()` | no equivalent | `text-end`, materialized `UIMessage` |
| Run success | `AgentRunStep::Done` | completed run result | `SDKResultMessage(success)` | run completion | end of invocation | `WorkflowExecutionCompleted` | result / finish callback |
| Incomplete output | absent | `response.incomplete` / `response.failed` | `aborted`, stream error | message error | `interrupted` flag | no assistant equivalent | `abort`, `error`; response state `incomplete`/`interrupted` |
| Tool intent | `ToolCall` | function/tool call item | `tool_use` | tool call | `FunctionCall` | Activity scheduling command | `tool-call`, `ToolCallEvent` |
| Tool outcome | `ToolResult` | function call output / `tool_output` | `tool_result` | tool result/error | `FunctionResponse` | Activity completed/failed event | `tool-result`, `ToolResultEvent` |
| Approval | example-specific | interruptions / approval items | permission or tool confirmation | interrupt | `ToolConfirmation` | Update/Signal patterns | approval request/response |
| Ordered durable fact | absent | provider item/event | persisted Managed Agent event | checkpoint/event stream | `Event` | `HistoryEvent(event_id)` | absent |
| Resume marker | absent | response/conversation IDs | session ID / page cursor | checkpoint ID / `Last-Event-ID` | timestamp filter | page token / event ID | active stream ID / prior history |

### Rig

Rig's current source uses `AgentRun`, `ModelTurn`, `ToolCall`, `ToolResult`, and
`TextDelta`. Its raw stream also calls provider partitions chunks. A successful
stream ends in `FinalResponse`; there is no durable interrupted-output record.
This makes Rig a strong reason to keep `delta` and raw `chunk` inside the
adapter/runtime layer. See
[`AgentRunStep`](https://github.com/0xPlaygrounds/rig/blob/6cfae6d829da21f9dc9e775e065fee157b264f7e/crates/rig-agent/src/agent/run/mod.rs#L117-L176),
[`MultiTurnStreamItem`](https://github.com/0xPlaygrounds/rig/blob/6cfae6d829da21f9dc9e775e065fee157b264f7e/crates/rig-agent/src/agent/prompt_request/streaming.rs#L51-L129), and
[`StreamedAssistantContent`](https://github.com/0xPlaygrounds/rig/blob/6cfae6d829da21f9dc9e775e065fee157b264f7e/crates/rig-core/src/streaming.rs#L956-L987).

### OpenAI

The Responses API uses `response.output_text.delta` for newly received text,
`response.output_text.done` for finalized text, output-item states of
`in_progress | completed | incomplete`, and response terminal events including
`completed`, `incomplete`, and `failed`. Each raw response event has a
`sequence_number`, but it is not an Osfo-wide Thread position. The Agents SDK
then separates raw response events from higher-level `RunItemStreamEvent`s such
as message output, tool call, and tool output. See the
[Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/content_part)
and [Agents SDK streaming guide](https://openai.github.io/openai-agents-python/streaming/).

### Anthropic

The Messages API uses `message_start`, `content_block_delta`, and
`message_stop`; `message_stop` only ends the transport stream, while
`stop_reason` carries semantics. The Agent SDK separately emits partial
assistant events, a complete assistant message, and a final result for the
whole agent loop. Managed Agents go further: persisted events are authoritative,
while `event_delta`/`content_delta` are best-effort previews that are not
persisted or replayed. This is direct evidence against naming Osfo's durable
fact a delta. See [Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output),
and [Managed Agents events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming).

### LangGraph and Google ADK

LangGraph exposes message/content-block deltas and run-scoped event sequences,
while checkpoints persist graph state. Its `interrupt` is normally resumable
workflow pause, so it must not define Osfo's terminal output meaning. Google ADK
stores ordered `Event`s but explicitly does not persist partial events; it
derives a final response through a predicate rather than an explicit terminal
event. See [LangGraph event streaming](https://docs.langchain.com/oss/python/langgraph/event-streaming),
[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence),
and Google ADK's [`Event`](https://github.com/google/adk-python/blob/d9c5a129d8aeedb33ce13ad0dffde147eefac929/src/google/adk/events/event.py#L92-L157)
and [`append_event`](https://github.com/google/adk-python/blob/d9c5a129d8aeedb33ce13ad0dffde147eefac929/src/google/adk/sessions/base_session_service.py#L154-L165).

### Temporal

Temporal's `HistoryEvent` has a monotonically increasing `event_id`, and event
types are scope-qualified facts such as `WorkflowExecutionCompleted`,
`WorkflowExecutionFailed`, `WorkflowExecutionCanceled`, and
`WorkflowExecutionTimedOut`. Its best lesson is naming, not direct reuse:
Workflow replay rebuilds workflow state, while history page tokens and event IDs
do not define Osfo client delivery. See the
[Temporal protocol reference](https://api-docs.temporal.io/), especially
`HistoryEvent` and `EventType`.

### Vercel AI SDK and PydanticAI

Vercel uses `UIMessageChunk` as a broad wire union, then text-specific
`text-start`, `text-delta`, and `text-end`. `finish`, `abort`, and `error` are
separate and overlapping transport/runtime outcomes. PydanticAI's
`TextPartDelta` mutates a streamed response part, while `output` means the final
validated AgentRun result. Both show why raw `chunk`, `delta`, `finish`, and
`final result` should not be copied into Osfo's durable layer. See Vercel's
[`UIMessageChunk`](https://github.com/vercel/ai/blob/e84b8bc8154030cdb7469b0e0b8cd8b9354f19a0/packages/ai/src/ui-message-stream/ui-message-chunks.ts#L226-L398)
and PydanticAI's
[`PartDeltaEvent`](https://github.com/pydantic/pydantic-ai/blob/v2.21.0/pydantic_ai_slim/pydantic_ai/messages.py#L3313-L3378).

### graph-flow and OpenPoke

graph-flow has a complete `TaskResult.response` and workflow
`ExecutionStatus::{Paused, WaitingForInput, Completed}`, but no streamed output
primitive. Its `Session.version` is an optimistic-lock value. OpenPoke forces
non-streaming provider calls, persists whole `poke_reply` values, reloads full
history, and synthesizes UI IDs. They are useful counterexamples rather than
naming authorities for this contract.

## Assistant-output candidate grading

| Rank | Event family | Precision | Familiar | Durable | Lifecycle | Neutral | Projection | Rust | Total |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `AssistantOutputAppended` → `Completed \| Interrupted` | 5 | 4 | 5 | 5 | 5 | 5 | 5 | **34/35** |
| 2 | `AssistantMessageContentAppended` → `Completed \| Interrupted` | 5 | 4 | 5 | 5 | 4 | 5 | 4 | **32/35** |
| 3 | `AssistantTextAppended` → `OutputCompleted \| OutputInterrupted` | 5 | 4 | 5 | 4 | 4 | 5 | 5 | **32/35** |
| 4 | `AssistantOutputChunk` → `Completed \| Interrupted` | 3 | 5 | 3 | 5 | 5 | 3 | 5 | **29/35** |
| 5 | `AssistantOutputFinished { outcome }` | 3 | 4 | 4 | 3 | 5 | 3 | 5 | **27/35** |
| 6 | `AssistantMessageDelta` → `Completed \| Incomplete` | 4 | 5 | 2 | 4 | 3 | 4 | 4 | **26/35** |

`AssistantOutputAppended` wins because it names the canonical state transition,
not the shape or origin of its payload. The payload may still contain a bounded
`fragment`; the buffering implementation may still call that fragment a
`chunk`. Neither noun needs to become the event's semantic name.

`AssistantOutput` is preferable to `AssistantMessage` here because one output
attempt may eventually contain typed or multimodal content, and because tool
and workflow facts are separate ThreadEvent families. The `Assistant` prefix
prevents PydanticAI's broader “final run output” meaning from leaking in.

## Recommended Osfo glossary

These are domain primitives. Concrete event variants follow in the next
section.

| Primitive | Recommended definition | Avoid |
|---|---|---|
| `Thread` | The sole authoritative ordered conversational scope of a Single-Thread Agent. | account timeline, device conversation |
| `ThreadEvent` | An immutable fact at one stable position in a Thread, retained for durable replay, reconstruction, or explanation. | provider event, runtime log |
| `ThreadPosition` | The monotonically increasing order assigned to a committed ThreadEvent within one Thread. | timestamp order, provider sequence |
| `ThreadCursor` | An opaque client resume token representing the last Thread position that client applied. | provider cursor, page token |
| `AgentRun` | One durable, bounded attempt to advance a Thread for an accepted message. | worker, process, model turn |
| `AgentEvent` | A fact or update emitted while an AgentRun executes; only explicitly promoted families become ThreadEvents. | ThreadEvent, provider event |
| `ModelTurn` | One provider/model call within an AgentRun. Useful internal runtime vocabulary, not the conversational ordering authority. | AgentRun, Thread turn |
| `AssistantOutput` | One identified, client-visible assistant response attempt belonging to an AgentRun. It terminates as completed or interrupted. | final result, provider response |
| `ToolCall` | A model's request to invoke a named tool with typed input; it does not prove the tool executed. | tool execution, tool result |
| `ToolResult` | The correlated terminal value or error produced for a ToolCall and made available to the agent. | tool call, raw process log |
| `ApprovalRequest` | A durable request for an authorized principal to decide whether proposed work may proceed. | prompt, confirmation string |
| `ApprovalDecision` | The correlated grant or denial of an ApprovalRequest. | tool result, user message |
| `WorkflowInstance` | Independently durable work that may wait, retry, or outlive the AgentRun that started it. | long-running AgentRun, worker |
| `Compaction` | A rebuildable context projection over an exact ThreadEvent range; it is not canonical history. | summary event log, deletion |

## Recommended ThreadEvent families

Use scope-qualified, past-tense facts:

```text
UserMessageAccepted

AssistantOutputAppended
AssistantOutputCompleted
AssistantOutputInterrupted { cause }

ToolCallRequested
ToolResultProduced

ApprovalRequested
ApprovalGranted
ApprovalDenied

AgentRunCompleted
AgentRunFailed
AgentRunCancelled
AgentRunInterrupted

WorkflowStarted
WorkflowProgressed
WorkflowCompleted
WorkflowFailed
WorkflowCancelled
```

`ToolCallRequested` is intentionally not `ToolInvoked`: approval or validation
may prevent execution. If the product later needs actual execution-start facts,
add a distinct `ToolExecutionStarted`; do not change the meaning of ToolCall.

The three assistant-output events share an `output_id`. `Appended` carries one
bounded committed fragment. Exactly one terminal event follows. A retry uses a
new output identity.

```text
raw TextDelta*
      |
   coalesce
      |
AssistantOutputAppended*
      |
      +--> AssistantOutputCompleted
      |
      `--> AssistantOutputInterrupted { cause }
```

## Recommended shape

Keep the vocabulary and its invariants at the `osfo-session` interface. Provider
adapters translate raw deltas into AgentEvents. The session implementation
coalesces, promotes, appends, and allocates Thread positions atomically. Clients
see only committed ThreadEvents and opaque ThreadCursors.

Do not create `osfo-protocol` merely to house these names. Extract a separate
module only when independently versioned wire consumers or separate authority
earn that seam.

## Caveats and invalidation conditions

- If Osfo decides every output attempt is exactly one user-visible chat message
  forever, `AssistantMessageContentAppended` becomes competitive with
  `AssistantOutputAppended`.
- If only text can ever stream, `AssistantTextAppended` is more precise, but it
  makes future structured or multimodal fragments a schema break.
- `Interrupted` must mean terminal for one AssistantOutput. It must not inherit
  LangGraph or Google ADK's common meaning of “paused and resumable.”
- `Completed` describes successful output termination, not a successful
  AgentRun or WorkflowInstance. Those lifecycles retain their own terminal
  events.
- Comparable cursors are usually provider-response sequences, checkpoint IDs,
  pagination tokens, timestamps, or active-stream IDs. None should replace
  Osfo's ThreadPosition/ThreadCursor contract.

## Primary sources

All sources were accessed 2026-07-31.

- [Rig source](https://github.com/0xPlaygrounds/rig/tree/6cfae6d829da21f9dc9e775e065fee157b264f7e)
- [OpenAI Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming/response/content_part)
- [OpenAI Agents SDK streaming](https://openai.github.io/openai-agents-python/streaming/)
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Anthropic Managed Agents events and streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)
- [LangGraph event streaming](https://docs.langchain.com/oss/python/langgraph/event-streaming)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Google ADK Event source](https://github.com/google/adk-python/blob/d9c5a129d8aeedb33ce13ad0dffde147eefac929/src/google/adk/events/event.py)
- [Temporal protocol documentation](https://api-docs.temporal.io/)
- [Vercel AI SDK source](https://github.com/vercel/ai/tree/e84b8bc8154030cdb7469b0e0b8cd8b9354f19a0)
- [PydanticAI v2.21.0](https://github.com/pydantic/pydantic-ai/tree/v2.21.0)
- [graph-flow source](https://github.com/a-agmon/rs-graph-llm/tree/f18bf6a197fda9ee47f2ad21a625e985740e0cbb/graph-flow)
- [OpenPoke source](https://github.com/shlokkhemani/openpoke)
