# Hermes messaging adapter delivery semantics

Accessed: 2026-08-01
Hermes commit: [`470cf66b039c73bdd2c21d43094ce41a4db74eae`](https://github.com/NousResearch/hermes-agent/tree/470cf66b039c73bdd2c21d43094ce41a4db74eae)

## Executive judgment

Hermes supports the separation Osfo has chosen:

```text
canonical agent output and transcript
                |
      structured delivery events
                |
        Messaging Adapter
                |
   provider-specific projection
```

The key rule is explicit in Hermes: adapter rendering is presentation-only.
An adapter may render or suppress stream and tool events, but it must not alter
the bytes stored in conversation history. History belongs to the agent, not the
adapter. [Base adapter rendering contract](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/base.py#L3026-L3074)

For Osfo, adopt the shape, not Hermes's exact interface:

1. Keep canonical `ThreadEvent`s independent of delivery rendering.
2. Give every adapter an explicit capability descriptor.
3. Select an adapter policy from those capabilities, with per-installation
   overrides.
4. Treat previews, typing, reactions, progress bubbles, provider edits, and
   stale-preview cleanup as delivery state, never canonical Thread state.
5. Default permanent-message and high-cost channels to completed-answer-only.

## What Hermes shares and what adapters own

`BasePlatformAdapter` requires connection lifecycle and text delivery, then
offers optional editing, deletion, native drafts, formatting, media, typing,
threading, and interactive controls. Capability flags also describe code
blocks, textual status, asynchronous delivery, long-message splitting, and
command syntax. [Base capabilities](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/base.py#L2626-L2707),
[required and optional delivery methods](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/base.py#L3451-L3560)

Shared above adapters:

- normalized inbound messages and session routing;
- structured assistant, commentary, tool, and notice events;
- buffering, edit cadence, overflow handling, fallback delivery, and silence
  suppression;
- tool-progress grouping and per-platform display preferences;
- reconnect supervision and delivery outcome vocabulary.

Owned by each adapter:

- provider authentication and conversation addressing;
- formatting and message-size units;
- send, edit, delete, draft, typing, reaction, attachment, and button APIs;
- reply and thread semantics;
- provider pacing, sending windows, and reconnect details;
- the final projection of the canonical answer.

Hermes recommends a plugin adapter path that needs no core changes and lets the
plugin registry supply common authorization, delivery routing, config, status,
and chunking integration. [Adapter plugin guide](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/ADDING_A_PLATFORM.md#L1-L39)

## Delivery preferences by channel

| Channel | Hermes default projection | Material behavior |
|---|---|---|
| Telegram | Progressive when the global streaming switch is on | Native draft preview in supported DMs under `auto`, edit-in-place elsewhere, final answer becomes or remains a real message, 4,096 UTF-16-unit legacy chunks, MarkdownV2 or optional rich rendering, native media and typing. Tool progress is off by default, but polished interim commentary and long-running notices remain on. [Telegram draft lifecycle](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/telegram/adapter.py#L5195-L5231), [Telegram limits and preferences](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/telegram/adapter.py#L600-L640) |
| WhatsApp, Baileys bridge | Editable progressive answer | First send, repeated edits, then final edit. Text is converted to WhatsApp syntax, split near 4,096 characters, sent sequentially with 300 ms pacing, and only the first chunk quotes the source message. Images, video, documents, voice, and typing are native. [WhatsApp send and edit](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/whatsapp/adapter.py#L853-L950) |
| WhatsApp Cloud | Completed answer only | Hermes has no edit override here, so its conservative default disables token streaming, tool progress, interim commentary, and heartbeats. It still sends provider-formatted chunks, URL previews, first-chunk quoting, native media, buttons and lists, and a best-effort combined read and typing signal. [Cloud send](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/whatsapp_cloud.py#L499-L575), [Cloud typing and read state](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/whatsapp_cloud.py#L577-L645) |
| BlueBubbles, iMessage | Completed answer only | Editing is explicitly unsupported. Markdown is stripped, blank-line-separated paragraphs become natural iMessage bubbles, oversized paragraphs split without `(1/N)` suffixes, and attachments are native. Typing and read receipts are best-effort and require BlueBubbles Private API support. [BlueBubbles text projection](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/bluebubbles.py#L139-L143), [paragraph bubbles and splitting](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/bluebubbles.py#L503-L561), [typing and read receipts](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/bluebubbles.py#L694-L741) |
| Twilio SMS | Completed plain-text answer only | Markdown is stripped and text is split at 1,600 characters. Each chunk is a separate Twilio REST request. There is no preview, edit, typing, reaction, MMS, pacing, or send retry in this adapter. The first failed chunk ends the send. [SMS adapter](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/sms/adapter.py#L41-L65), [SMS send and formatting](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/sms/adapter.py#L157-L222) |
| Discord | Completed answer by default, editable streaming by opt-in | Native Markdown, 2,000-character chunks, preview edits, final overflow split into continuations, native attachments, persistent typing refresh, and lifecycle reactions `eyes` to success or failure. Streaming is off in shipped per-platform defaults because edit streaming flickers. [Discord capabilities and recovery state](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/discord/adapter.py#L886-L1015), [Discord streaming edit semantics](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/discord/adapter.py#L3178-L3277) |
| Slack | Completed answer by default, editable streaming by opt-in | Slack mrkdwn, roughly 39,000-character chunks, optional final-only Block Kit rendering, native file uploads, lifecycle reactions, and textual thread status such as `is thinking...` or live tool phrases. Tool progress and long-running notification bubbles are off by default because shared workspace channels are easy to spam. [Slack capabilities](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/slack/adapter.py#L855-L881), [Slack edit and final rendering](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/slack/adapter.py#L2710-L2819), [Slack status](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/plugins/platforms/slack/adapter.py#L2849-L2944) |
| Direct HTTP or web client | Structured stream, not chat-bubble projection | The session-chat endpoint emits SSE events such as `run.started`, `message.started`, `assistant.delta`, tool events, `assistant.completed`, and `run.completed`. The API adapter is request-response scoped and explicitly cannot promise later asynchronous delivery after the request ends. [Session SSE lifecycle](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/api_server.py#L3453-L3626), [stateless API capability](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/api_server.py#L1168-L1189) |

The general preference is capability-tiered and conservative. High-capability
personal channels may show live output. Workspace channels reduce progress
noise. Non-editable channels disable live chatter. Batch channels show only the
completed answer. [Display tiers and platform defaults](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/display_config.py#L73-L180)

The global streaming switch is off by default. When enabled, transport defaults
to `auto`, which prefers native drafts where supported and otherwise uses edits.
Shipped per-platform overrides enable Telegram streaming but disable Discord and
Slack streaming. The shared cadence is 0.8 seconds or 24 buffered characters.
[Streaming defaults](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/hermes_cli/config_defaults.py#L1194-L1215),
[streaming transport config](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/hermes_cli/config_defaults.py#L2545-L2571)

## Progress, silence, and attachments

Hermes separates three user-visible surfaces:

```text
assistant output       editable preview or completed answer
interim commentary     optional separate assistant message
tool progress          editable accumulated bubble, separate bubbles, or hidden
```

Tool progress defaults to one accumulated editable bubble. An adapter may eat a
tool event, and the gateway drops progress completely when the adapter has no
real edit implementation. [Structured stream dispatch](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/stream_dispatch.py#L40-L129),
[non-editable progress suppression](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/run.py#L3641-L3669)

Exact intentional-silence markers are suppressed. The streaming consumer also
holds partial prefixes so `NO_REPLY` cannot briefly flash before being removed.
If a preview exists, deletion is best-effort. [Streaming silence handling](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/stream_consumer.py#L745-L805)

Attachments are not flattened into one universal provider payload. The shared
layer discovers media intent, while adapters select native image, video, voice,
audio, document, upload, caption, and fallback behavior. This is the right seam
for Osfo as well.

## Failure and recovery semantics

Hermes's useful shared streaming fallback is:

```text
edit succeeds
  -> keep editing the same preview

rate limit
  -> double edit interval, capped at 10 seconds
  -> after 3 strikes, stop editing for this turn

edit fails or editing is unavailable
  -> preserve the visible prefix
  -> send only the missing tail when possible
  -> retry a bounded flood-controlled final send once
  -> delete stale preview only after confirmed replacement
```

This favors delivering the complete answer over a perfectly clean provider UI.
If stale-preview deletion fails, the old preview may remain. [Adaptive edit
fallback](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/stream_consumer.py#L2141-L2204),
[fallback final and cleanup](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/stream_consumer.py#L1245-L1427)

Hermes avoids blindly retrying ambiguous non-idempotent sends. Its delivery
ledger records final-response obligations and can recover pending or failed
delivery with visible duplicate-risk handling. This is more important to Osfo
than any one adapter's local retry loop. [Delivery obligation model](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/delivery_ledger.py#L1-L38)

Reconnect is adapter-aware. The base contract tells adapters to preserve queued
provider updates on reconnect where possible, while the runner supervises
retryable failures. [Reconnect contract](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/platforms/base.py#L3451-L3465)

## Transcript separation

Hermes has two different identities:

```text
platform + chat + optional thread/participant
                  |
             session_key
                  |
             session_id
                  |
       canonical SQLite transcript
```

`SessionSource` retains provider routing fields, and its deterministic key
includes platform, chat, and thread identity. The canonical transcript is stored
separately in SQLite by `session_id`, with full messages and tool data.
[Hermes session key construction](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/session.py#L1029-L1133),
[session storage architecture](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/website/docs/developer-guide/session-storage.md#L1-L32)

Hermes's transcript is message-oriented, not an Osfo-style immutable event log,
so it is not a persistence model to copy directly. Its separation of routing,
transcript, and presentation is still strong evidence for Osfo's seam.

## Decisions to carry into Osfo

### Stable Osfo contract

- `MessagingAdapterId + ProviderConversationKey -> ThreadId` binding.
- Canonical committed `ThreadEvent`s and replay remain provider-neutral.
- Explicit delivery outcomes distinguish confirmed, rejected, retryable,
  ambiguous, partial, and permanently failed delivery.
- Adapter rendering consumes Thread events without changing canonical history.
- Presentation artifacts use adapter-owned identifiers and state.

### Adapter capability descriptor

At minimum, declare:

```text
streaming: none | edit | native_draft
editable, deletable, async_delivery
message_limit + length_unit
formatting_profile
attachments[]
typing, read_receipts, reactions, interactive_controls
threading and reply semantics
provider_send_window
```

Capabilities should be explicit and may vary by conversation, not only adapter
type. Telegram drafts work in DMs but not groups. BlueBubbles typing depends on
Private API availability. WhatsApp's two Hermes adapters have different edit
support even though both target WhatsApp.

### Default projection policy

- Native draft available: use the draft for live output and commit a real final
  provider message.
- Safe edit available: optionally edit one preview, then finalize in place.
- No safe edit: buffer until `AssistantOutputCompleted` and send only the final.
- Permanent or costly channels such as SMS: hide tool progress, commentary, and
  heartbeats by default.
- Shared workspace channels: favor textual typing/status or reactions over
  permanent progress bubbles.
- Split only in the adapter, after provider formatting and using the provider's
  length unit.
- Make all presentation defaults overridable per adapter installation.

## Hermes details not to copy

- Hermes sometimes infers edit support optimistically. An adapter without an
  explicit `SUPPORTS_MESSAGE_EDITING = False` can enter the streaming path and
  discover missing edit support only after a preview send. Osfo should require
  explicit, fail-closed capabilities. [Hermes edit capability check](https://github.com/NousResearch/hermes-agent/blob/470cf66b039c73bdd2c21d43094ce41a4db74eae/gateway/run.py#L22753-L22763)
- Hermes keys sessions primarily by platform kind. Osfo's adapter installation
  identifier is safer because users may configure several accounts of the same
  provider.
- Do not bake Telegram's 0.8-second cadence, Discord's 2,000-character limit,
  WhatsApp's sending window, or SMS segmentation into Osfo core.
- Do not persist cursors, typing state, reactions, preview message IDs, tool
  chrome, or stale-preview cleanup as canonical Thread events.
