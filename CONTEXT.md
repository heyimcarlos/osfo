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
or dedicated compute resource, and it may wait and later continue without
changing identity. Its lifecycle and ordered typed interaction history are the
authority for logical recovery. It pins the versioned semantic configuration
needed to interpret those records throughout its lifetime. It terminates only
as succeeded, failed, or canceled; interruption describes an incomplete
interaction rather than a fourth AgentRun terminal state.
_Avoid_: Worker, process, Temporal Workflow, Agent Runtime state machine

**Proactive AgentRun**:
An AgentRun admitted from an authorized durable trigger rather than a new user
message. It creates new conversational work and does not resume or continue the
AgentRun that originally scheduled the trigger.
_Avoid_: Detached Workflow, continuation AgentRun, direct ThreadEvent append

**Child AgentRun**:
An AgentRun admitted by another AgentRun through a fenced, idempotent admission.
It has its own durable identity and stable parent and root lineage. It is created
atomically with its typed input and join membership and is independently
dispatchable within the root run's delegation limits. It receives an immutable,
versioned input contract and exposes one typed terminal outcome; its parent does
not consume the child's internal interaction history or execution state. Its
ModelCalls, ToolCalls, and assistant text are not canonical parent Thread
conversation; only explicit child lifecycle facts may be promoted.
_Avoid_: In-process task, continuation AgentRun, WorkflowInstance

**ChildJoin**:
The Osfo-owned durable condition correlating one parent AgentRun with a stable
set of Child AgentRuns and their typed terminal outcomes. `AllTerminal` satisfies
when every child is terminal. `FirstSuccessful` satisfies on the first committed
success, or with aggregate failure when no child succeeds. A ChildJoin wakes its
parent exactly once. It may have an Osfo-owned durable deadline that settles the
join with a typed timeout outcome without discarding already committed child
outcomes; late outcomes cannot reopen a settled join. Accepting a child's
terminal outcome atomically advances the join and, when newly satisfied, wakes
the parent.
_Avoid_: WorkflowInstance, generic condition expression, child AgentRun

**ModelCall**:
One identified model operation within an AgentRun. Its typed intent is durable
before provider dispatch. A provider response becomes authoritative only when
its normalized semantic outcome is durably committed, so an interrupted call
may be retried under bounded policy. Raw provider payloads are not recovery
authority.
_Avoid_: AgentRun, AssistantOutput, ModelTurn, raw provider request

**ToolCall**:
One identified logical tool operation within an AgentRun. Its durable intent is
committed once, bounded execution retries retain the same identity, and exactly
one terminal semantic outcome is committed. A ToolCall remains within its
AgentRun only while its lifecycle is bounded by that run; independently durable
work starts a WorkflowInstance. When its result is required for continuation,
the ToolCall remains logically open while the same AgentRun waits and completes
only when the typed workflow outcome is accepted. Execution-attempt details do
not create duplicate conversational events.
_Avoid_: Tool execution attempt, tool result, WorkflowInstance

**Agent Runtime**:
The execution implementation that drives one AgentRunAttempt's model and
bounded ToolCall loop through typed execution steps under Osfo lifecycle
authority. It proposes actions from reconstructed state but cannot directly
commit AgentRun identity, scheduling, recovery, or canonical Thread state.
_Avoid_: Agent provider, model provider, AgentRun manager, worker

**AgentRunAttempt**:
One fenced worker execution of an AgentRun, identified by the AgentRun and its
claim epoch. A new attempt changes execution authority without changing the
AgentRun identity. Direct takeover after lease expiry creates a new attempt
without consuming operation retry budget.
_Avoid_: AgentRun, operation retry, resumed process, sandbox session

**Pending AgentRun**:
An AgentRun lifecycle state that is immediately eligible for a new claim when
compatible execution capacity is available. Newly accepted and newly awakened
AgentRuns enter this state.
_Avoid_: Waiting AgentRun, Retry-ready AgentRun, running worker

