# Oz cost and onboarding economics

Date: 2026-08-08

## Decision summary

Oz does not incur the cost of a private VM when a person sends their first
WhatsApp message. A per-account Durable Object is a logical identity and SQLite
namespace. It runs only while handling work and can hibernate without duration
charges. The meaningful costs scale with active usage, not registered accounts.

The cost order for v1 is:

1. model calls and paid research tools;
2. WhatsApp delivery, especially after Meta's announced October 1, 2026 change;
3. long-term-memory ingestion;
4. files and account state;
5. ordinary Cloudflare requests and compute.

The launch recommendation is a small, cost-weighted free experience, followed
by email verification, a bounded verified trial, and then payment before
recurring or expensive work. The free experience should prove that Oz can
remember and act, but should not include unrestricted research, document
generation, connectors, or repeating triggers.

All provider prices below are current on the report date. Prices are USD unless
marked CAD. Taxes, foreign exchange, support, observability vendors, and human
operations are excluded.

## Current provider rates

### Cloudflare

The Workers Paid plan has a $5 monthly minimum. It includes 10 million Worker
requests and 30 million CPU milliseconds per month. Overage is $0.30 per million
requests and $0.02 per million CPU milliseconds. Ordinary Workers have no
duration or bandwidth fee. [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

SQLite Durable Objects include 1 million requests and 400,000 GB-seconds per
month. Overage is $0.15 per million requests and $12.50 per million GB-seconds.
An object that is inactive or eligible to hibernate does not incur duration
charges. SQLite includes 25 billion rows read, 50 million rows written, and 5
GB-month of stored data. Overage is $0.001 per million rows read, $1 per million
rows written, and $0.20 per GB-month. Setting an alarm counts as one row write.
[Cloudflare Workers and Durable Objects pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Durable Object alarms wake an object at a scheduled time. Each object can have
one scheduled alarm, but one SQLite schedule can contain multiple reminders and
the alarm can always point to the next due item. Delivery is at least once and
failed alarm handlers receive automatic retries. [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

R2 Standard storage is $0.015 per GB-month, Class A mutations are $4.50 per
million, Class B reads are $0.36 per million, and internet egress is free. The
monthly free allowance is 10 GB, 1 million Class A operations, and 10 million
Class B operations. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Cloudflare Workflows begins step and storage billing on August 10, 2026. The
Paid plan includes 500,000 steps and 1 GB-month of state, then charges $0.80 per
100,000 steps and $0.20 per GB-month. Workflow requests and CPU use the ordinary
Workers rates. Waiting does not consume CPU. [Cloudflare Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

Use Durable Object alarms for normal reminders. Reserve Workflows for durable,
multi-step jobs whose retries and intermediate state justify another primitive.

### Supermemory

Supermemory does not list a flat price per Oz user. It meters unique ingested
content and operations:

| Operation                           |                       Public rate |
| ----------------------------------- | --------------------------------: |
| Per-user memory graph, plain text   | $0.005 per 1,000 unique SM tokens |
| Per-user memory graph, rich content | $0.010 per 1,000 unique SM tokens |
| SuperRAG, plain text                | $0.001 per 1,000 unique SM tokens |
| SuperRAG, rich content              | $0.002 per 1,000 unique SM tokens |
| Search and graph traversal          |          $0.005 per 1,000 queries |
| Rerank, aggregate, or rewrite       |        $0.10 per 1,000 operations |

The service states that duplicate or unchanged content is deduplicated for
billing. The Free plan includes about $5 of usage. Pro costs $19 with about $20
included, Max costs $100 with about $130 included, and Scale costs $399 with
about $600 included. Paid plans list unlimited storage and users, while API
operations draw down the included balance. [Supermemory pricing](https://supermemory.ai/pricing/)

The expensive behavior is indiscriminate ingestion, not retrieval. Oz should
promote stable facts, preferences, outcomes, and selected knowledge sources. It
should not mirror every transcript token into the memory graph.

### WhatsApp Business Platform

Meta currently charges template messages when delivered. A user message opens
or resets a 24-hour service window. As of August 8, non-template service replies
and utility templates sent in that open window are free. Outside the window,
proactive communication requires an appropriate template. [Meta pricing documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/),
[WhatsApp Business pricing](https://whatsappbusiness.com/products/platform-pricing/)

The current official USD rate card lists North America, including Canada, at
$0.0034 per delivered utility message, $0.0034 for authentication, and $0.025
for marketing. Rates depend on the recipient's calling code, not Oz's location.
[Meta rate cards and volume tiers](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#rate-cards-and-volume-tiers)

There is an important announced change. Effective October 1, 2026, Meta will
charge every non-template service message per delivery, including replies
powered by a third-party AI. Meta says the service rate in each market will
match its utility and authentication rate, without volume tiers. It also says
the final October rates will be published by September 1, 2026. Oz therefore
must budget for every assistant reply, not only proactive reminders, before
launch. [Meta non-template message pricing update](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages/)

The estimates below use the current $0.0034 North America utility rate as the
October placeholder. This is a planning assumption, not the unpublished final
October service rate.

### Managed models and research

OpenAI's current short-context standard rates are:

| Model         | Input per 1M | Cached input per 1M | Output per 1M |
| ------------- | -----------: | ------------------: | ------------: |
| GPT-5.6 Luna  |        $0.20 |               $0.02 |         $1.20 |
| GPT-5.6 Terra |        $2.00 |               $0.20 |        $12.00 |
| GPT-5.6 Sol   |        $5.00 |               $0.50 |        $30.00 |

Requests above 272,000 input tokens receive higher long-context rates. Cache
writes cost 1.25 times ordinary input. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing),
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

Anthropic's current direct API rates are:

| Model                                 | Input per 1M | Cached read per 1M | Output per 1M |
| ------------------------------------- | -----------: | -----------------: | ------------: |
| Claude Haiku 4.5                      |        $1.00 |              $0.10 |         $5.00 |
| Claude Sonnet 5, through August 31    |        $2.00 |              $0.20 |        $10.00 |
| Claude Sonnet 5, starting September 1 |        $3.00 |              $0.30 |        $15.00 |
| Claude Opus 5                         |        $5.00 |              $0.50 |        $25.00 |

Anthropic cache writes cost 1.25 times input for five-minute caching and 2 times
input for one-hour caching. Batch processing is half the standard input and
output price. [Anthropic Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)

Both OpenAI and Anthropic list web search at $10 per 1,000 searches, plus model
tokens. A 20-search research job therefore starts with $0.20 of search charges
before the model reads and synthesizes results. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing),
[Anthropic tool pricing](https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool)

A consumer subscription is not a transferable API allowance. OpenAI says
ChatGPT and API billing are separate. Anthropic says the same for Claude.ai and
the Claude API. Oz can later support a user's API account or API key, but should
not promise that ChatGPT Plus, ChatGPT Pro, or a Claude consumer plan pays for
Oz's model calls. [OpenAI subscription and API billing](https://help.openai.com/en/articles/8156019),
[Anthropic subscription and API billing](https://support.anthropic.com/en/articles/9876003-i-subscribe-to-a-paid-claude-ai-plan-why-do-i-have-to-pay-separately-for-api-usage-on-console)

### Stripe Canada

Stripe's standard Canadian price for a successful domestic online card payment
is 2.9% plus CA$0.30. Stripe Checkout and Payment Links add no separate fee on
standard Payments pricing. Stripe Billing's pay-as-you-go subscription
management adds 0.7% of Billing volume. [Stripe Canada pricing](https://stripe.com/en-ca/pricing)

| Monthly price | Card processing |  Billing | Total Stripe cost |
| ------------- | --------------: | -------: | ----------------: |
| CA$15         |        CA$0.735 | CA$0.105 |           CA$0.84 |
| CA$20         |         CA$0.88 |  CA$0.14 |           CA$1.02 |
| CA$30         |         CA$1.17 |  CA$0.21 |           CA$1.38 |

The fixed CA$0.30 makes very small recurring plans less attractive. A single
CA$20 to CA$30 launch plan is simpler and more efficient than several low-price
micro-plans.

## Scale model

This is a transparent planning model, not a forecast. It separates registered
accounts from monthly active users because dormant accounts retain small state
but do not run model or memory work.

Assumptions per month:

- 25 percent of registered users are monthly active.
- Each active user sends 60 turns, producing 60 Oz replies.
- Tool loops make 90 model calls per active user.
- Each model call averages 5,000 input tokens and 700 output tokens after
  compaction and retrieval.
- The cost floor uses GPT-5.6 Luna for every call: $0.1656 per active user.
- Supermemory receives 10,000 unique plain memory-graph tokens, 30,000 unique
  plain SuperRAG tokens, and 90 searches: $0.08045 per active user before plan
  credits.
- Each active user receives eight proactive utility messages: $0.0272 at the
  current North America list rate.
- From October, 60 replies plus eight proactive messages are estimated at
  $0.2312 per active user using the current rate as a placeholder.
- Each registered account retains 2 MB in Durable Object SQLite.
- Each active account averages 50 MB in R2 files.
- Each active account uses 130 Durable Object requests and 150 ordinary Worker
  requests. CPU and row operations remain inside the included allowances at
  the modeled scales.
- Supermemory plan credits and WhatsApp utility volume discounts are not
  subtracted. This keeps the table conservative and comparable.

### Monthly cost floor

| Registered |    MAU | Luna model | Supermemory meter | WhatsApp now | WhatsApp October placeholder | Cloudflare | Total now | Total October |
| ---------: | -----: | ---------: | ----------------: | -----------: | ---------------------------: | ---------: | --------: | ------------: |
|        100 |     25 |      $4.14 |             $2.01 |        $0.68 |                        $5.78 |      $5.00 |    $11.83 |        $16.93 |
|      1,000 |    250 |     $41.40 |            $20.11 |        $6.80 |                       $57.80 |      $5.04 |    $73.35 |       $124.35 |
|     10,000 |  2,500 |    $414.00 |           $201.13 |       $68.00 |                      $578.00 |      $9.73 |   $692.85 |     $1,202.85 |
|    100,000 | 25,000 |  $4,140.00 |         $2,011.25 |      $680.00 |                    $5,780.00 |     $62.94 | $6,894.19 |    $11,994.19 |

Cloudflare at 100,000 registered users includes about $39 for 200 GB of Durable
Object SQLite, $18.60 for 1.25 TB of R2, $0.34 of Durable Object request
overage, and the $5 Workers minimum. The per-account SQLite topology is not the
scale risk.

The table is a floor because Luna is the lowest-cost routing tier. With the same
token shape:

| Model route                         | Model cost per active user | Model cost at 25,000 MAU |
| ----------------------------------- | -------------------------: | -----------------------: |
| 100% GPT-5.6 Luna                   |                    $0.1656 |                   $4,140 |
| 85% Luna, 15% Terra                 |                    $0.3892 |                   $9,729 |
| 100% Claude Haiku 4.5               |                    $0.7650 |                  $19,125 |
| 100% GPT-5.6 Terra                  |                    $1.6560 |                  $41,400 |
| 100% Claude Sonnet 5 from September |                    $2.2950 |                  $57,375 |

The 85/15 OpenAI route raises the modeled October total at 100,000 registered
users from about $11,994 to about $18,583. This is still linear. The business
risk is that a user turn can fan out into many model calls, searches, tools, and
outbound messages.

### Idle-account cost

At the 2 MB assumption, one dormant registered account adds about $0.0004 per
month of Durable Object storage after the shared 5 GB allowance. It has no
model, Supermemory ingestion, WhatsApp, or active Durable Object duration cost.
An empty or near-empty provisional identity is cheaper still.

Do not create periodic per-user maintenance work. A nightly extraction or
"dream" cycle for every account turns dormant accounts into active cost. Run
memory extraction after meaningful activity and compact or reconcile only when
a user's state requires it.

## Onboarding and payment gates

```text
Unknown WhatsApp number
  -> receive first inbound message
  -> create provisional principal + WhatsApp channel binding
  -> create canonical thread identity
  -> lazily write the account's Durable Object SQLite
  -> answer with the managed low-cost model
  -> object hibernates when the turn ends

Managed Starter Allowance
  -> up to 8 useful Oz replies
  -> save 1 explicit memory
  -> schedule and deliver 1 one-time reminder
  -> no connector, repeating trigger, research spin-up, or large document
  -> hard lifetime vendor-cost cap: $0.10 per provisional principal

Value checkpoint
  -> Oz demonstrates recall in a later turn
  -> Oz completes the one-time reminder
  -> user asks for more persistent, sensitive, or expensive work

Account claim gate
  -> request email
  -> send verification link or code
  -> claim the provisional identity without replacing its thread
  -> keep the WhatsApp binding revocable

Verified trial
  -> allow a small sample of a premium capability
  -> examples: one small document or one bounded research task
  -> hard one-time vendor-cost cap: $0.50
  -> no recurring connector automation before payment

Payment gate
  -> triggered by allowance exhaustion or first recurring premium request
  -> send Stripe Checkout link
  -> Stripe webhook activates the paid entitlement

Paid Oz
  -> long-term-memory allowance
  -> documents and research within monthly cost limits
  -> Gmail and later connectors
  -> recurring triggers and proactive messages within plan limits
  -> warn before the internal cost budget is exhausted
  -> offer upgrade or API BYOK later
```

Under the October WhatsApp assumption, eight replies, one reminder, one small
2,000-token memory, and eight single-call Luna responses cost about $0.055
before Cloudflare's shared fixed cost. The proposed $0.10 provisional cap has
room for retries and variance.

A $0.50 verified trial can safely demonstrate one higher-value action. For
example, 25 replies, ten paid web searches, modest memory ingestion, and one
small document can remain around that boundary if tool loops have explicit
limits. The application must meter dollars internally across model tokens,
searches, memory ingestion, outbound WhatsApp messages, and temporary compute.

## Product recommendations

1. Create the Durable Object lazily on the first message. Do not describe it as
   provisioning compute, RAM, or a private machine.
2. Let first contact prove two promises: Oz remembers and Oz follows through.
3. Ask for email after that proof, or immediately before the first sensitive or
   expensive capability.
4. Allow one verified premium sample, then require payment for recurrence,
   connectors, broad research, or continued managed usage.
5. Launch with one CA$20 to CA$30 paid plan and a hidden internal vendor-cost
   budget. Avoid an "unlimited" promise.
6. Meter proactive messages separately from triggers. A trigger can be free to
   store while its deliveries consume allowance.
7. Route ordinary conversation to the cheapest acceptable model and escalate
   selected tasks. Cap model calls, searches, tool retries, and output size per
   run.
8. Recheck Meta's final October service rates after September 1, 2026 before
   setting retail price. This is the largest newly announced channel risk.
9. Treat BYOK as an API billing connection. Do not market consumer ChatGPT or
   Claude subscriptions as transferable usage.
10. Negotiate or reconsider Supermemory only after measured unique ingestion
    per active user. Retrieval itself is unlikely to force the decision.

## What can become nonlinear

The published platform rate cards are linear or tiered. Exponential-looking
spend comes from application behavior:

- an agent run recursively starts more agent runs;
- the complete conversation is resent on every model call;
- every transcript is copied into multiple memory pipelines;
- retries have no total budget or idempotency key;
- research loops choose their own unbounded search count;
- every account receives periodic maintenance whether active or not;
- a single trigger produces many WhatsApp deliveries;
- large files are repeatedly parsed and regenerated.

The cost control primitive should therefore be a cost-weighted allowance per
principal and per run, not raw message count and not advertised CPU or RAM.

## Verification

- PASS: all pricing facts were checked against first-party provider pages on
  2026-08-08.
- PASS: calculations separate registered accounts from monthly active users and
  expose every modeling assumption.
- PASS: the October WhatsApp change is modeled as an explicit placeholder, not
  presented as a final unpublished rate.
- MISSING: observed Oz token, search, memory-ingestion, file-storage, and message
  distributions. Replace assumptions with prototype telemetry before fixing
  final plan limits.
