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
