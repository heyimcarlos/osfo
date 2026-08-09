# ADR 0003: Select Cloudflare as the Oz v1 account-agent foundation

Date: 2026-08-08

Status: Accepted, qualification pending

Oz v1 will use Cloudflare as its application and agent-runtime foundation. One
account-scoped Agent backed by a Durable Object will own the canonical Thread's
private operational state, while Workers handle ingress, R2 holds files, and
alarms provide ordinary reminders. Cloudflare Think is the selected harness
candidate, subject to the agreed acceptance prototype, and Supermemory remains
the separate Knowledge Base provider.

This choice favors iteration speed, TypeScript, isolated scale-to-zero account
state, and a single operated platform over LangGraph's greater maturity and
portability. It supersedes the GCP, Pub/Sub, fixed-worker, Cloud SQL, and
hand-rolled runtime direction for Oz v1 in ADRs 0001 and 0002. Their durable
semantics remain historical evidence and may be retained only where the
selected harness does not already provide the required behavior.

Alchemy is the selected infrastructure-as-code system for provisioning the
Cloudflare stack, declaring bindings, applying deploy-time D1 migrations, and
composing stage outputs. Oz accepts Alchemy's pre-stable release risk for v1 in
exchange for faster iteration and Effect-native infrastructure composition.
Alchemy does not become the Agent Harness or own Oz runtime behavior. The
Think-derived Durable Object class remains a normal Cloudflare runtime export,
with one explicit Promise-to-Effect adapter where Cloudflare callbacks enter
Oz services.
