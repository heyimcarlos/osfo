# ADR 0003: Select Cloudflare as the Oz v1 User-agent foundation

Date: 2026-08-08

Status: Accepted, production qualification pending

Oz v1 will use Cloudflare as its application and agent-runtime foundation. One
User-scoped Oz Agent backed by a Durable Object will host the canonical Think
Thread and private operational state, while Workers handle ingress, R2 holds files, and
Scheduled Tasks provide ordinary reminders. The accepted foundation prototype
selects Cloudflare Think as the Agent Harness. Supermemory remains a separate,
rebuildable retrieval projection.

This choice favors iteration speed, TypeScript, isolated scale-to-zero User
state, and one operated platform over LangGraph's greater maturity and
portability. It supersedes the first application architecture. Git history
preserves that implementation. Current source must use the selected foundation.

The decision research proved direct durable submission, D1 and Agent SQLite
migrations, interruption recovery, scheduling, idempotency, Effect integration,
and activation recovery. This does not qualify production. The production SLO,
recovery, model-quality, and cost gates remain mandatory.

Alchemy is the selected infrastructure-as-code system for provisioning the
Cloudflare stack, declaring bindings, applying deploy-time D1 migrations, and
composing stage outputs. Oz accepts Alchemy's pre-stable release risk for v1 in
exchange for faster iteration and Effect-native infrastructure composition.
Alchemy does not become the Agent Harness or own Oz runtime behavior. The
Think-derived Durable Object class remains a normal Cloudflare runtime export,
with one explicit Promise-to-Effect adapter where Cloudflare callbacks enter
Oz services.
