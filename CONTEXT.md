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
Single-Thread Agent. Oz is a long-lived, deployable Agent Application, not a
disposable demo or test harness.
_Avoid_: Osfo, TryAgent

**Production Workload Envelope**:
The topology-neutral demand model that relates incoming messages to derived
Osfo work, traffic shape, sustained capacity, and stress characterization.
Each workload unit remains distinct and internal amplification comes from a
versioned reference trace rather than becoming a product SLO.
_Avoid_: Benchmark target, AgentRun throughput target, DAU target

**Reference Workload Trace**:
A versioned, reproducible incoming-message trace whose observed work mix and
amplification represent production-shaped Oz behavior.
_Avoid_: Synthetic benchmark, worst-case workload

**Challenge Lane**:
A focused workload that stresses one amplification, fairness, recovery, or
delivery dimension independently of the Reference Workload Trace.
_Avoid_: Production traffic forecast, simultaneous worst case

**Production Acceptance Corpus**:
The retained-data shape at which every production SLO and correctness gate
must pass.
_Avoid_: Clean database, empty benchmark corpus

**Growth Corpus**:
A mandatory deeper-history or wider-identity retained-data shape used to test
correctness and scaling behavior without inventing v1 latency or cost SLOs.
_Avoid_: Production acceptance corpus, capacity promise

**Good Root Outcome**:
The authoritative root outcome for one accepted incoming message that passes
its Reference Workload Trace journey's versioned acceptance assertions before
that journey's Evaluation Deadline.
_Avoid_: Useful Completion, successful AgentRun, terminal response

**Good Root Outcome Ratio**:
Good Root Outcomes divided by accepted incoming messages whose evaluation
windows have closed. System failures and deadline misses remain in the
denominator; overload rejections remain in the admission SLI.
_Avoid_: Success rate over completed work, admission success rate

**Goodput**:
The number of Good Root Outcomes produced per second.
_Avoid_: AgentRun throughput, terminal response rate

**Goodput Knee**:
The first offered-demand region where additional demand no longer increases
Goodput acceptably or first violates an outcome, latency, backlog, correctness,
recovery, or bounded-resource gate.
_Avoid_: First rejection, peak AgentRun throughput, benchmark maximum

**Recovery Reserve**:
The measured processing capacity above current accepted demand that drains
recovery backlog within its deadline. It is proven through goodput and backlog
slope rather than inferred from provisioned resources or autoscaling limits.
_Avoid_: Spare instance count, autoscaling maximum, nominal headroom

**First Meaningful ThreadEvent**:
The first durable client-visible ThreadEvent after message acceptance that
provides output, progress, an approval request, a declared wait, or a terminal
outcome.
_Avoid_: Heartbeat, non-durable model token, transport notification

**Single-Thread Agent**:
An agent reached through one canonical ordered conversation, independent of the
devices used to participate in it. The term describes conversational identity,
not compute concurrency.
_Avoid_: Single-threaded process, one worker per agent

**Principal**:
The authenticated actor whose work shares admission limits and scheduler
fairness policy. Oz v1 maps one authenticated user to one Principal.
_Avoid_: Thread, device, parent AgentRun, tenant hierarchy

**Authentication Session**:
Independently revocable authentication state through which a client acts as one
Principal. It does not own Thread identity, cursor progress, or device identity.

**Thread**:
The canonical ordered conversational scope of a Single-Thread Agent, owned by
exactly one Principal. Every authorized client observes and resumes the same
Thread order; accounts and devices do not define competing conversation
sequences.
_Avoid_: Account timeline, device thread

**ThreadEvent**:
An immutable, per-Thread sequenced record of a conversational fact required for
durable replay, reconstruction, or explanation.
_Avoid_: Runtime log, provider event

**UserMessage**:
One immutable client-submitted input accepted into a Thread. Its identity is
distinct from the ThreadEvent that records it, the AgentRun it creates, and its
Acceptance Receipt.

**UserMessageAppended**:
A ThreadEvent recording that one UserMessage was durably added to a Thread and
correlated with its resulting AgentRun.

**ThreadPosition**:
The stable, monotonically increasing order of a committed ThreadEvent within
one Thread.
_Avoid_: Timestamp order, provider sequence

**ThreadCursor**:
An opaque resume token representing the last ThreadPosition a client applied.
_Avoid_: Provider cursor, pagination token

**Thread Snapshot**:
A versioned, complete, self-consistent client projection of one Thread through
cursor H. It is derived from canonical ThreadEvents and can bootstrap or replace
client-derived state. It is not canonical history and does not replace or
rewrite ThreadEvents.

**Context Projection**:
A versioned, rebuildable Thread-scoped derivation of canonical ThreadEvent
history used to assemble bounded context for future Agent Runtime input. It is
not AgentRun recovery authority and never replaces canonical history.
_Avoid_: RuntimeCheckpointRef, canonical summary, memory record

