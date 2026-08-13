# ADR 0004: Use Think as the sole Thread and turn authority

Date: 2026-08-12

Status: Accepted

Osfo v1 uses Think Session history as its only canonical Thread and one stable
Think Submission as the lifecycle owner for each conversational turn. Osfo stores
product correlation, Delivery, memory, allowance, and side-effect evidence, but
it does not create a parallel ThreadEvent stream, AgentRun, or execution state
machine. This prevents two recovery authorities from disagreeing and lets the
selected Agent Harness own the behavior that it already implements.

Cloudflare Workflows remain separate authority for work whose independent
steps, waits, approvals, or retryable effects matter. Scheduled Tasks and Agent
Queue Tasks keep their accepted narrow roles. Results enter the Thread only
through a new idempotent Think Submission.
