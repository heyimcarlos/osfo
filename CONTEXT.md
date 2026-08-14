# Osfo Context

Osfo is a personal AI agent product for non-technical users. Osfo owns the
product rules, application behavior, and public identity described here.

## Language

**Osfo**:
The WhatsApp-only v1 personal agent product. Each User has one durable, private
Osfo Agent with memory, files, skills, triggers, and connected accounts, while
task compute is temporary and isolated. Later messaging channels are separate
product efforts.
_Avoid_: Integration library, agent builder, universal harness abstraction,
reference application

**Agent Harness**:
The selected third-party TypeScript framework that owns generic model and tool
loops, context behavior, delegation, and any native execution semantics Osfo
adopts. Osfo extends or translates it without rebuilding the same machinery.
_Avoid_: Model provider, Osfo runtime, Messaging Adapter

**Registration Turn**:
An ephemeral pre-registration interaction that presents the same visible Osfo
persona to an unregistered visitor and conducts the natural part of a
Registration Dialogue. It has no stable AgentId, Session, User memory,
entitlements, or external authority. It may use registration-scoped tools and
skills, and is deleted after registration or expiry.
_Avoid_: Company Osfo Agent, anonymous personal Agent, registration authority,
Agent handoff

**Production Workload Envelope**:
The topology-neutral demand model that relates incoming messages to derived
Osfo work, traffic shape, sustained capacity, and stress characterization.
Each workload unit remains distinct and internal amplification comes from a
versioned reference trace rather than becoming a product SLO.
_Avoid_: Benchmark target, AgentRun throughput target, DAU target

**Reference Workload Trace**:
A versioned, reproducible incoming-message trace whose observed work mix and
amplification represent production-shaped Osfo behavior. Before beta evidence
exists, its declared assumptions derive from Plan mix and Usage Allowances.
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

**Bounded Beta Acceptance**:
The production gate that permits Osfo to serve only a declared limited cohort
after every beta correctness, reliability, and cost requirement passes.
_Avoid_: Public launch, prototype acceptance, partial production pass

**Scale-Qualified Public Launch**:
The production gate that permits Osfo to remove its beta cohort bound only after
every declared scale, retained-corpus, recovery, and cost requirement passes.
_Avoid_: Bounded beta, best-effort launch, benchmark completion

**Cold Osfo Agent Activation**:
An Osfo Agent request handled by a new observed runtime activation identity. First
use, idle eviction, deployment, and fault recovery remain separate cold causes.
_Avoid_: Slow request, inactive User, cold database query

**Warm Osfo Agent Activation**:
An Osfo Agent request handled by the same observed runtime activation identity as
its preceding request.
_Avoid_: Fast request, cached response, recently active User

**Osfo Contribution Margin**:
Subscription revenue less attributable platform, vendor, payment, observability,
support, and expected GM Summon costs for the same cohort and allowance periods.
_Avoid_: Vendor allowance, gross revenue, per-request model cost

**Good Root Outcome**:
The authoritative root outcome for one accepted incoming message that passes
its Reference Workload Trace journey's versioned reproducible acceptance
assertions before that journey's Evaluation Deadline. Subjective model quality
evaluation is separate.
_Avoid_: Useful Completion, successful AgentRun, terminal response, model score

**Model Quality Gate**:
The release verdict for one complete Osfo behavior configuration, evaluated with
independent journey and risk-class floors plus a non-regression comparison. It
remains separate from Good Root Outcome, Delivery, and system error budgets.
_Avoid_: Model benchmark, combined quality score, production SLO

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

**First Meaningful User Update**:
The first durable response, progress update, Approval request, Declared Wait,
Workflow Milestone, or terminal outcome committed after message acceptance.
Delivery timing remains a separate measurement.
_Avoid_: Heartbeat, non-durable model token, transport notification