**Running AgentRun**:
An AgentRun lifecycle state with a current fenced AgentRunAttempt and finite
lease. Lease expiry permits direct takeover through a new claim epoch.
_Avoid_: Worker process, sandbox session, operation retry

**Waiting AgentRun**:
An AgentRun lifecycle state in which the run is non-runnable until one
referenced durable wake condition is satisfied, after which it becomes a
Pending AgentRun. Waiting does not create a separate work identity.
_Avoid_: AgentRunWait, paused worker, sandbox pause, WorkflowInstance

**Retry-ready AgentRun**:
An AgentRun lifecycle state following a classified retryable failure. It is
claimable only after its eligible time and backoff requirements are satisfied,
and it carries the applicable operation retry-budget effect. Claiming it does
not require an intermediate Pending AgentRun transition.
_Avoid_: Lease takeover, Waiting AgentRun, new AgentRun

**RuntimeCheckpointRef**:
An optional durable reference to agent-runtime-defined continuation state. It
may accelerate compatible continuation but is never the sole authority for
Osfo recovery.
_Avoid_: AgentRunCheckpoint, ThreadEvent, SandboxRef

**SandboxRef**:
An optional durable reference to sandbox-provider-defined execution environment
state. It may accelerate compatible restoration but never owns AgentRun
lifecycle or Osfo recovery authority and cannot be the sole reference to an
authoritative artifact.
_Avoid_: RuntimeCheckpointRef, AgentRunCheckpoint, paused AgentRun

**ArtifactRef**:
An immutable durable reference to content required by a committed semantic
outcome, together with integrity and interpretation metadata. Authoritative
content produced in a sandbox is exported and verified before its ArtifactRef
is committed.
_Avoid_: Sandbox path, SandboxRef, RuntimeCheckpointRef

**WorkflowInstance**:
Independently durable work that may wait, retry, or outlive the AgentRun that
started it. Temporal owns its internal execution lifecycle; Osfo owns its
correlation to AgentRuns and Threads and accepts its typed outcomes. Its
invocation mode is Awaited or Detached.
Osfo durably assigns the WorkflowInstance identity and records the start intent
before requesting its idempotent creation in Temporal.
Temporal reports stably identified typed facts through Osfo and never writes
AgentRun state or canonical ThreadEvents directly. Intermediate progress is
operational by default and becomes a ThreadEvent only through an explicitly
user-visible event family.
_Avoid_: Long-running AgentRun, background thread

**Awaited Workflow**:
A ToolCall-to-WorkflowInstance invocation mode in which the ToolCall remains
open and its AgentRun waits. The accepted terminal workflow outcome completes
the ToolCall and wakes the same AgentRun. Canceling the AgentRun terminalizes
the ToolCall as canceled and requests cancellation of the WorkflowInstance.
_Avoid_: WorkflowInstance type, continuation AgentRun, paused worker

**Detached Workflow**:
A ToolCall-to-WorkflowInstance invocation mode in which durable workflow
acceptance completes the ToolCall with a WorkflowInstanceRef. The original
AgentRun does not wait or later resume for its outcome. A later workflow trigger
may admit a new proactive AgentRun. The workflow remains owned, correlated, and
observable. Canceling or completing the originating AgentRun does not cancel
the WorkflowInstance. A later workflow failure never rewrites the completed
ToolCall; it is a terminal workflow fact and may admit a Proactive AgentRun for
user notification.
_Avoid_: Fire-and-forget task, untracked background work, Waiting AgentRun

**Workflow Completion Policy**:
The declared rule for delivering a Detached Workflow's terminal outcome.
`RecordOnly` preserves the terminal workflow fact without creating
conversational work. `AdmitProactiveAgentRun` idempotently admits a new AgentRun
under normal authorization, admission, fairness, and capacity controls.
_Avoid_: Implicit notification, direct assistant message, resumed AgentRun

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
