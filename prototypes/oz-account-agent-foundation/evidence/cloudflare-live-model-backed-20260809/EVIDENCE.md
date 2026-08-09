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

The real-model GCP target accepted 13,920 messages at 232/s with caller-to-receipt p95 58.820 ms and p99 140.839 ms. The Cloudflare target recorded p95 1660.245 ms and p99 2272.104 ms. The older GCP result of p95 20.435 ms and p99 91.173 ms used a synthetic 15 ms executor.

Both real-model candidates used one agent turn per message and the same external model, system instruction, current user message, output cap, and arrival lanes. Cloudflare Think assembled accumulated account session history and distributed requests across 1,024 accounts. The reused GCP B3 harness sent no prior session history and carried no Principal or Thread identity. This run is a topology characterization from a Toronto client, not production qualification.

Cloudflare provider CPU and duration telemetry, a server-side D1 versus Durable Object versus Think receipt-stage breakdown, Cloudflare infrastructure cost, multi-region clients, and sustained production qualification are **MISSING**. The measured cost is OpenRouter model usage only.