**Channel Identity**:
A messaging-provider-asserted identifier for one sender, such as a WhatsApp
sender ID. It authenticates the channel interaction but is not the user's
durable Osfo ownership identity or sole recovery credential; an equal phone
number in a Phone Account remains separate verified evidence.
_Avoid_: User, Account, Phone Account

**User**:
The durable Osfo identity for one registered person, created only after User
Registration verifies its first Phone Account. A User owns one Osfo Agent in v1
and scopes ownership, admission, fairness, allowances, entitlements, and memory.
_Avoid_: Account, Channel Identity, Principal

**Account**:
A reusable authentication method linked to a User, such as SMS-verified phone,
passwordless email, federated identity, or passkey. Osfo v1 implements exactly one
Phone Account per User. Other Account types are later product decisions; none
is the User or a messaging identity.
_Avoid_: User, Channel Binding, subscription, Stripe customer

**Phone Account**:
An Account established by verifying control of one E.164 phone number through
an SMS challenge. Osfo v1 requires exactly one active Phone Account, which may be
replaced but not removed without a Deletion Case.
_Avoid_: User, Channel Identity, WhatsApp account, phone-number primary key

**User Registration**:
The transition that creates a User after an SMS challenge verifies its first
Phone Account. It also establishes its AuthSession, Osfo Agent, primary
conversation route, primary Session, and Free Plan without deriving their
identities from the phone number.
_Avoid_: Provisional User, Channel Binding, paid subscription

**Registration Invitation**:
A finite-lived invitation issued to an unbound Channel Identity or web
onboarding flow. It owns a Registration Token digest, expiry, and consumption
state and ends only as Consumed or Expired, but creates no User, Osfo Agent,
Session, memory, or allowance.
_Avoid_: Provisional User, Registration Token, anonymous conversation

**Registration Dialogue**:
The temporary pre-registration exchange presented as Osfo to an unbound Channel
Identity under one Registration Invitation. It contains at most one natural
Registration Turn, is not a Session, User memory, or authority source, and is
deleted after registration or expiry.
_Avoid_: Anonymous Session, Provisional User, Agent handoff

**Registration Token**:
The high-entropy secret carried in `https://osfo.ai/verify/<token>` that continues
one Registration Invitation. Osfo stores only its digest; it is not an Account,
AuthSession, or reusable authentication credential.
_Avoid_: UserId, OTP, permanent bearer token

**Phone Verification**:
The finite-lived SMS challenge that proves current control of one E.164 phone
number for registration or replacement. A successful challenge is consumed
exactly once without creating a Channel Binding or making the phone number a
UserId.
_Avoid_: Phone Account, Channel Identity, AuthSession

**Channel Binding**:
A revocable association between a Channel Identity and a User. It lets messages
from that provider identity act as the User without making the provider identity
a reusable Account or recovery authority. In v1, a User has at most one active
WhatsApp binding. Conflicts fail closed to manual support.
_Avoid_: AuthSession, permanent phone login, conversation ownership

**Free Plan**:
The no-cost Subscription established by User Registration. It gives a
registered User a bounded set of capabilities and managed usage without giving
unregistered contacts product access.
_Avoid_: Free trial, provisional access, unlimited free tier

**Adventurer Plan**:
The sole paid Subscription at Osfo v1 launch. It grants recurring, sensitive,
and higher-cost capabilities within bounded monthly Usage Allowances.
_Avoid_: Premium Plan, Pro Plan, unlimited plan, usage add-on

**Usage Allowance**:
A Plan-scoped quantity or cost budget that bounds eligible work without
granting authority. It is separate from Plan Entitlement and never creates an
overage charge.
_Avoid_: Plan Entitlement, message quota, pay-as-you-go balance

**Integration Connection**:
Revocable authority for Osfo to read or act through a third-party product such as
Gmail or Google Calendar. It remains separate from an Account even when one
OAuth consent flow explicitly establishes both.
_Avoid_: Account, implicit OAuth scope, Approval

**Model Access Policy**:
The Osfo-owned rule that chooses a managed model route for a request and applies
its Plan and cost budget. V1 does not expose model choice or a Provider
Connection.
_Avoid_: Model Adapter, provider credential, hard-coded model

