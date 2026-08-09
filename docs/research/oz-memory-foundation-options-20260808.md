# Oz memory foundation options

Date: 2026-08-08

## Decision question

Should Oz begin with a `memory.md` file, a per-user SQLite database, an Oz-owned
Postgres/vector stack, or a managed memory provider such as Supermemory?

## Recommendation

Do not begin with a file and migrate users to a different memory model after a
size threshold. Begin with one durable ownership model and add richer derived
retrieval as data grows.

For the first Oz prototype:

1. Keep canonical conversation events, confirmed user facts, provenance,
   deletion state, and account ownership in Oz-controlled durable storage.
2. Keep uploaded source files in Oz-controlled object storage.
3. Generate a small, bounded profile projection for every model call. A
   `profile.md`-shaped representation is useful, but it is a view rather than
   the source of truth.
4. Use a managed memory engine, with Supermemory as the first prototype, for
   extraction, evolving profiles, semantic recall, and knowledge-base indexing.
5. Scope every managed-memory request with an Oz-generated opaque account ID.
   Never accept a caller-supplied namespace.
6. Preserve enough canonical source and identifiers to rebuild or delete the
   managed index.
7. Compare the managed prototype against the selected Agent Harness's native
   memory before committing the v1 foundation.

This gives early users advanced recall without making Oz's identity, deletion,
or portability depend entirely on one memory vendor.

## The layers are different products

```text
Current conversation
  -> bounded thread context and summary

Confirmed user facts and preferences
  -> canonical Oz records
  -> small profile projection supplied on each relevant run

Episodes, people, projects, and learned instructions
  -> memory extraction and semantic retrieval
  -> rebuildable index linked to canonical provenance

Files, email, and connected knowledge
  -> canonical source or source reference
  -> parsing, chunks, metadata, and retrieval index
```

A local database solves persistence. It does not itself solve extraction,
contradiction, temporal updates, ranking, profile synthesis, or retrieval
quality.

## Why not one `memory.md`

A small human-readable file is excellent for stable, always-needed context. It
is poor as the only durable memory because it has no natural per-fact
provenance, supersession, confidence, retention policy, selective deletion, or
scalable retrieval.

Use a `profile.md` projection for the agent experience, not as the database.
The projection can be regenerated from confirmed memories and the active memory
engine. This avoids a later threshold migration and keeps the prompt bounded.

## Why not a GitHub repository per user

Git is valuable for explicit user exports and human-authored knowledge packs.
It is a poor operational store for personal memories:

- personal data enters an additional third-party system;
- deletion is complicated by immutable history and clones;
- repository and API operations are much heavier than indexed database writes;
- tenant authorization, low-latency recall, retention, and selective forgetting
  become application problems;
- repository limits and abuse controls become part of Oz availability.

An optional export to files or Git can be added later without making Git the
runtime memory substrate.

## Per-user SQLite is possible, but platform-dependent

There is no user machine in the WhatsApp-first Oz topology. A database file
cannot live on the user's device. Ordinary ephemeral workers also cannot own a
durable local SQLite file.

