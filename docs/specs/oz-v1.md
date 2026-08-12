# Oz v1 product and architecture specification

Status: Approved implementation contract

Wayfinder map: [Specify the Cloudflare-first Oz v1](https://github.com/heyimcarlos/osfo/issues/151)

Implementation map: [Implement the Cloudflare-first Oz v1](https://github.com/heyimcarlos/osfo/issues/167)

## Authority and purpose

This specification defines the Oz v1 product and its Cloudflare implementation
contract. An implementation issue can select local code details, but it must not
change a product rule, authority owner, identity, state transition, package seam,
or production gate in this document.

Authority has this order:

1. [`CONTEXT.md`](../../CONTEXT.md) defines the domain language.
2. [`docs/adr/`](../adr/) records durable architecture decisions and their status.
3. This specification connects those decisions into one implementation contract.
4. GitHub issues own implementation work and evidence status.

If these sources conflict, implementation stops until the conflict is corrected.

## Product boundary

Oz v1 is a WhatsApp-only personal agent for non-technical Users. Each registered
User owns one stable Oz Agent, one AgentId, one canonical Thread, and one private
Knowledge Space. The Agent and its data are durable. Compute is temporary.

Oz v1 uses:

- TypeScript and Effect for product behavior;
- Cloudflare Workers, Durable Objects, D1, R2, and Workflows;
- Think as the selected Agent Harness and canonical Thread authority;
- Drizzle for schema declarations, typed queries, and migration generation;
- Alchemy for Cloudflare infrastructure composition;
- Supermemory as a rebuildable retrieval projection;
- the official Meta WhatsApp Cloud API as the only launch messaging transport.

Oz v1 does not include Apple Messages, a universal agent builder, harness
portability, one permanent VM for each User, recursive child-agent orchestration,
a general sandbox product, arbitrary connectors, or a second GCP production
runtime. Production implementation starts through the issue map linked from this
specification.

## System shape

```text
Meta webhook or Oz web request
  -> Oz Worker
     -> D1 directory, identity, policy, and cross-Agent facts
     -> named Oz Agent Durable Object by AgentId
        -> Think Session and Think Submission authority
        -> Oz product facts in namespaced Agent SQLite tables
        -> managed model, memory, scheduling, and Delivery
     -> R2 content
     -> Cloudflare Workflow when independent durable work is required
     -> external adapters: Meta, SMS, Supermemory, Gmail, search, model, task compute
```

The Worker routes work. It does not own product policy. The named Oz Agent owns
private User-scoped product behavior. Think owns conversation and bounded turn
execution. A Workflow owns its own independent durable steps and waits. External
providers never become product authority.

## Identities and authority

### Stable ownership

- A `UserId` identifies one registered person.
- One User owns one Oz Agent in v1.
- An `AgentId` identifies that Oz Agent and routes its Durable Object.
- One Oz Agent owns one canonical Thread and one Knowledge Space.
- UserId, AgentId, Thread identity, and Knowledge Space identity are random,
  stable, internal values. They are not derived from a phone number, Account,
  Channel Identity, or provider identifier.
- A Durable Object activation identity is disposable. It is not an AgentId.

User is the scope for ownership, admission, fairness, Subscription, allowances,
and memory. Phone replacement, approved recovery, Subscription changes, channel
revocation, and runtime activation must not replace stable User, Agent, Thread,
or Knowledge Space identities.

### Separate authentication facts

A Channel Identity is provider-asserted messaging identity. A Phone Account is
SMS-verified authentication evidence. An AuthSession lets a web client act as a
User. A Channel Binding lets one provider identity act as and receive messages
for one User. These facts remain separate.

Oz v1 supports:

- exactly one active Phone Account for a User;
- short-lived renewable AuthSessions with rotating renewal credentials;
- at most one active WhatsApp Channel Binding for a User;
- administrative User suspension;
- AuthSession and Channel Binding revocation;
- a deletion request that immediately revokes access.

Phone loss, suspected compromise, phone replacement, Account collision, and a
conflicting Channel Binding fail closed to manual support. V1 does not implement
general Account Linking, User Merge, multiple conversational channels, Preferred
Channel selection, automated recovery, or a general User lifecycle framework.

### Launch authorization

Authorization is deterministic and default-deny. It uses a small table for the
declared launch actions. It does not use a general permission framework.

```text
registered User
  + named Plan Entitlement
  + current Usage Allowance
  + exact resource ownership or Integration Connection
  + exact Approval when required
  - current denial facts
  = launch authorization result
```

Ingress checks the Channel Binding, User suspension, Plan access, and allowance.
Every protected external effect checks the exact User, action, resource,
Integration Connection, Approval, and current denial facts again. Model output,
tool visibility, earlier acceptance, and an earlier Approval are not authority.

The implementation records minimum content-free security audit facts for
registration, authentication, binding, revocation, suspension, deletion,
Approval, and protected effects. It does not record secrets in the Thread,
telemetry, or audit data.

## Phone-first registration and onboarding

Oz presents one visible persona. An unregistered WhatsApp sender may receive one
natural Registration Turn. This turn can identify language, ask what help the
person wants, and issue a Registration Invitation. It has no stable AgentId,
Thread, memory, tools, entitlements, or external authority. More unregistered
messages receive a deterministic registration prompt.

The Registration Dialogue and its temporary transcript are deleted after
registration or invitation expiry. Oz creates no handoff summary. Only a
preferred name and help areas that the person explicitly enters as registration
fields can enter the new User profile.

### Web entry

```text
/get-started
  -> optional preferred name and help areas
  -> phone-number entry
  -> privacy and channel notice
  -> SMS Phone Verification
  -> Free Plan confirmation
  -> User Registration or existing-User sign-in
  -> explicit Continue in WhatsApp enrollment
  -> personal Oz welcome
```

The WhatsApp-first path uses a high-entropy, single-use Registration Token at
`/verify/<token>`. Oz stores only its digest. The page shows a masked invited
number and requires an explicit `Send code` action.

Phone Verification uses a six-digit, single-use code, a ten-minute lifetime, at
most five entry attempts, resend after 30 seconds, and at most five sends per
hour. A Registration Invitation is resumable for 24 hours. Public failures do
not disclose whether an Account exists.

A new verified phone causes one idempotent registration operation to establish:

- the User and Phone Account;
- an AuthSession and Free Plan;
- the personal Oz Agent, AgentId, canonical Thread, and empty Knowledge Space;
- the invited WhatsApp Channel Binding only after explicit consent.

A verified phone that already belongs to a User signs in to that User. It does
not create or merge another User. A conflicting WhatsApp binding fails closed.
The web-first `Continue in WhatsApp` flow completes binding only after a
provider-authenticated inbound enrollment event. The enrollment control message
is not a conversational UserMessage.

Before completion, Oz states: "You are starting on Free. No card is required.
You get 30 messages every 30 days." The full Plan details remain linked.

The first personal response is a normal committed response in the new canonical
Thread. It uses the chosen language and only accepted setup facts. It asks for
the first task. It does not start work, show a tutorial, or request payment.

The web flow must meet WCAG 2.2 AA. It must support keyboard use, visible focus,
screen readers, accessible validation summaries, non-color errors,
international phone input, and SMS code paste and autofill. Before Phone
Verification it must explain AI processing, message storage, WhatsApp
involvement, Channel Binding, and how to stop proactive messages.

## Thread, Think, and execution

Think Session history is the sole canonical Thread record. Oz does not maintain
a parallel ThreadEvent stream, AgentRun lifecycle, or execution state machine.

One accepted UserMessage creates one stable Think Submission. Think owns its
serialization, idempotency, cancellation, lifecycle, and crash recovery. Long
reasoning stays in that Submission unless the work independently needs durable
steps, waits, approvals, or retryable side effects and therefore qualifies as a
Workflow.

The accepted identity chain is:

```text
InboundWhatsAppEventKey
  -> Channel Message Key
  -> UserMessageId
  -> Think SubmissionId
  -> Acceptance Receipt
```

Interactive ingress calls the named Oz Agent directly. No Cloudflare Queue or
Workflow is on this path. Provider success is returned only after Think has
accepted the stable Submission and the Acceptance Receipt mapping is
recoverable.

The accepted Cloudflare work roles are:

| Primitive        | Role                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| Think Submission | Conversational and one-off background turn                             |
| Scheduled Task   | Future or recurring Agent-local callback                               |
| Agent Queue Task | Short, immediate, sequential, non-conversational Agent-local work      |
| Managed Fiber    | Recoverable application execution inside one Agent                     |
| Workflow         | Independent durable steps, waits, approvals, or retryable side effects |
| Cloudflare Queue | Deferred until a concrete cross-Agent or system-wide workload exists   |

Every stable occurrence and callback has an idempotency identity. Oz stores
correlation and side-effect evidence. It does not copy the execution history of
Think, a Workflow, or a Managed Fiber.

## WhatsApp transport and Delivery

Oz uses the official Meta WhatsApp Cloud API directly. Production has one Meta
business portfolio, one WhatsApp Business Account, one Meta app, and one
dedicated phone number. Development and test use separate credentials and a
separate number. Launch operations must recheck Meta approval, policy, and legal
availability before enabling production.

The Worker:

1. compares the verification token before it returns `hub.challenge`;
2. verifies `X-Hub-Signature-256` over the exact raw body before parsing;
3. decodes valid bodies with Effect Schema into closed event types;
4. records `InboundWhatsAppEventKey = (phone_number_id, provider_message_id)`
   before Channel Binding resolution;
5. fixes the first resolved Channel Binding for that event;
6. routes accepted direct messages to the named Oz Agent.

V1 accepts one-to-one text and supported button replies. It rejects group and
status interactions. Unsupported direct content receives a deterministic
explanation. Echoes and non-message events do not become UserMessages.

### Response projection

One committed Think response creates one Delivery. Rendering happens once
before the first provider call. The exact bytes and stable order are durable.
WhatsApp output does not stream partial model text.

The renderer splits at paragraph, sentence, word, and Unicode grapheme
boundaries, in that order. Each Delivery Part is at most 4,096 characters,
including a stable `N/Total` prefix for a multipart Delivery.

One Managed Delivery Fiber sends parts in order. It stops later unsent parts
after rejection or ambiguity. Each pre-recorded Delivery Attempt returns:

- `Accepted(providerMessageId)` when Meta returns a `wamid`;
- `Rejected(reason)` for proven non-acceptance;
- `Ambiguous(reason)` when acceptance cannot be proved or disproved.

Oz can retry automatically only when no request bytes left the process or Meta
returned an allowlisted synchronous pre-acceptance rejection. A timeout or lost
response after write is Ambiguous and blocks automatic retry. A returned `wamid`
is provider acceptance. Oz does not resend it after a later failed status.

Meta status observations use this idempotency key:

```text
hash(phone_number_id, wamid, status, timestamp, recipient_id, normalized_errors)
```

Confirmed progress does not move backward. Failure, deletion, malformed, and
contradictory observations stay explicit. A Delivery problem never changes the
committed Thread response. A User or operator can approve a new attempt only
after an explicit duplicate-risk warning.

The next successful User contact after an earlier failed or ambiguous Delivery
adds a deterministic notice to the next canonical response. It states that the
earlier reply may be incomplete and was not resent because that could create a
duplicate. It then offers only safe actions for the affected part.

Within 24 hours after the latest User message, Oz can send free-form responses.
Outside the window, it uses only approved, opted-in utility wake-up templates.
The template contains no private result. At most one wake-up is active for a
User. A reply opens the service window. Oz then sends pending Deliveries in
commit order before the response to the new UserMessage.

A suspended WhatsApp endpoint acknowledges valid webhooks, admits no work that
cannot receive a response, stops invitations and sends, and retains all pending
or ambiguous evidence. Suspension does not change User, Agent, Thread, memory,
or Subscription identity. Recovery does not replay missed inbound events or
blindly retry ambiguous sends.

The transport-neutral Messaging Adapter Interface verifies and decodes inbound
facts, renders stored Delivery Parts, sends one stored part, and normalizes
status evidence. Provider credentials, limits, templates, and errors stay in
the adapter. WhatsApp and the test adapter are the v1 adapters. A later channel
must implement the same Interface without changing product authority.

## Plans, capabilities, and cost controls

Oz has two launch Plans. Free has no charge. Adventurer costs CA$25 each month,
plus tax. V1 has no annual billing, trial, overage, usage add-on, or user-selected
model. Managed models serve all launch work. Provider Connections are deferred.

Free includes managed conversation, bounded Supermemory use, supported file
analysis, and unambiguous one-time reminders. Adventurer adds a stronger managed
route, higher limits, PDF and DOCX generation, cited web research, one Gmail
Integration Connection, recurring reminders, three Workflows, and GM Summon.

| Capability                      |                     Free |                                   Adventurer |
| ------------------------------- | -----------------------: | -------------------------------------------: |
| Accepted User messages          |            30 per period |                               300 per period |
| Managed model steps per request |                        6 |                                           12 |
| Supermemory ingestion           | 10,000 normalized tokens |                    250,000 normalized tokens |
| Supermemory retrievals          |                      100 |                                        2,000 |
| File uploads                    |         10 at 10 MB each |                            100 at 25 MB each |
| Retained files                  |                   100 MB |                                         2 GB |
| Generated documents             |                     None |            10, at most 20 pages or 5 MB each |
| Research Reports                |                     None |                  5, at most 20 searches each |
| Gmail                           |                     None | 50 searches, 500 messages examined, 20 sends |
| Reminders                       |   1 active, 3 deliveries |                    25 active, 100 deliveries |
| Workflows                       |                     None |                      3 concurrent, 40 starts |
| GM Summon                       |                     None |                        1 completed or active |
| Hidden vendor-cost ceiling      |                  US$0.25 |                                      US$7.50 |
| Maximum vendor cost per request |                  US$0.03 |                                      US$0.75 |

Free periods are 30 days from registration. Adventurer uses its billing period.
Allowances do not roll over. Safety, account, billing, usage, cancellation,
revocation, deletion, and data-right actions stay available after normal usage
is exhausted.

A versioned price book converts expected and reported provider use to USD. Oz
reserves the conservative maximum cost and category quantities before work.
Completion reconciles actual or conservative estimated use and releases the
unused reservation. Concurrent work cannot reserve the same remainder. A retry
keeps the same work identity and allowance reservation. Oz never creates an
overage charge.

These actions need one exact Approval:

- Gmail send;
- creation or material change of a recurring reminder;
- every Workflow start or material change;
- GM Summon;
- destructive memory, file, message, Thread, or account-data action;
- Adventurer work estimated above US$0.50.

Approval is bound to one immutable Action Presentation. A material change to a
recipient, content, schedule, resource, or cost creates a new Action and needs a
new Approval.

On downgrade or expiry, excess retained data stays readable, exportable, and
deletable. New writes stop while use exceeds Free limits. Paid reminders and
Workflows pause or cancel before another protected effect. Gmail authority stays
stored, dormant, and revocable. Existing User data is not silently deleted.

## Launch capabilities

### Memory

Think Session history is canonical Thread Memory. The Oz Memory module owns one
canonical, user-visible Knowledge Space. Supermemory is only a rebuildable
retrieval projection.

| Store                        | Canonical ownership                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Think tables in Agent SQLite | Thread messages, tool interactions, branches, working context, search, and compaction overlays                                           |
| Oz tables in Agent SQLite    | Knowledge Sources, Memory Claims, Schema Packs, Core Profile, suppression markers, provider mappings, index generations, and sync outbox |
| D1                           | Directory, identity, registration, channel, Subscription, administration, and content-free erasure facts                                 |
| R2                           | User files, large normalized sources, generated files, and temporary exports                                                             |
| Supermemory                  | Rebuildable documents, memories, chunks, embeddings, graph, profile, and ranking                                                         |

A Memory Claim is versioned, addressable, and linked to one or more Knowledge
Sources. Its trust is Explicit, Observed, or Inferred. Only an Explicit claim can
be a durable instruction without confirmation. Assistant text alone is not
evidence. Memory cannot grant authority or Approval.

Each turn loads the local Core Profile and local search, requests Supermemory
under a short deadline, rejects results without current same-space provenance,
and runs with a bounded context. Provider failure does not fail the turn. After
a committed response, the module records one stable turn source and enqueues
extraction and provider ingestion.

Remember, correct, forget, source delete, Message Redaction, Thread Reset,
export, and account deletion commit canonical local facts before confirmation.
Correction creates a new Explicit claim and supersedes the old version.
Forgetting suppresses recall without deleting its source. Source deletion removes
claims supported only by that source. Conflicts keep separate provenance until
an explicit correction or clear time update resolves them.

Think owns non-destructive compaction. Oz sets thresholds and validates output.
Compaction never enters the Knowledge Base. Age alone does not remove canonical
Thread history, active claims, or User sources.

A Knowledge Export is built from Think, Agent SQLite, and R2, never from
Supermemory. A Supermemory rebuild writes a new opaque generation, validates it,
switches atomically, and deletes the old generation.

### Erasure and recovery

Oz can promise deletion from live product reads after provider operations,
independent absence checks, recreation fences, and Erasure Receipt replay. It
must not promise immediate physical destruction or complete provider backup
purge.

The User disclosure states that Durable Object point-in-time recovery can retain
prior content for up to 30 days. D1 Time Travel retains 30 days on Workers Paid
and 7 days on Workers Free. R2 live deletion is strongly consistent, subject to
separate cache and bucket-lock controls. Supermemory public contracts are not
enough to prove deletion of every derived value, replica, queue, or backup.

Every Message Redaction, source deletion, Thread Reset, and account deletion has
an opaque deletion manifest, provider-operation evidence, absence checks, and a
fence against queued recreation. Content-free Erasure Receipts live outside the
state that they protect. A restored Agent or directory stays closed until all
applicable receipts are replayed, revived content is removed, provider deletion
is reissued, and live absence is verified.

### Files, research, documents, and Gmail

V1 accepts text, PDF, DOCX, CSV, and common image uploads. Large source bytes and
generated artifacts belong in R2. Disposable Python task compute can support
file analysis and document generation. It is bounded, isolated, and not a
general User-facing execution product.

Adventurer web research produces cited Research Reports within the declared
search and cost limits. It does not bypass authentication or paywalls.

One Gmail Integration Connection permits on-demand search and read, local
summaries and drafts, and approved sends. V1 does not perform mailbox-wide sync,
continuous monitoring, delete, archive, label changes, or automatic replies.
OAuth consent creates the Integration Connection. It does not approve a send.

### Reminders and Workflows

One-time reminders use Scheduled Tasks. Adventurer recurring reminders have a
minimum interval of one day. Workflows are not used for simple reminders.

Adventurer exposes exactly these Workflows:

| Workflow        | Purpose                                                  | Milestone                                                 |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Research Report | Gather sources and create a cited report                 | `SourcesCollected`, once after 15 minutes if not terminal |
| Document Build  | Analyze supplied content and create PDF or DOCX          | `PreviewReady`, once after 15 minutes if not terminal     |
| Scheduled Email | Prepare, approve, wait, and send one exact Gmail message | `ApprovalReady`, once when Approval is needed             |

All three use `Always` Workflow Follow-up Policy. Success, Failure, and Canceled
remain distinct. Each terminal outcome is recorded before at most one proactive
Think Submission is created. Workflow progress stays outside the Thread.

Oz admits at most three milestone Think Submissions for one User in 24 hours.
Current authority is checked before each protected effect. Authority loss causes
Canceled, not Failure. The terminal follow-up uses a small company continuity
reserve when User allowance is no longer available.

### GM Summon and support

`HELP` and `HUMAN` always return a real support web path. They do not create a GM
Summon.

A Problem groups distinct Resolution Attempts in one Thread without copying
Think history. An attempt counts as failed only after explicit User feedback or
objective failure evidence. Oz can offer GM Summon only when one open Problem
has three distinct failed attempts, the User has active Adventurer entitlement,
no summon is active for the Thread, and the allowance-period limit is available.
The User must confirm. One stable summon identity survives safe retries. Oz
promises no response time.

## Module and persistence design

### Repository target

```text
alchemy.run.ts
infra/cloudflare/
  data.ts
  oz.ts
  workflows.ts
  web.ts
  observability.ts

apps/oz/
  src/{worker,env,router,layers}.ts
  src/agent/
  src/registration-dialogue/
  src/workflows/
  src/adapters/
  test/

packages/think/
packages/oz/
packages/oz-persistence/
packages/ui/
```

Public package exports are limited to:

```text
@osfo/think: integration, testing
@osfo/oz: interfaces, http, client, testing
@osfo/oz-persistence: layers, migrations, testing
```

`apps/oz` is the sole Cloudflare composition root. It owns Cloudflare class
exports, binding conversion, environment decoding, concrete provider adapters,
Effect Layer assembly, Alchemy binding, and host Promise-to-Effect conversion.
It does not own product policy.

`@osfo/think` owns only the selected Think integration. It provides stable
Submission acceptance and lookup, canonical Session reads, committed-turn
references and hooks, integration helpers, and deterministic test support. It
does not wrap every Think method or reproduce Think execution behavior.

`@osfo/oz` owns product behavior. Its explicit internal modules cover identity,
registration, onboarding, recovery, authorization, memory, messaging, Delivery,
allowances, integrations, background work, and semantic evidence. These remain
cohesive behind the public deep Effect Interfaces:

```text
UserLifecycle
Authorization
OzMemory
MessagingAdmission
Delivery
Allowances
IntegrationAuthority
WorkflowCorrelation
```

The Messaging Adapter Interface is part of `@osfo/oz`. Persistence ports and
provider adapters remain internal. A package or public seam is allowed only when
it hides substantial behavior, protects a real authority, or has demonstrated
variation. Public Interfaces and observable outcomes are the test surface.

`@osfo/oz-persistence` owns Drizzle schemas, typed queries, migration artifacts,
Effect database Layers, and storage test support. It implements three internal
atomic ports:

```text
DirectoryStore: D1 cross-Agent transactions
AgentStore: one Agent SQLite transaction authority
ContentStore: R2 immutable object operations
```

No port exposes raw Drizzle clients or one CRUD Interface for each table.

### Runtime lifetime

```text
Oz Worker
├── WorkerRuntime, one request or safe invocation scope
├── OzAgent Durable Object
│   └── OzAgentRuntime, one AgentId activation
├── RegistrationDialogue Durable Object
│   └── restricted runtime, one invitation activation
└── Workflow classes
    └── WorkflowRuntime, one execution or resumed step
```

A runtime never crosses execution-unit or Agent lifetimes. One global
`ManagedRuntime` must not be shared across Agents. Each runtime is reconstructible
from its own bindings, identity, and durable inputs.

### Storage and transactions

D1 owns cross-Agent identity, registration, channel, Subscription, allowance,
Agent directory, deletion progress, Erasure Receipt, administration, and
security-audit facts. D1 contains no private Thread or memory content.

Think tables in each Agent SQLite database own Thread and Think execution facts.
Namespaced Oz tables in the same database own Acceptance Receipts, Delivery,
memory, Supermemory outbox, Workflow correlation, proactive receipts, and
Agent-local allowance evidence. Oz migrations never inspect or modify Think
tables. R2 owns large or immutable content.

There is no transaction across D1, Agent SQLite, R2, Think, Workflow, or an
external provider. Recovery uses stable identities and reconciliation.

The committed-turn projection is idempotent:

```text
stable Think committed-turn reference
  -> one Agent SQLite transaction
     + Delivery obligation and stored parts
     + committed-turn Knowledge Source
     + required outbox records
```

An Agent activation reconciles committed Think turns that lack an Oz projection.
Workflow outcomes and milestones use stable RPC to the named Agent. The Agent
records correlation and creates at most one proactive Submission.

D1 migrations are forward-only. Alchemy applies them before updated traffic.
Failure aborts deployment. Agent SQLite carries the complete immutable Oz
migration chain because an Agent can sleep across releases. Initialization runs
migrations under Durable Object exclusion. Each migration has a version and
digest. Failure blocks only that Agent. Destructive changes use expand, migrate,
and contract releases.

### Infrastructure

The root `alchemy.run.ts` selects Stack, stage, provider state, resource groups,
and safe outputs. It contains no product behavior. `infra/cloudflare` groups
data, Oz compute, Workflows, web, and observability by lifecycle. Development,
test, and production use separate resources and secrets. Secrets never enter
stage outputs.

Product facts and required semantic evidence commit in the same local
transaction. There is no cross-store evidence transaction. Telemetry exports
after commit and cannot erase product evidence. Qualification correlates local
evidence and returns only PASS, FAIL, or MISSING.

## Production acceptance

### Levels and workload

Bounded Beta Acceptance permits at most 1,000 Canadian registered Users.
Scale-Qualified Public Launch removes the bound only after representative
Americas, Europe, and Asia-Pacific evidence passes independently.

| Gate or corpus |     Users | Retained registered messages |              Target |              Stress |
| -------------- | --------: | ---------------------------: | ------------------: | ------------------: |
| Bounded Beta   |     1,000 |                       57,000 |  5/s for 30 minutes | 10/s for 15 minutes |
| Public         |   100,000 |                  5.7 million | 25/s for 30 minutes | 50/s for 15 minutes |
| Growth width   | 1 million |                   57 million |        Characterize |        Characterize |
| Growth depth   |   100,000 | 68.4 million over 12 periods |        Characterize |        Characterize |

The first Reference Workload Trace uses 90% Free and 10% Adventurer and this
incoming mix: 5% registration, 67% ordinary conversation, 8% file analysis, 5%
reminders, 4% Gmail, 3% Research Report, 2% Document Build, 1% Scheduled Email,
and 5% account, billing, safety, and data-right work. Rare journeys also run in
isolated Challenge Lanes.

After 30 production days and 25,000 accepted registered messages, Oz replaces
the assumed trace with a version based on observed Plans, journeys, geography,
cold activation, history, amplification, and cost. The historical 232/s and
464/s lanes remain characterization only.

Each level runs three clean target, stress, and recovery repetitions against its
complete retained corpus. The suite includes a baseline, linear ramp, zero-to-
burst lane, all-cold lane, dependency outage and drain, and separate audit and
teardown windows. Load uses open arrivals.

### SLOs

| Stage                                                 | Objective                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Warm durable acceptance                               | 99.9% within 1 second                                                    |
| Cold durable acceptance                               | 99% within 3 seconds                                                     |
| Combined live admission                               | 99.9% within 3 seconds                                                   |
| Target admission                                      | Every valid authorized allowance-covered identity, no capacity rejection |
| First Meaningful User Update                          | 99% committed within 10 seconds after acceptance                         |
| First Delivery Attempt                                | 99% starts within 2 seconds after update commit                          |
| Scheduled Task due to handler start                   | 99% within 60 seconds                                                    |
| Scheduled Task due to proactive Submission acceptance | 99% within 90 seconds                                                    |
| Workflow start acceptance                             | 99.9% within 3 seconds                                                   |
| Workflow wake or milestone due to commit              | 99% within 60 seconds                                                    |
| Workflow outcome to follow-up acceptance              | 99% within 60 seconds                                                    |
| Scheduled Email due to protected send start           | 99% within 60 seconds                                                    |
| Scheduled Email send start to outcome                 | Within 2 minutes                                                         |

Journey deadlines are two minutes for ordinary conversation, reminder setup,
Approval, and account work; five minutes for file analysis and Gmail read or
draft; and 60 minutes for Research Report and Document Build, with the permitted
milestone after 15 minutes. Deterministic lanes require 100% Good Root Outcomes.
Live model or provider journeys require 99% overall and for each journey class.

Correctness has zero tolerance for loss, stranded accepted work, duplicate
authority or effect, ghost work, stale commits, ordering gaps, irreconcilable
outcomes, or unbounded amplification. RPO is zero inside the declared fault
domain. One interrupted Agent settles within 60 seconds. After dependency
recovery, backlog slope is negative within five minutes and recoverable work is
terminal or durably waiting within 20 minutes.

Every accepted root has one unsampled semantic trace. Required signals cover all
platform stores, Think, providers, Workflows, model access, memory, Gmail,
WhatsApp, and task compute. Missing material semantic, usage, or cost evidence
makes the affected gate MISSING. At target, measured use stays at least 30%
below every hard limit.

The economics gate requires at least 50% Adventurer contribution margin and at
most US$0.50 all-in cost for an active Free period. It includes platform, model,
search, Supermemory, WhatsApp, file, compute, storage, backup, observability,
payment, support, expected GM Summon, idle, failure, retry, recovery, retention,
and teardown costs. Prices are at most 30 days old and reconcile with bills.

Beta needs three clean repetitions of every required lane. Continued beta uses
rolling seven-day SLOs. Public promotion needs 28 consecutive beta days, 25,000
accepted registered messages, the full Public corpus, and three clean public
runs from each region. Correctness failures cannot spend an error budget.

### Model Quality Gate

The gate evaluates the complete behavior configuration, not only a model. It
includes routes, prompts, skills, tools, context, memory, policy, Workflows, and
rendering. System SLOs and model quality remain separate.

The initial 600 authored cases include 100 ordinary, 100 memory, 60 file, 60
Gmail, 40 Research Report, 40 Document Build, 40 Scheduled Email, and 160 safety
or adversarial cases. Twenty percent of each class is sealed. Ordinary cases run
three times. Safety cases run five times. Permanent cases are authored or
synthetic, not raw User conversations.

Deterministic grading runs first. Humans review every safety case and at least
20% of each journey, with at least 20 cases per journey. A model grader is a
release authority only after its one-sided exact-binomial calibration proves:

- zero observed critical false passes and an upper 95% bound below 1%;
- other false-pass upper bound below 5%;
- false-failure upper bound below 10%.

The zero-error critical calibration needs at least 299 independent critical
examples. Repeated runs of one case do not increase that independent count.

Every candidate needs 100% critical checks, at least 90% complete-rubric pass for
each journey and Plan route, at least 95% groundedness for memory, files, Gmail,
Research Reports, and Document Builds, and complete evidence. Candidate and
production configurations use identical cases. Non-inferiority uses 2 percentage
points overall and 5 points per stratum only when the sample is powered at 90%
with one-sided alpha 0.05. An underpowered result is MISSING.

One confirmed authority bypass, cross-User disclosure, secret disclosure, use
of erased data, authority-changing prompt injection, wrong or duplicate external
effect, or fabricated evidence is FAIL.

Pull requests run affected deterministic checks, mapped critical cases, at least
five cases for every journey, 20 safety cases, and one run each. Release and
promotion run the complete gate. A PASS expires after seven days or a material
configuration change.

A passing release canaries at 5% for at least 72 hours and 200 eligible messages,
then 25% for at least 72 hours and 500 messages. One critical failure stops
promotion and starts rollback. Insufficient evidence is MISSING.

Production triage reviews negative feedback, corrections, repeated failed
attempts, summons, incidents, and invariant alerts. Automated sampling is 1%
for each journey and Plan route, capped at 200 samples per journey each week.
Random human reading of private conversations is prohibited. Evaluation copies
follow the accepted deletion lineage. Unflagged temporary content is deleted
within 24 hours. Content-free scores, operational metadata, and flagged review
bundles are retained for 30 days. A necessary consented real-trace case is kept
for at most 90 days. Permanent corpus content is synthetic or authored only.

All acceptance verdicts use this order:

1. Any required FAIL makes the result FAIL.
2. Otherwise, any required MISSING makes it MISSING.
3. Only complete passing evidence produces PASS.

## Historical architecture disposition

Cloudflare is the only Oz v1 production architecture. ADR 0003 supersedes the
GCP, Cloud SQL, PostgreSQL ThreadEvent, AgentRun driver, transactional outbox,
Pub/Sub, StreamingPull, Temporal, Native Thread Transport, fixed-worker, and GCP
Terraform implementation direction for Oz v1.

The following invariants remain and must be re-proved through Cloudflare:

- durable acceptance before provider acknowledgement;
- stable idempotency identities and immutable Acceptance Receipts;
- commit before an external effect and explicit ambiguous outcomes;
- no blind retry after an uncertain effect;
- one authority owner for each lifecycle;
- reconstruction from durable state after process loss;
- typed failure, default denial, bounded work, and fair User-scoped admission;
- canonical ordering, no duplicate semantic result, and complete recovery;
- provider-neutral product facts and testable adapter seams;
- fail-closed qualification with PASS, FAIL, and MISSING.

The retired implementation is absent from the current tree. Git history
preserves it. New work must not restore a dual runtime or retain old source as a
compatibility shim.

## Required acceptance journeys

Each implementation ticket adds ordinary tests for its behavior and failure
boundaries. Use Effect TypeScript diagnostics for source correctness, focused
type tests only for real public compile-time behavior, and Effect Vitest for
runtime behavior. User feedback on a running vertical slice becomes a
regression case.

Every change must pass the root install, format, lint, typecheck, test, and build
commands. Production-facing work also records the applicable system,
provider, browser, migration, SLO, cost, and Model Quality evidence required by
this specification. Report each required result as PASS, FAIL, or MISSING.

Implementation evidence must include at least:

- every web and WhatsApp onboarding path, recovery, consent, expiry, and
  idempotent partial-failure case in the onboarding decision;
- webhook signature and schema rejection, duplicate inbound events, exact-byte
  Delivery recovery, status disorder, ambiguity, wake-up coalescing, suspension,
  support, and GM Summon;
- the full entitlement, allowance, cost reservation, Approval, downgrade,
  reminder, Workflow, and authority-loss matrix;
- memory provenance, correction, conflict, forgetting, deletion, export,
  Supermemory outage and rebuild, cross-space rejection, and restore replay;
- D1 and Agent SQLite migration chains, interruption, old Agent activation,
  Think-table isolation, and Worker-to-Agent recovery;
- provider conformance and focused live qualification for Meta, SMS, managed
  models, Supermemory, Gmail, search, and temporary compute;
- the complete production and Model Quality gates in this document.

The linked implementation map owns the exact ticket order and live status. No
implementation ticket may silently decide a structural question that this
specification leaves open.

## Decision sources

- [Prove the Cloudflare account-agent foundation](https://github.com/heyimcarlos/osfo/issues/152)
- [Define Oz Agent identity, Thread, and execution dispatch](https://github.com/heyimcarlos/osfo/issues/153)
- [Define Oz User registration, authentication, recovery, and capability enforcement](https://github.com/heyimcarlos/osfo/issues/154)
- [Define the Oz Memory System and Supermemory contract](https://github.com/heyimcarlos/osfo/issues/155)
- [Define the WhatsApp launch transport and delivery contract](https://github.com/heyimcarlos/osfo/issues/156)
- [Freeze Oz launch capabilities, approvals, allowances, and plan economics](https://github.com/heyimcarlos/osfo/issues/157)
- [Define Oz module ownership, Drizzle persistence, and GCP migration](https://github.com/heyimcarlos/osfo/issues/158)
- [Define Oz production SLOs, workload, observability, and cost gates](https://github.com/heyimcarlos/osfo/issues/161)
- [Define the Oz phone-first onboarding and setup journey](https://github.com/heyimcarlos/osfo/issues/162)
- [Verify provider erasure and backup-retention guarantees](https://github.com/heyimcarlos/osfo/issues/163)
- [Define Oz model-quality evaluation and release gates](https://github.com/heyimcarlos/osfo/issues/165)