**AuthSession**:
Short-lived, renewable authentication state through which a web client acts as
one User. It is Active until it ends as Expired or Revoked; rotating renewal
credentials cannot own Session identity, Channel identity, or device identity.
_Avoid_: Channel Binding, Account, permanent bearer token

**User Suspension**:
A durable administrative fact that blocks a User's protected operations without
changing or replacing the User. Recovery and deletion remain separate manual
policies.
_Avoid_: User lifecycle status, AuthSession revocation, allowance exhaustion

**Channel Binding Revocation**:
The durable end of one Channel Binding's authority to act as or deliver to a
User. It does not revoke the Phone Account or another Channel Binding.
_Avoid_: AuthSession revocation, User Suspension, channel delivery failure

**Plan Entitlement**:
A positive Subscription fact that makes one capability eligible for a User. It
does not by itself grant authority over an action or resource.
_Avoid_: Usage Allowance, Approval, paid User status

**Authorization Policy**:
The small deterministic default-deny table that decides whether one v1 launch
action is allowed for a User, resource, and current context. It uses exact Plan,
allowance, ownership, Integration Connection, Approval, User Suspension,
AuthSession revocation, Channel Binding revocation, and deletion-access facts.
_Avoid_: Agent judgment, generic permission framework, tool visibility

**Subscription**:
The User's commercial state that controls paid entitlements without changing
User Registration, Accounts, Channel Bindings, or AuthSessions.
_Avoid_: Account, registration state, identity revocation

**Problem**:
One unresolved User goal or obstacle in a Session that groups its distinct
Resolution Attempts. It references evidence in Think without copying the
conversation or owning Session history.
_Avoid_: Session, model topic, support ticket

**Resolution Attempt**:
One distinct proposed or performed solution for a Problem with durable evidence
in Think. It counts as failed only after explicit User feedback or objective
failure evidence.
_Avoid_: Model Call Attempt, Delivery Attempt, unsupported model judgment

**GM Summon**:
A paid User's explicitly confirmed request for privileged human escalation
after three failed Resolution Attempts for one open Problem in the same Session.
At most one GM Summon may be active per Session, and it promises no response time.
_Avoid_: HELP response, automatic escalation, support-time guarantee

**Deletion Case**:
The explicit administrative process that closes a User and applies the accepted
deletion and retention policy. A request immediately revokes access, but v1 does
not expose a general User lifecycle or automated deletion workflow.
_Avoid_: User Suspension, Account removal, immediate hard delete

**Osfo Agent**:
The durable personal agent owned by exactly one User. It has one stable AgentId
and can own several conversation routes and Sessions.
_Avoid_: User, Agent Harness, Durable Object instance

**AgentId**:
The stable internal identity of one Osfo Agent, minted when the Agent is created
during User Registration. It is not derived from an Account or Channel Identity.
_Avoid_: UserId, SessionId, provider account ID

**Conversation Route**:
A stable conversational address owned by one Osfo Agent. Each route has exactly
one current Session and can have historical Sessions.
_Avoid_: Session, Account, device

**Session**:
The durable ordered conversation history for one conversation route. A Session
survives context compaction and becomes historical only after an explicit reset
or another product action replaces it as the route's current Session.
_Avoid_: Model context window, fixed time window, message topic

**UserMessage**:
One immutable client-submitted input accepted into a Session and identified by an
Osfo-owned UserMessageId. Its identity is distinct from its Channel Message Key,
Think Submission, and Acceptance Receipt.

**Channel Message Key**:
The transport-scoped identity formed from one Channel Binding and the messaging
provider's message identifier. It deduplicates provider delivery without
becoming the UserMessageId.
_Avoid_: UserMessageId, Think SubmissionId, global provider message ID

**UserMessageAppended**:
The historical event name for recording that one UserMessage was durably added
to a conversation. Osfo v1 represents the accepted message in Session history and
correlates it through its Acceptance Receipt instead.

