# ADR 0004: Use Native Memory with a replaceable MemoryProvider

Date: 2026-08-13

Status: Accepted

Osfo v1 separates Agent-owned Native Memory from the User-scoped Knowledge
Base. Think stores Core Memory, Sessions, compaction overlays, and on-demand
full-text Session Recall in the Agent Durable Object SQLite database.
MemoryProvider is the application-owned seam for semantic recall, ordered
conversation appends, forgetting, and deletion. SupermemoryMemoryProvider is the
first adapter, with `UserId` as its permission scope and `SessionId` as its
conversation identity. Provider recall fails open and provider writes reconcile
from an Agent-local durable outbox, so provider failure never blocks normal
conversation. The outbox is synchronization machinery, not memory.

This replaces the local claim graph, Knowledge Space, Schema Pack, suppression
marker, provider-generation, and independent Erasure Receipt designs. Osfo does
not duplicate Supermemory's semantic extraction or profile machinery. Session
history remains the canonical record of what happened, Core Memory is the
Agent's bounded working model, and provider recall is supporting evidence. V1
does not support product backup or point-in-time restoration, so a future
restore feature must define its own deletion journal and restore gate instead of
adding restore machinery to the v1 Memory System.
