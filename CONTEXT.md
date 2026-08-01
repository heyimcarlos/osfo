# Osfo Context

Osfo defines reusable semantics for agent systems. Deployable products compose
Osfo without making their product-specific rules part of Osfo.

## Language

**Osfo**:
A reusable semantic foundation for building agent systems. Products depend on
Osfo; they do not define its domain.
_Avoid_: TryAgent backend, product application

**Agent Application**:
A deployable agent product that selects, configures, and constrains reusable
Osfo modules and Adapter implementations for a particular use case. TryAgent
and Oz are separate Agent Applications.
_Avoid_: Product Composition, Osfo instance, Osfo product

**Reference Agent Application**:
An Agent Application maintained to prove and document how reusable Osfo
modules compose. The Single-Thread Agent demo is the initial reference.
_Avoid_: Reference Product Composition, Osfo core, throwaway sample

**Oz**:
The initial Reference Agent Application built with Osfo. Oz v1 is a
Single-Thread Agent.
_Avoid_: Osfo, TryAgent

**Single-Thread Agent**:
An agent reached through one canonical ordered conversation, independent of the
devices used to participate in it. The term describes conversational identity,
not compute concurrency.
_Avoid_: Single-threaded process, one worker per agent

**Thread**:
The canonical ordered conversational scope of a Single-Thread Agent. Every
device observes and resumes the same Thread order; accounts and devices do not
define competing conversation sequences.
_Avoid_: Account timeline, device thread

**ThreadEvent**:
An immutable, per-Thread sequenced record of a conversational fact required for
durable replay, reconstruction, or explanation.
_Avoid_: Runtime log, provider event

**ThreadPosition**:
The stable, monotonically increasing order of a committed ThreadEvent within
one Thread.
_Avoid_: Timestamp order, provider sequence

**ThreadCursor**:
An opaque resume token representing the last ThreadPosition a client applied.
_Avoid_: Provider cursor, pagination token

**AgentEvent**:
An event emitted while an AgentRun executes. An AgentEvent becomes a
ThreadEvent only when it represents a durable conversational fact.
_Avoid_: ThreadEvent, provider event

**AssistantOutput**:
One identified, client-visible assistant response attempt within an AgentRun.
It terminates as completed or interrupted; a retry is a new AssistantOutput.
_Avoid_: Provider response, final result, output chunk

**AssistantOutputAppended**:
A ThreadEvent recording a committed fragment added to one AssistantOutput.
_Avoid_: AssistantOutputChunk, provider delta

**AssistantOutputCompleted**:
The terminal ThreadEvent stating that one AssistantOutput finished
successfully.
_Avoid_: Thread completed, AgentRun completed

**AssistantOutputInterrupted**:
The terminal ThreadEvent stating that one AssistantOutput cannot continue,
together with its cause.
_Avoid_: Completed output, client disconnect

**AgentRun**:
The durable, bounded unit of conversational work created for an accepted
message. Any compatible worker may execute it; it is not a process, container,
or dedicated compute resource.
_Avoid_: Worker, process, Temporal Workflow

**WorkflowInstance**:
Independently durable work that may wait, retry, or outlive the AgentRun that
started it. It reports typed outcomes to the originating Thread.
_Avoid_: Long-running AgentRun, background thread

**Channel Endpoint**:
An external messaging address through which a person reaches a Single-Thread
Agent. The endpoint is a transport boundary, not the agent or its conversation.
_Avoid_: Agent identity, Thread

**Messaging Adapter**:
A reusable Adapter implementation that translates one external messaging
transport to and from Osfo's transport-neutral conversation semantics. It does
not own the Thread or agent identity.
_Avoid_: Channel Edge, messaging provider, conversation store

**AdapterId**:
The stable identity of one configured Adapter in an Agent Application. It
scopes conversation keys and routing, not conversational authority.
_Avoid_: AdapterInstallationId, provider account ID, ThreadId

**ConversationKey**:
An opaque, AdapterId-scoped identity for one conversation on an external
protocol. Each `(AdapterId, ConversationKey)` maps to a separate Thread by
default.
_Avoid_: ProviderConversationKey, provider thread ID, ThreadId

**Thread Binding**:
The Agent Application association from an AdapterId and ConversationKey to a
Thread. Sharing or moving a Thread across Adapters requires an explicit binding
decision.
_Avoid_: Provider conversation, automatic account merge

**Native Thread Transport**:
Osfo's direct client boundary for adding input to a Thread and observing its
canonical ThreadEvents across live delivery and durable resume. It is the
default transport for Osfo-owned clients, not an Adapter for an external
protocol.
_Avoid_: Web Adapter, OpenAI-Compatible Adapter, Messaging Adapter

**OpenAI-Compatible Adapter**:
A reusable Adapter implementation that exposes selected Osfo behavior through
OpenAI-compatible HTTP protocols for third-party clients and web interfaces.
Compatibility does not make client-supplied history authoritative over a
Thread.
_Avoid_: Web Messaging Adapter, canonical Osfo protocol