**Think Submission**:
The Think-owned bounded execution of one interactive or proactive turn. One
accepted UserMessage creates exactly one stable Think Submission; Think owns its
lifecycle, serialization, idempotency, cancellation, and crash recovery.
Duration alone does not create another work identity or require a Workflow.
_Avoid_: AgentRun, Durable Object activation, Osfo execution record

**Scheduled Task**:
An Agent-managed durable trigger for one future or recurring callback. Each
occurrence has a stable idempotency key and creates one proactive Think
Submission only when conversational work is required.
_Avoid_: Raw alarm, Think Submission, Workflow

**Agent Queue Task**:
An Agent-local durable callback for short, immediate, sequential,
non-conversational work. It is not a multi-step process, cross-Agent transport,
or Session ordering authority.
_Avoid_: Think Submission, Scheduled Task, Cloudflare Queue, Workflow

**Cloudflare Queue Message**:
An at-least-once system-wide asynchronous delivery for work outside one Osfo
Agent's local execution. Osfo v1 introduces it only for a concrete cross-Agent or
system-wide workload, never for interactive admission or Session ordering.
_Avoid_: Agent Queue Task, Think Submission, Session event

**Delivery**:
The durable obligation to send one committed Think response through a Channel
Binding. It owns one or more ordered Delivery Parts, and its ledger remains
authoritative after delivery work completes; a Delivery problem never changes
the committed response in the Session.
_Avoid_: Think Submission, provider message, managed Fiber

**Delivery Part**:
One stable ordered send unit within a Delivery. It owns one or more Delivery
Attempts, while provider message identities belong to those attempts.
_Avoid_: Separate Delivery, Delivery Attempt, Session message

**Managed Delivery Fiber**:
The idempotent Agent-managed job that sends one Delivery's ordered Delivery
Parts and recovers application execution. It stops after rejection or ambiguity
and never waits for later provider status webhooks.
_Avoid_: AgentRun, Delivery ledger, Think Submission, Workflow

**Delivery Attempt**:
One durably recorded provider call for a Delivery Part. It owns its optional
provider message identity and accepted, rejected, or ambiguous outcome; an
ambiguous outcome blocks automatic retry.
_Avoid_: Delivery, provider status webhook, blind retry

**Provider Delivery Status**:
A distinct provider-reported observation correlated to a Delivery Attempt by
its provider message identity. Confirmed progress never moves backward; failure
evidence and conflicting evidence remain explicit.
_Avoid_: Delivery Attempt result, Fiber status, Session history

**Osfo Memory System**:
The complete product capability that combines Native Memory and the Knowledge
Base to preserve continuity and personalize future work. A model context window
is a temporary view of this system, not durable memory.
_Avoid_: Knowledge Base, model context window, MemoryProvider

**Native Memory**:
The memory owned by one Osfo Agent. It contains Core Memory, Session Memory, and
Session Recall.
_Avoid_: Knowledge Base, MemoryProvider index, model context window

**Core Memory**:
The bounded Agent-wide memory included in every turn. It contains User Context
and Agent Notes.
_Avoid_: Session summary, Knowledge Base, provider profile

**User Context**:
The Agent's bounded and user-readable working model of the User's current
identity, durable preferences, communication style, and standing constraints.
It can contain direct facts and reasonable durable inferences.
_Avoid_: unquestionable truth record, full User profile, Session transcript

**Agent Notes**:
The Agent's bounded and user-readable working memory for current goals,
commitments, environment facts, and continuity that should be visible in every
turn.
_Avoid_: hidden reasoning, task log, Session transcript

**Session Memory**:
The messages, human-visible tool interactions, branches, and compaction overlays
owned by a Session. The Session persists while its bounded context view rolls
forward.
_Avoid_: Core Memory, Knowledge Base, model context window

**Session Recall**:
The model-invoked search of current and historical Session Memory for exact or
lexical conversation evidence.
_Avoid_: automatic every-turn retrieval, Knowledge Base recall, provider search