Cloudflare is the notable exception. Each Cloudflare Agent instance has a
private, persistent SQLite database backed by a Durable Object. It hibernates
when idle and wakes on demand. The paid plan currently includes 5 GB-month of
SQLite data, 25 billion rows read, and 50 million rows written; overage storage
is $0.20 per GB-month. This makes one logical agent instance per Oz Account
economically plausible, but it couples the identity and state topology to
Cloudflare. [Cloudflare Agent state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

Cloudflare's higher-level Agent Memory now extracts facts, events,
instructions, and tasks and combines full-text and semantic retrieval. It is
currently a private beta with no billing, so neither availability nor future
unit economics can be treated as a launch contract.
[Cloudflare Agent Memory](https://developers.cloudflare.com/agent-memory/),
[how it works](https://developers.cloudflare.com/agent-memory/concepts/how-agent-memory-works/),
[current beta pricing](https://developers.cloudflare.com/agent-memory/platform/pricing/)

## Existing harness support

- LangGraph distinguishes thread-scoped short-term memory from cross-thread
  long-term memory. Its TypeScript store can use Postgres and semantic search,
  which could become the Oz-owned baseline if LangGraph is selected.
  [LangGraph long-term memory](https://docs.langchain.com/oss/javascript/langchain/long-term-memory)
- OpenAI Agents SDK sessions persist conversation history through a small
  storage interface, but this is not by itself an agentic personal-memory or
  knowledge-base system. Its local `MemorySession` is development-only.
  [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- Anthropic Managed Agents has versioned, path-addressed memory stores mounted
  into temporary agent sandboxes. It is new and harness-specific, so it belongs
  in the foundation comparison rather than becoming an independent Oz
  assumption.
  [Anthropic Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)

## Managed memory cost snapshot

These prices are current on 2026-08-08 and must be rechecked before a product
commitment.

| Provider                | Entry point                                                                                                                                                          | Relevant scale behavior                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supermemory             | Free includes about $5 of usage. Pro is $19/month with about $20 included. Max is $100/month with about $130 included. Scale is $399/month with about $600 included. | Plain unique ingested text is listed at $0.005 per 1,000 Supermemory tokens and rich content at $0.010. Storage and users are unlimited on paid plans, but ingestion, retrieval, and operations consume credits. |
| Mem0 Platform           | Free includes 10,000 adds and 1,000 retrievals per month. Starter is $19/month for 50,000 adds and 5,000 retrievals.                                                 | Pro is $249/month for 500,000 adds and 50,000 retrievals. Retrieval quotas can become the binding cost for an everyday assistant.                                                                                |
| Zep                     | Free prototype allowance is 10,000 credits. Flex is $125/month or $104/month billed annually for 50,000 credits.                                                     | Ingestion costs at least one credit per 350 bytes. Retrieval, storage, and users are unmetered, but conversational ingestion can consume credits quickly.                                                        |
| Cloudflare Agent Memory | No charge during private beta.                                                                                                                                       | Future price is unknown. Cloudflare promises at least 30 days' notice before billing begins.                                                                                                                     |

Sources:

- [Supermemory pricing](https://supermemory.ai/)
- [Supermemory pricing units](https://supermemory.ai/blog/dear-reader-we-just-made-supermemory-insanely-cheap-the-context-cloud/)
- [Mem0 pricing](https://mem0.ai/pricing)
- [Zep pricing](https://www.getzep.com/pricing/)

## Why Supermemory is the first prototype candidate

Supermemory has a TypeScript SDK, user profiles with static and dynamic facts,
hybrid memory and document retrieval, logical container isolation, connectors,
export and deletion surfaces, and self-hosting as a later option. It therefore
tests the complete Oz promise faster than building an extraction and retrieval
stack from Postgres primitives.

Its container tags are still an application-enforced logical isolation
mechanism within the Oz organization, not a substitute for Oz authorization.
[Supermemory organization and container tags](https://supermemory.ai/docs/concepts/filtering),
[profiles](https://supermemory.ai/docs/user-profiles)

The prototype must measure:

- correct cross-user isolation under adversarial identifiers;
- recall precision and false-memory rate on Oz-shaped conversations;
- update and contradiction behavior;
- explicit remember, correct, forget, export, and account-delete flows;
- latency added to an ordinary WhatsApp turn;
- unique ingestion tokens, retrievals, operations, and dollars per active user;
- ability to rebuild from Oz-owned canonical sources;
- behavior during provider outage and quota exhaustion.

## TryAgent lesson

TryAgent first selected local GBrain with PGLite inside each Agent Box, then
replaced that hosted baseline after operational instability with managed
Postgres and pgvector using separate schemas and database roles. GBrain remained
inside the Hermes memory lifecycle and assumed an Agent Box runtime.

Oz should reuse the lesson, not the topology. Without dedicated boxes, local
GBrain state and one database role per runtime are not natural defaults. The
useful carryovers are native memory-provider behavior, human-readable export,
verified writes, recall before answering personal questions, and explicit
backup, repair, reset, and deletion boundaries.

Local evidence:

- `/home/ren/repos/tryagent/docs/adr/0008-box-brain-local-pglite-default.md`
- `/home/ren/repos/tryagent/docs/adr/0009-box-brain-through-hermes-memory-lifecycle.md`
- `/home/ren/repos/tryagent/docs/adr/0010-box-brain-managed-postgres-alpha-baseline.md`

## Wayfinder consequences

The replacement map should not contain an implementation ticket called “build
Oz memory.” It should contain a sequenced investigation:

1. Define Oz memory behavior and an application-specific evaluation corpus.
2. Prototype Supermemory with canonical Oz source ownership.
3. Prototype the selected harness's native memory on the same corpus.
4. Model observed cost per activated, daily-active, and power user.
5. Choose the v1 memory engine and its deletion, export, outage, and isolation
   contracts from evidence.
