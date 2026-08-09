# Hermes memory layer cross-check

Date: 2026-08-08

## Question

How does Hermes Agent actually divide native memory, session recall, external
memory providers, and GBrain, and what should Oz copy or avoid?

## Executive conclusion

The user's mental model is directionally strong, with four important
corrections:

1. Hermes has no official Tier 0, Tier 1, Tier 2, or Tier 3 terminology. Its
   first-party architecture is built-in curated memory, SQLite session history,
   and one optional external memory provider.
2. `MEMORY.md` is capped at 2,200 characters, but `USER.md` has a separate
   1,375-character cap. Both are frozen into the system prompt at session start.
3. The 80% rule is documentation advice, not runtime enforcement. The hard rule
   is the configured character cap. If consolidation repeatedly fails, Hermes
   eventually skips the save rather than blocking the user's turn forever.
4. The 24-hour and 90-day values apply only to opt-in session database cleanup.
   Native memory is not pruned every 24 hours, and 90 days is not a retrieval
   attention window.

The most useful idea to copy is the separation of roles:

```text
current turn
  -> bounded conversation context

always-needed operating context
  -> small profile and instruction projection

past conversations
  -> durable transcript store plus lexical retrieval

people, projects, documents, and evolving facts
  -> addressable long-term memory and knowledge retrieval
```

Oz should preserve those distinctions in its domain model even if Supermemory
or Cloudflare implements several of them behind one API.

From the user's perspective, all durable personal knowledge can still be called
the **Oz Knowledge Base**. The distinctions below are internal record and
retrieval contracts, not separate products the user must understand.

## Source baseline

