# ADR 0002: Use Think as the sole Session and turn authority

Date: 2026-08-12

Status: Accepted

For Osfo v1, Think Session history is the only canonical conversation record,
and one stable Think Submission is the lifecycle owner for each conversational
turn.
One Osfo Agent can own several conversation routes, each route has exactly one
current Session, and an explicit reset replaces that current Session without
deleting its historical Sessions. Osfo stores product correlation, Delivery,
allowance, and side-effect evidence, but it does not create a parallel
conversation event stream, AgentRun, or execution state machine. This prevents
two recovery authorities from disagreeing and lets the selected Agent Harness
own the behavior that it already implements.

Cloudflare Workflows remain separate authority for work whose independent
steps, waits, approvals, or retryable effects matter. Scheduled Tasks and Agent
Queue Tasks keep their accepted narrow roles. Results enter a Session only
through a new idempotent Think Submission.
