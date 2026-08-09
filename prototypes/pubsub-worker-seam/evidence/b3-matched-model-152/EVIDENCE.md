# GCP B3 matched-model load evidence

- Source revision: `a48e9da`
- Environment: live GCP, non-production, `northamerica-northeast1`
- Model: `openai/gpt-5-nano` through OpenRouter, eight output tokens maximum
- Workload: one AgentRun per accepted message using the accepted B3 load lane
- Correctness verdict: **PASS**

| Lane           | Offered | Accepted | Receipt p95 ms | Receipt p99 ms |  Within 1s | Receipt SLO | Terminal p95 ms | Audit |
| -------------- | ------: | -------: | -------------: | -------------: | ---------: | ----------- | --------------: | ----- |
| warm-up-23     |     230 |      230 |         43.851 |         59.333 | 100.00000% | PASS        |        4327.631 | PASS  |
| target-232     |  13,920 |   13,920 |         58.820 |        140.839 | 100.00000% | PASS        |        2506.678 | PASS  |
| stress-464     |   6,960 |    6,960 |        629.981 |       1578.523 |  98.04598% | FAIL        |        2334.127 | PASS  |
| post-stress-23 |     230 |      230 |         49.775 |         71.008 | 100.00000% | PASS        |        1944.139 | PASS  |

All 21,340 accepted messages produced one authoritative, terminal AgentRun. No nonterminal AgentRuns remained. The smoke gate also completed three real-model calls before the measured lanes.

## Cloudflare comparison

| Lane           | Cloudflare p95 ms | GCP p95 ms | Cloudflare p99 ms | GCP p99 ms | Cloudflare within 1s | GCP within 1s |
| -------------- | ----------------: | ---------: | ----------------: | ---------: | -------------------: | ------------: |
| warm-up-23     |          1195.984 |     43.851 |          1343.481 |     59.333 |            63.47826% |    100.00000% |
| target-232     |          1660.245 |     58.820 |          2272.104 |    140.839 |            86.73132% |    100.00000% |
| stress-464     |          8976.059 |    629.981 |          9209.431 |   1578.523 |             6.22126% |     98.04598% |
| post-stress-23 |           307.057 |     49.775 |           379.278 |     71.008 |           100.00000% |    100.00000% |

Both candidates used the same external model, system instruction, current user message, eight-token output cap, one agent turn per message, and arrival lanes. The reused GCP topology is the previously accepted B3 transactional-outbox system, not a new implementation.

This is not a fully identical context or identity workload. Cloudflare Think assembled each account's accumulated session history. The GCP B3 model seam sent the fixed system and current user messages without prior session history. The reused GCP lane also carried no Principal or Thread identity, while Cloudflare distributed requests across 1,024 accounts. OpenRouter response token and cache telemetry is **MISSING**, so the immediate provider account deltas cannot explain the latency difference by themselves.

The GCP target used at most 16 workers with 32 concurrent handlers per worker. Cloudflare used 1,024 named account-agent Durable Objects. Both clients ran from the local Toronto development host. These results characterize the tested topologies and do not qualify production behavior.

## Cost and teardown

The immediate OpenRouter account usage delta was `$0.00001035`. This is a provider account delta, not a complete invoice or per-request usage record. GCP infrastructure cost is **MISSING**.

Teardown verification recorded zero manifest-owned Cloud Run services, Cloud SQL instances, Pub/Sub topics or subscriptions, Artifact Registry repositories, secrets, and service accounts.