Hermes was checked against first-party source at commit
[`3d7dda4cf`](https://github.com/NousResearch/hermes-agent/tree/3d7dda4cf42176d587b459345c56236a26030324),
pulled on 2026-08-08. GBrain was checked against its own repository at commit
[`0b47afbf4`](https://github.com/garrytan/gbrain/tree/0b47afbf402a4e27a648bb9d131ce584461461ea).
Supermemory and Cloudflare comparisons use their official current documentation.

## Claim-by-claim verification

| Claim                                                                                                             | Verdict                                  | What the primary source says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MEMORY.md` is capped at 2,200 characters                                                                         | Confirmed                                | `MEMORY.md` is 2,200 characters. `USER.md` is a second store capped at 1,375 characters. [Hermes memory docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/features/memory.md#L13-L20)                                                                                                                                                                                                                                                                                                                                                             |
| Native memory is always loaded                                                                                    | Qualified                                | Both files are loaded as a frozen system-prompt snapshot at session start. Writes persist immediately but do not enter that session's frozen prompt until a later session. [Hermes memory docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/features/memory.md#L36-L67)                                                                                                                                                                                                                                                                           |
| Hermes consolidates at 80%                                                                                        | Qualified                                | The docs call consolidation above 80% a best practice. The active model guidance intentionally contains no 80% threshold. Hard enforcement happens only when a proposed write exceeds the configured cap. [Docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/features/memory.md#L125-L153), [model guidance](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/agent/prompt_builder.py#L165-L188)                                                                                                        |
| An overflow error forces the model to free memory                                                                 | Qualified                                | Overflow returns the live entries and asks the model to consolidate and retry. After more than three failed consolidation attempts in one turn, Hermes returns a terminal result and permits the fact to remain unsaved. [Implementation](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/tools/memory_tool.py#L159-L201), [overflow path](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/tools/memory_tool.py#L390-L445)                                                                                                         |
| Memory is pruned every 24 hours                                                                                   | Incorrect                                | The native Markdown stores have no 24-hour pruning lifecycle. Session database cleanup can run at most once per 24 hours, but only when `sessions.auto_prune` is explicitly enabled. It is off by default. [Hermes configuration](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/hermes_cli/config_defaults.py#L2576-L2608)                                                                                                                                                                                                                                                  |
| Hermes has 90 days of attention                                                                                   | Incorrect terminology                    | Ninety days is the default retention cutoff for ended, inactive sessions when manual or opt-in automatic pruning runs. It is not a recall window. With automatic pruning disabled, session search covers all retained history. [Session cleanup docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/sessions.md#L702-L718)                                                                                                                                                                                                                          |
| SQLite keeps normal FTS and trigram indexes                                                                       | Confirmed, but incomplete                | Hermes has a standard FTS5 index plus a trigram FTS5 index for substring-capable search. The current code also supports an optional CJK bigram index. Trigram excludes tool-result rows to control index size, while the standard index still covers them. [FTS schema](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/hermes_state_common.py#L331-L405)                                                                                                                                                                                                                     |
| Session search answers “was this discussed?”                                                                      | Confirmed                                | It returns real stored messages without an LLM summarization pass and supports discovery plus scrolling through a session. [Persistent memory docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/features/memory.md#L185-L209)                                                                                                                                                                                                                                                                                                                     |
| External memory is pluggable and only one provider runs at a time                                                 | Confirmed                                | One external provider may be active. Built-in `MEMORY.md` and `USER.md` remain active alongside it, so the provider is additive rather than a replacement. [Provider docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/features/memory-providers.md#L7-L39)                                                                                                                                                                                                                                                                                       |
| Official providers include Honcho, Mem0, Hindsight, Holographic, OpenViking, RetainDB, ByteRover, and Supermemory | Confirmed                                | Those are the eight current in-tree providers. “M1,” “white,” and plain “Rover” are not provider names in the current first-party list. [Provider docs](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/user-guide/features/memory-providers.md#L1-L25)                                                                                                                                                                                                                                                                                                          |
| GBrain is an official Hermes Layer 3 provider                                                                     | Not supported                            | GBrain does not appear in Hermes' provider registry or first-party memory docs. It integrates with Hermes through GBrain's own install protocol, skills, CLI, MCP, and scheduled jobs. Calling it a community integration is fair. Calling it official Hermes “Layer 3” is not first-party terminology. [Hermes provider interface](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/website/docs/developer-guide/memory-provider-plugin.md#L7-L28), [GBrain integration](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/README.md#L81-L129) |
| GBrain owns world knowledge while agent memory owns operational state                                             | Confirmed by GBrain                      | GBrain explicitly routes people, companies, deals, meetings, concepts, and ideas to the brain. Preferences, decisions, tool configuration, and session continuity go to agent memory. Current conversation state stays in session context. [GBrain brain vs memory guide](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/docs/guides/brain-vs-memory.md#L1-L64)                                                                                                                                                                                                                        |
| GBrain tracks who said what, when, and with confidence                                                            | Confirmed, with nuance                   | Its “takes” layer records holder, claim kind, confidence weight, and time. Its hot “facts” layer captures the owner's conversational knowledge, then dream consolidation promotes durable facts into attributed, deduplicated takes. This is more specific than a generic document graph. [GBrain takes vs facts](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/docs/takes-vs-facts.md#L1-L65)                                                                                                                                                                                        |
| GBrain preserves raw sources and maintains Markdown entity pages                                                  | Confirmed                                | Its ingestion contract requires inline source attribution, raw-source preservation, entity backlinks, and subject-based filing such as people, companies, concepts, meetings, and sources. [GBrain ingestion contract](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/skills/ingest/SKILL.md#L25-L54), [raw source routing](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/skills/ingest/SKILL.md#L219-L235)                                                                                                                                         |
| GBrain's database is the canonical knowledge store                                                                | Incorrect for the current implementation | GBrain's current system-of-record contract makes Markdown plus frontmatter canonical for user knowledge. PostgreSQL or PGLite stores search indexes, graph materializations, and structured derivatives that can be rebuilt. Some DB-only runtime records are explicit exceptions. [GBrain system of record](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/docs/architecture/system-of-record.md#L1-L68)                                                                                                                                                                              |
| GBrain runs dream cycles                                                                                          | Confirmed                                | The maintenance cycle synthesizes selected transcripts into reflections, ideas, entity timelines, and recurring patterns. It is its own scheduled maintenance workflow, not a native Hermes memory-provider hook. [GBrain maintenance skill](https://github.com/garrytan/gbrain/blob/0b47afbf402a4e27a648bb9d131ce584461461ea/skills/maintain/SKILL.md#L116-L164)                                                                                                                                                                                                                                                        |

## What Hermes actually implements

Hermes has three first-party persistence roles, plus an optional external
provider:

```text
Model call
  -> frozen MEMORY.md and USER.md snapshot
     -> compact, always-visible operating facts

  -> active conversation context
     -> current task and recent turns

  -> session_search when needed
     -> SQLite messages
     -> standard FTS5
     -> trigram/CJK substring fallback

  -> optional external provider
     -> prefetched semantic context
     -> provider tools
     -> turn/session ingestion
```

This is not one progressively larger memory store. It is a latency and context
budget hierarchy:

- Prompt memory is tiny, immediate, and paid for on every model call.
- Session history is complete and cheap to search, but the model must choose to
  retrieve it.
- External memory adds extraction, user modeling, semantic recall, or graph
  behavior without replacing prompt memory.

## Where Hermes is weaker than the proposed Oz model

Hermes' native Markdown memory is operationally useful but is not a sufficient
canonical personal-memory store:

- Entries have no stable record IDs in the model-facing API. Mutation uses
  substring matching.
- Provenance, confidence, validity intervals, and supersession are not native
  fields.
- Selective correction is fragile when two entries contain similar text.
- The frozen projection and canonical storage are the same file.
- The external-provider bridge is not a transactional replica. In the current
  Supermemory integration, built-in memory writes are mirrored only for `add`,
  not `replace` or `remove`, so the two stores can diverge.
  [Hermes Supermemory bridge](https://github.com/NousResearch/hermes-agent/blob/3d7dda4cf42176d587b459345c56236a26030324/plugins/memory/supermemory/__init__.py#L830-L850)

The last point is decisive for Oz. A managed memory provider should be treated
as a derived retrieval engine unless Oz can prove atomic correction and erasure
semantics across both systems.

## One knowledge base, several record types

The user's statement that “the knowledge base is the long-term memory” is the
right product definition. The implementation still needs several record types
because their correction, deletion, retention, prompt, and audit behavior
differs.

| Concern         | Extracted memory record                       | Knowledge source                                       |
| --------------- | --------------------------------------------- | ------------------------------------------------------ |
| Unit            | Atomic fact, event, instruction, relationship | Document, message, email, page, file, or chunk         |
| Update behavior | Supersede, correct, forget, preserve history  | Replace or delete source, then re-index derived chunks |
| Retrieval       | Semantic, lexical, temporal, entity-aware     | Lexical, semantic, metadata-filtered source retrieval  |
| Evidence        | Links back to a message or source             | Is the source itself, or a faithful normalized copy    |
| Prompt use      | Small profile projection plus targeted recall | Targeted retrieval only                                |

Both belong to one per-account Knowledge Base. A person or project page is a
human-readable materialized view over the relevant sources, memories, events,
and relationships. It does not need to become a separate long-term-memory
system.

```text
Oz Knowledge Base
  -> Knowledge sources
     -> messages, email, files, pages, transcripts
  -> Memory records
     -> facts, preferences, events, instructions, relationships
  -> Entity views
     -> people, projects, organizations, topics
  -> Core profile
     -> small generated projection for model context
  -> Retrieval indexes
     -> lexical, semantic, temporal, graph
```

GBrain makes the distinction concrete: raw sources and Markdown pages form the
knowledge substrate, while hot facts, attributed takes, graph edges, and dream
consolidation form derived memory. Supermemory makes a similar distinction
between document chunks, extracted memories, and a static/dynamic profile.
[Supermemory hybrid search](https://supermemory.ai/docs/search),
[graph memory](https://supermemory.ai/docs/concepts/graph-memory),
[user profiles](https://supermemory.ai/docs/concepts/user-profiles)

## Supermemory comparison

Supermemory can reproduce much of the useful Hermes and GBrain behavior:

- Profiles supply a compact static and dynamic projection.
- Hybrid retrieval searches extracted memories and source document chunks.
- Graph relationships express update, extend, and derive links while retaining
  history.
- Memories are ID-addressable and can be explicitly forgotten.
- Documents and memories remain different API concepts.

This is enough to prototype profile synthesis, cross-session recall, document
RAG, contradiction handling, and forgetting without building them all in Oz.
It does not remove the need for Oz-owned canonical events and provenance.
Supermemory's official model is a memory and context engine, not a transactional
system of record, and its public contract does not promise GBrain's general
holder plus timestamp plus numeric confidence semantics.
[Supermemory documents vs memories](https://supermemory.ai/docs/concepts/graph-memory#documents-vs-memories),
[memory operations](https://supermemory.ai/docs/memory-operations),
[security and erasure](https://supermemory.ai/docs/overview/security#deleting-a-user-right-to-erasure)

## Cloudflare comparison

Cloudflare now exposes two different relevant products:

1. The Agents Session API stores conversation history and context blocks in
   each Agent's SQLite-backed Durable Object. Writable short-form blocks behave
   much like Hermes prompt memory, searchable blocks use SQLite FTS5 by default,
   and the system prompt can remain frozen for cache stability.
   [Cloudflare conversation memory](https://developers.cloudflare.com/agents/concepts/conversation-state-and-memory/)
2. Agent Memory is a separate managed private-beta service. It extracts facts,
   events, instructions, and tasks, preserves raw messages, supports
   supersession for facts and instructions, and combines keyword, topic,
   semantic, and raw-message retrieval.
   [Cloudflare Agent Memory model](https://developers.cloudflare.com/agent-memory/concepts/how-agent-memory-works/)

This is the closest managed analogue to the proposed Oz layering. The
per-account SQLite database can own canonical local records while Agent Memory
acts as the extraction and recall layer. The material risk remains maturity:
Agent Memory is still private beta, so availability, API stability, and future
pricing are not launch-grade assumptions.

## Recommendation for Oz

Keep the earlier ownership recommendation, but place it under one user-facing
Knowledge Base:

1. **Conversation store:** canonical messages, tool events, channel provenance,
   and summaries.
2. **Memory records:** individually addressable facts, events, instructions,
   preferences, relationships, and corrections, each linked to evidence.
3. **Profile projection:** bounded, generated, always-needed context. This may
   render as Markdown but is not the database.
4. **Knowledge sources:** files, emails, pages, transcripts, and normalized raw
   content with source-level deletion.
5. **Retrieval indexes:** lexical, semantic, temporal, and graph views that can
   be rebuilt from the first four layers.
6. **Entity views:** generated or curated people, project, organization, and
   topic pages that make the Knowledge Base inspectable without becoming a
   second source of truth.

For v1, do not build GBrain's full attributed epistemology or dream cycle.
Borrow these narrower behaviors:

- preserve the raw evidence before extraction;
- distinguish personal operating preferences from facts about other people;
- give every extracted memory a stable ID and source link;
- support supersession rather than destructive overwrite;
- keep the prompt projection small and generated;
- retain lexical transcript search even if semantic recall is unavailable;
- treat scheduled consolidation as a later quality process, not the only path
  preventing data loss.

Prototype Supermemory first if Oz remains platform-neutral. If Oz selects
Cloudflare for the runtime, benchmark Cloudflare Agent Memory against the same
corpus, but keep an Oz-owned canonical schema either way.
