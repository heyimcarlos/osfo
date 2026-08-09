# Cloudflare account-agent live load evidence

- Source revision: `3bb0377`
- Environment: live Cloudflare, non-production
- Model: `openai/gpt-5-nano` through OpenRouter, eight output tokens maximum
- Overall verdict: **FAIL**

| Lane           | Offered | Accepted | Receipt p95 ms | Receipt p99 ms |  Within 1s | Verdict |
| -------------- | ------: | -------: | -------------: | -------------: | ---------: | ------- |
| warm-up-23     |     230 |      230 |       1195.984 |       1343.481 |  63.47826% | FAIL    |
| target-232     |   13920 |    13920 |       1660.245 |       2272.104 |  86.73132% | FAIL    |
| stress-464     |    6960 |     6960 |       8976.059 |       9209.431 |   6.22126% | FAIL    |
| post-stress-23 |     230 |      230 |        307.057 |        379.278 | 100.00000% | PASS    |

The frozen GCP short target accepted 13,920 messages at 232/s with caller-to-receipt p95 20.435 ms and p99 91.173 ms. The matched Cloudflare target recorded p95 1660.245 ms and p99 2272.104 ms.

The terminal audit records acceptance-to-completion, queue, and model duration separately. The Cloudflare workload maps one message to one account-agent turn. The GCP workload derived 1.5 AgentRuns per incoming message. This run is a topology characterization from a Toronto client, not production qualification.

Cloudflare provider CPU and duration telemetry, a server-side D1 versus Durable Object versus Think receipt-stage breakdown, Cloudflare infrastructure cost, multi-region clients, and sustained production qualification are **MISSING**. The measured cost is OpenRouter model usage only.