**Knowledge Base**:
The User-scoped semantic memory used for broad personalization and
query-relevant recall across the User's Sessions and routes. It is evidence for
the Agent, not the canonical record of what happened.
_Avoid_: Session transcript, Core Memory, product database

**MemoryProvider**:
The replaceable external capability that maintains and recalls the Knowledge
Base from committed conversation updates. Provider failure never blocks normal
conversation.
_Avoid_: Native Memory, model provider, canonical truth store

**SupermemoryMemoryProvider**:
The v1 MemoryProvider adapter. It maps `UserId` to the provider permission scope
and `SessionId` to the provider conversation identity without exposing provider
SDK types to Osfo callers.
_Avoid_: MemoryProvider interface, canonical memory store, generic document API

**Forget Knowledge**:
The User-requested removal of a remembered conclusion from Core Memory and the
Knowledge Base while preserving the original Session transcript.
_Avoid_: Delete Session, message deletion, account deletion

**Delete Session**:
The User-requested permanent deletion of one Session from Native Memory and the
Knowledge Base. Deleting a current Session first creates its replacement for the
same route.
_Avoid_: New Session, Forget Knowledge, context compaction

**AgentEvent**:
An event emitted while an AgentRun executes. An AgentEvent becomes a
Session event only when it represents a durable conversational fact.
_Avoid_: Session history, provider event

**AssistantOutput**:
One identified, client-visible assistant response attempt within an AgentRun.
It terminates as completed or interrupted; a retry is a new AssistantOutput.
_Avoid_: Provider response, final result, output chunk

**AssistantOutputAppended**:
A historical event name for a committed fragment added to one AssistantOutput.
_Avoid_: AssistantOutputChunk, provider delta

**AssistantOutputCompleted**:
The terminal event stating that one AssistantOutput finished
successfully.
_Avoid_: Session completed, AgentRun completed

**AssistantOutputInterrupted**:
The terminal event stating that one AssistantOutput cannot continue,
together with its cause.
_Avoid_: Completed output, client disconnect

**AgentRun**:
The historical Osfo-owned durable execution lifecycle for one bounded unit of
work. Osfo v1 does not create AgentRuns or use them as recovery authority; Think
Submission owns that lifecycle.
_Avoid_: Think Submission, current Osfo execution record

**AgentRunSucceeded**:
The terminal event stating that one AgentRun completed successfully.

**AgentRunFailed**:
The terminal event stating that one AgentRun failed with a normalized,
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
ModelCalls, ToolCalls, and assistant text are not canonical parent Session
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

**Model Adapter**:
A concrete integration that translates one Osfo-owned ModelCallAttempt into a
provider protocol and normalizes provider observations and outcomes back into
Osfo-owned values through ModelCallExecutor. It owns protocol translation and
provider conformance, but never AgentRun lifecycle, retry policy, canonical
Session state, credentials in durable records, or provider selection policy.
OpenRouter is one Model Adapter that Osfo can select, not an Osfo runtime
dependency or the identity of Osfo.
_Avoid_: Agent Runtime, model router, provider SDK wrapper

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
executes tools, or directly commits AgentRun lifecycle or canonical Session
state.
_Avoid_: Agent provider, model provider, AgentRun manager, worker

**ExecutionProfileRef**:
An immutable versioned reference pinned by an AgentRun to Osfo's runtime
behavior, model policy, prompt rules, tool schemas, and initial execution limits.
Osfo owns each concrete profile, its manifest schema, and its interpretation.
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
_Avoid_: Session workspace, User workspace, worker environment, Agent Runtime

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
Osfo-owned Authorization Policy sets the governing policy; the Agent Runtime may
require a stricter outcome from instruction evidence but can never weaken policy.
An instruction such as "do not confirm" is not authority.

