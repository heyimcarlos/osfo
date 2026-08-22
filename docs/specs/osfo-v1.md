# Osfo v1 product and architecture specification

Status: Approved implementation contract

Wayfinder map: [Specify the Cloudflare-first Osfo v1](https://github.com/heyimcarlos/osfo/issues/151)

Implementation map: [Implement the Cloudflare-first Osfo v1](https://github.com/heyimcarlos/osfo/issues/167)

## Authority and purpose

This specification defines the Osfo v1 product and its Cloudflare implementation
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

Osfo v1 is a WhatsApp-only personal agent for non-technical Users. Each registered
User owns one stable Osfo Agent and one AgentId. The Agent can own several
conversation routes. Each route has exactly one current Session and can have
historical Sessions. V1 has one WhatsApp direct-message route, so the User
experiences one continuous primary Session. The Agent and its data are durable.
Compute is temporary.

Osfo v1 uses:

- TypeScript and Effect for product behavior;
- Cloudflare Workers, Durable Objects, Hyperdrive, R2, and Workflows;
- Neon PostgreSQL for shared control-plane facts;
- Think as the selected Agent Harness and Session authority;
- Drizzle for schema declarations, typed queries, and migration generation;
- Alchemy for Cloudflare infrastructure composition;
- Supermemory as the v1 adapter behind MemoryProvider;
- Composio Cloud as the v1 integration provider for Gmail;
- the official Meta WhatsApp Cloud API as the only launch messaging transport.

Osfo v1 does not include Apple Messages, a universal agent builder, harness
portability, one permanent VM for each User, recursive child-agent orchestration,
a general sandbox product, arbitrary connectors, or a second GCP production
runtime. Production implementation starts through the issue map linked from this
specification.

Composio Cloud is the selected v1 integration architecture. The Composio runtime
adapter is not implemented yet. This specification does not claim that Gmail is
available in the current code.

## System shape

```text
Meta webhook or Osfo web request
  -> Osfo Worker
     -> PostgreSQL directory, identity, policy, auth, and cross-Agent facts
     -> named Osfo Agent Durable Object by AgentId
        -> Think Session and Think Submission authority
        -> Osfo product facts in namespaced Agent SQLite tables
        -> Native Memory, managed model, scheduling, and Delivery
     -> R2 content
     -> Cloudflare Workflow when independent durable work is required
     -> external adapters: Meta, SMS, Supermemory, Composio Cloud, search, model,
        task compute
```

The Worker entry point routes work and does not decide product policy. Focused
modules inside `apps/worker` own that policy. The named Osfo Agent owns private
User-scoped product behavior. Think owns conversation and bounded turn execution.
A Workflow owns its own independent durable steps and waits. External providers
never become product authority.

## Identities and authority

### Stable ownership

- A `UserId` identifies one registered person.
- One User owns one Osfo Agent in v1.
- An `AgentId` identifies that Osfo Agent and routes its Durable Object.
- One Osfo Agent can own several conversation routes and Sessions.
- Each conversation route has exactly one current Session and can have
  historical Sessions.
- V1 has one WhatsApp direct-message route with one current primary Session.
- UserId, AgentId, route identity, and SessionId are stable internal values. They
  are not derived from a phone number, Account, Channel Address, or provider
  identifier.
- A Durable Object activation identity is disposable. It is not an AgentId.

User is the scope for ownership, admission, fairness, Subscription, allowances,
and memory. Phone replacement, approved recovery, Subscription changes, channel
revocation, and runtime activation must not replace stable User or Agent
identities. They do not replace a route's current Session.

### Separate authentication facts

A Channel Address is the opaque pair of Think's `MessengerContext.messengerId`
and normalized `author.userId`. A Phone Account is SMS-verified authentication
evidence. An AuthSession lets a web client act as a User. A Channel Link lets one
provider-authenticated address act as and receive messages for one User. These
facts remain separate. Better Auth owns authentication. Its
`users` table is the Osfo control-plane User table, not a separate auth copy.
Better Auth also owns `sessions`, `accounts`, `verifications`, and
`rate_limits`. The phone-number plugin and Twilio Verify provide the selected
SMS path.

Google sign-in is not supported in v1. Better Auth has no Google social provider,
and a Google or Gmail authorization cannot create or link an Account. The Phone
Account is the supported launch Account path.

Development temporarily enables Better Auth email-and-password sign-up and
sign-in so the web and control-plane integration can be exercised without an
SMS dependency. This is not a launch authentication method. Remove the
credential UI and disable `emailAndPassword` before the bounded beta.

Osfo v1 supports:

- exactly one active Phone Account for a User;
- short-lived renewable AuthSessions with rotating renewal credentials;
- at most one active Channel Link for each Channel Address;
- administrative User suspension;
- AuthSession and Channel Link revocation;
- a deletion request that immediately revokes access.

Phone loss, suspected compromise, phone replacement, Account collision, and a
conflicting Channel Link fail closed. V1 does not implement general Account
Linking, User Merge, Preferred Channel selection, automated recovery, or a
general User lifecycle framework.

### Launch authorization

Authorization is deterministic and default-deny. It uses a small table for the
declared launch actions. It does not use a general permission framework.

```text
registered User
  + named Plan Entitlement
  + current Usage Allowance
  + exact resource ownership or Integration Connection
  + exact Approval when required
  - User Suspension, revoked AuthSession or Channel Link, or deletion access revocation
  = launch authorization result
```

Ingress resolves the Channel Link before any privileged model execution, then
checks User suspension, Plan access, and allowance.
Every protected external effect checks the exact User, action, resource,
Integration Connection, Approval, User Suspension, Channel Link and session
revocation, and deletion access revocation again. Missing ownership, Plan
entitlement, allowance, Integration Connection, or Approval also denies the
operation. Model output, tool visibility, earlier acceptance, and an earlier
Approval are not authority. Osfo does not store these decisions in one generic
denial-facts table.

The initial control plane does not store a generic security audit table.
Registration state is recoverable from current product facts. Application logs
support early operational debugging. A future security workflow adds its own
purpose-built history, such as User suspension and restoration events. Osfo can
extract a shared audit model only after several concrete workflows need it.

## Direct Channel Linking

Osfo presents one visible persona. An unlinked direct-message sender talks to
Osfo itself in a temporary Company Conversation instead of receiving only a
deterministic invite. The conversation runs on a fixed model route inside a
bounded envelope: a capped transcript window, an optional per-address daily
turn ceiling, and no memory, entitlements, tools, or external authority except
one presentation capability for the current Channel Link Invite. The model
judges when presenting the invite serves the person; deterministic code
appends the verification URL after the model turn, calling ChannelLinks.ensure
only when the linking attempt holds no unexpired invitation. Invite tokens
persist only as hashes, so the presenting layer remembers the URL it delivered
instead of reconstructing one. Tokens and URLs never enter model input,
transcript, model output, logs, or errors. Group contexts stay deterministic,
receive no conversation, and never
receive an invite. Any private sender on a supported transport reaches the
conversation; provider allowlists do not gate it.

The invite token is opaque random material resolved by hashed lookup; it
carries no address, User, key, or signature semantics. Address and User PII
appear in neither the URL nor audit metadata. Unknown, forged, expired,
cancelled, superseded, or consumed invites fail closed.

### Web entry

```text
/get-started
  -> optional preferred name
  -> phone-number entry
  -> SMS Phone Verification
  -> optional help areas
  -> User Registration
  -> profile and Channel Link management

/verify/<token>
  -> phone-number entry
  -> SMS Phone Verification
  -> User Registration with an empty profile, or existing-User sign-in
  -> explicit acceptance of the same Channel Link Invite
  -> personal Osfo welcome
```

A messaging-provider-first path uses an opaque invitation at
`https://osfo.ai/verify/<token>`. It does not enter the website-first `/get-started`
flow. Only a hash of the token is stored. Acceptance trusts only the
server-authenticated User and requires completed registration; it never accepts
a UserId from the client.

Phone Verification uses a six-digit, single-use code, a ten-minute lifetime, at
most five entry attempts, resend after 30 seconds, and at most five sends per
hour. A Channel Link Invite is resumable for 24 hours. Public failures do not
disclose address or Account existence.

A new verified phone causes one idempotent registration operation to establish:

- the User and Phone Account;
- an AuthSession and Free Plan;
- the personal Osfo Agent, AgentId, primary conversation route, and primary Session;
- the Channel Link only after explicit acceptance.

A verified phone that already belongs to a User signs in to that User. It does
not create or merge another User. Acceptance is atomic, an exact retry by the
same User is idempotent, and competing Users or active links fail closed.

The first personal response is a normal committed response in the new primary
Session. It uses the chosen language and only accepted setup facts. It asks for
the first task. It does not start work, show a tutorial, or request payment.

The web flow must meet WCAG 2.2 AA. It must support keyboard use, visible focus,
screen readers, accessible validation summaries, non-color errors,
international phone input, and SMS code paste and autofill.

## Sessions, Think, and execution

Think Session history is the sole canonical conversation record. Osfo does not
maintain a parallel conversation event stream, AgentRun lifecycle, or execution
state machine.

One primary Think Session has a rolling context view. The Session is durable
conversation history, not one model context window. Compaction changes the
bounded view sent to the model and does not normally end the Session or remove
its original SQLite history. Osfo does not classify messages as work or
personal, switch Sessions from message content, or reset the primary Session on
a fixed time window. Explicit `/new` replaces the current Session for the same
route. The previous Session remains historical and searchable.

Future web conversations, Discord threads, group conversations, cron work, and
sub-agents can use separate Sessions. A future web Home route shares the
WhatsApp Session only after an explicit product decision. Core Memory is
Agent-wide, Session transcripts are route-scoped, and sub-agent Sessions are
isolated and return bounded results to the requesting Session.

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

Interactive ingress calls the named Osfo Agent directly. No Cloudflare Queue or
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

Every stable occurrence and callback has an idempotency identity. Osfo stores
correlation and side-effect evidence. It does not copy the execution history of
Think, a Workflow, or a Managed Fiber.

## WhatsApp transport and Delivery

Osfo uses the official Meta WhatsApp Cloud API directly. Production has one Meta
business portfolio, one WhatsApp Business Account, one Meta app, and one
dedicated phone number. Development and test use separate credentials and a
separate number. Launch operations must recheck Meta approval, policy, and legal
availability before enabling production.

The Worker:

1. compares the verification token before it returns `hub.challenge`;
2. verifies `X-Hub-Signature-256` over the exact raw body before parsing;
3. decodes valid bodies with Effect Schema into closed event types;
4. records `InboundWhatsAppEventKey = (phone_number_id, provider_message_id)`
   before Channel Link resolution;
5. fixes the first resolved Channel Link for that event;
6. routes accepted direct messages to the named Osfo Agent.

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

Osfo can retry automatically only when no request bytes left the process or Meta
returned an allowlisted synchronous pre-acceptance rejection. A timeout or lost
response after write is Ambiguous and blocks automatic retry. A returned `wamid`
is provider acceptance. Osfo does not resend it after a later failed status.

Meta status observations use this idempotency key:

```text
hash(phone_number_id, wamid, status, timestamp, recipient_id, normalized_errors)
```

Confirmed progress does not move backward. Failure, deletion, malformed, and
contradictory observations stay explicit. A Delivery problem never changes the
committed Session response. A User or operator can approve a new attempt only
after an explicit duplicate-risk warning.

The next successful User contact after an earlier failed or ambiguous Delivery
adds a deterministic notice to the next canonical response. It states that the
earlier reply may be incomplete and was not resent because that could create a
duplicate. It then offers only safe actions for the affected part.

Within 24 hours after the latest User message, Osfo can send free-form responses.
Outside the window, it uses only approved, opted-in utility wake-up templates.
The template contains no private result. At most one wake-up is active for a
User. A reply opens the service window. Osfo then sends pending Deliveries in
commit order before the response to the new UserMessage.

A suspended WhatsApp endpoint acknowledges valid webhooks, admits no work that
cannot receive a response, stops invitations and sends, and retains all pending
or ambiguous evidence. Suspension does not change User, Agent, Sessions, memory,
or Subscription identity. Recovery does not replay missed inbound events or
blindly retry ambiguous sends.

The transport-neutral Messaging Adapter Interface verifies and decodes inbound
facts, renders stored Delivery Parts, sends one stored part, and normalizes
status evidence. Provider credentials, limits, templates, and errors stay in
the adapter. WhatsApp and the test adapter are the v1 adapters. A later channel
must implement the same Interface without changing product authority.

## Plans, capabilities, and cost controls

Osfo has two launch Plans. Free has no charge. Adventurer costs CA$25 each month,
plus tax. V1 has no annual billing, trial, overage, usage add-on, or user-selected
model. Managed models serve all launch work. User-selected model Provider
Connections are deferred.

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

An allowance period is `scheduled` before its start, `active` during its
half-open `[startsAt, endsAt)` interval, and `expired` at or after its end. One
common period for one User covers every allowance kind. The period pins one
immutable Plan policy version.

Authorization admits ordinary work only while recorded consumption is below its
limit and the operation fits its own size, step, cost, and concurrency limits.
Known-at-start consumption can be checked and recorded during admission. Actual
category use and vendor cost are recorded after the owning effect has trusted
evidence. Each Allowance Consumption record uses an existing product or effect
identity, so safe retries do not count it twice. Feature modules normalize their
own evidence. Osfo does not create a generic allowance work identity.

Work admitted below a limit may finish and can move recorded use above that
limit. The next ordinary operation is denied. Per-operation cost limits and
concurrency limits bound this overshoot. Provider-reported exact cost is used
when trustworthy. An uncertain incurred cost uses a conservative configured
maximum. Proven no-use work creates no consumption record. Osfo never creates an
overage charge.

These actions need one exact Approval:

- Gmail send;
- creation or material change of a recurring reminder;
- every Workflow start or material change;
- GM Summon;
- destructive memory, file, Session, or account-data action.

Cost alone never requires Approval.

Approval is bound to one immutable Action Presentation. A material change to a
recipient, content, schedule, resource, or cost creates a new Action and needs a
new Approval.

On downgrade or expiry, excess retained data stays readable, exportable, and
deletable. New writes stop while use exceeds Free limits. Paid reminders and
Workflows pause or cancel before another protected effect. The Osfo Gmail
Integration Connection authorization fact stays dormant and revocable. Composio
continues to own its connected-account record and credentials. Existing User data
is not silently deleted.

## Launch capabilities

### Memory

The Osfo Memory System has two layers:

| Layer          | Authority                                                                            |
| -------------- | ------------------------------------------------------------------------------------ |
| Native Memory  | Agent-owned Core Memory, Session Memory, and Session Recall in Durable Object SQLite |
| Knowledge Base | User-scoped semantic memory behind the application-owned MemoryProvider seam         |

Think owns Sessions, message order, human-visible tool interactions, branches,
compaction overlays, and FTS5 indexes. Session history is the canonical record
of what happened. Core Memory is the Agent's bounded working model. Supermemory
owns its semantic extraction, provider profile, graph, and retrieval mechanics.
MemoryProvider recall is evidence, not canonical product truth. Control-plane PostgreSQL contains no
private Session or memory content.

Core Memory contains two independently bounded, user-readable blocks that are
included in every turn:

- User Context records the Agent's current model of the User's identity, durable
  preferences, communication style, and standing constraints.
- Agent Notes record current goals, commitments, environment and workflow facts,
  and continuity.

The User can inspect, correct, clear, and independently bound both blocks. They
never contain hidden reasoning or chain-of-thought. Their initial budgets are
implementation defaults that prompt-utilization evidence can change.

The User does not need to say "remember this." The Agent records direct durable
facts and reasonable useful inferences proactively. It saves the narrowest
durable conclusion that explains the evidence and will probably improve future
behavior. A correction immediately replaces or removes the wrong conclusion.
The Agent does not add situational explanatory baggage or maintain a local claim
graph, typed confidence, provenance, reconciliation, or suppression machinery.
Sensitive or high-impact assumptions about health, religion, politics,
sexuality, legal status, or financial condition need strong direct evidence or
User confirmation.

Conflicting context uses this precedence:

```text
current User correction
  > current direct User statement
  > User Context
  > MemoryProvider recall
  > weak behavioral inference
```

Each incoming User message automatically assembles Core Memory, the rolling
Think context view, the current provider profile, query-relevant provider recall,
and the current User input. Provider recall has a strict timeout and fails open.
Session Recall is a separate model-invoked FTS5 search across current and
historical Sessions. Osfo does not run FTS5 automatically on each turn and does
not add a heuristic prefetch layer in v1. Some overlap between Core Memory and
provider context is acceptable until measurements justify deduplication.

The complete assembled prompt also includes Agent instructions, tool
definitions, compaction summaries, and recent Session history. Tool results can
extend it during the turn. Session Recall results join only after the model
invokes Session Recall.

MemoryProvider exposes Osfo-owned conversation operations, not generic document
storage. SupermemoryMemoryProvider is the v1 adapter. It maps `containerTag` to
`UserId` and `conversationId` to `SessionId`. This makes the Knowledge Base
User-scoped across Sessions and routes. If one User owns several Agents later,
they share this scope until a separate product decision changes it. After each
completed turn, Think commits the User and final assistant messages before an
Agent-local ordered outbox records a delta-only provider append. Outbox records
are synchronization machinery, not memory. The adapter sends only newly
committed messages for that Session. It never mixes full-transcript and delta
updates, creates fixed time windows, or runs another LLM before ingestion.
Human-readable tool outcomes and supported human-visible source details can be
included. Hidden reasoning, raw tool traces, credentials, secrets, aborted
output, and infrastructure records are excluded.

The caller-shaped interface has five operations: recall User-scoped context,
append one ordered Session delta, forget derived knowledge, delete one Session
conversation, and delete all knowledge for one User. Application-owned request,
result, and typed failure values isolate callers from Supermemory SDK types.
Provider selection is an internal composition decision, not a User setting.

Provider append failure never rolls back a committed Think turn. Failed appends
retry in Session order with stable append identities. Provider deletion
obligations also retry, and deletion remains pending until the provider confirms
it. Observability records provider latency, recall failures, retry count, and the
oldest pending append age. Osfo tells the User about degraded memory only when it
affects the requested task.

Compaction thresholds and safety headroom are configurable per model. The 50 to
60 percent context target is a measurement hypothesis, not a product rule.
Think's proactive overflow handling and bounded reactive compact-and-retry are
safety mechanisms. Osfo measures model context size, input utilization before
each model step, peak utilization, utilization before and after compaction,
tokens by prompt category where practical, compaction frequency, overflow and
retry events, output tokens, and tool-heavy turn growth.

Current and historical Sessions are retained indefinitely by default. Osfo does
not prune a current Session, apply a fixed age rule, or silently delete history
under storage pressure. Explicit `/new` creates a replacement current Session
and deletes nothing. Forget Knowledge updates Core Memory and asks
MemoryProvider to forget matching derived memory while preserving the original
Session transcript. Delete Session removes local messages, branches,
compactions, and search entries, settles related pending append work, and
permanently deletes the provider conversation. If it is current, Osfo creates
its replacement first. Account deletion fences the Agent, permanently deletes
all provider memory under the UserId scope, and deletes Agent SQLite as part of
the broader deletion flow. Individual-message deletion is not supported in v1.

Arbitrary files, web pages, and connected sources are not forced through the v1
conversation interface. A later source-ingestion operation needs a real product
caller and a separate decision. Knowledge Export also needs a separate decision
before implementation.

### Deletion and recovery

V1 has no product-level Agent backup, point-in-time restoration, or arbitrary
operator rollback. Worker restart, eviction, and normal Durable Object recovery
are not product restoration. Osfo does not restore an Agent to a point before a
confirmed privacy deletion. There is no independent Erasure Receipt database or
authority. Pending provider deletion is outbox or account-deletion state. A
future backup or restore feature must separately define logical export and import
or an independent deletion journal and restore gate.

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
Composio supplies current provider connection evidence for the Osfo Integration
Connection. Provider consent does not approve a send.

Composio owns integration OAuth and consent mechanics, OAuth credentials and
refresh tokens, connected-account records, provider token refresh, Gmail tool
discovery and execution, and provider API transport. Osfo does not persist Gmail
credentials or connected-account records and does not call Google OAuth or Gmail
APIs directly.

Osfo owns User identity and AuthSession authority, Plan Entitlements and Usage
Allowances, authorization decisions, human Approval for protected effects,
stable Action identity and idempotency, product-level outcome and recovery
policy, and safe audit evidence without credentials. An approved Gmail send must
still pass the current Osfo authorization checks before execution through
Composio.

If provider connection evidence is absent or no longer current, the operation
does not run. Composio owns reconnection and returns its authorization path. Osfo
records a provider-neutral outcome, keeps the stable Action identity, and resumes
or retries only under Osfo recovery and idempotency policy after current evidence
exists. Osfo never refreshes a provider token or treats a Composio connected
account as product authority.

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
Think Submission is created. Workflow progress stays outside Session Memory.

Osfo admits at most three milestone Think Submissions for one User in 24 hours.
Current authority is checked before each protected effect. Authority loss causes
Canceled, not Failure. The terminal follow-up uses a small company continuity
reserve when User allowance is no longer available.

### GM Summon and support

`HELP` and `HUMAN` always return a real support web path. They do not create a GM
Summon.

A Problem groups distinct Resolution Attempts in one Session without copying
Think history. An attempt counts as failed only after explicit User feedback or
objective failure evidence. Osfo can offer GM Summon only when one open Problem
has three distinct failed attempts, the User has active Adventurer entitlement,
no summon is active for the Session, and the allowance-period limit is available.
The User must confirm. One stable summon identity survives safe retries. Osfo
promises no response time.

## Module and persistence design

### Repository target

```text
alchemy.run.ts
infra/cloudflare/
  Db.ts
  ExecutionUnitWorkflow.ts
  Worker.ts

apps/worker/
  src/worker.ts
  src/app.ts
  src/auth.ts
  src/cors.ts
  src/handlers.ts
  src/routes.ts
  src/handlers/
    health.ts
  src/middleware/
  src/agents/
    osfo/
      agent.ts
      config.ts
      memory/
      storage/
      tools/
      skills/
    registration/
      agent.ts
      registration.ts
      tools/
      skills/
  src/services/
  src/db/
  src/workflows/
  src/adapters/
  src/integrations/
    composio/
    think/
    supermemory/
  src/identity/
  src/messaging/
  src/delivery/
  src/allowances/
  src/content/
  test/

packages/ui/
packages/api/
  src/api.ts
  src/groups/
    health.ts
  src/middleware/
    auth.ts
packages/auth/
  src/index.ts
  src/schema-generator.ts
packages/db/
  src/index.ts
  src/schema/
  src/migrations/
```

`apps/worker` is the sole Cloudflare composition root. It owns Cloudflare class
exports, binding conversion, environment decoding, concrete provider adapters,
Effect Layer assembly, Alchemy binding, host Promise-to-Effect conversion, and
product behavior. Its internal modules cover identity, registration, channel linking,
recovery, authorization, memory, messaging, Delivery, allowances, integrations,
background work, and semantic evidence. These remain cohesive behind deep Effect
Interfaces:

```text
UserLifecycle
Authorization
OsfoMemory
MessagingAdmission
Delivery
Allowances
IntegrationAuthority
WorkflowCorrelation
```

The Messaging Adapter Interface, persistence ports, and provider adapters remain
internal to `apps/worker`. A workspace package or public seam is allowed only
when it hides substantial behavior, protects a real authority, or has a second
consumer or demonstrated variation. Module Interfaces and observable outcomes
are the test surface.

The future Composio adapter belongs in
`apps/worker/src/integrations/composio/`. It stays behind one small typed Effect
Interface for the required v1 Gmail operations. It translates Composio connection
evidence and tool outcomes into Osfo terms. It does not create a broad integration
framework, own product authorization, or persist provider credentials or
connected accounts in PostgreSQL.

`packages/auth` is the private authentication module. It owns the Better Auth
policy, Dashboard plugin, phone plugin configuration, request-scoped factory,
and schema-generation entrypoint. It accepts a Drizzle database, Dashboard API
key, and provider callbacks. It does not read runtime bindings or open a
database connection.

`packages/db` is the private PostgreSQL module. It owns the shared Drizzle
schema, database construction, migrations, and migration tests. The Worker owns
the Hyperdrive resource lifecycle, Effect database Adapter, typed persistence
failures, Twilio Adapter, HTTP route, and product operations. Authentication and
product modules import only the schema area they use.

The future Think adapter belongs in `apps/worker/src/integrations/think/`. It is
extracted only after a second consumer or supported public Interface proves the
package seam. `packages/api` owns the shared HTTP contract. `packages/ui`
contains generic shared visual modules and no Osfo-specific product behavior.

The Worker-local `db` module owns the Hyperdrive PostgreSQL connection and its
Effect lifecycle. Product operations live outside it in caller-focused modules
such as registration, directory, and authorization. Agent SQLite and R2 remain
separate transaction authorities:

```text
PostgreSQL: shared control-plane transactions
Agent SQLite: one Agent transaction authority
R2: immutable object operations
```

PostgreSQL access stays inside `apps/worker`; the web application does not import
the database. Agent storage lives with the Durable Object SQLite authority, and
content operations live with R2.

### Runtime lifetime

```text
Osfo Worker
├── WorkerRuntime, one request or safe invocation scope
├── OsfoAgent Durable Object
│   └── OsfoAgentRuntime, one AgentId activation
└── Workflow classes
    └── WorkflowRuntime, one execution or resumed step
```

A runtime never crosses execution-unit or Agent lifetimes. One global
`ManagedRuntime` must not be shared across Agents. Each runtime is reconstructible
from its own bindings, identity, and durable inputs.

### Storage and transactions

Control-plane PostgreSQL owns Better Auth data, cross-Agent identity,
registration, channel, Subscription, allowance, Agent directory, deletion
progress, and administration facts. It contains no private
Session or memory content.

Think tables in each Agent SQLite database own Sessions, messages, branches,
compactions, context blocks, FTS5 search, and Think execution facts. Namespaced
Osfo tables in the same database own Acceptance Receipts, Delivery,
MemoryProvider outbox, Workflow correlation, proactive receipts, and Agent-local
allowance evidence. Osfo migrations never inspect or modify Think tables. R2
owns large or immutable content.

There is no transaction across PostgreSQL, Agent SQLite, R2, Think, Workflow, or an
external provider. Recovery uses stable identities and reconciliation.

Phone Verification and Better Auth complete before the Osfo product
registration transaction. Better Auth first commits the User, Phone Account
fields, and AuthSession. One later PostgreSQL transaction establishes or
recovers the Subscription, first allowance period, Agent route, registration
completion marker, and one Agent-initialization outbox obligation. The outbox
then calls the named Agent with a stable initialization
identity. Agent SQLite applies that initialization idempotently. Activation and
reconciliation recover a Better Auth User without product facts, a committed
outbox without Agent initialization, and an initialized Agent whose outbox
completion was not recorded.

The committed-turn projection is idempotent:

```text
stable Think committed-turn reference
  -> one Agent SQLite transaction
     + Delivery obligation and stored parts
     + ordered MemoryProvider append record
     + required operational records
```

An Agent activation reconciles committed Think turns that lack an Osfo projection.
Workflow outcomes and milestones use stable RPC to the named Agent. The Agent
records correlation and creates at most one proactive Submission.

PostgreSQL migrations are forward-only. Alchemy applies them before updated traffic.
Failure aborts deployment. Agent SQLite carries the complete immutable Osfo
migration chain because an Agent can sleep across releases. Initialization runs
migrations under Durable Object exclusion. Each migration has a version and
digest. Failure blocks only that Agent. Destructive changes use expand, migrate,
and contract releases.

### Infrastructure

The root `alchemy.run.ts` selects Stack, stage, provider state, concrete resources,
and safe outputs. It contains no product behavior. `infra/cloudflare` declares
the database, Osfo Worker, and execution-unit Workflow. One retained Neon project
owns the production branch. Development uses a retained child branch, and each
pull-request preview uses an expiring child branch. Each deployed stage owns its
Cloudflare resources and secrets. Secrets never enter stage outputs.

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

After 30 production days and 25,000 accepted registered messages, Osfo replaces
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
platform stores, Think, providers, Workflows, model access, memory,
Composio-backed Gmail operations, WhatsApp, and task compute. Safe evidence
contains no OAuth credential or provider token. Missing material semantic, usage,
or cost evidence makes the affected gate MISSING. At target, measured use stays
at least 30% below every hard limit.

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

Cloudflare is the only Osfo v1 production architecture. ADR 0003 supersedes the
GCP, Cloud SQL, PostgreSQL ThreadEvent, AgentRun driver, transactional outbox,
Pub/Sub, StreamingPull, Temporal, Native Thread Transport, fixed-worker, and GCP
Terraform implementation direction for Osfo v1.

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

- every web registration and Channel Link path, recovery, consent, expiry, and
  idempotent partial-failure case;
- webhook signature and schema rejection, duplicate inbound events, exact-byte
  Delivery recovery, status disorder, ambiguity, wake-up coalescing, suspension,
  support, and GM Summon;
- the full entitlement, soft-cap allowance consumption, Approval, downgrade,
  reminder, Workflow, and authority-loss matrix;
- Core Memory inference and correction, Session replacement, Session Recall,
  forgetting, Session and account deletion, ordered delta capture,
  MemoryProvider timeout, outage, and retry;
- PostgreSQL and Agent SQLite migration chains, interruption, old Agent activation,
  Think-table isolation, and Worker-to-Agent recovery;
- provider conformance and focused live qualification for Meta, SMS, managed
  models, Supermemory, Composio-backed Gmail, search, and temporary compute;
- the complete production and Model Quality gates in this document.

The linked implementation map owns the exact ticket order and live status. No
implementation ticket may silently decide a structural question that this
specification leaves open.

## Decision sources

- [Prove the Cloudflare account-agent foundation](https://github.com/heyimcarlos/osfo/issues/152)
- [Define Osfo Agent identity, Session, and execution dispatch](https://github.com/heyimcarlos/osfo/issues/153)
- [Define Osfo User registration, authentication, recovery, and capability enforcement](https://github.com/heyimcarlos/osfo/issues/154)
- [Define the Osfo Memory System and MemoryProvider contract](https://github.com/heyimcarlos/osfo/issues/155)
- [Define the WhatsApp launch transport and delivery contract](https://github.com/heyimcarlos/osfo/issues/156)
- [Freeze Osfo launch capabilities, approvals, allowances, and plan economics](https://github.com/heyimcarlos/osfo/issues/157)
- [Define Osfo module ownership, Drizzle persistence, and GCP migration](https://github.com/heyimcarlos/osfo/issues/158)
- [Define Osfo production SLOs, workload, observability, and cost gates](https://github.com/heyimcarlos/osfo/issues/161)
- [Define the Osfo phone-first onboarding and setup journey](https://github.com/heyimcarlos/osfo/issues/162)
- [Verify provider erasure and backup-retention guarantees](https://github.com/heyimcarlos/osfo/issues/163)
- [Define Osfo model-quality evaluation and release gates](https://github.com/heyimcarlos/osfo/issues/165)
