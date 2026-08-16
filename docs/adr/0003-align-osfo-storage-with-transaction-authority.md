# ADR 0003: Align Osfo storage with transaction authority

Date: 2026-08-12

Status: Accepted, control-plane storage superseded by ADR 0007, memory and restore rules superseded by ADR 0006

Osfo v1 stores cross-Agent identity, Agent routing, Subscription, and administration
facts in a shared control-plane database; private Session and Osfo product facts in each Agent's Durable
Object SQLite database; large immutable content in R2; and the User-scoped
Knowledge Base through MemoryProvider. Drizzle owns schema declarations, typed
queries, and generated migrations for the control plane and Osfo-owned Agent SQLite tables. No
cross-store transaction exists.

Each deep product operation commits its semantic evidence with its product fact
inside the same local transaction. Cross-store work uses stable identities and
reconciliation. MemoryProvider appends and deletion obligations use an
Agent-local durable outbox. V1 has no product backup, point-in-time restore, or
independent Erasure Receipt ledger. This split follows real failure and
transaction scopes instead of creating one database abstraction or a second
canonical copy.

## Agent SQLite foundation

Osfo uses `drizzle-orm/durable-sqlite` for its Agent-local application tables.
Drizzle owns the table declarations, inferred row types, normal reads and writes,
and generated SQL migration files. The Agent-local schema does not contain a
second Agent directory. PostgreSQL owns the cross-Agent directory. The named
Durable Object stores only one `osfo_agent_initialization` receipt as local
initialization evidence and an optional AgentId consistency guard. The receipt
also preserves the initial route and Session identities. Current Session changes
do not change these original initialization facts.

The first stable primitives are:

```text
osfo_agent_initialization       one local initialization fact
osfo_conversation_routes        stable Agent-local routes
osfo_session_ownership          current and historical Think Session identities
osfo_committed_turns             committed-turn observation receipts
```

Foreign keys express route and Session ownership. Partial unique indexes permit
only one primary route and only one current Session per route. The initialization
receipt, initialization identity, Session identity, assistant message identity,
and non-null Think request identity are unique. Store transactions create the
required primary route and current Session together, and replace a current
Session without deleting its historical ownership row.

Initialization replay must match the complete stored receipt, including the
initialization timestamp and the initial route and Session identities. A compatible
replay returns the route's current Session, which can differ from its initial
Session. Conflicts report both established and attempted stable identities so
operators can diagnose a rejected replay without inspecting private Think state.

Each committed-turn receipt has an SQLite-assigned monotonic
`observation_sequence`. This value records Osfo observation order only. It is not
a provider timestamp and does not claim wall-clock commit order. Reconciliation
uses Session ownership order, then Think Session history order, and writes one
receipt at a time. A repeated observation preserves its first sequence and
observation time. One local transaction checks assistant message and Think request
identity, enriches a compatible receipt, or inserts the next receipt. Identity
conflicts are typed failures.

Think remains the only authority for Session content, branches, messages, and
history. Osfo queries and migrations do not inspect or change Think tables.

## Agent SQLite migration policy

The generated Drizzle migration files form one complete immutable version chain.
Before the first release, development-only corrections are folded into one
coherent baseline. After release, every migration is immutable and additive.
An Osfo coordinator verifies that versions are continuous and verifies the SHA-256
digest of each generated SQL file before it reads or changes database state. It
also verifies the applied ledger as an exact supported prefix and rejects gaps,
changed digests, and future versions.

Agent activation runs the coordinator inside Durable Object concurrency exclusion.
Each generated migration and its ledger row run in one synchronous SQLite
transaction. An interruption therefore commits both or neither, and the next
activation can retry safely from every supported old version.

Direct Durable Object SQLite access is limited to these explicit cases:

- `PRAGMA foreign_keys = ON`, because Drizzle has no clearer Durable SQLite API
- migration ledger bootstrap and reads, because the ledger is coordinator state
- `transactionSync` for generated DDL plus its ledger row, because this is the
  exact synchronous atomicity boundary

Product stores use typed Drizzle operations and show their transaction boundaries.
They parse retrieved records with Effect Schema and do not hide transaction
boundaries behind a generic repository. Think Session history records are also
parsed into an Osfo-owned boundary shape at the public Session seam.
