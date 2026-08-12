# ADR 0005: Align Oz storage with transaction authority

Date: 2026-08-12

Status: Accepted

Oz v1 stores cross-Agent directory, identity, Subscription, and administration
facts in D1; private Thread and Oz product facts in each Agent's Durable Object
SQLite database; large immutable content in R2; and rebuildable retrieval data
in Supermemory. Drizzle owns schema declarations, typed queries, and generated
migrations for D1 and Agent SQLite. No cross-store transaction exists.

Each deep product operation commits its semantic evidence with its product fact
inside the same local transaction. Cross-store work uses stable identities and
reconciliation. Content-free Erasure Receipts live outside restore targets and
must be replayed before restored state can serve work. This split follows real
failure and transaction scopes instead of creating one database abstraction or
a second canonical copy.