**ContextProjectionRef**:
An immutable reference selected during AgentRun context preparation and
recorded before Agent Runtime evaluation. It identifies the exact Context
Projection generation used as that evaluation's historical base.
_Avoid_: RuntimeCheckpointRef, admission-time snapshot, mutable context pointer

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
interaction rather than an AgentRun terminal state.
_Avoid_: Worker, process, Temporal Workflow, Agent Runtime state machine

**AgentRunSucceeded**:
The terminal ThreadEvent stating that one AgentRun completed successfully.

**AgentRunFailed**:
The terminal ThreadEvent stating that one AgentRun failed with a normalized,
client-safe cause.

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
One identified logical model operation within an AgentRun. Its typed intent is
durable before dispatch, it may have multiple ModelCallAttempts, and it has
exactly one final normalized semantic outcome. Raw provider payloads are not
recovery authority.
_Avoid_: ModelCallAttempt, AgentRun, AssistantOutput, provider request

**ModelCallAttempt**:
One recorded, accountable logical provider request for a ModelCall. It may
reconnect or resume the same provider operation, but issuing another logical
request requires another attempt; each attempt records its binding, outcome,
and Reported, Estimated, or Unknown usage. Reported input, output, and optional
reasoning units preserve the provider's separate measures; Osfo does not infer
that reasoning units are a subset of output units.
_Avoid_: ModelCall, TCP connection, hidden SDK retry

**ModelCallExecutor**:
The Osfo-owned execution interface that accepts one committed ModelCallAttempt
and emits normalized observations without owning ModelCall retry or lifecycle
policy. Concrete Model Adapters implement this interface.
_Avoid_: Agent Runtime, model provider, uncommitted ModelCall

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
The authority-free decision module that examines a derived view of recorded
AgentRun state and proposes one typed next step. It never invokes models,
executes tools, or directly commits AgentRun lifecycle or canonical Thread
state.
_Avoid_: Agent provider, model provider, AgentRun manager, worker

**ExecutionProfileRef**:
An immutable versioned reference pinned by an AgentRun to the Agent
Application's runtime behavior, model policy, prompt rules, tool schemas, and
initial execution limits. Osfo owns the manifest schema and interpretation;
the Agent Application owns each concrete profile.
_Avoid_: RuntimeCheckpointRef, mutable configuration, credential reference

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

**AgentRunCancellationRequested**:
A ThreadEvent recording that durable cancellation won for a non-terminal
AgentRun. If active work exists, the AgentRun remains Running while normal
completion, ordinary output, and new child work are closed and bounded cleanup
proceeds.

**AgentRunCanceled**:
The terminal ThreadEvent stating that one AgentRun was canceled, together with
its completed or deadline-exceeded cleanup disposition and whether external work
may continue.

**Waiting AgentRun**:
An AgentRun lifecycle state in which the run is non-runnable until one
referenced durable wake condition is satisfied, after which it becomes a
Pending AgentRun. Waiting does not create a separate work identity.
_Avoid_: AgentRunWait, paused worker, sandbox pause, WorkflowInstance

**Declared Wait**:
A client-visible durable suspension of one Waiting AgentRun, identified by one
WaitId and correlated with one typed wake subject. It resolves once as
satisfied, timed out, or canceled without becoming a separate work identity.
_Avoid_: Waiting AgentRun, retry delay, Approval Request, WorkflowInstance

**User-visible Progress**:
An explicitly promoted bounded update to one open ToolCall, WorkflowInstance,
or Child AgentRun. It is a conversational fact, not operational telemetry or a
separate work identity.
_Avoid_: Runtime log, retry status, metric, progress entity

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

**RunCode**:
A bounded, Python-first ToolCall that creates one disposable E2B Sandbox,
stages immutable source and logically named Client Content inputs, executes one
supervised process tree, exports explicitly selected verified results, and
destroys the Sandbox. It never hosts the Agent Runtime or durable coordination.
_Avoid_: Bash terminal, AgentRun workspace, persistent workspace, subagent runtime

**Sandbox**:
An isolated E2B execution environment owned by exactly one RunCode ToolCall.
It never owns AgentRun lifecycle, recovery authority, durable waits, ChildJoin
coordination, or authoritative artifacts.
_Avoid_: Thread workspace, Principal workspace, worker environment, Agent Runtime

**Sandbox Profile**:
An immutable, versioned declaration of the sandbox capabilities, resource and
network policy, exact E2B template build, and SDK compatibility required by an
Execution Profile. Compatibility is validated exactly rather than negotiated
while an AgentRun executes.
_Avoid_: Runtime capability probe, mutable sandbox configuration, provider session

