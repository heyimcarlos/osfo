# ADR 0006: Define explicit authorization and allowance facts

Date: 2026-08-14

Status: Accepted, allowance reservation rules superseded by ADR 0007

Osfo does not use a generic `denial_facts` table. Launch authorization denies by
default from explicit current facts: User Suspension, AuthSession revocation,
Channel Binding revocation, deletion access revocation, missing ownership,
inactive Plan entitlement, exhausted Usage Allowance, missing or revoked
Integration Connection, and missing Approval. Each owning product module reads
and changes its own fact. The Authorization module combines their typed results.

Osfo does not add a generic security audit table before a concrete workflow
needs one. Registration state is recoverable from the User completion marker,
Agent route, Subscription, and first allowance period. Application logs support
early operational debugging. A later suspension feature can add purpose-built
suspension history. A shared historical model can be extracted only after
several concrete security workflows require it.

The initial Usage Allowance period remains in the control-plane schema because
registration establishes the first Free period. A period is scheduled, active,
or expired from its half-open time interval. It does not roll over. Phase 5 adds
separate reservation facts keyed by work identity. A reservation moves once
from reserved to committed or released. Authorization subtracts committed and
currently reserved quantity from the period limit. Expiry blocks new
reservations but retains usage and unresolved reservation evidence for
reconciliation.

Better Auth and Agent SQLite remain separate transaction authorities. Better
Auth first commits the User, Phone Account fields, and AuthSession. One later
PostgreSQL transaction commits product registration facts and one
Agent-initialization outbox obligation. The named Agent applies that obligation
idempotently in SQLite. Stable identities and reconciliation
recover failure after either commit. No network call or Agent SQLite operation
runs inside the PostgreSQL transaction.
