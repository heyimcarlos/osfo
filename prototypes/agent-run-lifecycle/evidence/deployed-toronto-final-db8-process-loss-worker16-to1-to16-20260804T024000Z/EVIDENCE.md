# Deployed AgentRun process-loss cut

- Workload window: 2026-08-04T02:36:24Z to 2026-08-04T02:36:57Z
- Offered load: 232 authenticated messages per second for 20 seconds
- Worker fleet scale-down started: 2026-08-04T02:36:33Z
- Worker fleet reached one configured instance: 2026-08-04T02:36:40Z
- Worker fleet restore started: 2026-08-04T02:36:50Z
- Worker fleet restore operation finished: 2026-08-04T02:37:03Z
- Final fleet: 16 instances, ready

All 4,640 offered messages were accepted and completed. There were zero
caller drops, admission failures, completion failures, duplicate authority
records, or typed-record audit failures. All 4,640 Cloud SQL evidence checks
and all 47 sampled idempotent replay checks passed.

The reduced fleet created an observable queue: authoritative terminal p95 was
10.35 seconds and the backlog drained 12.75 seconds after the offer window.
Cloud SQL leases and fencing allowed replacement processes to finish accepted
work without losing or duplicating authority.