**SandboxRef**:
An optional durable reference to sandbox-provider-defined execution environment
state. It is a possible future restoration accelerator, never AgentRun recovery
authority or the sole reference to an authoritative artifact. Disposable v1
RunCode ToolCalls do not create or restore SandboxRefs.
_Avoid_: RuntimeCheckpointRef, AgentRunCheckpoint, paused AgentRun

**ArtifactRef**:
An immutable durable domain value containing a Client Content reference plus a
versioned artifact role and interpretation. It has no separate identity; its
client projection is the contained ClientContentRefV1. Authoritative sandbox
content is race-safely snapshotted, exported, and verified before commitment.
_Avoid_: Sandbox path, SandboxRef, RuntimeCheckpointRef

**Operation Gate**:
The effective authorization outcome for one exact committed Action:
`deny`, `require approval`, or `permit`, ordered from strictest to weakest. The
Agent Application sets the governing policy; the Agent Runtime may require a
stricter outcome from instruction evidence but can never weaken policy. An
instruction such as "do not confirm" is not authority.

**Approval**:
An authorized decision bound to one exact committed Action that passed an
Operation Gate requiring approval. A material change creates a new Action
and requires a new approval; the Agent Application determines who may approve.
Approval satisfies human consent but does not replace the current authorization
check required before a new external call.
_Avoid_: Authorization policy, reusable consent, approval of mutable intent

**Approval Request**:
A finite-lived durable request for an authorized actor to approve or deny one
exact committed Action. It has its own stable identity and a deterministic,
versioned client-safe presentation of every material field and consequence. It
moves once from pending to approved, denied, expired, or canceled; the first
valid terminal transition wins.
_Avoid_: Mutable prompt, reusable consent, authorization policy

**Action**:
The semantic classification of one exact, durably committed effectful ToolCall.
Its versioned tool definition owns that classification. It reuses the ToolCall
identity, has a stable idempotency key, may require Approval, and terminates as
applied, not applied, or unresolved. A read-only ToolCall is not an Action, and
the Agent Runtime cannot weaken either classification.
_Avoid_: ExternalEffectObligation, separate effect identity, mutable intent

**Action Success Boundary**:
The stable, versioned claim that defines exactly what `applied` proves for an
Action definition and which affirmative evidence satisfies it. Evidence of
non-application is also affirmative; missing evidence yields `unresolved`. Its
client-safe description states both what success proves and what it does not.
_Avoid_: Provider success message, delivery assumption, absence of an error

**Action Presentation**:
The immutable, client-safe title, description, and material fields of one
committed Action. Its versioned Action definition owns the presentation; it is
bound to the Action's internal digest and uses bounded safe values or typed
references for large or sensitive content.
_Avoid_: Mutable summary, raw Action payload, approval hash

**Client Content**:
Client-safe content represented as bounded inline text or an immutable stored
content reference carrying a stable ContentId, media type, byte length, and
SHA-256 digest. Referenced bytes are retrieved under Thread authorization.
_Avoid_: Provider file ID, expiring download URL, raw storage location

**ContentId**:
The stable server-issued identity of one immutable stored Client Content byte
sequence. It is not a content-addressed ID or a bearer credential.
_Avoid_: File ID, blob URL, SHA-256 digest

**Action Attempt**:
One private durably recorded attempt to execute an Action. It is recorded
before any external call; an unknown outcome blocks blind retry.
_Avoid_: Action, network connection

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

**Osfo API**:
Osfo's direct HTTP interface for adding input to a Thread and observing its
canonical ThreadEvents across live delivery and durable resume. It is the
default interface for Osfo-owned clients, not an Adapter for an external
protocol.
_Avoid_: Native Thread Transport, Web Adapter, OpenAI-Compatible Adapter,
Messaging Adapter

**Acceptance Receipt**:
Immutable evidence that Osfo durably accepted one idempotent API operation.
Identical retries return the same receipt without creating another canonical
transition.

**ActionReceipt**:
Immutable terminal, client-safe evidence of the final knowledge state of one
Action, keyed by its ToolCall identity. It distinguishes confirmed application,
confirmed non-application, and unresolved uncertainty; it never treats
acceptance as proof that an external effect occurred. It names the Action
definition and Action Success Boundary with stable versions and may carry closed
client-safe evidence references. Read-only ToolCalls do not produce
ActionReceipts.
_Avoid_: Acceptance Receipt, mutable status, provider response

**OpenAI-Compatible Adapter**:
A reusable Adapter implementation that exposes selected Osfo behavior through
OpenAI-compatible HTTP protocols for third-party clients and web interfaces.
Compatibility does not make client-supplied history authoritative over a
Thread.
_Avoid_: Web Messaging Adapter, canonical Osfo protocol