**Approval**:
An authorized decision bound to one exact committed Action that passed an
Operation Gate requiring approval. A material change creates a new Action
and requires a new approval; Osfo determines who may approve. Approval satisfies
human consent but does not replace the current authorization check required
before a new external call.
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
SHA-256 digest. Referenced bytes are retrieved under User and Session
authorization.
_Avoid_: Provider file ID, expiring download URL, raw storage location

**ContentId**:
The stable server-issued identity of one immutable stored Client Content byte
sequence. It is not a content-addressed ID or a bearer credential.
_Avoid_: File ID, blob URL, SHA-256 digest

**Action Attempt**:
One private durably recorded attempt to execute an Action. It is recorded
before any external call; an unknown outcome blocks blind retry.
_Avoid_: Action, network connection

**Workflow**:
An independently durable Cloudflare process whose steps, dependencies, waits,
approvals, or retryable side effects matter. It has a stable WorkflowId and may
invoke Think for bounded reasoning without owning Session history or Think
Submission lifecycle.
_Avoid_: Think Submission, Agent Queue Task, Scheduled Task, long model response

**Workflow Outcome**:
The terminal result of a Workflow: Success, Failure, or Canceled. These outcomes
remain distinct so follow-up behavior does not treat cancellation as failure.
_Avoid_: Workflow status update, Delivery outcome, Think Submission outcome

**Workflow Follow-up Policy**:
The User-intent rule that selects when a terminal Workflow outcome creates a
proactive Think Submission: Never follows no outcome, OnFailure follows only
Failure, and Always follows Success, Failure, and Canceled. Every outcome is
recorded first; enabled follow-up is the only path from the outcome into the
requesting Session.
_Avoid_: Workflow callback, resumed Think Submission, direct Session write

**Workflow Progress**:
The Workflow-owned, nonterminal operational state of one Workflow. It remains
outside Session Memory and is inspected when a User asks for status.
_Avoid_: Session history, Workflow Outcome, Workflow Milestone

**Workflow Milestone**:
One of a small declared set of user-visible facts that a Workflow can reach
before its terminal outcome. Each reached milestone creates at most one
proactive Think Submission and never writes directly to a Session.
_Avoid_: Raw Workflow Progress, Workflow Outcome, direct Session event

**Channel Endpoint**:
An external messaging address through which a person reaches an Osfo Agent. The
endpoint is a transport boundary, not the Agent or its conversation.
_Avoid_: Agent identity, Session

**Messaging Adapter**:
A reusable Adapter implementation that translates one external messaging
transport to and from Osfo's transport-neutral conversation semantics. It does
not own the Session or Agent identity.
_Avoid_: Channel Edge, messaging provider, conversation store

**AdapterId**:
The stable identity of one Adapter configured in Osfo. It scopes conversation
keys and routing, not conversational authority.
_Avoid_: AdapterInstallationId, provider account ID, SessionId

**ConversationKey**:
An opaque, AdapterId-scoped identity for one conversation on an external
protocol. Each `(AdapterId, ConversationKey)` maps to a separate Conversation Route by
default.
_Avoid_: ProviderConversationKey, provider conversation ID, SessionId

**Conversation Route Binding**:
Osfo's association from an AdapterId and ConversationKey to a Conversation
Route. Sharing or moving a route across Adapters requires an explicit binding
decision.
_Avoid_: Provider conversation, automatic account merge

**Osfo API**:
Osfo's direct HTTP interface for adding input to a Conversation Route's current
Session and observing Session history across live delivery and durable resume.
It is the default interface for Osfo-owned clients, not an Adapter for an
external protocol.
_Avoid_: Native Session Transport, Web Adapter, OpenAI-Compatible Adapter,
Messaging Adapter

**Acceptance Receipt**:
Immutable evidence that Osfo durably accepted one Channel Message Key as one
UserMessage and correlated its UserMessageId with one Think SubmissionId.
Identical retries return the same receipt, and ingress returns success only when
both Think acceptance and this mapping are recoverable.

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
Session.
_Avoid_: Web Messaging Adapter, canonical Osfo protocol
