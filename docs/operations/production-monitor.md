# Production monitor

The existing scheduled workflow checks API runtime identity, web HTML and API
Worker runtime errors. No additional scheduler or notification channel is created.
GitHub failed-run notification routing and actual scheduled firing must be
qualified separately. The schedule can be delayed or dropped; this is not a
five-minute detection guarantee.

## Analytics configuration

Configure repository secrets `CLOUDFLARE_ANALYTICS_ACCOUNT_ID` and
`CLOUDFLARE_ANALYTICS_API_TOKEN`. The token needs only **Account / Account Analytics /
Read** for the production account. Missing or invalid configuration makes the
metrics result `MISSING` and the monitor unsuccessful. Never log credentials or
GraphQL response bodies. Rotate the token before its configured expiry.

The query uses `accounts.workersInvocationsAdaptive` filtered to the exact deployed
API script `osfo-api-production-z523cwnu5fuebaer`. Selecting only the script
name dimension aggregates its request/error totals rather than truncating a list
of timestamps or statuses. The response must contain exactly one account and at
most one matching script group. GraphQL errors, partial responses, malformed
counts, HTTP failures, redirects, oversized bodies and timeouts are unavailable
coverage, never zero errors. Each metrics query has a ten-second bound and no
retry. Existing availability probes retain their separate bounded retry.

Monitor policy is a fifteen-minute window ending five minutes before observation,
with overlapping checks. Any observed error fails; positive request volume with
zero reported errors passes for that sampled window only. No rows or zero traffic
is `NO_DATA` and unsuccessful coverage. The delay is a conservative policy choice,
not a guaranteed provider ingestion deadline. Neither the issue contract nor this
monitor establishes an error-rate SLO. Sampling can miss events.

The verified production Web script `osfo-web-production-hxz26hpoghafseuv` serves
assets without Worker code, so its runtime-error result is `NOT_APPLICABLE`.
HTTPS HTML remains checked. This exemption is based on deployment inventory, not
on an empty analytics response. Requalify it on every deployment that adds Worker
code or changes the script name. If the API script name changes, update the query
target with the deployment inventory before relying on the monitor.

Database health, providers, durable-operation outcomes, browser journeys and
complete production health are not covered. A successful query does not verify
scheduled firing or receipt of a failed-run email.

Sources: [Cloudflare token permissions](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/),
[Workers metrics query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/),
[GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
