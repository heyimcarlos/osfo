# Hermes, Composio, tools, and skills study

Date: 2026-08-22  
Research refreshed: 2026-08-23  
Issue: [#252](https://github.com/heyimcarlos/osfo/issues/252)

## Decision

Ticket 252 should keep the provider boundaries and authority model stated in the
issue.

- Borrow progressive Skill disclosure from Hermes and Codex. Show only compact
  metadata until a Skill is selected, then load its instructions and only the
  references needed for the operation.
- Borrow Poke's product-level precedent for broad capability availability, one
  visible usage surface, and a useful lighter mode after exhaustion. Do not use
  Poke as evidence for exact allowances, authorization, or unit economics.
- Use Composio Platform sessions as a credential and tool-transport boundary.
  One stable Osfo user identity should scope one resumable Composio session for
  each Osfo session. The Composio session, discovered tool, or connected account
  must never grant Osfo authority.
- Keep the Osfo Capability Catalog closed. Expose only approved operations from
  the active Tool Bundle manifest. Keep Composio meta tools, multi-execution,
  Remote Workbench, Bash, arbitrary MCP tools, and sandbox access hidden.
- Keep Cloudflare AI Gateway Dynamic Routing as the selected managed-routing
  candidate, subject to the ticket's compatibility and reconciliation proof. It
  is currently Beta and its compatibility path has material constraints.
- Treat OpenRouter as a useful routing and evidence comparator, not as the
  default execution plane and not as pricing authority for Osfo usage. Do not
  layer independent OpenRouter routing underneath a Cloudflare dynamic route.
- Keep Cloudflare as the default execution provider, Neon as the control-plane
  PostgreSQL provider, and Composio and Supermemory as specialist providers.
  Stripe, Twilio, Meta, and Google remain explicit external service endpoints.
- Do not activate either plan from this study. The economics verdict is
  `MISSING`: no qualified route model set, complete measured workload, complete
  fixed-cost allocation, settlement evidence, support estimate, conservative
  foreign-exchange input, or exact soft-cap overshoot bound exists yet.

This is a source comparison and economics input register. It is not the
activation artifact required by the issue.

## Method and freshness

Only official product documentation, official pricing pages, official APIs, and
official source repositories are used. Every web source below was checked on
2026-08-23. Where a publisher exposes a page update date or a source commit, it
is recorded. A current page without an effective-date history is weaker than an
immutable quote, invoice, or versioned price snapshot.

`MISSING` has a strict meaning in this document: the fact is required to approve
the design or economics, but the reviewed first-party evidence does not provide
it. It is not estimated or silently treated as zero.

Published prices are observations, not an Osfo `Resource Price Version`. The
implementation must preserve the observed source, observation time, resource
identity, unit, integer USD-micro rate, and effective interval before a rate can
authorize completed usage. Provider-reported cost remains Company Cost or
reconciliation evidence, not mutable user-facing usage authority.

## Product and architecture comparables

### Hermes Agent

Hermes treats Skills as on-demand knowledge rather than always-present prompt
content. Its discovery layer initially exposes only Skill names, descriptions,
and categories. The selected Skill body is loaded later, and referenced material
is loaded only when needed. This is direct support for Osfo's progressive Skill
and Tool Bundle disclosure. Hermes also supports platform and tool requirements,
so unavailable Skills can be excluded before selection. See the official
[Skills source at the reviewed commit](https://github.com/NousResearch/hermes-agent/blob/336059011521c595d00803be93d1652aaab58720/website/docs/user-guide/features/skills.md),
last changed 2026-08-18.

Hermes also demonstrates the risks ticket 252 is intended to avoid. Its agent
can create, edit, and delete filesystem-backed Skills. Skills can include scripts
and reference assets. Write approval is configurable and is not the same as an
immutable, evidence-backed personal Skill lifecycle. Third-party and project
Skills receive provenance and quarantine controls, which are worth adopting,
but the public design still presents mutable local files rather than Osfo's
protected version history.

Hermes exposes a broad built-in tool registry, dynamic MCP toolsets, terminal
execution, filesystem operations, browser automation, delegation, memory, and
multiple execution backends. See the official
[Tools source at the reviewed commit](https://github.com/NousResearch/hermes-agent/blob/bceda18df08b79130a734495a41f5cd7dace3b58/website/docs/user-guide/features/tools.md),
last changed 2026-08-17. That breadth fits a general computer-use agent, but not
Osfo's closed consumer Capability Catalog. Osfo should not adopt Hermes's Bash,
persistent workspace, eager broad registry, dynamic MCP exposure, or mutable
agent-authored Skill semantics.

Hermes documents command approval, filesystem approval, isolation, MCP filtering,
Skill scanning, and input sanitation in its official
[security guide](https://hermes-agent.nousresearch.com/docs/user-guide/security).
The guide also documents approval modes and bypasses. These are useful defense
comparables, but they do not establish ticket 252's exact typed Approval,
evidence, or immutable rate requirements. Exact Hermes hosting, model, tool, and
Nous Portal economics are `MISSING` from the reviewed first-party material.

### Poke

Poke is useful as a product comparison, not an implementation template. Its
official [pricing page](https://poke.com/pricing) says that every plan gets Poke,
while the plan details give paid tiers greater model intelligence, automation,
and headroom. Its official [usage and resets guide](https://poke.com/docs/usage-and-resets)
documents one usage bar, a visible reset, and a lighter conversational behavior
after exhaustion. This supports ticket 252's combination of broad capability
availability, a single usage surface, and a useful exhausted state.

The details narrow that precedent:

- Free, Pro, and Ultra are shown as `$0`, `$19/month`, and `$199/month`, but the
  page does not state an ISO currency code.
- Pro adds frontier models for complex work and real-time automations. Ultra adds
  frontier models on every action and pay-as-you-go use. The page therefore does
  not prove identical model access or service levels across plans.
- Public first-party material does not publish Free or Pro allowance quantities,
  Ultra's included-credit quantity, the exact reset duration, or its rating
  algorithm. Those facts are `MISSING`.

Poke's official guides separate
[integrations](https://poke.com/docs/managing-integrations) from
[recipes](https://poke.com/docs/creating-recipes). Recipes package guidance and
required integrations, which resembles Osfo's separation between a Skill and an
Integration Connection. Poke's
[custom MCP guide](https://poke.com/docs/mcp-servers), however, discovers the
tools exposed by a server. Osfo must reject that open-ended pattern and admit
only approved manifest operations.

Poke's [release notes](https://poke.com/docs/release-notes) record Poke Human as
a separate human service and say real-world expenses are charged at cost. That
is a useful comparison for keeping GM Summon outside ordinary automatic tool
authority. The public pages do not document Poke's exact Approval semantics,
security boundary, provider bills, or unit economics, so none can be imported
into the ticket 252 gate.

### Codex Skills, plugins, and deferred tools

Codex uses metadata-first Skill discovery and loads `SKILL.md` only after a
Skill is selected. References and scripts are accessed later as needed. See the
official [Customization and Skills documentation](https://developers.openai.com/codex/concepts/customization/#skills).
This is strong support for ticket 252's context discipline, but executable Skill
scripts are not appropriate for Osfo personal Skills. Osfo personal Skills remain
natural-language procedure, policy, and context. Tool authority stays elsewhere.

Codex plugins keep Skills, MCP servers, apps, assets, hooks, and permissions as
separate concepts. See the official
[plugin build documentation](https://developers.openai.com/codex/plugins/build/)
and [Plugins in Codex help article](https://help.openai.com/en/articles/20001256-plugins-in-codex/),
which was displayed as freshly updated when checked on 2026-08-23. The latter
states that app permissions and source-system permissions remain in force. This
supports ticket 252's distinction between Skill selection, an Integration
Connection, exact Approval, and source-system authority.

The official Codex source also demonstrates deferred schema exposure. With tool
search enabled, ordinary MCP tools can be deferred rather than placed directly
in the initial model tool list, and policy filtering occurs before model-visible
exposure. The search handler performs bounded retrieval over deferred tool
specifications. See
[`mcp_tool_exposure.rs`](https://github.com/openai/codex/blob/479c8c8924eaafdeb56e86154cd19ff0805839e4/codex-rs/core/src/mcp_tool_exposure.rs)
and
[`tool_search.rs`](https://github.com/openai/codex/blob/479c8c8924eaafdeb56e86154cd19ff0805839e4/codex-rs/core/src/tools/handlers/tool_search.rs)
at the reviewed repository commit.

Osfo should adopt the context-saving pattern, not the orchestration surface.
Search can choose which already-approved schema to show; it must not convert a
provider-discovered tool into authority.

### Comparable conclusion

| Pattern                                           | First-party precedent       | Ticket 252 choice        |
| ------------------------------------------------- | --------------------------- | ------------------------ |
| Metadata-first Skills                             | Hermes, Codex               | Adopt                    |
| Load references only when needed                  | Hermes, Codex               | Adopt                    |
| Separate procedure from connected authority       | Codex plugins, Poke recipes | Adopt and strengthen     |
| One usage surface and lighter exhaustion behavior | Poke                        | Adopt product shape only |
| Agent-mutated executable Skills                   | Hermes                      | Reject                   |
| Broad terminal, filesystem, or MCP catalog        | Hermes, Poke custom MCP     | Reject                   |
| Search or discovery grants tool authority         | No suitable precedent       | Reject explicitly        |
| Source permissions survive agent integration      | Codex plugins               | Adopt                    |
| Human operator as ordinary automatic tool         | No suitable precedent       | Reject; retain GM Summon |

## Composio Platform boundary

### Sessions and identity

Composio defines a session as runtime context for a user, tool access,
authentication, and connected accounts. Its official
[platform overview](https://docs.composio.dev/docs/how-composio-works) and
[quickstart](https://docs.composio.dev/docs/quickstart) recommend a stable app
user identifier and persisting the session identifier instead of creating a new
session on every turn.

That supports the ticket's chosen mapping:

```text
authenticated Osfo User
  -> Osfo Session
     -> one resumable Composio session
        -> eligible connected account selected for this operation
           -> approved manifest operation
```

The mapping is contextual, not authoritative. An Osfo session record must bind
the authenticated user, its Composio session identifier, and lifecycle state.
Supplying a stable Composio user identifier, possessing a Composio session ID,
or finding a connected account does not approve any later effect.

### Tool discovery and execution

The official [session configuration guide](https://docs.composio.dev/docs/configuring-sessions)
documents several defaults that Osfo must override:

- Sessions can start with every toolkit available.
- Meta tools can discover and execute tools dynamically.
- The sandbox is enabled by default and exposes Remote Workbench and Bash.
- Multi-execution can invoke multiple tools.
- A Direct Tools preset or explicit tool and toolkit allowlist can narrow the
  visible catalog.
- Account selection can be restricted to one account when multi-account behavior
  is disabled.

Ticket 252 therefore should use a session with sandbox access disabled and an
explicit approved operation set. Composio meta tools, multi-execution, Remote
Workbench, and Bash must not appear in the model-visible catalog. A provider tool
slug or tag is only discovery metadata. The Osfo Tool Bundle manifest supplies
the admitted operation, typed input, review requirement, output handling, and
price-resource mapping.

The pricing page distinguishes a Session from direct execution outside a
Session. Ticket 252 selects session-scoped approved tools, not the outside-session
direct-execution product. The precise invoice treatment of that configuration is
still `MISSING` and must be confirmed with a bill before activation.

### Connect Links and credentials

Composio's official
[manual authentication guide](https://docs.composio.dev/docs/authentication/manually-authenticating)
documents `session.authorize`, a returned Connect Link or redirect URL, callback
configuration, and status waiting. The broader
[authentication guide](https://docs.composio.dev/docs/authentication) says that
managed credentials are stored and refreshed by Composio and need not pass
through the application or model.

Osfo should use that transport while retaining its own binding rules:

- Create the Connect Link from an authenticated server-side Osfo request.
- Persist a one-time binding to the exact Osfo user, intended toolkit, callback,
  and expiry.
- Do not trust a callback query parameter as user identity.
- On callback, verify the server-side binding and connected-account result before
  attaching it to the Osfo user.
- Require normal Osfo Approval for every later effect. Connection is not consent
  for a future operation.
- Keep one selected connected account per operation and disconnect cleanly after
  eligibility or exhaustion rules require it.

Composio's official
[API-key guide](https://docs.composio.dev/reference/authenticating-to-composio)
documents organization, project, and scoped keys. Use the least-scoped server-side
credential. No Composio credential, Connect Link, or raw provider token belongs
in model context, logs, Skill material, or browser-readable state.

### Security evidence and remaining gaps

Composio's official [security page](https://composio.dev/security/) states SOC 2,
TLS 1.2, and AES-256 controls. Those are provider claims, not proof that the Osfo
account has the needed retention, zero-data-retention, regional, DPA, or incident
terms. The current pricing page makes some of those controls plan-dependent.

Before activation, the following remain `MISSING`:

- the contracted Composio plan and ISO billing currency;
- the exact retention and payload-logging configuration;
- whether zero-data-retention or a DPA is required and purchased;
- a scoped-key and rotation record for the production project;
- invoice evidence for session-scoped direct tools, managed versus owned apps,
  connections, triggers, and any security add-ons;
- a callback threat-model test and disconnect/revocation proof;
- provider behavior when a connected account is revoked during an operation.

### Current Composio price observations

The official [Composio pricing page](https://composio.dev/pricing) was checked on
2026-08-23. It says the displayed schedule applies to signups on or after
2026-08-15, with transition dates for older accounts. The page uses `$` but does
not state an ISO currency code in the reviewed text, so currency is `MISSING`
until confirmed contractually.

| Item                               |                      Published observation | Integer micro form if USD is confirmed |
| ---------------------------------- | -----------------------------------------: | -------------------------------------: |
| Free plan                          |                                 `$0/month` |                                      0 |
| Free total tool-call allowance     |                 100,000/month, hard capped |                        Not a unit rate |
| Free managed-app tool calls        |                Up to 20,000 of the 100,000 |                        Not a unit rate |
| Pro plan                           |      `$29/month`, with `$29` usage balance |                       29,000,000/month |
| Owned-app tool call overage        |                             `$0.0003/call` |                               300/call |
| Managed-app tool call overage      |                             `$0.0005/call` |                               500/call |
| Owned-app trigger overage          |                           `$0.003/trigger` |                          3,000/trigger |
| Managed-app trigger overage        |                           `$0.005/trigger` |                          5,000/trigger |
| Managed-app connection overage     |     `$0.10/connection` after included tier |                     100,000/connection |
| Direct execution outside a Session |        `+$0.0001/call` after included tier |                              +100/call |
| Proxy execution                    |        `+$0.0002/call` after included tier |                              +200/call |
| Sandbox execution                  |        `+$0.0001/call` after included tier |                              +100/call |
| Sandbox LLM use                    | `$3.75/million tokens` after included tier |                      3,750,000/million |
| Zero-data-retention add-on         |   `+$0.0001/tool call`, `+$0.0005/trigger` |                +100/call, +500/trigger |
| DPA or BAA add-on                  |                               `$500/month` |                      500,000,000/month |
| IP allowlist add-on                |                       `+$0.0001/tool call` |                              +100/call |

Meta-tool search is listed as free, but ticket 252 hides meta tools regardless of
price. Premium search, media, and browser services are described as provider
pass-through plus 5 percent, with examples rather than a complete immutable rate
schedule. Those services cannot be rated until the exact admitted resource and
price version is selected.

## Managed model routing

### Cloudflare AI Gateway Dynamic Routing

Cloudflare's official
[Dynamic Routing guide](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/),
last updated 2026-08-07, documents named, versioned routing configurations with
conditional, percentage, rate-limit, budget-limit, model, and fallback nodes.
Versions can be deployed and rolled back. This fits ticket 252's selected shape
of one route graph with distinct route names and versions per model-access
policy.

There are material constraints:

- Dynamic Routing is Beta.
- The documented invocation path currently uses
  `/compat/chat/completions`.
- The standard compatibility endpoint is marked deprecated in the guide.
- Dynamic routes are not currently invoked through the ordinary REST API.
- A model node can configure timeouts and retries, and fallback proceeds through
  a selected graph. For streaming, success is defined when streaming starts, not
  when the completed output is durably reconciled. See the official
  [JSON configuration guide](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/json-configuration/).

These constraints make the ticket's compatibility proof mandatory. Before
activation, the exact candidate routes must prove:

- streaming completion and partial-stream failure handling;
- required tool calling and structured-output behavior;
- cancellation and timeout propagation;
- exactly one equivalent fallback and zero same-model retries;
- no retry or fallback after a visible side effect;
- selected route version, model, and provider evidence;
- prompt, completion, cached-token, and any non-token resource evidence;
- gateway-log reconciliation and durable completion ordering;
- route-version rollback without changing immutable historic ratings.

The official [Dynamic Routing usage guide](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/),
last updated 2026-08-07, documents `cf-aig-model` and `cf-aig-provider` response
headers. The official [logs API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/)
exposes log identifiers, model, provider, input tokens, output tokens, cost,
metadata, success, and status fields. Those are useful evidence and
reconciliation inputs. A stored price version, not the current gateway catalog,
must calculate Rated Cost.

The official
[custom metadata guide](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/),
last updated 2026-08-05, permits at most five metadata entries. Ticket 252 should
use the four named fields `route_profile`, `policy_version`, opaque
`routing_subject`, and `operation_id`, leaving the fifth reserved. Metadata must
not contain a raw user identifier or content.

Cloudflare's official [logging guide](https://developers.cloudflare.com/ai-gateway/observability/logging/),
last updated 2026-06-15, says payload logging is on by default. Sending
`cf-aig-collect-log-payload: false` retains metadata such as token, model,
provider, status, cost, and duration while excluding prompt and response payload.
The production adapter must set and test this behavior.

The gateway's [cost documentation](https://developers.cloudflare.com/ai-gateway/observability/costs/)
describes cost as an estimate derived from token counts and public pricing. Its
[spend-limit guide](https://developers.cloudflare.com/ai-gateway/features/spend-limits/),
last updated 2026-08-17, says limits are best-effort, eventually consistent, and
can be exceeded by concurrent requests. Neither feature is suitable as exact
Usage Policy enforcement or immutable Rated Cost authority. They can be
defensive breakers only.

If any required compatibility or evidence item fails, ticket 252 requires the
direct fixed Workers AI path to remain in place.

### Cloudflare AI Gateway pricing

The official [AI Gateway pricing page](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
was checked on 2026-08-23 and carries a 2026-05-19 update date. Core gateway
features are listed as free. Unified Billing charges a 5 percent credit-purchase
fee while passing inference pricing through. Logpush includes 10 million logs per
month, then lists `$0.05/million`. The page's own update date is older than 30
days, so an invoice, current quote, or approved fresh snapshot is still required
for the ticket's activation-quality price evidence.

### Workers AI pricing and evidence

The official [Workers AI pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/),
last updated 2026-08-18, lists `$0.011/1,000` Neurons and model-specific token or
media equivalents. Workers AI currently includes 10,000 Neurons per day, though
Cloudflare's official
[2026-07-28 change notice](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)
says selected models require the Workers Paid plan.

Representative current observations are below. They are not qualified Osfo
route selections.

| Workers AI model            | Input USD micros per 1M tokens | Cached input | Output USD micros per 1M tokens |
| --------------------------- | -----------------------------: | -----------: | ------------------------------: |
| `@cf/openai/gpt-oss-120b`   |                        350,000 |    `MISSING` |                         750,000 |
| `@cf/openai/gpt-oss-20b`    |                        200,000 |    `MISSING` |                         300,000 |
| `@cf/zai-org/glm-4.7-flash` |                         60,000 |    `MISSING` |                         400,000 |
| `@cf/zai-org/glm-5.2`       |                      1,400,000 |      260,000 |                       4,400,000 |
| `@cf/moonshotai/kimi-k2.5`  |                        600,000 |      100,000 |                       3,000,000 |
| `@cf/moonshotai/kimi-k2.6`  |                        950,000 |      160,000 |                       4,000,000 |

The page also lists media formulas. For example,
`@cf/black-forest-labs/flux-1-schnell` is priced per 512-pixel tile and step,
while newer Flux entries use input and output megapixels or tiles and steps. A
media price version therefore needs the exact model, dimensions, tiles, steps,
and other billed units. An image-generation call cannot be safely represented by
a generic per-image estimate.

Workers AI's official
[prompt caching guide](https://developers.cloudflare.com/workers-ai/features/prompt-caching/)
documents cached-input usage in the response `usage` object where supported. The
official [JSON mode guide](https://developers.cloudflare.com/workers-ai/features/json-mode/)
supports a JSON schema but explicitly does not guarantee schema compliance. Both
behaviors require route-specific tests. A structured-output response must still
be decoded at the Osfo boundary.

### OpenRouter comparator

OpenRouter exposes more explicit provider selection and accounting than a simple
model endpoint:

- The official [provider-routing guide](https://openrouter.ai/docs/guides/routing/provider-selection)
  documents provider order, price, latency, throughput, load balancing, and
  fallbacks.
- The official [model-fallback guide](https://openrouter.ai/docs/guides/routing/model-fallbacks)
  says the ultimately used model is returned and its price applies.
- The official [usage-accounting guide](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
  documents prompt, completion, native, cached, cache-write, reasoning, and
  charged-cost fields. Streaming usage arrives in the last chunk.
- The official [generation endpoint](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
  exposes provider, upstream identifier, request identifier, token, cost,
  routing, and service-tier evidence for reconciliation.

These are useful adapter and evidence precedents. OpenRouter's Auto Router is not
an immutable price or policy decision: without an allowlist it considers a
changing ranked pool, `cost_tier` is a band rather than a price ceiling, and the
Models API uses dynamic sentinel prices for `openrouter/auto`. The selected
provider can also perform its own fallbacks. Osfo must not give that mutable
router authority over a ticket 252 route profile unless every admitted outcome,
fallback, and price version has first been qualified.

The official [OpenRouter pricing page](https://openrouter.ai/pricing) and
[FAQ](https://openrouter.ai/docs/faq) were checked on 2026-08-23. They list a 5.5
percent credit-purchase fee with a `$0.80` minimum for card purchases, a 5 percent
crypto purchase fee, and provider inference pricing without a model markup.
OpenRouter says failed or fallback attempts are not billed. Osfo still needs the
attempt record for observability and must reconcile provider settlement rather
than assuming every failure is costless.

The live official [Models API](https://openrouter.ai/api/v1/models) was observed
at 2026-08-23T23:11Z. The following are representative catalog entries, not
qualified Osfo routes. Values convert the API's USD-per-token fields to integer
USD micros per one million tokens.

| Canonical model                          |     Input | Cached input |     Output | Web search per operation |
| ---------------------------------------- | --------: | -----------: | ---------: | -----------------------: |
| `google/gemini-3-flash-preview-20251217` |   500,000 |       50,000 |  3,000,000 |                   14,000 |
| `deepseek/deepseek-v3.2-20251201`        |   260,000 |      130,000 |    380,000 |                `MISSING` |
| `openai/gpt-5.1-20251113`                | 1,250,000 |      125,000 | 10,000,000 |                   10,000 |
| `anthropic/claude-4.5-sonnet-20250929`   | 3,000,000 |      300,000 | 15,000,000 |                   10,000 |
| `openai/gpt-5-mini-2025-08-07`           |   250,000 |       25,000 |  2,000,000 |                   10,000 |

Claude Sonnet 4.5 additionally listed cache-write rates of 3,750,000 USD micros
per million tokens and 6,000,000 for a one-hour cache write. Its long-context
tier at 200,000 or more prompt tokens listed 6,000,000 input, 22,500,000 output,
600,000 cache read, 7,500,000 cache write, and 12,000,000 one-hour cache write.
This tiering shows why a Resource Price Version needs conditions and denominators,
not a single generic model number.

OpenRouter's [web-search guide](https://openrouter.ai/docs/guides/features/server-tools/web-search)
lists Exa, Parallel, and Perplexity search charges, including per-request and
per-additional-result units. A model may instead use native provider search at a
provider-specific price. Search therefore needs its own admitted resource and
price entry. It must not be hidden inside a text-token estimate.

OpenRouter's pricing pages do not publish an effective-date history. A fetched
catalog response and later bill can support a frozen price version, but the live
catalog alone cannot authorize historic Rated Cost.

## Selected provider seams

Ticket 252 selects provider ownership without collapsing product authority into
those providers.

| Seam                                                                                               | Selected provider                                               | Provider responsibility                                  | Osfo responsibility                                                                  | Current economics status                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Runtime, agents, workflows, queues, files, compute, model routing, inference, media, observability | Cloudflare                                                      | Execute and report provider evidence                     | Intent, approval, route eligibility, immutable pricing, Usage Policy, reconciliation | Partial rates known; measured workload and allocation `MISSING`                     |
| Control-plane PostgreSQL                                                                           | Neon                                                            | Durable PostgreSQL service and usage metering            | Schema, transactions, typed failures, retention, cost allocation                     | Current list rates known; selected plan and bill `MISSING`                          |
| OAuth, credentials, integration transport                                                          | Composio                                                        | Connections, credential refresh, admitted transport      | User binding, catalog, approval, exact operation authority, evidence, pricing        | Current list rates known; contract and operation mix `MISSING`                      |
| Memory and retrieval                                                                               | Supermemory                                                     | Memory ingestion, profiles, retrieval, provider metering | User scope, content policy, authority, deletion, price version, outcome evidence     | Current list rates known; plan, SM-token workload, bill, retention terms `MISSING`  |
| Payments                                                                                           | Stripe                                                          | Payment processing and settlement evidence               | Plan state, tax treatment, entitlement, refund policy, allocation                    | Domestic base rate known; actual charge mix and add-ons `MISSING`                   |
| Messaging                                                                                          | Twilio, Meta                                                    | Delivery and provider settlement evidence                | Approved message intent, recipient scope, segmentation, rate mapping                 | Base examples known; exact product, market, carrier, template, and volume `MISSING` |
| Connected Google services                                                                          | Google through approved connection transport                    | Source-system identity, permissions, quotas, API result  | Connection binding, operation authority, approval, evidence                          | Quotas and Composio rates are separate; billable mix `MISSING`                      |
| Search, artifacts, images, browser work                                                            | Cloudflare by default, explicit approved exception if qualified | Execute admitted resource                                | Select provider, operation maxima, evidence, immutable price                         | Exact provider-resource set and workload `MISSING`                                  |

### Cloudflare platform baseline

The official [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/),
last updated 2026-07-07, lists a `$5/month` Workers Paid minimum. It includes 10
million Worker requests and 30 million CPU milliseconds per month, followed by
`$0.30/million` requests and `$0.02/million` CPU milliseconds. The same page
lists current Queues, Workflows, Durable Objects, R2, and other platform units.

The issue's Free plan Company Cost limit is also US$5 per active 30-day period.
That does not mean a `$5` account-wide Workers minimum should be assigned to each
active Free user. The allocation denominator, included-capacity sharing, idle
usage, and marginal usage all need an explicit conservative policy. Treating an
account-wide included tier as free per user would understate cost; assigning the
entire account minimum to every user would overstate it.

### Neon

The official [Neon pricing page](https://neon.com/pricing), checked on
2026-08-23, lists a Free allowance of 100 CU-hours per project per month and 0.5
GB storage. Launch lists `$0.106/CU-hour`, `$0.35/GB-month`, 100 GB transfer
included and `$0.10/GB` after the inclusion. Scale lists `$0.222/CU-hour` and
`$0.35/GB-month` before other features and usage.

If the displayed currency is contractually confirmed as USD, the Launch compute
and storage rates are 106,000 USD micros per CU-hour and 350,000 USD micros per
GB-month. The production plan, autoscaling behavior, branch use, history, backup,
egress, idle floor, support tier, taxes, and actual invoice are `MISSING`.

### Supermemory

Supermemory's official [quickstart](https://supermemory.ai/docs/quickstart)
documents `containerTag` as the user-scoping key for adding content and retrieving
a profile. Osfo must bind that tag to an opaque authenticated Osfo user scope and
must not treat returned memories as authority or instructions.

The official [Supermemory pricing page](https://supermemory.ai/pricing), checked
on 2026-08-23, lists Free, Pro, Max, and Scale plans at `$0`, `$19`, `$100`, and
`$399` per month with included usage balances. It lists these usage primitives:

| Supermemory resource       |    Published observation | Integer micro form if USD is confirmed |
| -------------------------- | -----------------------: | -------------------------------------: |
| Memory, plain content      | `$0.005/1,000` SM tokens |                  5,000/1,000 SM tokens |
| Memory, rich content       | `$0.010/1,000` SM tokens |                 10,000/1,000 SM tokens |
| SuperRAG, plain content    | `$0.001/1,000` SM tokens |                  1,000/1,000 SM tokens |
| SuperRAG, rich mode        | `$0.002/1,000` SM tokens |                  2,000/1,000 SM tokens |
| Search and graph traversal |   `$0.005/1,000` queries |                    5,000/1,000 queries |
| Composable operations      | `$0.10/1,000` operations |               100,000/1,000 operations |

The page defines SM tokens as unique ingested content and says repeats are
deduplicated. That is a provider billing rule, not an Osfo outcome rule. The
selected plan, ISO currency, exact SM-token measurement evidence, ingestion and
query workload, duplicate behavior on the production account, retention and
deletion terms, taxes, and bill are `MISSING`.

### Stripe

The official [Stripe Canada pricing page](https://stripe.com/en-ca/pricing),
checked on 2026-08-23, lists 2.9 percent plus CA$0.30 for a successful domestic
card charge, with additional international-card and currency-conversion fees.
At a CA$25 pre-tax charge, that base domestic fee is CA$1.025. Because processing
normally applies to the amount actually charged, tax can increase the fee. Stripe
Billing, Stripe Tax, dispute, refund, international-card, and foreign-exchange
configuration may add costs.

Ticket 252 requires at least 50 percent contribution margin on CA$25 plus tax, so
the total Company Cost ceiling is CA$12.50 on the pre-tax subscription revenue.
Using only the domestic base processing example would leave CA$11.475 for every
other cost. That is a lower-bound illustration, not a gate result. The real
payment mix, tax configuration, add-ons, refunds, disputes, and conservative
CAD/USD conversion are `MISSING`.

### Twilio, Meta, and Google

The official [Twilio Canada SMS pricing page](https://www.twilio.com/en-us/sms/pricing/ca),
checked on 2026-08-23, lists a base `$0.0083` per outbound or inbound long-code or
toll-free SMS segment, a `$0.001` failed-processing charge, carrier fees, and a
`$1.15/month` long-code number example. The exact Osfo messaging product,
currency, destination mix, carrier, number allocation, message segmentation,
verification use, taxes, and bill are `MISSING`.

Meta publishes WhatsApp pricing and category rules in its official
[WhatsApp Business Platform pricing documentation](https://developers.facebook.com/docs/whatsapp/pricing/).
Google publishes separate quotas for the official
[Calendar API](https://developers.google.com/calendar/api/guides/quota) and
[Drive API](https://developers.google.com/drive/api/guides/limits). Quotas,
Composio tool-call charges, messaging charges, and Osfo Rated Cost are different
units. No ordinary integration operation should be assigned zero merely because
the source API does not show a per-call price. The exact operation manifest,
account configuration, market, quota behavior, provider invoice, and any
pass-through charge are `MISSING`.

## Economics input register

### Plan arithmetic fixed by ticket 252

Ticket 252 defines one plan Usage micro as one Rated Cost USD micro. The visible
allowances therefore represent the following pricing-equivalent amounts:

| Plan       |        Usage allowance | Nominal pricing-equivalent amount | At 15% provider-price stress |
| ---------- | ---------------------: | --------------------------------: | ---------------------------: |
| Free       | 2,000,000 usage micros |                           US$2.00 |                      US$2.30 |
| Adventurer | 6,000,000 usage micros |                           US$6.00 |                      US$6.90 |

These values are not credits, stored value, or a promise that Company Cost equals
Rated Cost. They cover only successfully completed priced resources under frozen
rates. Company Cost also includes failed attempts, non-usage provider fees,
fixed and idle allocation, support, payment processing, storage, messaging,
Skill Learning, exhausted fallback behavior, overshoot, and GM Summon.

### Inputs that can be frozen now

The following current first-party observations can seed candidate Resource Price
Versions after currency and account applicability are confirmed:

- Workers AI model token and media rates from the 2026-08-18 rate page.
- The OpenRouter Models API response observed at 2026-08-23T23:11Z, for comparison
  or for an explicitly selected OpenRouter resource.
- Composio's post-2026-08-15 schedule, subject to account cohort, currency, and
  invoice confirmation.
- Supermemory usage primitives, subject to plan, currency, metering, and invoice
  confirmation.
- Workers, Neon, Stripe, and Twilio unit observations, subject to the selected
  account and allocation policy.

None should be rounded through floating-point arithmetic. Rates with fractional
per-event prices need integer numerator and denominator units. Tiered, cached,
long-context, media, and pass-through prices need explicit conditions.

### Blocking `MISSING` inputs

The economics gate cannot be evaluated until all of these exist:

1. Exact model IDs, provider endpoints, and route versions for exhausted, Free
   normal, Adventurer routine, and Adventurer frontier profiles.
2. A compatibility and quality result for every route, including the single
   escalation and equivalent-fallback cases.
3. Immutable price versions for every admitted model, cached token, search,
   image, artifact, storage, compute, integration, trigger, message, connection,
   and other billable resource.
4. A complete measured workload covering calendar, drive, search, research,
   artifacts, images, integrations, workflows, Skill Learning, and exhausted
   behavior.
5. Exact operation maxima and concurrency needed to calculate worst-case
   soft-cap overshoot. Eventual provider spend limits are not a substitute.
6. Failed-attempt, retry, timeout, fallback, cancellation, and partial-stream
   rates, with bill reconciliation.
7. Account-wide fixed and idle cost allocation for Cloudflare, Neon, Composio,
   Supermemory, observability, security add-ons, and support.
8. Payment processing, tax configuration, messaging and carrier mix, storage,
   transport, refunds, and other non-model Company Cost.
9. Conservative CAD/USD foreign-exchange evidence and a refresh rule.
10. Expected support effort and expected GM Summon frequency and cost.
11. Provider invoices or equally strong settlement evidence proving which list
    rates and included tiers apply to the production accounts.
12. A 15 percent provider-price stress run over the complete workload and the
    exact overshoot bound.

### Gate result

| Gate                   | Required result                                                                  | Current result | Reason                                                                           |
| ---------------------- | -------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| Free                   | Full usage and all listed Company Cost at or below US$5 per active 30-day period | `MISSING`      | Complete workload, fixed allocation, failures, support, and overshoot are absent |
| Adventurer             | At least 50% contribution margin on CA$25 plus tax                               | `MISSING`      | Complete Company Cost, payment mix, conservative FX, and overshoot are absent    |
| Price stress           | Both gates still pass at +15% provider prices                                    | `MISSING`      | Candidate routes and complete unit-price set are absent                          |
| Provider compatibility | Cloudflare managed route meets all runtime and evidence requirements             | `MISSING`      | No live compatibility or reconciliation artifact exists                          |

No `MISSING` input should be filled with a guess or a zero. Activation remains
blocked until the issue receives the dated workload, price-version register,
provider evidence, reconciliation, and gate calculations it requires.

## Source register

All sources were accessed on 2026-08-23.

| Publisher     | First-party source                                                                                                                                            | Publisher date or reviewed revision                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Nous Research | [Hermes Skills source](https://github.com/NousResearch/hermes-agent/blob/336059011521c595d00803be93d1652aaab58720/website/docs/user-guide/features/skills.md) | File changed 2026-08-18                               |
| Nous Research | [Hermes Tools source](https://github.com/NousResearch/hermes-agent/blob/bceda18df08b79130a734495a41f5cd7dace3b58/website/docs/user-guide/features/tools.md)   | File changed 2026-08-17                               |
| Nous Research | [Hermes security](https://hermes-agent.nousresearch.com/docs/user-guide/security)                                                                             | Update date `MISSING`                                 |
| Poke          | [Pricing](https://poke.com/pricing)                                                                                                                           | Update date `MISSING`                                 |
| Poke          | [Usage and resets](https://poke.com/docs/usage-and-resets)                                                                                                    | Update date `MISSING`                                 |
| Poke          | [Managing integrations](https://poke.com/docs/managing-integrations)                                                                                          | Update date `MISSING`                                 |
| Poke          | [Creating recipes](https://poke.com/docs/creating-recipes)                                                                                                    | Update date `MISSING`                                 |
| Poke          | [MCP servers](https://poke.com/docs/mcp-servers)                                                                                                              | Update date `MISSING`                                 |
| Poke          | [Release notes](https://poke.com/docs/release-notes)                                                                                                          | Latest entry 2026-07-23                               |
| OpenAI        | [Customization and Skills](https://developers.openai.com/codex/concepts/customization/#skills)                                                                | Update date `MISSING`                                 |
| OpenAI        | [Plugin build documentation](https://developers.openai.com/codex/plugins/build/)                                                                              | Update date `MISSING`                                 |
| OpenAI        | [Plugins in Codex](https://help.openai.com/en/articles/20001256-plugins-in-codex/)                                                                            | Displayed as updated on access date                   |
| OpenAI        | [Codex deferred MCP exposure source](https://github.com/openai/codex/blob/479c8c8924eaafdeb56e86154cd19ff0805839e4/codex-rs/core/src/mcp_tool_exposure.rs)    | Commit `479c8c8924eaafdeb56e86154cd19ff0805839e4`     |
| Composio      | [How Composio works](https://docs.composio.dev/docs/how-composio-works)                                                                                       | Update date `MISSING`                                 |
| Composio      | [Quickstart](https://docs.composio.dev/docs/quickstart)                                                                                                       | Update date `MISSING`                                 |
| Composio      | [Configuring sessions](https://docs.composio.dev/docs/configuring-sessions)                                                                                   | Update date `MISSING`                                 |
| Composio      | [Manual authentication](https://docs.composio.dev/docs/authentication/manually-authenticating)                                                                | Update date `MISSING`                                 |
| Composio      | [Authentication](https://docs.composio.dev/docs/authentication)                                                                                               | Update date `MISSING`                                 |
| Composio      | [API-key authentication](https://docs.composio.dev/reference/authenticating-to-composio)                                                                      | Update date `MISSING`                                 |
| Composio      | [Pricing](https://composio.dev/pricing)                                                                                                                       | Schedule states 2026-08-15 applicability              |
| Composio      | [Security](https://composio.dev/security/)                                                                                                                    | Update date `MISSING`                                 |
| Cloudflare    | [Dynamic Routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)                                                                     | Updated 2026-08-07                                    |
| Cloudflare    | [Dynamic Routing JSON](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/json-configuration/)                                             | Current on access date                                |
| Cloudflare    | [Dynamic Routing usage](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/)                                                         | Updated 2026-08-07                                    |
| Cloudflare    | [AI Gateway metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)                                                            | Updated 2026-08-05                                    |
| Cloudflare    | [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)                                                                     | Updated 2026-06-15                                    |
| Cloudflare    | [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)                                                                | Updated 2026-08-17                                    |
| Cloudflare    | [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)                                                                         | Updated 2026-05-19                                    |
| Cloudflare    | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)                                                                          | Updated 2026-08-18                                    |
| Cloudflare    | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)                                                                                | Updated 2026-07-07                                    |
| OpenRouter    | [Models API](https://openrouter.ai/api/v1/models)                                                                                                             | Snapshot observed 2026-08-23T23:11Z                   |
| OpenRouter    | [Pricing](https://openrouter.ai/pricing)                                                                                                                      | Effective-date history `MISSING`                      |
| OpenRouter    | [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)                                                                       | Update date `MISSING`                                 |
| OpenRouter    | [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)                                                                              | Update date `MISSING`                                 |
| OpenRouter    | [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)                                                                                  | Update date `MISSING`                                 |
| Neon          | [Pricing](https://neon.com/pricing)                                                                                                                           | Current on access date                                |
| Supermemory   | [Quickstart](https://supermemory.ai/docs/quickstart)                                                                                                          | Current on access date                                |
| Supermemory   | [Pricing](https://supermemory.ai/pricing)                                                                                                                     | Current on access date                                |
| Stripe        | [Canada pricing](https://stripe.com/en-ca/pricing)                                                                                                            | Current on access date                                |
| Twilio        | [Canada SMS pricing](https://www.twilio.com/en-us/sms/pricing/ca)                                                                                             | Current on access date                                |
| Meta          | [WhatsApp Business pricing](https://developers.facebook.com/docs/whatsapp/pricing/)                                                                           | Current schedule not frozen; exact workload `MISSING` |
| Google        | [Calendar API quotas](https://developers.google.com/calendar/api/guides/quota)                                                                                | Current on access date                                |
| Google        | [Drive API limits](https://developers.google.com/drive/api/guides/limits)                                                                                     | Current on access date                                |
